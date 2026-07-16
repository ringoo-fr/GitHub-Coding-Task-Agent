'use strict';

/**
 * client.js — Authenticated Octokit instance (singleton).
 */

const { Octokit } = require('@octokit/rest');

let _octokit = null;

function getClient() {
  if (!_octokit) {
    if (!process.env.GITHUB_TOKEN) {
      throw new Error('GITHUB_TOKEN is not set. Add it to your .env file.');
    }
    _octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  }
  return _octokit;
}

module.exports = { getClient };
