'use strict';

/**
 * logger.js — Action logger for the GitHub Task Agent.
 * Every run gets its own log file at logs/run-<timestamp>.log.
 */

const fs   = require('fs');
const path = require('path');

class Logger {
  constructor(logsDir, runId) {
    this.logsDir  = logsDir;
    this.runId    = runId;
    this.entries  = [];
    this.startMs  = Date.now();

    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

    this.logFile = path.join(logsDir, `run-${runId}.log`);
    this._write(`=== GitHub Task Agent Run — ${runId} ===\n`);
  }

  step(label, data) {
    const elapsed = ((Date.now() - this.startMs) / 1000).toFixed(2);
    const entry   = { ts: new Date().toISOString(), elapsed: `${elapsed}s`, label, data };
    this.entries.push(entry);

    let line = `[${entry.ts}] (+${entry.elapsed}) ${label}`;
    if (data !== undefined) {
      const d = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      line += `\n  → ${d}`;
    }
    const preview = data !== undefined
      ? ': ' + (typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 120)
      : '';
    console.log(`  📋 ${label}${preview}`);
    this._write(line + '\n');
    return entry;
  }

  warn(label, data)  { return this.step(`⚠️  ${label}`, data); }
  error(label, err)  {
    const msg = err instanceof Error ? err.message : String(err);
    return this.step(`❌ ${label}`, msg);
  }

  finalize(summary) {
    this.step('run_complete', {
      runId: this.runId,
      totalSeconds: ((Date.now() - this.startMs) / 1000).toFixed(2),
      steps: this.entries.length,
      ...summary,
    });
    this._write('\n=== END ===\n');
    return this.logFile;
  }

  _write(text) {
    try { fs.appendFileSync(this.logFile, text + '\n'); }
    catch (e) { console.error('Logger write error:', e.message); }
  }
}

module.exports = Logger;
