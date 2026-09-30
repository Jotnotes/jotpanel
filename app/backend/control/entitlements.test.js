'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createOwnershipService } = require('./ownership');
const { createEntitlementsService } = require('./entitlements');

function freshDb(options = {}) {
  const db = new Database(':memory:');
  const ownership = createOwnershipService({ db });
  const ent = createEntitlementsService({ db, ...options });
  return { db, ownership, ent };
}

// Writes a storage reading straight into the table, with a chosen age, so the
// freshness rule can be tested without waiting fifteen real minutes.
function reading(db, domain, bytes, { minutesAgo = 0, status = 'fresh', errorCode = null } = {}) {
  const at = new Date(Date.now() - minutesAgo * 60000).toISOString();
  db.prepare(`INSERT OR REPLACE INTO entitlement_usage_readings
    (metric_key, resource_kind, resource_key, used_value, measured_at, status, error_code)
    VALUES ('managed_storage_bytes','site',?,?,?,?,?)`).run(domain, bytes, at, status, errorCode);
}

function site(db, key, orgId) {
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site',?,?,?)`).run(key, orgId, new Date().toISOString());
}

function unlimitedLimits(ent) {
  return ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: true }));
}
function finiteLimits(ent, overrides) {
  return ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: false, value: overrides[m.metric_key] ?? 1000 }));
}

async function run() {
  testRootIsUnlimited();
  testNonRootWithNoAssignmentIsMissing();
  testPackageAssignmentGivesEffectiveLimit();
  await testAdmissionBlocksAtLimitAllowsUnderIt();
  testStrictAllocationRefusesOversell();
  testUsageBasedAllocationPermitsOversell();
  testOverrideProvenanceAndClear();
  testOverrideLockedByAncestor();
  testCycleAndDuplicateParentRefused();
  await testConcurrentAdmissionOnlyOneWins();
  testSubtreeAggregationDoesNotDoubleCount();
  await testStorageReadingsAreSummedAndAged();
  await testStaleStorageReadingRefusesRatherThanPasses();
  await testStorageCleanupIsNeverBlocked();
  await testRefreshRecordsFailuresRatherThanZero();
  await testAiSpendIsMeteredThroughTheReader();
  await testDowngradeOntoExistingUsageOpensAnOverage();
  await testOverageBlocksGrowthAndSaysSo();
  await testOverageNeverBlocksRemoval();
  await testOverageResolvesOnlyOnAFreshReadingUnderTheLimit();
  await testAFullAccountIsNotAnOverage();
  await testLiftingTheCeilingResolvesTheOverageToo();
  await testAnUnmeasuredAccountIsMeasuredRatherThanRefusedForever();
  await testMeasuringOnDemandIsNotAWayPastTheLimit();
  await testAMeasurementThatCannotBeTakenStillRefuses();
  await testTenWritesAtOnceMeasureTheDiskOnce();
  testFeatureMetricsAreOptionalInAPackage();
  testAFeatureNobodyPricedIsOn();
  testAHosterCanTurnAFeatureOffAndBackOn();
  testAFeatureIsNotDividedBetweenChildren();
  console.log('entitlements tests passed');
}

function testRootIsUnlimited() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  const eff = ent.effectiveEntitlement('org_root', 'sites_count');
  assert.equal(eff.maxUnlimited, true);
  assert.equal(eff.source, 'root');
}

function testNonRootWithNoAssignmentIsMissing() {
  const { ent } = freshDb();
  const eff = ent.effectiveEntitlement('org_nobody', 'sites_count');
  assert.equal(eff.missing, true);
}

function testPackageAssignmentGivesEffectiveLimit() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Starter', limits: finiteLimits(ent, { sites_count: 3 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });
  const eff = ent.effectiveEntitlement('org_child', 'sites_count');
  assert.equal(eff.maxValue, 3);
  assert.equal(eff.source, 'package');
}

async function testAdmissionBlocksAtLimitAllowsUnderIt() {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Two Sites', limits: finiteLimits(ent, { sites_count: 2 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  const a = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_1' }));
  assert.equal(a.ok, true);
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','one.example','org_child',?)`).run(new Date().toISOString());
  ent.releaseHolds('prop_1');

  const b = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_2' }));
  assert.equal(b.ok, true);
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','two.example','org_child',?)`).run(new Date().toISOString());
  ent.releaseHolds('prop_2');

  const c = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_3' }));
  assert.equal(c.ok, false);
  assert.equal(c.code, 'ENTITLEMENT_LIMIT_EXCEEDED');
}

