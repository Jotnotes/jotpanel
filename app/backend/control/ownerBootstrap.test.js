'use strict';

// The first five minutes of a brand new machine.
//
// Every one of these fails against the code as it stood on 2026-08-30, which is
// the point: the panel installed, all eleven stacks went on, nine suites passed
// and the owner still could not create a single thing, because nothing marked
// its organization the entitlement root. These are written against the state a
// clean machine is really in, not against a database somebody built by hand.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { createOwnershipService } = require('./ownership');
const { createEntitlementsService } = require('./entitlements');
const { ensureEntitlementRoot } = require('./ownerBootstrap');

// A machine as the installer leaves it: the schema exists and nothing else.
// `users` is created here because ownership's startup backfill looks for it.
function freshMachine() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, email TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`);
  const ownership = createOwnershipService({ db });
  const entitlements = createEntitlementsService({ db });
  return { db, ownership, entitlements };
}

// What the installer does over the loopback bootstrap surface, in the order it
// does it: the row, then the membership, then the root.
function installOwner(m, id = 'owner1') {
  m.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(id, `${id}@example.invalid`);
  m.ownership.ensureMembership(id);
  return ensureEntitlementRoot(m);
}

function metricsOf(m, orgId) {
  return m.entitlements.enabledMetrics().map(x => m.entitlements.effectiveEntitlement(orgId, x.metric_key));
}

function orgOf(m, identityId) {
  return m.ownership.getMembership(identityId).orgId;
}

// A customer as `account.create` makes one: their own identity, their own
// organization, linked under whoever provided for them.
function takeOnCustomer(m, parentOrgId, id, actor = 'owner1') {
  m.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run(id, `${id}@example.invalid`);
  m.ownership.ensureMembership(id);
  const childOrg = orgOf(m, id);
  m.entitlements.linkOrganizations(parentOrgId, childOrg, actor);
  return childOrg;
}

function unlimited(m) {
  return m.entitlements.enabledMetrics().map(x => ({ metric: x.metric_key, unlimited: true }));
}
function finite(m, value) {
  return m.entitlements.enabledMetrics().map(x => ({ metric: x.metric_key, unlimited: false, value }));
}

// ── 1. The first owner ───────────────────────────────────────────────
function testFirstOwnerHoldsTheMachine() {
  const m = freshMachine();
  const root = installOwner(m);
  assert.equal(root.created, true, 'the first owner establishes the root');
  assert.equal(root.orgId, orgOf(m, 'owner1'));
  assert.equal(m.ownership.getMembership('owner1').role, 'hosting_company');

  // The failure this whole exercise exists to catch: every metric reading zero
  // with source "missing" on a machine that was installed correctly.
  for (const eff of metricsOf(m, root.orgId)) {
    assert.equal(eff.source, 'root', 'the owner holds the machine, not a package');
    assert.equal(eff.maxUnlimited, true);
    assert.notEqual(eff.source, 'missing');
  }
  console.log('ok  a freshly installed box\'s owner holds the machine rather than nothing');
}

// ── 2. Ownership cannot be claimed twice ─────────────────────────────
function testOwnershipCannotBeClaimedAgain() {
  const m = freshMachine();
  installOwner(m);

  // A second account, however it arrives, lands at the bottom in an
  // organization of its own.
  m.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run('later', 'later@example.invalid');
  const second = m.ownership.ensureMembership('later');
  assert.equal(second.role, 'end_user', 'the second account is not an operator');
  assert.notEqual(second.orgId, orgOf(m, 'owner1'));

  // And it cannot be promoted into one.
  assert.throws(() => m.ownership.setRole('later', 'hosting_company'),
    /not a role that can be granted/, 'hosting_company is not grantable');

  // Running the ceremony again names the organization that already holds it and
  // never the newcomer.
  const again = ensureEntitlementRoot(m);
  assert.equal(again.created, false, 'a second ceremony establishes nothing');
  assert.equal(again.orgId, orgOf(m, 'owner1'));
  assert.equal(m.entitlements.isRoot(second.orgId), false, 'the newcomer is not a root');
  assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM entitlement_roots').get().n, 1,
    'one machine, one root');
  console.log('ok  a second account cannot claim the machine, and a second ceremony changes nothing');
}

// ── 3. Untrusted input cannot invent an operator ─────────────────────
function testItCannotMakeAnOperatorOutOfNothing() {
  const m = freshMachine();
  // No membership at all: this is the state the boot migration meets on a
  // machine the installer has not finished with.
  assert.equal(ensureEntitlementRoot(m), null, 'nothing to mark, so nothing is marked');
  assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM entitlement_roots').get().n, 0);

  // An account that arrives before the operator does cannot become one through
  // this path: ensureMembershipForExisting refuses to write the first
  // membership on a box, so there is nobody for the ceremony to find.
  m.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run('stranger', 's@example.invalid');
  assert.equal(m.ownership.ensureMembershipForExisting('stranger'), null);
  assert.equal(ensureEntitlementRoot(m), null, 'a stranger signing in does not become the operator');
  assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM entitlement_roots').get().n, 0);
  console.log('ok  the ceremony takes no argument and cannot be made to name a stranger');
}

// ── 4. Idempotent retry ──────────────────────────────────────────────
function testRetryingChangesNothing() {
  const m = freshMachine();
  installOwner(m);
  const before = m.db.prepare('SELECT * FROM entitlement_roots').all();
  for (let i = 0; i < 5; i += 1) {
    const r = ensureEntitlementRoot(m);
    assert.equal(r.created, false, 'only the first call creates');
  }
  assert.deepEqual(m.db.prepare('SELECT * FROM entitlement_roots').all(), before,
    'the row is byte for byte what it was');
  console.log('ok  running the ceremony five more times leaves the record exactly as it was');
}

// ── 5. An interrupted bootstrap recovers ─────────────────────────────
function testAnInterruptedBootstrapRecovers() {
  const m = freshMachine();
  // The exact broken state a clean machine was in: an owner with a membership
  // and no root, because the boot migration ran before the owner existed and
  // the route that created it never marked one.
  m.db.prepare('INSERT INTO users (id,email) VALUES (?,?)').run('owner1', 'o@example.invalid');
  m.ownership.ensureMembership('owner1');
  const ownerOrg = orgOf(m, 'owner1');
  assert.equal(m.entitlements.isRoot(ownerOrg), false);
  assert.equal(m.entitlements.effectiveEntitlement(ownerOrg, 'sites_count').source, 'missing',
    'this is what the regression box reported');

  // The next boot, or a rerun of the installer step, repairs it.
  const repaired = ensureEntitlementRoot(m);
  assert.equal(repaired.created, true);
  assert.equal(m.entitlements.effectiveEntitlement(ownerOrg, 'sites_count').source, 'root');
  console.log('ok  an owner left without a root is repaired, and the repair reports that it happened');
}

// ── 6. The owner can actually provision ──────────────────────────────
function testTheOwnerCanProvisionAResellerAndACustomer() {
  const m = freshMachine();
  const root = installOwner(m).orgId;

  // A reseller, taken on by the owner and sold a finite package.
  const resellerOrg = takeOnCustomer(m, root, 'reseller1');
  m.ownership.setRole('reseller1', 'reseller');
  const resellerPkg = m.entitlements.createPackage({
    ownerOrgId: root, name: 'Reseller 10', limits: finite(m, 10), actorIdentityId: 'owner1' });
  m.entitlements.assignPackage({ parentOrgId: root, targetOrgId: resellerOrg, packageId: resellerPkg.id, actorIdentityId: 'owner1' });
  const resellerSites = m.entitlements.effectiveEntitlement(resellerOrg, 'sites_count');
  assert.equal(resellerSites.maxValue, 10);
  assert.equal(resellerSites.source, 'package');

  // A customer of the owner's own, on a package the owner made.
  const customerOrg = takeOnCustomer(m, root, 'customer1');
  const customerPkg = m.entitlements.createPackage({
    ownerOrgId: root, name: 'Starter', limits: finite(m, 3), actorIdentityId: 'owner1' });
  m.entitlements.assignPackage({ parentOrgId: root, targetOrgId: customerOrg, packageId: customerPkg.id, actorIdentityId: 'owner1' });
  assert.equal(m.entitlements.effectiveEntitlement(customerOrg, 'sites_count').maxValue, 3);

  // And the reseller's own customer, which is the chain that matters: a
  // reseller holding ten cannot promise a hundred.
  const subOrg = takeOnCustomer(m, resellerOrg, 'subcustomer1', 'reseller1');
  const tooBig = m.entitlements.createPackage({
    ownerOrgId: resellerOrg, name: 'Too big', limits: finite(m, 100), actorIdentityId: 'reseller1' });
  assert.throws(() => m.entitlements.assignPackage({
    parentOrgId: resellerOrg, targetOrgId: subOrg, packageId: tooBig.id, actorIdentityId: 'reseller1' }),
    e => e.entitlementCode === 'ALLOCATION_LIMIT_EXCEEDED' && /more than the 10 this account holds/.test(e.message),
    'a reseller cannot promise more than it holds');

  const fits = m.entitlements.createPackage({
    ownerOrgId: resellerOrg, name: 'Fits', limits: finite(m, 4), actorIdentityId: 'reseller1' });
  m.entitlements.assignPackage({ parentOrgId: resellerOrg, targetOrgId: subOrg, packageId: fits.id, actorIdentityId: 'reseller1' });
  assert.equal(m.entitlements.effectiveEntitlement(subOrg, 'sites_count').maxValue, 4);
  console.log('ok  the owner provisions a reseller and a customer, and the reseller cannot oversell');
}

// ── 7. Nothing above was weakened ────────────────────────────────────
// The fix marks a root. It must not have turned any refusal into a yes, and the
// self-limit rule in particular has to still refuse the owner, who is now the
// most powerful account on the machine rather than the most powerless.
function testNoBoundaryWasWeakened() {
  const m = freshMachine();
  const root = installOwner(m).orgId;
  const customerOrg = takeOnCustomer(m, root, 'customer1');

  const assignOp = {
    id: 'entitlements.package.assign',
    scope: { kind: 'organization', param: 'targetOrgId' },
    label: () => 'Assign a package',
  };
  // The owner, on its own organization. Still refused, and for the same reason.
  assert.throws(() => m.ownership.authorize('owner1', assignOp, { targetOrgId: root }),
    /cannot change its own limits/, 'the owner still cannot change its own limits');
  // A customer, on its own organization. Still refused.
  assert.throws(() => m.ownership.authorize('customer1', assignOp, { targetOrgId: customerOrg }),
    /cannot change its own limits/, 'an ordinary account still cannot change its own limits');
  // A customer, on somebody else's. Still refused, and not with the self message.
  assert.throws(() => m.ownership.authorize('customer1', assignOp, { targetOrgId: root }),
    /is not an account this one provides for/);
  // The owner, on a customer's. Allowed, which is the whole point.
  assert.equal(m.ownership.authorize('owner1', assignOp, { targetOrgId: customerOrg }).orgId, root);

  // An account with no package still holds nothing. Being on a machine whose
  // owner is now a root must not leak capacity sideways.
  assert.equal(m.entitlements.effectiveEntitlement(customerOrg, 'sites_count').source, 'missing');
  assert.equal(m.entitlements.effectiveEntitlement(customerOrg, 'sites_count').maxValue, 0);
  assert.equal(m.entitlements.isRoot(customerOrg), false);

  // A whole-machine operation is still refused to an ordinary account.
  const serverOp = { id: 'service.restart', scope: { kind: 'server' }, label: () => 'Restart a service' };
  assert.throws(() => m.ownership.authorize('customer1', serverOp, {}),
    /reserved to the account that runs this box/);
  console.log('ok  every refusal that stood before this fix still stands, including for the owner');
}

// ── 8. What the record says ──────────────────────────────────────────
function testTheCeremonyIsInTheRecord() {
  const m = freshMachine();
  const root = installOwner(m);
  const row = m.db.prepare('SELECT * FROM entitlement_roots WHERE org_id=?').get(root.orgId);
  assert.ok(row, 'the root is a row, not an inference');
  assert.equal(row.created_by_identity_id, 'bootstrap', 'the record says how it was established');
  assert.ok(Date.parse(row.created_at), 'and when');

  // `created` is true exactly once, which is what lets the caller write one
  // audit line for the ceremony rather than one on every boot forever.
  let creations = 0;
  for (let i = 0; i < 4; i += 1) if (ensureEntitlementRoot(m).created) creations += 1;
  assert.equal(creations, 0, 'the ceremony announces itself once and never again');
  console.log('ok  the root is recorded with how and when, and announces itself exactly once');
}

// ── 9. It refuses to run without what it needs ───────────────────────
function testItRefusesRatherThanGuesses() {
  const m = freshMachine();
  assert.throws(() => ensureEntitlementRoot({}), /needs a database/);
  assert.throws(() => ensureEntitlementRoot({ db: m.db }), /needs a database/);
  console.log('ok  called wrong, it refuses rather than quietly doing nothing');
}

// ── 10. The bootstrap surface can say what it means ──────────────────
//
// The installer's four calls are mounted on their own express app, built by hand
// beside `app` rather than inherited from it, and that app had no language
// middleware. Every handler in this file says what it means through `req.t`, so
// the whole surface answered `TypeError: req.t is not a function` wherever it
// tried to speak: creating the first owner twice, a missing field, an unknown
// account id, a wrong admin key, a request a proxy had touched, and an unknown
// path. Measured over real HTTP on 127.0.0.1, not inferred.
//
// The one thing that still worked was the success path of each route, because
// none of those three lines call `req.t`. That is why an install passed and the
// defect sat here: the installer only ever walks the happy path.
//
// Asserted against the source, in the style of `listeningChain.test.js`,
// because the thing being asserted is which middleware is on which app and in
// what order, and standing two listeners up to read an order is a slower way to
// learn the same fact. This test must pass with no server running.
const SERVER = path.join(__dirname, '..', 'server.js');

// The bootstrap listener's own block: from the port it reads to the main app's
// health route, which is the next thing in the file.
function bootstrapBlock(source) {
  const start = source.indexOf('const BOOTSTRAP_PORT');
  assert.ok(start > 0, 'the bootstrap listener has gone from server.js');
  const end = source.indexOf("app.get('/health'", start);
  assert.ok(end > start, 'the bootstrap block no longer ends where this test expects');
  return source.slice(start, end);
}

function testTheBootstrapSurfaceCanSayWhatItMeans() {
  const source = fs.readFileSync(SERVER, 'utf8');
  const block = bootstrapBlock(source);

  // Defined once and used by both apps. Two inline copies are the same defect
  // waiting for whoever adds the third surface.
  assert.match(source, /const attachLanguage = \(req, res, next\) => \{ req\.t =/,
    'the language middleware is not one named thing both apps can share');
  assert.ok(source.includes('app.use(attachLanguage);'),
    'the main app no longer uses the shared language middleware');
  assert.ok(block.includes('bootstrap.use(attachLanguage);'),
    'the bootstrap surface has no language middleware, so every refusal and every 404 on it answers a TypeError instead of its own words');

  // A middleware mounted after the thing it serves is not mounted at all.
  const attached = block.indexOf('bootstrap.use(attachLanguage);');
  assert.ok(attached < block.indexOf("bootstrap.use('/admin/api', admin)"),
    'the language is attached after the admin router, so none of the installer\'s routes see it');
  assert.ok(attached < block.indexOf('res.status(404)'),
    'the language is attached after the bootstrap 404 handler, so an unknown path answers a TypeError');

  // And it is the real translator, not a stub that hands English back: the
  // dictionaries are the front end's and the key is the English sentence.
  const { translate } = require('./messages');
  assert.equal(translate({ headers: { 'x-jotpanel-language': 'fr' } }, 'Not found'), 'Non trouvé',
    'the translator the middleware installs does not translate');
  console.log('ok  the loopback bootstrap surface has the same language middleware the main app has');
}

// ── 11. And it still says it in the person's language ────────────────
//
// The cheap way to make the TypeError go away is to delete the `req.t` calls or
// write the English in by hand. That trades a crash for a message the half of
// the world that does not read English cannot act on, at the exact moment they
// most need to — which is the reason `control/messages.js` exists. These are the
// sentences the bootstrap surface refuses with; they stay translated.
function testTheBootstrapSurfaceStillSpeaksTheLanguageAsked() {
  const source = fs.readFileSync(SERVER, 'utf8');
  const block = bootstrapBlock(source);

  const gate = source.slice(source.indexOf('function adminAuth'), source.indexOf('function isOperatorIdentity'));
  assert.ok(gate.includes("req.t('This is administered on the machine itself, not over the network')"),
    'the bootstrap gate hardcodes its non-local refusal instead of translating it');
  assert.ok(gate.includes("req.t('Forbidden')"),
    'the bootstrap gate hardcodes its wrong-key refusal instead of translating it');

  const router = source.slice(source.indexOf('const admin = express.Router();'), source.indexOf('const BOOTSTRAP_PORT'));
  const spoken = (router.match(/req\.t\(/g) || []).length;
  // Five, and each one is named below or in the next assertions: the 409, the
  // missing field, the duplicate email, and a "Not found" for each of the two
  // routes that take an account id.
  assert.ok(spoken >= 5, `the installer's routes speak through req.t in only ${spoken} places; a refusal was hardcoded or deleted rather than translated`);
  assert.ok(router.includes("req.t('This machine already has accounts."),
    'creating the first owner twice no longer explains itself in the caller\'s language');
  assert.ok(router.includes("req.t('Missing fields')"), 'a missing field no longer explains itself');
  assert.ok(block.includes("req.t('Not found')"), 'the bootstrap 404 no longer explains itself');
  console.log('ok  the bootstrap surface translates its refusals rather than hardcoding English');
}

