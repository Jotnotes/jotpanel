'use strict';

// A unit that is mid-reload has not answered yet.
//
// On 2026-09-25 a fresh install on a 1-core box installed Postfix and Dovecot,
// both came up, the Mailboxes screen worked completely — and the account action
// record said the install had FAILED, because the verification probe asked
// `systemctl is-active dovecot` at the instant systemd still said `reloading`
// and treated that as a refusal. A red mark over a working thing.
//
// These hold the wait in place. Remove the settling wait from
// `settleServiceState` and the first two fail.

const test = require('node:test');
const assert = require('node:assert');
const { __testing } = require('./privilegedJobs.js');

const { settleServiceState, SETTLING_UNIT_STATES } = __testing;

function reader(states) {
  const queue = [...states];
  const seen = [];
  const read = async () => {
    const next = queue.length > 1 ? queue.shift() : queue[0];
    seen.push(next);
    return next;
  };
  read.seen = seen;
  return read;
}

test('a unit still reloading is waited out and reported by where it lands', async () => {
  const read = reader(['reloading', 'reloading', 'active']);
  const state = await settleServiceState('dovecot.service', { read, timeoutMs: 5000, everyMs: 5 });
  assert.strictEqual(state, 'active', 'a service that settles active must be reported active');
  assert.ok(read.seen.length >= 3, 'it must ask again rather than believe the first transient answer');
});

test('a unit still activating is waited out too', async () => {
  const read = reader(['activating', 'active']);
  assert.strictEqual(await settleServiceState('postfix.service', { read, timeoutMs: 5000, everyMs: 5 }), 'active');
});

test('a genuinely dead unit is believed at once, not waited on', async () => {
  const read = reader(['failed']);
  const state = await settleServiceState('dovecot.service', { read, timeoutMs: 5000, everyMs: 5 });
  assert.strictEqual(state, 'failed', 'a real answer is a real answer');
  assert.strictEqual(read.seen.length, 1, 'a settled state must not be polled again');
});

test('a unit that never leaves a settling state still returns that state rather than claiming active', async () => {
  const read = reader(['reloading']);
  const state = await settleServiceState('dovecot.service', { read, timeoutMs: 60, everyMs: 5 });
  assert.ok(SETTLING_UNIT_STATES.has(state), 'the wait must not invent an outcome it never saw');
  assert.notStrictEqual(state, 'active');
});

// ── The budget a caller cannot override ───────────────────────────
//
// `hostBackend` asked for twenty minutes on `packages.apply`, the request used
// `options.timeoutMs || budgetFor(job)`, and the caller's number quietly won.
// The two-minute hand-off to the watcher could therefore never happen for that
// job, and a live run passed while doing the wrong thing: it finished inside
// twenty minutes, so nothing looked broken. These hold the rule where no caller
// can reach it.

const { requestTimeout, budgetFor } = require('./privilegedClient.js');

test('a caller cannot stretch the budget of work that writes its own result', () => {
  assert.strictEqual(requestTimeout('packages.apply', 20 * 60 * 1000, 300000), 2 * 60 * 1000);
  assert.strictEqual(requestTimeout('stack.install.mail', 20 * 60 * 1000, 300000), 2 * 60 * 1000);
});

test('and cannot shorten it either, in the other direction', () => {
  assert.strictEqual(requestTimeout('stack.install.database', 5000, 300000), 2 * 60 * 1000);
});

test('work that leaves nothing to read back still honours what the caller asked', () => {
  assert.strictEqual(requestTimeout('backup.create', 90000, 300000), 90000);
  assert.strictEqual(requestTimeout('probe.service', 5000, 300000), 5000);
});

test('and falls back to the table, then the default, when the caller says nothing', () => {
  assert.strictEqual(requestTimeout('backup.create', undefined, 300000), 60 * 60 * 1000);
  assert.strictEqual(requestTimeout('mail.mailbox.create', undefined, 300000), 300000);
  assert.strictEqual(budgetFor('nothing.special', 300000), 300000);
});