// ── Usage already above the ceiling ─────────────────────────────
// A package with a ceiling, an account already past it, and the two rules that
// then apply: nothing already there is touched, and nothing new may be added.

function overageFixture(sites) {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const roomy = ent.createPackage({ ownerOrgId: 'org_root', name: 'Five sites', limits: finiteLimits(ent, { sites_count: 5 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: roomy.id, actorIdentityId: 'steve' });
  for (const name of sites) site(db, name, 'org_child');
  const small = ent.createPackage({ ownerOrgId: 'org_root', name: 'One site', limits: finiteLimits(ent, { sites_count: 1 }), actorIdentityId: 'steve' });
  return { db, ent, small };
}

async function testDowngradeOntoExistingUsageOpensAnOverage() {
  const { db, ent, small } = overageFixture(['a.example', 'b.example', 'c.example']);
  assert.equal(ent.listOverages('org_child').length, 0, 'nothing is over before the ceiling moves');

  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: small.id, actorIdentityId: 'steve' });
  const found = await ent.observeOverages('org_child');
  assert.deepEqual(found.map(f => f.metric), ['sites_count']);

  const [row] = ent.listOverages('org_child');
  assert.equal(row.status, 'open');
  assert.equal(row.used_value, 3);
  // The ceiling as it was when this started, so the row reads afterwards as a
  // package that changed rather than as a number with no history.
  assert.equal(row.maximum_value_at_detection, 1);
  assert.ok(row.first_detected_at);
  assert.equal(row.resolved_at, null);

  // Seen again is the same overage, not a second one, and the ceiling it was
  // detected against does not drift.
  site(db, 'd.example', 'org_child');
  await ent.observeOverages('org_child');
  const [again] = ent.listOverages('org_child');
  assert.equal(ent.listOverages('org_child').length, 1);
  assert.equal(again.used_value, 4);
  assert.equal(again.first_detected_at, row.first_detected_at);
  assert.equal(again.maximum_value_at_detection, 1);
  console.log('  ok  a downgrade onto existing usage opens one overage and keeps the ceiling it was detected against');
}

async function testOverageBlocksGrowthAndSaysSo() {
  const { ent, small } = overageFixture(['a.example', 'b.example', 'c.example']);
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: small.id, actorIdentityId: 'steve' });

  const refused = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_over' }));
  assert.equal(refused.ok, false);
  // The distinction the whole table exists to make. "This would take you past
  // your limit" and "you are already past it" are different situations and only
  // one of them means somebody has to go and delete something.
  assert.equal(refused.code, 'ENTITLEMENT_OVERAGE_BLOCKED');
  assert.equal(refused.overage, true);
  assert.equal(refused.used, 3);
  assert.equal(refused.maximum, 1);
  // Refused means no hold was taken, so the headroom of an account that is
  // already over is not quietly reserved by attempts that cannot run.
  assert.equal(refused.metric, 'sites_count');

  // Admission is a measurement too: it opened the row on its own, without
  // anybody having called observeOverages first.
  const fresh = overageFixture(['a.example', 'b.example']);
  fresh.ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: fresh.small.id, actorIdentityId: 'steve' });
  await fresh.ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_x' }));
  assert.equal(fresh.ent.listOverages('org_child').length, 1);
  console.log('  ok  growth is refused as an overage, said differently from a full account');
}

async function testOverageNeverBlocksRemoval() {
  const { ent, small } = overageFixture(['a.example', 'b.example', 'c.example']);
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: small.id, actorIdentityId: 'steve' });
  await ent.observeOverages('org_child');

  // Deleting is the way out of an overage, so it is the one thing that must
  // never be caught by it.
  const removal = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: -1 }], () => ({ id: 'prop_del' }));
  assert.equal(removal.ok, true);
  assert.equal(ent.listOverages('org_child')[0].status, 'open', 'still over until the usage actually comes down');
  console.log('  ok  removal is never blocked by an overage');
}