// ── 12. Nothing about the surface's reach changed ────────────────────
//
// Adding a middleware to this app is the kind of change that could quietly widen
// it, so the three properties that keep the surface shut are asserted beside it:
// its own listener bound to loopback, `off` switching it off entirely, and the
// router never mounted on the app nginx proxies.
function testTheBootstrapSurfaceIsStillShut() {
  const source = fs.readFileSync(SERVER, 'utf8');
  const block = bootstrapBlock(source);

  assert.match(block, /bootstrap\.listen\(BOOTSTRAP_PORT, '127\.0\.0\.1'/,
    'the bootstrap listener no longer binds loopback only');
  assert.match(block, /!== 'off'\) \{/, 'the bootstrap surface can no longer be switched off');
  assert.ok(block.indexOf("bootstrap.use('/admin/api', admin)") > block.indexOf("!== 'off'"),
    'the admin router is mounted outside the off switch');
  assert.ok(!/app\.use\(\s*['"]\/admin\/api['"]\s*,\s*admin\s*\)/.test(source),
    'the bootstrap router is also mounted on the app nginx proxies');

  // The gate is the router's first middleware, and the language middleware went
  // in front of the router rather than between the gate and the handlers.
  assert.ok(source.indexOf('admin.use(adminAuth);') < source.indexOf("admin.post('/accounts'"),
    'the bootstrap gate no longer runs before the routes it guards');
  assert.ok(block.indexOf('bootstrap.use(attachLanguage);') < block.indexOf("bootstrap.use('/admin/api', admin)"),
    'the language middleware was put inside the guarded router rather than in front of it');
  console.log('ok  loopback-only, off still means off, and the router is on no other app');
}

function run() {
  testFirstOwnerHoldsTheMachine();
  testOwnershipCannotBeClaimedAgain();
  testItCannotMakeAnOperatorOutOfNothing();
  testRetryingChangesNothing();
  testAnInterruptedBootstrapRecovers();
  testTheOwnerCanProvisionAResellerAndACustomer();
  testNoBoundaryWasWeakened();
  testTheCeremonyIsInTheRecord();
  testItRefusesRatherThanGuesses();
  testTheBootstrapSurfaceCanSayWhatItMeans();
  testTheBootstrapSurfaceStillSpeaksTheLanguageAsked();
  testTheBootstrapSurfaceIsStillShut();
  console.log('owner bootstrap tests passed');
}

run();
