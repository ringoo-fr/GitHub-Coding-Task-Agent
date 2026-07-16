#!/usr/bin/env node
'use strict';

/**
 * index.js — CLI entry point for the GitHub Task Agent.
 *
 * Usage:
 *   node index.js
 *   node index.js --repo owner/repo --label agent-task
 *   node index.js --issue 42          # target a specific issue number
 */

require('dotenv').config();

const path   = require('path');
const yargs  = require('yargs');
const Logger = require('./src/logger');

const { pickNextIssue, postComment, addLabel } = require('./src/github/issues');
const { ensureClone, createBranch, commitAndPush, resetToMain } = require('./src/github/repo');
const { openDraftPR, getDefaultBranch } = require('./src/github/pr');
const { runAgent } = require('./src/agent');

// ─── CLI args ────────────────────────────────────────────────────────────────

const argv = yargs
  .scriptName('github-task-agent')
  .usage('$0 [options]\n\nAutonomous GitHub issue resolver — picks up labeled issues and opens draft PRs.')
  .option('repo', {
    alias:       'r',
    type:        'string',
    description: 'Target repo as owner/repo (overrides .env)',
  })
  .option('label', {
    alias:       'l',
    type:        'string',
    description: 'Issue label to pick up (default: agent-task)',
    default:     process.env.ISSUE_LABEL || 'agent-task',
  })
  .option('issue', {
    alias:       'i',
    type:        'number',
    description: 'Target a specific issue number instead of auto-picking',
  })
  .option('model', {
    alias:       'm',
    type:        'string',
    description: 'Claude model override',
  })
  .help().alias('h', 'help')
  .wrap(90)
  .argv;

// ─── Validate env ─────────────────────────────────────────────────────────────

const missing = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'].filter(k => !process.env[k]);
if (missing.length) {
  console.error(`❌  Missing required env vars: ${missing.join(', ')}`);
  console.error('    Copy .env.example → .env and fill in your values.');
  process.exit(1);
}

// ─── Resolve config ──────────────────────────────────────────────────────────

if (argv.model) process.env.CLAUDE_MODEL = argv.model;

let owner = process.env.GITHUB_REPO_OWNER;
let repo  = process.env.GITHUB_REPO_NAME;

if (argv.repo) {
  [owner, repo] = argv.repo.split('/');
}

if (!owner || !repo) {
  console.error('❌  No repo specified. Set GITHUB_REPO_OWNER + GITHUB_REPO_NAME in .env, or pass --repo owner/repo');
  process.exit(1);
}

const WORKSPACE_DIR  = path.resolve(process.env.WORKSPACE_DIR || path.join(__dirname, 'workspace'));
const LOGS_DIR       = path.join(__dirname, 'logs');
const BRANCH_PREFIX  = process.env.BRANCH_PREFIX || 'agent-fix';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const runId  = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const logger = new Logger(LOGS_DIR, runId);

  console.log('\n🤖 GitHub Task Agent starting…');
  console.log(`   Repo  : ${owner}/${repo}`);
  console.log(`   Label : ${argv.label}`);
  console.log(`   Model : ${process.env.CLAUDE_MODEL || 'claude-opus-4-5'}`);
  console.log(`   Log   : ${logger.logFile}\n`);

  // ── 1. Pick issue ──────────────────────────────────────────────────────────
  let issue;

  if (argv.issue) {
    const { getClient } = require('./src/github/client');
    const { data } = await getClient().issues.get({ owner, repo, issue_number: argv.issue });
    issue = data;
    logger.step('issue_targeted', { number: issue.number, title: issue.title });
  } else {
    logger.step('issue_search', { label: argv.label });
    issue = await pickNextIssue(owner, repo, argv.label);
  }

  if (!issue) {
    console.log('✅  No unprocessed issues found. Nothing to do.');
    logger.finalize({ result: 'no_issues' });
    return;
  }

  console.log(`\n📌 Picked issue #${issue.number}: ${issue.title}`);
  logger.step('issue_picked', { number: issue.number, title: issue.title, url: issue.html_url });

  // Mark in-progress
  await addLabel(owner, repo, issue.number, 'agent-in-progress').catch(() => {});

  // ── 2. Prepare local repo ─────────────────────────────────────────────────
  const { repoPath, git } = await ensureClone(owner, repo, WORKSPACE_DIR, logger);

  const defaultBranch = await getDefaultBranch(owner, repo);
  const branchName    = `${BRANCH_PREFIX}/issue-${issue.number}-${runId}`;

  await createBranch(git, branchName, logger);

  // ── 3. Run agent ──────────────────────────────────────────────────────────
  console.log('\n🧠 Running Claude agent…\n');
  let agentResult;

  try {
    agentResult = await runAgent(issue, repoPath, logger);
  } catch (err) {
    logger.error('agent_fatal', err);
    agentResult = {
      outcome:      'blocked',
      summary:      'Agent threw an unexpected error.',
      approach:     err.message,
      filesChanged: [],
      blockers:     `Fatal error: ${err.message}\n\nCheck the log: ${logger.logFile}`,
    };
  }

  // ── 4. Handle result ──────────────────────────────────────────────────────
  if (agentResult.outcome === 'fix') {
    console.log('\n✅ Agent produced a fix — committing and opening draft PR…');

    const commitMsg = `fix: address issue #${issue.number} — ${issue.title}\n\nCloses #${issue.number}`;
    const pushed    = await commitAndPush(git, branchName, commitMsg, logger);

    if (pushed) {
      const pr = await openDraftPR({
        owner, repo,
        branchName,
        baseBranch:   defaultBranch,
        issueNumber:  issue.number,
        issueTitle:   issue.title,
        summary:      agentResult.summary,
        approach:     agentResult.approach,
        filesChanged: agentResult.filesChanged,
      });

      logger.step('pr_opened', { url: pr.url, number: pr.number });
      console.log(`\n   🔀 Draft PR opened: ${pr.url}`);
    } else {
      // Agent said fix but no actual file changes — treat as blocked
      agentResult.outcome  = 'blocked';
      agentResult.blockers = 'Agent reported a fix but no files were modified.';
    }
  }

  if (agentResult.outcome === 'blocked') {
    console.log('\n⚠️  Agent could not resolve — posting explanation comment…');

    const commentBody = [
      '## 🤖 Agent Attempt — Unable to Fully Resolve',
      '',
      '**Summary:** ' + agentResult.summary,
      '',
      '**Approach taken:**',
      agentResult.approach,
      '',
      '**Blockers:**',
      agentResult.blockers || 'See agent log for details.',
      '',
      `*Agent run ID: \`${runId}\`*`,
    ].join('\n');

    const comment = await postComment(owner, repo, issue.number, commentBody);
    logger.step('comment_posted', comment.html_url);
    console.log(`\n   💬 Comment posted: ${comment.html_url}`);
  }

  // ── 5. Cleanup ────────────────────────────────────────────────────────────
  await resetToMain(git).catch(() => {});
  logger.finalize({ outcome: agentResult.outcome, issue: issue.number });

  console.log(`\n   📋 Log: ${logger.logFile}\n`);
}

main().catch(err => {
  console.error('\n❌  Fatal:', err.message);
  process.exit(1);
});