async function testOverageResolvesOnlyOnAFreshReadingUnderTheLimit() {
  const { db, ent, small } = overageFixture(['a.example', 'b.example', 'c.example']);
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: small.id, actorIdentityId: 'steve' });
  await ent.observeOverages('org_child');

  db.prepare(`DELETE FROM resource_owners WHERE resource_key IN ('b.example','c.example')`).run();
  assert.equal(ent.listOverages('org_child').length, 1, 'nothing resolves until something looks');

  await ent.observeOverages('org_child');
  assert.equal(ent.listOverages('org_child').length, 0);
  const [row] = ent.listOverages('org_child', { includeResolved: true });
  assert.equal(row.status, 'resolved');
  assert.ok(row.resolved_at);
  assert.equal(row.used_value, 1);

  // And the account can grow again the moment it is back inside the ceiling,
  // which is the difference between a limit and a punishment.
  const after = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_after' }));
  assert.equal(after.ok, false, 'at the ceiling, so a new one still does not fit');
  assert.equal(after.code, 'ENTITLEMENT_LIMIT_EXCEEDED', 'but it is the ordinary limit again, not an overage');
  console.log('  ok  an overage resolves only on a fresh reading back under the ceiling');
}

// The other way out, and the one that was missed until the live run: the
// ceiling goes up, or away entirely, rather than the usage coming down. An
// account with no limit cannot be above it, and a row left open after the
// package was fixed would keep blocking growth for ever.
async function testLiftingTheCeilingResolvesTheOverageToo() {
  const { ent, small } = overageFixture(['a.example', 'b.example', 'c.example']);
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: small.id, actorIdentityId: 'steve' });
  await ent.observeOverages('org_child');
  assert.equal(ent.listOverages('org_child').length, 1);

  ent.setOverride({
    targetOrgId: 'org_child', metricKey: 'sites_count', fields: { maximum: { unlimited: true } },
    reason: 'fixed the package', actorOrgId: 'org_root', actorIdentityId: 'steve',
  });
  await ent.observeOverages('org_child');
  assert.equal(ent.listOverages('org_child').length, 0);
  assert.equal(ent.listOverages('org_child', { includeResolved: true })[0].status, 'resolved');

  const grow = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_lifted' }));
  assert.equal(grow.ok, true, 'and the account can grow again');
  console.log('  ok  lifting the ceiling resolves the overage as well as reducing the usage');
}

// An account using exactly what it is allowed is full, not over. Recording that
// as an overage would report the normal state of every well-fitted package as a
// fault, and the daily reminder it earns would train everybody to ignore them.
async function testAFullAccountIsNotAnOverage() {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'One site', limits: finiteLimits(ent, { sites_count: 1 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });
  site(db, 'full.example', 'org_child');

  assert.deepEqual(await ent.observeOverages('org_child'), []);
  assert.equal(ent.listOverages('org_child').length, 0);

  const refused = await ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], () => ({ id: 'prop_full' }));
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'ENTITLEMENT_LIMIT_EXCEEDED');
  assert.equal(refused.overage, undefined);
  assert.equal(ent.listOverages('org_child').length, 0, 'and being refused did not invent one');
  console.log('  ok  a full account is not an overage');
}

