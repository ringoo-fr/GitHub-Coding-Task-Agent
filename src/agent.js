'use strict';

/**
 * agent.js — Claude tool-use agent that reads an issue and attempts a fix.
 *
 * Flow:
 *   1. Receive issue details + repo path.
 *   2. Claude explores the codebase with read_file / list_files / search_code.
 *   3. Claude writes fixes with write_file.
 *   4. Claude optionally runs tests with run_command.
 *   5. Claude calls produce_result with outcome='fix' or 'blocked'.
 */

const Anthropic = require('@anthropic-ai/sdk');
const { TOOL_DEFINITIONS, executeTool } = require('./tools/registry');

const MODEL      = process.env.CLAUDE_MODEL || 'claude-opus-4-5';
const MAX_TURNS  = 30;
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `You are an expert software engineer acting as an autonomous coding agent.

Your job:
1. Read a GitHub issue description carefully.
2. Explore the repository to understand the codebase and locate relevant code.
3. Implement a fix or improvement that addresses the issue.
4. Verify your changes work (run tests if available).
5. Call produce_result to signal completion.

## Rules
- NEVER merge or push anything — that is handled externally.
- Make focused, minimal changes. Fix the issue; don't refactor unrelated code.
- If you write a new file, make sure it fits the existing code style.
- Always read relevant files before editing them.
- If you cannot solve the issue (missing context, needs human decision, too risky), call produce_result with outcome='blocked' and explain clearly.
- Do NOT call produce_result until you have either made changes or exhausted your options.
- You MUST call produce_result exactly once as your final action.

## Process
1. List repo root to understand structure.
2. Read the issue and identify what needs to change.
3. Search/read relevant files.
4. Make the change with write_file.
5. Run tests if a test command is available (check package.json, Makefile, etc.).
6. Call produce_result.`;

/**
 * Run the coding agent against a single issue.
 *
 * @param {object} issue      GitHub issue object.
 * @param {string} repoPath   Absolute path to local clone.
 * @param {Logger} logger
 * @returns {Promise<{ outcome: string, summary: string, approach: string, filesChanged: string[], blockers?: string }>}
 */
async function runAgent(issue, repoPath, logger) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const task = [
    `## GitHub Issue #${issue.number}: ${issue.title}`,
    '',
    '### Description',
    issue.body || '*(no description provided)*',
    '',
    '### Labels',
    (issue.labels || []).map(l => l.name).join(', ') || 'none',
    '',
    'Please explore the repository, implement a fix, and call produce_result when done.',
  ].join('\n');

  logger.step('agent_start', { model: MODEL, issue: issue.number, title: issue.title });

  const messages = [{ role: 'user', content: task }];
  let result     = null;
  let turnCount  = 0;

  while (turnCount < MAX_TURNS) {
    turnCount++;
    logger.step(`agent_turn_${turnCount}`, `${messages.length} messages`);

    const response = await client.messages.create({
      model:      MODEL,
      max_tokens: MAX_TOKENS,
      system:     SYSTEM_PROMPT,
      tools:      TOOL_DEFINITIONS,
      messages,
    });

    logger.step(`turn_${turnCount}_response`, {
      stop_reason: response.stop_reason,
      types: response.content.map(b => b.type),
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      logger.warn('agent_end_turn', 'Claude stopped without calling produce_result');
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolBlocks  = response.content.filter(b => b.type === 'tool_use');
      const toolResults = [];

      for (const block of toolBlocks) {
        if (block.name === 'produce_result') {
          result = block.input;
        }

        let content;
        try {
          content = await executeTool(block.name, block.input, repoPath, logger);
        } catch (err) {
          logger.error(`tool_error:${block.name}`, err);
          content = JSON.stringify({ error: err.message });
        }

        toolResults.push({
          type:        'tool_result',
          tool_use_id: block.id,
          content,
        });
      }

      messages.push({ role: 'user', content: toolResults });

      if (result) {
        logger.step('agent_result_received', { outcome: result.outcome, files: result.files_changed });
        break;
      }

      continue;
    }

    logger.warn('unexpected_stop', response.stop_reason);
    break;
  }

  if (!result) {
    logger.warn('agent_no_result', 'Agent did not call produce_result — treating as blocked');
    result = {
      outcome:       'blocked',
      summary:       'Agent completed without producing a result.',
      approach:      'Unknown — agent did not call produce_result.',
      files_changed: [],
      blockers:      'Agent loop ended without a result. Check the log for details.',
    };
  }

  logger.step('agent_done', { turns: turnCount, outcome: result.outcome });

  return {
    outcome:      result.outcome,
    summary:      result.summary,
    approach:     result.approach,
    filesChanged: result.files_changed || [],
    blockers:     result.blockers || '',
  };
}

module.exports = { runAgent };
