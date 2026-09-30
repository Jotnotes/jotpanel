'use strict';

// A fresh panel must be able to propose. The tier used to require a routing
// table row that a new install never has, so "create a mailbox for x@y" came
// back as directions to the Mailboxes screen and no card was ever filed. This
// reads the policy exactly as server.js computes it.

const assert = require('assert');
const Database = require('better-sqlite3');

function assistantOpsPolicy(db, userId) {
  let cfg = {};
  try {
    const row = db.prepare('SELECT data FROM routing_table WHERE id=2').get();
    if (row) cfg = JSON.parse(row.data).assistantOps || {};
  } catch {}
  const enabled = cfg.enabled !== false;
  if (!enabled) return { enabled: false, allowed: false, reason: 'The assistant tier is off on this deployment.' };
  const plans = Array.isArray(cfg.plans) ? cfg.plans : [];
  if (!plans.length) return { enabled: true, allowed: true, reason: null };
  let plan = null;
  try { plan = db.prepare('SELECT plan FROM users WHERE id=?').get(userId)?.plan || null; } catch {}
  if (plan && plans.includes(plan)) return { enabled: true, allowed: true, reason: null };
  return { enabled: true, allowed: false, reason: `Letting the assistant do the work is part of ${plans.join(' or ')}.` };
}

const db = new Database(':memory:');
db.exec(`CREATE TABLE routing_table (id INTEGER PRIMARY KEY, data TEXT);
         CREATE TABLE users (id TEXT PRIMARY KEY, plan TEXT);`);
db.prepare("INSERT INTO users (id, plan) VALUES ('u1', 'free')").run();
const set = cfg => { db.prepare('DELETE FROM routing_table WHERE id=2').run();
  db.prepare('INSERT INTO routing_table (id,data) VALUES (2,?)').run(JSON.stringify({ assistantOps: cfg })); };

// The install shape that shipped broken: no row at all.
assert.equal(assistantOpsPolicy(db, 'u1').allowed, true, 'a fresh panel with no config can propose');

set({});
assert.equal(assistantOpsPolicy(db, 'u1').allowed, true, 'a config that says nothing about the tier leaves it on');

set({ enabled: true });
assert.equal(assistantOpsPolicy(db, 'u1').allowed, true, 'explicitly on is on');

set({ enabled: false });
const off = assistantOpsPolicy(db, 'u1');
assert.equal(off.allowed, false, 'an operator who turns it off is obeyed');
assert.match(off.reason, /off on this deployment/);

set({ enabled: true, plans: ['pro'] });
assert.equal(assistantOpsPolicy(db, 'u1').allowed, false, 'a plan list still gates who may use it');
db.prepare("UPDATE users SET plan='pro' WHERE id='u1'").run();
assert.equal(assistantOpsPolicy(db, 'u1').allowed, true, 'a person on a listed plan may use it');

console.log('assistant tier checks passed — a fresh panel proposes, an operator can still switch it off');