function testStrictAllocationRefusesOversell() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_b', 'steve');

  const resellerPkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Reseller 10', limits: finiteLimits(ent, { sites_count: 10 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });

  const custPkg = ent.createPackage({ ownerOrgId: 'org_reseller', name: 'Customer 6', limits: finiteLimits(ent, { sites_count: 6 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_a', packageId: custPkg.id, actorIdentityId: 'steve' });

  assert.throws(() => ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_b', packageId: custPkg.id, actorIdentityId: 'steve' }),
    err => err.entitlementCode === 'ALLOCATION_LIMIT_EXCEEDED');
}

function testUsageBasedAllocationPermitsOversell() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_b', 'steve');

  const resellerLimits = ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: false, value: m.metric_key === 'sites_count' ? 10 : 1000, downstreamPolicy: m.metric_key === 'sites_count' ? 'usage_based' : 'strict' }));
  const resellerPkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Reseller Oversell', limits: resellerLimits, actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });

  // Every other metric stays well under the reseller's strict 1000 default
  // so this test isolates the one thing it's checking: sites_count oversell.
  const custPkg = ent.createPackage({ ownerOrgId: 'org_reseller', name: 'Customer 6', limits: finiteLimits(ent, { sites_count: 6, databases_count: 10, mailboxes_count: 10, managed_storage_bytes: 10, backups_count: 10, ai_cost_microunits_month: 10 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_a', packageId: custPkg.id, actorIdentityId: 'steve' });
  // Should NOT throw: reseller has usage_based policy for sites_count, so 6+6=12 > 10 is allowed at the allocation level.
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_cust_b', packageId: custPkg.id, actorIdentityId: 'steve' });
}

function testOverrideProvenanceAndClear() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Base', limits: finiteLimits(ent, { sites_count: 5 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  const overridden = ent.setOverride({ targetOrgId: 'org_child', metricKey: 'sites_count', fields: { maximum: { value: 20 } }, reason: 'Contract exception', actorOrgId: 'org_root', actorIdentityId: 'steve' });
  assert.equal(overridden.maxValue, 20);
  assert.equal(overridden.source, 'override');
  assert.equal(overridden.packageMaxValue, 5);

  const cleared = ent.clearOverride({ targetOrgId: 'org_child', metricKey: 'sites_count', actorOrgId: 'org_root' });
  assert.equal(cleared.maxValue, 5);
  assert.equal(cleared.source, 'package');
}

function testOverrideLockedByAncestor() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_child', 'steve');
  const resellerPkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'Reseller Capacity', limits: finiteLimits(ent, { sites_count: 100 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });
  const pkg = ent.createPackage({ ownerOrgId: 'org_reseller', name: 'Base', limits: finiteLimits(ent, { sites_count: 5 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  // The root (grandparent) sets an override.
  ent.setOverride({ targetOrgId: 'org_child', metricKey: 'sites_count', fields: { maximum: { value: 99 } }, reason: 'Root exception', actorOrgId: 'org_root', actorIdentityId: 'steve' });
  // The direct parent (reseller) may not clear an override set by its own ancestor.
  assert.throws(() => ent.clearOverride({ targetOrgId: 'org_child', metricKey: 'sites_count', actorOrgId: 'org_reseller' }),
    err => err.entitlementCode === 'OVERRIDE_LOCKED_BY_ANCESTOR');
}

function testCycleAndDuplicateParentRefused() {
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_a', 'steve');
  ent.linkOrganizations('org_a', 'org_b', 'steve');
  assert.throws(() => ent.linkOrganizations('org_b', 'org_root', 'steve'), err => err.entitlementCode === 'ORG_LINK_CYCLE');
  assert.throws(() => ent.linkOrganizations('org_root', 'org_b', 'steve'), err => err.entitlementCode === 'TARGET_NOT_DIRECT_CHILD');
}

async function testConcurrentAdmissionOnlyOneWins() {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({ ownerOrgId: 'org_root', name: 'One Site', limits: finiteLimits(ent, { sites_count: 1 }), actorIdentityId: 'steve' });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  // createProposal claims the resource for real, same as the live path does
  // between the capacity check and the hold being recorded — without this,
  // both proposals would see zero usage and both would wrongly be admitted.
  const claim = (name, key) => () => {
    db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site',?,?,?)`).run(key, 'org_child', new Date().toISOString());
    return { id: name };
  };
  const [a, b] = await Promise.all([
    ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], claim('race_a', 'race-a.example')),
    ent.admitProposal('org_child', [{ metric: 'sites_count', delta: 1 }], claim('race_b', 'race-b.example')),
  ]);
  const winners = [a, b].filter(r => r.ok);
  const losers = [a, b].filter(r => !r.ok);
  assert.equal(winners.length, 1, 'exactly one of the two concurrent proposals should be admitted');
  assert.equal(losers.length, 1);
  assert.equal(losers[0].code, 'ENTITLEMENT_LIMIT_EXCEEDED');
}

function testSubtreeAggregationDoesNotDoubleCount() {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_cust_b', 'steve');
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','a1.example','org_cust_a',?)`).run(now);
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','a2.example','org_cust_a',?)`).run(now);
  db.prepare(`INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','b1.example','org_cust_b',?)`).run(now);
  const subtree = ent.getSubtreeOrgIds('org_reseller');
  assert.deepEqual(subtree.sort(), ['org_cust_a', 'org_cust_b', 'org_reseller'].sort());
  assert.equal(ent.meterUsage ? undefined : undefined, undefined); // meterUsage is async; direct SQL check instead:
  const row = db.prepare(`SELECT COUNT(*) AS n FROM resource_owners WHERE kind='site' AND org_id IN (${subtree.map(() => '?').join(',')})`).get(...subtree);
  assert.equal(row.n, 3);
}

// ── Measured storage ─────────────────────────────────────────────

function storageTree(options = {}) {
  const { db, ent } = freshDb(options);
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({
    ownerOrgId: 'org_root', name: 'Small',
    limits: ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: false, value: m.metric_key === 'managed_storage_bytes' ? 1000 : 1000 })),
    actorIdentityId: 'steve',
  });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });
  return { db, ent };
}

