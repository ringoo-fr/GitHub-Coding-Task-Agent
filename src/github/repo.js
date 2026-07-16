'use strict';

/**
 * repo.js — Clone or update a local working copy of the target repo.
 */

const path      = require('path');
const fs        = require('fs');
const simpleGit = require('simple-git');

/**
 * Ensure a local clone exists and is up to date.
 * Returns the absolute path to the working copy and a git instance.
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} workspaceDir   Root dir for clones (e.g. ./workspace)
 * @param {Logger} logger
 * @returns {{ repoPath: string, git: SimpleGit }}
 */
async function ensureClone(owner, repo, workspaceDir, logger) {
  const repoPath = path.join(workspaceDir, `${owner}__${repo}`);
  const token    = process.env.GITHUB_TOKEN;
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  const git = simpleGit();

  if (fs.existsSync(path.join(repoPath, '.git'))) {
    logger.step('repo_pull', `Updating existing clone at ${repoPath}`);
    const repoGit = simpleGit(repoPath);
    await repoGit.fetch('origin');
    await repoGit.checkout('main').catch(() => repoGit.checkout('master'));
    await repoGit.pull('origin');
  } else {
    logger.step('repo_clone', `Cloning ${owner}/${repo} into ${repoPath}`);
    fs.mkdirSync(repoPath, { recursive: true });
    await git.clone(cloneUrl, repoPath);
  }

  const repoGit = simpleGit(repoPath);

  // Configure git identity for commits
  await repoGit.addConfig('user.email', 'github-task-agent@local');
  await repoGit.addConfig('user.name', 'GitHub Task Agent');

  return { repoPath, git: repoGit };
}

/**
 * Create a new branch for the fix.
 *
 * @param {SimpleGit} git
 * @param {string}    branchName
 * @param {Logger}    logger
 */
async function createBranch(git, branchName, logger) {
  logger.step('git_branch', branchName);
  await git.checkoutLocalBranch(branchName);
}

/**
 * Stage all changes, commit, and push the branch.
 *
 * @param {SimpleGit} git
 * @param {string}    branchName
 * @param {string}    commitMessage
 * @param {Logger}    logger
 */
async function commitAndPush(git, branchName, commitMessage, logger) {
  const status = await git.status();
  const changed = [
    ...status.modified,
    ...status.created,
    ...status.not_added,
  ];

  if (changed.length === 0) {
    logger.warn('git_commit', 'No changes to commit');
    return false;
  }

  logger.step('git_commit', { files: changed, message: commitMessage });
  await git.add('.');
  await git.commit(commitMessage);

  logger.step('git_push', branchName);
  await git.push('origin', branchName, ['--set-upstream']);

  return true;
}

/**
 * Reset the repo back to the default branch (cleanup after a run).
 */
async function resetToMain(git) {
  try {
    await git.checkout('main');
  } catch (_) {
    await git.checkout('master');
  }
}

module.exports = { ensureClone, createBranch, commitAndPush, resetToMain };
