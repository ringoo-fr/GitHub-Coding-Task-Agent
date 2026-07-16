'use strict';

/**
 * issues.js — Fetch and filter GitHub issues labeled "agent-task".
 *
 * "Unprocessed" = no comment from the authenticated bot user yet.
 */

const { getClient } = require('./client');

const AGENT_MARKER = '<!-- github-task-agent -->';

/**
 * Fetch open issues with the configured label, oldest first.
 * Returns full issue objects including body and comments summary.
 */
async function fetchLabeledIssues(owner, repo, label = 'agent-task') {
  const octokit = getClient();

  const { data: issues } = await octokit.issues.listForRepo({
    owner,
    repo,
    labels:    label,
    state:     'open',
    sort:      'created',
    direction: 'asc',
    per_page:  50,
  });

  // Filter out pull requests (GitHub returns PRs in issues endpoint)
  return issues.filter(i => !i.pull_request);
}

/**
 * Check if the agent has already commented on this issue.
 * We embed AGENT_MARKER in every agent comment so we can detect it.
 */
async function isAlreadyProcessed(owner, repo, issueNumber) {
  const octokit = getClient();

  const { data: comments } = await octokit.issues.listComments({
    owner,
    repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  return comments.some(c => c.body && c.body.includes(AGENT_MARKER));
}

/**
 * Pick the oldest unprocessed issue from the labeled list.
 * Returns null if all have been touched.
 */
async function pickNextIssue(owner, repo, label = 'agent-task') {
  const issues = await fetchLabeledIssues(owner, repo, label);

  for (const issue of issues) {
    const processed = await isAlreadyProcessed(owner, repo, issue.number);
    if (!processed) return issue;
  }

  return null;  // all processed
}

/**
 * Post a comment on an issue (used for blocker explanations).
 */
async function postComment(owner, repo, issueNumber, body) {
  const octokit = getClient();

  const { data } = await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body:         `${AGENT_MARKER}\n\n${body}`,
  });

  return data;
}

/**
 * Add a label to an issue (e.g., "agent-in-progress").
 */
async function addLabel(owner, repo, issueNumber, labelName) {
  const octokit = getClient();
  try {
    await octokit.issues.addLabels({
      owner, repo,
      issue_number: issueNumber,
      labels: [labelName],
    });
  } catch (_) { /* label may not exist — non-fatal */ }
}

module.exports = { fetchLabeledIssues, pickNextIssue, postComment, addLabel, AGENT_MARKER };