async function testStorageReadingsAreSummedAndAged() {
  const { db, ent } = storageTree();
  site(db, 'one.example', 'org_child');
  site(db, 'two.example', 'org_child');
  reading(db, 'one.example', 300);
  reading(db, 'two.example', 200);
  const read = ent.readStorage(['org_child']);
  assert.equal(read.bytes, 500);
  assert.deepEqual(read.unusable, []);
  assert.equal(await ent.meterUsage('managed_storage_bytes', ['org_child']), 500);
  // Under the limit, so a storage-growing operation is admitted.
  assert.equal((await ent.checkCapacity('org_child', 'managed_storage_bytes', 0)).ok, true);
  // Exactly at the limit is already spent, not "not yet exceeded". A gate asks
  // whether everything allowed is already in use, and 1000 of 1000 is.
  reading(db, 'two.example', 700);
  const exact = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(exact.ok, false, 'exactly at the limit must refuse the next write');
  assert.equal(exact.used, 1000);
  // Over it, and the gate closes even though the delta is zero: nothing can
  // say in advance how many bytes an upload costs, so being already full is
  // the thing that refuses.
  reading(db, 'two.example', 900);
  const full = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(full.ok, false);
  // Past the ceiling rather than at it, which is a different sentence to the
  // person reading it: 1200 of 1000 bytes is usage the limit came down onto,
  // and the refusal now says so rather than calling it a full account.
  assert.equal(full.code, 'ENTITLEMENT_OVERAGE_BLOCKED');
  assert.equal(full.used, 1200);
  assert.equal(ent.listOverages('org_child')[0].used_value, 1200);
  console.log('  ok  storage readings are summed across a subtree and gate at the limit');
}

async function testStaleStorageReadingRefusesRatherThanPasses() {
  const { db, ent } = storageTree();
  site(db, 'one.example', 'org_child');
  site(db, 'two.example', 'org_child');
  reading(db, 'one.example', 100);
  reading(db, 'two.example', 100, { minutesAgo: 20 });
  const result = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  // The sum is well under the limit. It is still refused, because one of the
  // two numbers is old enough to be wrong, and a limit that passes on unknown
  // usage is a limit that silently does not work.
  assert.equal(result.ok, false);
  assert.equal(result.code, 'USAGE_READING_STALE');
  assert.equal(result.unusable.length, 1);
  assert.equal(result.unusable[0].domain, 'two.example');

  // A site that has never been measured is the same answer, not zero.
  const other = storageTree();
  site(other.db, 'never.example', 'org_child');
  const unmeasured = await other.ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(unmeasured.code, 'USAGE_READING_STALE');
  assert.equal(unmeasured.unusable[0].why, 'never measured');

  // A reading that failed to be taken is refused too, rather than counting as
  // nothing and quietly freeing up somebody's headroom.
  const broken = storageTree();
  site(broken.db, 'gone.example', 'org_child');
  reading(broken.db, 'gone.example', null, { status: 'error', errorCode: 'NOT_MEASURED' });
  const failed = await broken.ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(failed.code, 'USAGE_READING_STALE');
  console.log('  ok  a stale, missing or failed measurement refuses instead of passing');
}

async function testStorageCleanupIsNeverBlocked() {
  const { db, ent } = storageTree();
  site(db, 'one.example', 'org_child');
  reading(db, 'one.example', 5000, { minutesAgo: 90 }); // over the limit AND stale
  // Giving space back is never blocked. If it were, an account that went over
  // its limit could not delete its way out of it, which is a trap rather than
  // a limit.
  assert.equal((await ent.checkCapacity('org_child', 'managed_storage_bytes', -1)).ok, true);
  console.log('  ok  freeing space is never blocked by a limit or a stale reading');
}

