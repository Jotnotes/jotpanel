'use strict';

// One process runner for every server operation.
//
// Two rules hold everywhere below. Commands are spawned with an argument list
// and never through a shell, so no operator input is ever concatenated into a
// command line. And a non-zero exit is data, not an exception: the caller
// decides whether it is a failure worth recording, because "the package manager
// says there are no updates" and "the package manager is not installed" both
// arrive as a bad exit code and mean completely different things.

const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 20000;
const OUTPUT_LIMIT = 4 * 1024 * 1024;

function createRunner({ timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return function run(file, args = [], options = {}) {
    return new Promise((resolve) => {
      let child;
      const done = (error, stdout, stderr) => {
        const missing = error && error.code === 'ENOENT';
        resolve({
          ok: !error,
          code: error && Number.isInteger(error.code) ? error.code : error ? null : 0,
          signal: (error && error.signal) || null,
          timedOut: !!(error && error.killed && !error.signal) || !!(error && error.signal === 'SIGTERM' && error.killed),
          missing,
          stdout: String(stdout == null ? '' : stdout),
          stderr: String(stderr == null ? '' : stderr),
          error: error ? (missing ? `${file} is not installed on this server` : firstLine(error.message)) : null,
        });
      };
      try {
        child = execFile(file, args, {
          timeout: options.timeoutMs || timeoutMs,
          maxBuffer: options.maxBuffer || OUTPUT_LIMIT,
          env: options.env || env,
          cwd: options.cwd,
          encoding: 'utf8',
        }, done);
      } catch (error) {
        return done(error, '', '');
      }
      if (options.input != null && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(String(options.input));
      }
      return undefined;
    });
  };
}

// Command failures are frequently a wall of usage text. The first line is what
// a person can read, and the whole thing stays available in the action record.
function firstLine(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean)[0] || 'Command failed';
}

// The message an operator should see when a command fails: whatever the tool
// itself said, in preference to anything we would invent on its behalf.
function failureMessage(result, fallback) {
  if (result && result.missing) return result.error;
  const said = firstLine(result && (result.stderr || result.stdout));
  if (said) return said;
  if (result && result.timedOut) return `${fallback} — the command did not finish in time`;
  return result && result.error ? result.error : fallback;
}

module.exports = { createRunner, failureMessage, firstLine, DEFAULT_TIMEOUT_MS };
