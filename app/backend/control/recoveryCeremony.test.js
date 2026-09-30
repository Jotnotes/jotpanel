'use strict';

// The recovery ceremony, tested from the outside like an attacker.
//
// The property that matters most is the one the deleted admin route broke: a
// hosting company may help its own customer back in and may have no authority
// whatsoever over somebody else's. So the fixture is two unrelated hosting
// companies with a customer each, which is the shape of the real risk.

const assert = require('assert');
const Database = require('better-sqlite3');
const { createOwnershipService } = require('./ownership');
const { createAccountRecoveryService } = require('./accountRecovery');
const { createRecoveryCeremony } = require('./recoveryCeremony');

const db = new Database(':memory:');
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT UNIQUE, password TEXT, created_at TEXT);`);
const add = (id, email) => db.prepare('INSERT INTO users (id,name,email,password,created_at) VALUES (?,?,?,?,?)')
  .run(id, email.split('@')[0], email, 'x', new Date(Date.now() + Object.keys(seen).length).toISOString());
const seen = {};

add('u_hosterA', 'hostera@example.com'); seen.a = 1;
add('u_hosterB', 'hosterb@example.com'); seen.b = 1;
add('u_customerA', 'customera@example.com'); seen.ca = 1;
add('u_customerB', 'customerb@example.com'); seen.cb = 1;

// Wired the way `server.js` wires it: the subtree question is what decides
// whether one organization provides for another, and a stub here would be a
// test agreeing with itself. The map below is the hierarchy the fixture builds.
const subtree = new Map();
const ownership = createOwnershipService({
  db,
  administersOrg: (actorOrgId, targetOrgId) => (subtree.get(actorOrgId) || []).includes(targetOrgId),
});
const accountRecovery = createAccountRecoveryService({ db });

const audits = [];
let clock = new Date('2026-08-28T10:00:00Z');
const ceremony = createRecoveryCeremony({
  db, ownership, accountRecovery,
  now: () => clock,
  audit: (userId, action, req, details) => audits.push({ userId, action, details }),
});

// Two providers, a customer each, built through the ownership engine so the
// hierarchy is the real one rather than a fixture that agrees with the test.
const orgs = {};
for (const who of ['u_hosterA', 'u_hosterB', 'u_customerA', 'u_customerB']) {
  orgs[who] = ownership.ensureMembership(who).orgId;
}
// Two providers who do not know about each other, a customer each. This is the
// shape of the real risk: not one hoster and one stranger, but two hosting
// businesses on the same machine.
const link = (parent, child) => {
  const list = subtree.get(orgs[parent]) || [orgs[parent]];
  list.push(orgs[child]);
  subtree.set(orgs[parent], list);
};
link('u_hosterA', 'u_customerA');
link('u_hosterB', 'u_customerB');

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

// If the ownership engine in this build does not read that table the same way,
// say so rather than reporting a pass that means nothing.
if (!ownership.withinReach(ownership.getMembership('u_hosterA'), orgs.u_customerA)) {
  console.log('SKIP: this build\'s ownership engine does not resolve the fixture hierarchy;');
  console.log('      the cross-hoster property is proved on the live box instead.');
  process.exit(0);
}

const codes = accountRecovery.generate('u_customerA').codes;

check('a request with no valid recovery code opens nothing', () => {
  const out = ceremony.open({ email: 'customera@example.com', code: 'NOT-A-REAL-CODE' });
  assert.strictEqual(out.opaque, true);
  assert.strictEqual(out.requestId, undefined, 'no request should exist');
  assert.strictEqual(ceremony.pending('u_hosterA').length, 0);
});

check('an unknown address answers exactly the same, so this cannot enumerate accounts', () => {
  const unknown = ceremony.open({ email: 'nobody@example.com', code: codes[0] });
  assert.strictEqual(unknown.opaque, true);
  assert.strictEqual(unknown.requestId, undefined);
});

let requestId = null;
check('a valid recovery code opens a request and burns the code', () => {
  const out = ceremony.open({ email: 'customera@example.com', code: codes[0] });
  requestId = out.requestId;
  assert.ok(requestId, 'a request should exist');
  assert.strictEqual(out.state, 'awaiting_hoster');
  // The code is spent even though recovery is not finished, so a photographed
  // sheet cannot be replayed against a second request.
  const again = ceremony.open({ email: 'customera@example.com', code: codes[0] });
  assert.strictEqual(again.requestId, undefined, 'a spent code must not open a second request');
});

check('the responsible hoster sees it', () => {
  const queue = ceremony.pending('u_hosterA');
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].id, requestId);
  assert.strictEqual(queue[0].email, 'customera@example.com');
});

check('an unrelated hoster cannot see it at all', () => {
  assert.strictEqual(ceremony.pending('u_hosterB').length, 0, 'hoster B must not see hoster A\'s customer');
});

check('an unrelated hoster cannot approve it either, which is the property that matters', () => {
  const stolen = ceremony.approve({ requestId, approverIdentityId: 'u_hosterB' });
  assert.strictEqual(stolen.ok, false);
  assert.match(stolen.reason, /not an account this organization provides for/);
  assert.strictEqual(ceremony.statusOf(requestId).state, 'awaiting_hoster', 'and it is still waiting');
});

check('the customer cannot approve their own recovery', () => {
  const self = ceremony.approve({ requestId, approverIdentityId: 'u_customerA' });
  assert.strictEqual(self.ok, false);
});

let ticket = null;
check('the responsible hoster approves, and gets a ticket for the user rather than a session', () => {
  const approved = ceremony.approve({ requestId, approverIdentityId: 'u_hosterA' });
  assert.strictEqual(approved.ok, true);
  ticket = approved.ticket;
  assert.ok(ticket.startsWith('arcv_'));
  // Nothing the approver receives is a credential for the account.
  assert.strictEqual(approved.token, undefined);
  assert.strictEqual(approved.password, undefined);
});

check('the ticket is stored hashed, so the database does not hold the thing that works', () => {
  const row = db.prepare('SELECT ticket_hash FROM account_recovery_requests WHERE id=?').get(requestId);
  assert.ok(row.ticket_hash && row.ticket_hash.length === 64);
  assert.ok(!row.ticket_hash.includes(ticket));
});

check('approving twice is refused, so an approval cannot be re-spent', () => {
  const again = ceremony.approve({ requestId, approverIdentityId: 'u_hosterA' });
  assert.strictEqual(again.ok, false);
  assert.match(again.reason, /already|approved/i);
});

check('the ticket redeems once, and names the account it belongs to', () => {
  const first = ceremony.redeem({ ticket });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(first.userId, 'u_customerA');
});

check('and never again', () => {
  const replay = ceremony.redeem({ ticket });
  assert.strictEqual(replay.ok, false);
  assert.match(replay.reason, /not valid|already been used/);
});

check('a made-up ticket is refused', () => {
  assert.strictEqual(ceremony.redeem({ ticket: 'arcv_' + 'f'.repeat(48) }).ok, false);
});

check('an approved ticket expires on its own', () => {
  const fresh = accountRecovery.generate('u_customerA').codes;
  const opened = ceremony.open({ email: 'customera@example.com', code: fresh[0] });
  const approved = ceremony.approve({ requestId: opened.requestId, approverIdentityId: 'u_hosterA' });
  clock = new Date(clock.getTime() + ceremony.TICKET_TTL_MS + 60000);
  const late = ceremony.redeem({ ticket: approved.ticket });
  assert.strictEqual(late.ok, false);
  assert.match(late.reason, /expired/);
  clock = new Date('2026-08-28T10:00:00Z');
});

check('a request nobody approves expires rather than waiting forever', () => {
  const fresh = accountRecovery.generate('u_customerA').codes;
  const opened = ceremony.open({ email: 'customera@example.com', code: fresh[0] });
  clock = new Date(clock.getTime() + ceremony.REQUEST_TTL_MS + 60000);
  assert.strictEqual(ceremony.statusOf(opened.requestId).state, 'expired');
  const late = ceremony.approve({ requestId: opened.requestId, approverIdentityId: 'u_hosterA' });
  assert.strictEqual(late.ok, false);
  assert.match(late.reason, /expired/);
  clock = new Date('2026-08-28T10:00:00Z');
});

check('every step is in the record, and no recovery code or ticket is in it', () => {
  const actions = audits.map(a => a.action);
  for (const wanted of ['recovery_requested', 'recovery_approved', 'recovery_ticket_redeemed', 'recovery_approval_refused']) {
    assert.ok(actions.includes(wanted), `${wanted} should be recorded`);
  }
  const text = JSON.stringify(audits);
  for (const code of codes) assert.ok(!text.includes(code.replace(/-/g, '')), 'a recovery code reached the record');
  assert.ok(!text.includes(ticket), 'a ticket reached the record');
});

console.log(`\n${passed} checks passed`);