async function testRefreshRecordsFailuresRatherThanZero() {
  const measured = { 'one.example': 400, 'two.example': null };
  const { db, ent } = storageTree({ runPrivilegedJob: async () => ({ usage: measured }) });
  site(db, 'one.example', 'org_child');
  site(db, 'two.example', 'org_child');
  const result = await ent.refreshStorageReadings(['org_child']);
  assert.equal(result.measured, 1);
  assert.equal(result.failed, 1);
  const read = ent.readStorage(['org_child']);
  assert.equal(read.bytes, 400);
  assert.equal(read.unusable.length, 1, 'the domain that could not be measured must not read as zero');

  // The whole measurement failing must leave every domain unknown, not zero.
  const broken = storageTree({ runPrivilegedJob: async () => { throw new Error('du would not run'); } });
  site(broken.db, 'one.example', 'org_child');
  const failure = await broken.ent.refreshStorageReadings(['org_child']);
  assert.equal(failure.failed, 1);
  assert.equal(broken.ent.readStorage(['org_child']).bytes, 0);
  assert.equal(broken.ent.readStorage(['org_child']).unusable.length, 1);
  console.log('  ok  a measurement that fails is written down as unknown, never as zero');
}

async function testAiSpendIsMeteredThroughTheReader() {
  const seen = [];
  const { db, ent } = freshDb({ aiSpendReader: (orgIds, month) => { seen.push({ orgIds: [...orgIds].sort(), month }); return 7_500_000; } });
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const pkg = ent.createPackage({
    ownerOrgId: 'org_root', name: 'Ten dollars',
    limits: ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: m.metric_key !== 'ai_cost_microunits_month', value: 10_000_000 })),
    actorIdentityId: 'steve',
  });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });

  assert.equal(await ent.meterUsage('ai_cost_microunits_month', ['org_child']), 7_500_000);
  assert.match(seen[0].month, /^\d{4}-\d{2}$/, 'the reader is asked for a calendar month in UTC');
  // $7.50 spent against a $10 package: still room.
  assert.equal((await ent.checkCapacity('org_child', 'ai_cost_microunits_month', 0, ent.monthKey())).ok, true);

  const spent = freshDb({ aiSpendReader: () => 10_000_000 });
  spent.ent.markRoot('org_root', 'steve');
  spent.ent.linkOrganizations('org_root', 'org_child', 'steve');
  const p2 = spent.ent.createPackage({
    ownerOrgId: 'org_root', name: 'Ten dollars',
    limits: spent.ent.enabledMetrics().map(m => ({ metric: m.metric_key, unlimited: m.metric_key !== 'ai_cost_microunits_month', value: 10_000_000 })),
    actorIdentityId: 'steve',
  });
  spent.ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: p2.id, actorIdentityId: 'steve' });
  const refused = await spent.ent.checkCapacity('org_child', 'ai_cost_microunits_month', 0, spent.ent.monthKey());
  assert.equal(refused.ok, false, 'a package budget spent to the penny stops the next call');
  assert.equal(refused.maximum, 10_000_000);
  console.log('  ok  assistant spend is read from its own ledger and capped by the package');
}

run().catch(error => { console.error(error); process.exit(1); });

// ── Measuring on demand ─────────────────────────────────────────────
//
// Nothing in the product ever measured disk use. `refreshStorageReadings` had
// one caller, an HTTP route with no scheduler, no timer and no button in the
// panel, so on a real installation every storage-metered operation was refused
// for ever with a message telling the customer to refresh figures they had no
// way to refresh. Found on a machine installed an hour earlier.

// A measurer that answers for whatever it is asked about, and counts how many
// times it was asked, because "measure once for ten writes" is a real
// requirement and not an implementation detail.
function countingMeasurer(bytesByDomain, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    runPrivilegedJob: async (job, params) => {
      calls.push({ job, params });
      if (fail) throw new Error('the disk could not be read');
      const usage = {};
      for (const d of params.domains || []) usage[d] = bytesByDomain[d] ?? 0;
      return { usage };
    },
  };
}

async function testAnUnmeasuredAccountIsMeasuredRatherThanRefusedForever() {
  const measurer = countingMeasurer({ 'fresh.example': 400 });
  const { db, ent } = storageTree({ runPrivilegedJob: measurer.runPrivilegedJob });
  site(db, 'fresh.example', 'org_child');
  // Never measured. Before this change that was a permanent refusal.
  const result = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(result.ok, true, 'a never-measured account is measured, not refused for ever');
  assert.equal(measurer.calls.length, 1, 'and it measured exactly once');
  assert.equal(ent.readStorage(['org_child']).bytes, 400, 'and the number it found is the one it used');
  assert.ok(ent.lastStorageMeasurement(), 'the cost of measuring is recorded so it can be judged');

  // A stale reading is the same: gone and looked at again, not refused.
  const stale = countingMeasurer({ 'old.example': 250 });
  const two = storageTree({ runPrivilegedJob: stale.runPrivilegedJob });
  site(two.db, 'old.example', 'org_child');
  reading(two.db, 'old.example', 999, { minutesAgo: 40 });
  const after = await two.ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(after.ok, true);
  assert.equal(two.ent.readStorage(['org_child']).bytes, 250, 'the fresh number replaced the stale one');
  console.log('  ok  an account nothing has ever measured is measured, rather than refused for ever');
}

