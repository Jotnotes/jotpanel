'use strict';

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createOwnershipService } = require('./ownership');
const { siteOwnershipByIdentity, siteStorageBytes, databaseOwnershipByIdentity, mailboxCountsByDomain, backupCountsByDomain } = require('./tenantMetrics');

async function run() {
  testSitesComeFromResourceOwnersNeverTheDeadSitesTable();
  testAnIdentityWithNoMembershipOwnsNothing();
  await testStorageComesFromThePrivilegedJobNeverTheDeadFilesTable();
  await testOneDomainsStorageFailureDoesNotBlankTheOthers();
  testDatabasesComeFromResourceOwnersOneRowPerDatabase();
  await testMailboxCountsAreGroupedFromTheRealMailState();
  await testBackupCountsAreGroupedFromEveryDomainInOneCall();
  console.log('tenant-metrics tests passed');
}

// The bug this whole file exists to make impossible again: the hoster admin
// view once counted rows in `sites` and summed `files.size`, both belonging
// to the older desktop-OS product, never written to by the current
// server-ops panel. Every account showed zero regardless of what it had
// actually built. This test seeds the OLD tables with numbers that would
// pass the assertions below if they leaked back in as the source, and seeds
// the REAL ownership ledger with the true, different numbers — so a
// regression that starts reading `sites` again fails loudly here rather
// than quietly showing zeros on a live hoster's screen.
function testSitesComeFromResourceOwnersNeverTheDeadSitesTable() {
  const db = new Database(':memory:');
  const ownership = createOwnershipService({ db });
  db.exec(`
    CREATE TABLE sites (id TEXT PRIMARY KEY, user_id TEXT, domain TEXT);
    INSERT INTO sites (id, user_id, domain) VALUES ('decoy1','alice','decoy-should-not-appear.example');
    INSERT INTO sites (id, user_id, domain) VALUES ('decoy2','alice','also-should-not-appear.example');
  `);

  const alice = ownership.ensureMembership('alice'); // first identity: hosting_company, but that's irrelevant here
  ownership.claim('site', 'real-site-one.example', alice.orgId, 'alice');
  ownership.claim('site', 'real-site-two.example', alice.orgId, 'alice');

  const { domainsByIdentity } = siteOwnershipByIdentity({ db });
  const aliceSites = (domainsByIdentity.get('alice') || []).sort();
  assert.deepEqual(aliceSites, ['real-site-one.example', 'real-site-two.example'],
    'sites must come from resource_owners, and the two rows planted in the dead `sites` table must never appear');
}

function testAnIdentityWithNoMembershipOwnsNothing() {
  const db = new Database(':memory:');
  createOwnershipService({ db }); // schema only, nobody has proposed anything yet
  const { domainsByIdentity, orgByIdentity } = siteOwnershipByIdentity({ db });
  assert.equal(orgByIdentity.has('nobody-yet'), false);
  assert.deepEqual(domainsByIdentity.get('nobody-yet') || [], []);
}

async function testStorageComesFromThePrivilegedJobNeverTheDeadFilesTable() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE files (id TEXT PRIMARY KEY, user_id TEXT, size INTEGER);
    INSERT INTO files (id, user_id, size) VALUES ('decoy', 'alice', 999999999);
  `);
  const calls = [];
  const runPrivilegedJob = async (job, params) => {
    calls.push({ job, params });
    return { usage: { 'real-site-one.example': 4096, 'real-site-two.example': 8192 } };
  };
  const bytes = await siteStorageBytes({ domains: ['real-site-one.example', 'real-site-two.example'], runPrivilegedJob });
  assert.deepEqual(calls, [{ job: 'site.storage', params: { domains: ['real-site-one.example', 'real-site-two.example'] } }]);
  assert.equal(bytes.get('real-site-one.example'), 4096);
  assert.equal(bytes.get('real-site-two.example'), 8192);
  // The decoy row's 999999999 bytes must not leak into a real answer through
  // any path — the function never touches `files` at all, and this asserts
  // the real total is nowhere close to it.
  assert.ok([...bytes.values()].reduce((a, b) => a + b, 0) < 999999999);
}

// A folder gone missing (deleted outside the panel, or a delete mid-flight)
// must not blank out every other domain's real figure — the privileged job
// reports that one domain as unmeasured (null) and the rest stay real.
async function testOneDomainsStorageFailureDoesNotBlankTheOthers() {
  const runPrivilegedJob = async () => ({ usage: { 'ok.example': 2048, 'gone.example': null } });
  const bytes = await siteStorageBytes({ domains: ['ok.example', 'gone.example'], runPrivilegedJob });
  assert.equal(bytes.get('ok.example'), 2048);
  assert.equal(bytes.get('gone.example'), null);
}

// Databases have never had a dead table to leak from — this is the metric
// the hoster admin view is missing entirely today, not a regression guard —
// but it should follow the exact shape sites already proved: one row per
// database in resource_owners, owned by org, mapped to identity.
function testDatabasesComeFromResourceOwnersOneRowPerDatabase() {
  const db = new Database(':memory:');
  const ownership = createOwnershipService({ db });
  const alice = ownership.ensureMembership('alice');
  ownership.claim('database', 'arca_shop', alice.orgId, 'alice');
  ownership.claim('database', 'arca_blog', alice.orgId, 'alice');

  const { databasesByIdentity } = databaseOwnershipByIdentity({ db });
  assert.deepEqual((databasesByIdentity.get('alice') || []).sort(), ['arca_blog', 'arca_shop']);
  assert.deepEqual(databasesByIdentity.get('nobody-yet') || [], []);
}

// Mail ownership in resource_owners is one row per domain, not one per
// mailbox, so the count has to come from the real mail.list state and be
// grouped locally — this proves the grouping, and that two domains' counts
// don't bleed into each other.
async function testMailboxCountsAreGroupedFromTheRealMailState() {
  const calls = [];
  const runPrivilegedJob = async (job, params) => {
    calls.push({ job, params });
    return { mailboxes: [
      { domain: 'shop.example', account: 'bob' },
      { domain: 'shop.example', account: 'alice' },
      { domain: 'blog.example', account: 'carol' },
    ] };
  };
  const counts = await mailboxCountsByDomain({ runPrivilegedJob });
  assert.deepEqual(calls, [{ job: 'mail.list', params: {} }]);
  assert.equal(counts.get('shop.example'), 2);
  assert.equal(counts.get('blog.example'), 1);
  assert.equal(counts.get('nowhere.example'), undefined);
}

// backup.list with no domain already answers for the whole box in one call
// (proved directly by reading its implementation), so this must call it
// exactly once regardless of how many domains an account owns, not once per
// domain.
async function testBackupCountsAreGroupedFromEveryDomainInOneCall() {
  const calls = [];
  const runPrivilegedJob = async (job, params) => {
    calls.push({ job, params });
    return { backups: [
      { domain: 'shop.example', id: '2026-08-20' },
      { domain: 'shop.example', id: '2026-08-21' },
      { domain: 'blog.example', id: '2026-08-21' },
    ] };
  };
  const counts = await backupCountsByDomain({ runPrivilegedJob });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { job: 'backup.list', params: {} });
  assert.equal(counts.get('shop.example'), 2);
  assert.equal(counts.get('blog.example'), 1);
}

run().catch(error => { console.error(error); process.exit(1); });
