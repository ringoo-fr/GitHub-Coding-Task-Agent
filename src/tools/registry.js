'use strict';

/**
 * registry.js — Tool definitions + executor for the Claude agent loop.
 *
 * Tools the agent can use while working on a fix:
 *   read_file       — read any file in the repo
 *   write_file      — create or overwrite a file
 *   list_files      — list files/dirs at a path
 *   search_code     — grep-style search across the codebase
 *   run_command     — run a shell command in the repo root (tests, linting)
 *   produce_result  — signal done: either 'fix' (changes made) or 'blocked'
 */

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { glob } = require('glob');

const TOOL_DEFINITIONS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to repo root.' },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file in the repository with new content. Use this to implement the fix.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path relative to repo root.' },
        content:   { type: 'string', description: 'Full new content for the file.' },
      },
      required: ['file_path', 'content'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories at a given path in the repo.',
    input_schema: {
      type: 'object',
      properties: {
        dir_path: { type: 'string', description: 'Directory path relative to repo root. Use "." for root.' },
        pattern:  { type: 'string', description: 'Optional glob pattern, e.g. "**/*.js".' },
      },
      required: ['dir_path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for a string or pattern across all files in the repository.',
    input_schema: {
      type: 'object',
      properties: {
        query:      { type: 'string', description: 'Text or regex to search for.' },
        file_glob:  { type: 'string', description: 'Limit search to files matching this glob, e.g. "**/*.js".' },
      },
      required: ['query'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command in the repository root (e.g. npm test, npm run lint). Use to verify changes.',
    input_schema: {
      type: 'object',
      properties: {
        command:     { type: 'string', description: 'Shell command to run.' },
        timeout_sec: { type: 'number', description: 'Timeout in seconds (default 60).' },
      },
      required: ['command'],
    },
  },
  {
    name: 'produce_result',
    description: [
      'Call this ONCE when finished. Signal either:',
      '  - outcome="fix": you made code changes that address the issue.',
      '  - outcome="blocked": you could not resolve it; explain why.',
    ].join('\n'),
    input_schema: {
      type: 'object',
      properties: {
        outcome: {
          type: 'string',
          enum: ['fix', 'blocked'],
          description: '"fix" if changes were made, "blocked" if not.',
        },
        summary:       { type: 'string', description: 'Short summary of what was done or attempted.' },
        approach:      { type: 'string', description: 'Explanation of the approach taken.' },
        files_changed: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of file paths that were modified (empty if blocked).',
        },
        blockers: {
          type: 'string',
          description: 'If blocked: explain what prevented a fix and what a human should do.',
        },
      },
      required: ['outcome', 'summary', 'approach'],
    },
  },
];

// ─── Executor ─────────────────────────────────────────────────────────────────

const MAX_READ_CHARS   = 15_000;
const MAX_SEARCH_HITS  = 20;
const MAX_OUTPUT_CHARS = 8_000;

async function executeTool(name, input, repoPath, logger) {
  switch (name) {

    case 'read_file': {
      const abs = path.join(repoPath, input.file_path);
      logger.step('tool:read_file', input.file_path);
      if (!fs.existsSync(abs)) return JSON.stringify({ error: 'File not found: ' + input.file_path });
      let content = fs.readFileSync(abs, 'utf8');
      if (content.length > MAX_READ_CHARS) {
        content = content.slice(0, MAX_READ_CHARS) + '\n\n[...truncated...]';
      }
      return JSON.stringify({ file_path: input.file_path, content });
    }

    case 'write_file': {
      const abs = path.join(repoPath, input.file_path);
      logger.step('tool:write_file', input.file_path);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, input.content, 'utf8');
      return JSON.stringify({ ok: true, file_path: input.file_path, bytes: input.content.length });
    }

    case 'list_files': {
      const pattern = input.pattern || '**/*';
      const cwd     = path.join(repoPath, input.dir_path);
      logger.step('tool:list_files', `${input.dir_path} (${pattern})`);
      if (!fs.existsSync(cwd)) return JSON.stringify({ error: 'Directory not found: ' + input.dir_path });
      const files = await glob(pattern, {
        cwd,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        nodir: false,
      });
      return JSON.stringify({ dir: input.dir_path, files: files.slice(0, 200) });
    }

    case 'search_code': {
      logger.step('tool:search_code', input.query);
      const fileGlob = input.file_glob || '**/*';
      const files = await glob(fileGlob, {
        cwd:    repoPath,
        ignore: ['node_modules/**', '.git/**', 'dist/**', 'build/**'],
        nodir:  true,
      });

      const hits = [];
      const re   = new RegExp(input.query, 'gi');

      for (const file of files) {
        if (hits.length >= MAX_SEARCH_HITS) break;
        try {
          const content = fs.readFileSync(path.join(repoPath, file), 'utf8');
          const lines   = content.split('\n');
          lines.forEach((line, idx) => {
            if (hits.length < MAX_SEARCH_HITS && re.test(line)) {
              hits.push({ file, line: idx + 1, text: line.trim().slice(0, 200) });
            }
          });
        } catch (_) { /* skip binary files */ }
      }

      return JSON.stringify({ query: input.query, hits, total: hits.length });
    }

    case 'run_command': {
      const timeoutSec = input.timeout_sec || 60;
      logger.step('tool:run_command', input.command);
      try {
        const output = execSync(input.command, {
          cwd:     repoPath,
          timeout: timeoutSec * 1000,
          encoding: 'utf8',
          stdio:   ['pipe', 'pipe', 'pipe'],
        });
        const trimmed = output.slice(0, MAX_OUTPUT_CHARS);
        return JSON.stringify({ ok: true, output: trimmed });
      } catch (err) {
        const out = ((err.stdout || '') + (err.stderr || '')).slice(0, MAX_OUTPUT_CHARS);
        return JSON.stringify({ ok: false, error: err.message, output: out });
      }
    }

    case 'produce_result': {
      logger.step('tool:produce_result', { outcome: input.outcome, files: input.files_changed });
      return JSON.stringify({ received: true });
    }

    default:
      logger.warn('unknown_tool', name);
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

module.exports = { TOOL_DEFINITIONS, executeTool };