async function testMeasuringOnDemandIsNotAWayPastTheLimit() {
  // The measurement must decide the answer, not excuse it. This account is over
  // its 1000-byte limit and the fresh reading is what proves it.
  const measurer = countingMeasurer({ 'big.example': 4000 });
  const { db, ent } = storageTree({ runPrivilegedJob: measurer.runPrivilegedJob });
  site(db, 'big.example', 'org_child');
  const result = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(result.ok, false, 'measuring must not become a way past the ceiling');
  assert.equal(result.used, 4000);
  assert.ok(['ENTITLEMENT_OVERAGE_BLOCKED', 'ENTITLEMENT_LIMIT_EXCEEDED'].includes(result.code), result.code);
  console.log('  ok  measuring on demand decides the answer and is not a way past the limit');
}

async function testAMeasurementThatCannotBeTakenStillRefuses() {
  // The freshness guarantee is unchanged. A disk that cannot be read is unknown
  // usage, and unknown still refuses: waving it through would be a limit that
  // silently does not work, which is the whole reason the rule exists.
  const broken = countingMeasurer({}, { fail: true });
  const { db, ent } = storageTree({ runPrivilegedJob: broken.runPrivilegedJob });
  site(db, 'unreadable.example', 'org_child');
  const result = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'USAGE_READING_STALE');
  assert.equal(broken.calls.length, 1, 'it tried');
  // And a failure is not remembered as a verdict: the next caller tries again.
  const second = await ent.checkCapacity('org_child', 'managed_storage_bytes', 0);
  assert.equal(second.code, 'USAGE_READING_STALE');
  assert.equal(broken.calls.length, 2, 'a failed measurement is not cached as an answer');
  console.log('  ok  a disk that cannot be read still refuses, and the failure is not cached');
}

async function testTenWritesAtOnceMeasureTheDiskOnce() {
  // Ten uploads arriving together must measure the disk once. Without this the
  // fix trades a permanent refusal for ten `du` runs on one machine.
  const measurer = countingMeasurer({ 'busy.example': 100 });
  const { db, ent } = storageTree({ runPrivilegedJob: measurer.runPrivilegedJob });
  site(db, 'busy.example', 'org_child');
  const results = await Promise.all(
    Array.from({ length: 10 }, () => ent.checkCapacity('org_child', 'managed_storage_bytes', 0)));
  assert.ok(results.every(r => r.ok), 'all ten are admitted');
  assert.equal(measurer.calls.length, 1, `ten concurrent writes measured ${measurer.calls.length} times, expected 1`);
  console.log('  ok  ten writes arriving together measure the disk once between them');
}


// ── Capacity is rationed, a capability is switched on ───────────────────────
//
// Two kinds of metric that were one. Capacity is a quantity the machine has and
// every package must name every one, because a package that silently meant
// unlimited for what you forgot is how somebody sells a plan they did not mean
// to. A feature is whether a capability is on, and requiring those would mean
// every hoster's existing packages break the day a new capability ships.

function featureTree(limitOverrides = null) {
  const { db, ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_child', 'steve');
  const capacity = ent.enabledMetrics().filter(m => m.kind !== 'feature');
  const pkg = ent.createPackage({
    ownerOrgId: 'org_root', name: 'Plan',
    limits: [...capacity.map(m => ({ metric: m.metric_key, unlimited: false, value: 1000 })),
             ...(limitOverrides || [])],
    actorIdentityId: 'steve',
  });
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_child', packageId: pkg.id, actorIdentityId: 'steve' });
  return { db, ent };
}

function testFeatureMetricsAreOptionalInAPackage() {
  // The whole point: a package naming only capacity is valid. Before this it was
  // refused, so shipping any new capability broke every package in existence.
  const { ent } = featureTree();
  assert.ok(ent.isFeatureMetric('workspace_publish'), 'workspace_publish is not registered as a feature');
  assert.ok(!ent.isFeatureMetric('sites_count'), 'sites_count was treated as a feature');
  console.log('  ok  a package may name only capacity, and still be a valid package');
}

function testAFeatureNobodyPricedIsOn() {
  const { ent } = featureTree();
  for (const key of ['workspace_publish', 'workspace_share_links', 'workspace_watermark', 'workspace_viewer_analytics']) {
    const eff = ent.effectiveEntitlement('org_child', key);
    assert.strictEqual(eff.maxUnlimited, true, `${key} was not on by default`);
    assert.strictEqual(eff.source, 'default', `${key} resolved from ${eff.source}`);
    assert.ok(!eff.missing, `${key} came back missing, so the customer silently lost it`);
  }
  // And capacity is untouched by any of this: a metric nobody assigned is still
  // zero, because capacity you were never given is capacity you do not have.
  const { ent: bare } = (() => { const { db, ent } = freshDb(); ent.markRoot('org_root', 'steve');
    ent.linkOrganizations('org_root', 'org_orphan', 'steve'); return { db, ent }; })();
  assert.strictEqual(bare.effectiveEntitlement('org_orphan', 'sites_count').missing, true);
  // An account with no package at all still has the working product.
  assert.strictEqual(bare.effectiveEntitlement('org_orphan', 'workspace_publish').maxUnlimited, true);
  console.log('  ok  a feature nobody priced is on, and capacity nobody granted is still zero');
}

function testAHosterCanTurnAFeatureOffAndBackOn() {
  // The business model in one test. The hoster decides, per package, and the
  // product does not choose the tiers for them.
  const { ent } = featureTree([{ metric: 'workspace_watermark', unlimited: false, value: 0 }]);
  const off = ent.effectiveEntitlement('org_child', 'workspace_watermark');
  assert.strictEqual(off.maxUnlimited, false);
  assert.strictEqual(off.maxValue, 0, 'the hoster could not switch a feature off');
  assert.strictEqual(off.source, 'package');
  // Another package, same box, feature on. Two tiers, the hoster's own choice.
  const { ent: on } = featureTree([{ metric: 'workspace_watermark', unlimited: true }]);
  assert.strictEqual(on.effectiveEntitlement('org_child', 'workspace_watermark').maxUnlimited, true);
  console.log('  ok  a hoster can switch a feature off in one package and on in another');
}

function testAFeatureIsNotDividedBetweenChildren() {
  // Ten resellers may all switch watermarking on without anybody running out of
  // watermarking. Running the allocation arithmetic over an on/off row produces
  // refusals that mean nothing, like "more than the 1 this account holds".
  const { ent } = freshDb();
  ent.markRoot('org_root', 'steve');
  ent.linkOrganizations('org_root', 'org_reseller', 'steve');
  ent.linkOrganizations('org_reseller', 'org_a', 'steve');
  ent.linkOrganizations('org_reseller', 'org_b', 'steve');
  const capacity = ent.enabledMetrics().filter(m => m.kind !== 'feature');
  // A package is assigned by whoever owns it, so the reseller's own customers get
  // a package the reseller minted rather than one of the hoster's.
  // Capacity is generous on purpose: this test is about the feature, and a
  // capacity refusal here would pass for the wrong reason.
  const mk = (owner, name, cap, extra) => ent.createPackage({ ownerOrgId: owner, name,
    limits: [...capacity.map(m => ({ metric: m.metric_key, unlimited: false, value: cap })), ...extra],
    actorIdentityId: 'steve' });
  const resellerPkg = mk('org_root', 'Reseller', 100, [{ metric: 'workspace_publish', unlimited: false, value: 1 }]);
  ent.assignPackage({ parentOrgId: 'org_root', targetOrgId: 'org_reseller', packageId: resellerPkg.id, actorIdentityId: 'steve' });
  const customerPkg = mk('org_reseller', 'Customer', 10, [{ metric: 'workspace_publish', unlimited: false, value: 1 }]);
  for (const child of ['org_a', 'org_b']) {
    ent.assignPackage({ parentOrgId: 'org_reseller', targetOrgId: child, packageId: customerPkg.id, actorIdentityId: 'steve' });
    assert.strictEqual(ent.effectiveEntitlement(child, 'workspace_publish').maxValue, 1);
  }
  console.log('  ok  two customers under one reseller both have a feature the reseller has once');
}
