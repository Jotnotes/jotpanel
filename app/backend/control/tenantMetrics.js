'use strict';

// What the hoster admin view's per-account figures are actually made of.
//
// `/admin/tenants` used to count rows in `sites` and sum `files.size` — both
// tables belong to the older desktop-OS deploy-workspace product and are
// never written to by the current server-ops panel, so every account showed
// zero sites and zero storage no matter what they had actually built. The
// only place that records who owns what today is `resource_owners`, built
// for the authorization chokepoint, so this reads from there and nowhere
// else. One source of truth: this file, not a second table kept in sync
// with it.
//
// `resource_owners` is keyed by organization, not by identity, and an
// identity's organization comes from `memberships` (see control/ownership.js
// — one identity, one membership, one organization, today). A user with no
// membership row yet (nobody has proposed anything on their behalf) simply
// owns nothing, which is the correct answer, not an error.

// Shared shape behind siteOwnershipByIdentity and databaseOwnershipByIdentity:
// every identity's org, then every resource of one `kind` that org owns.
// Not exported — the two functions below are the real API, kept separate so
// a caller never has to know or care that they share a code path.
function ownershipByIdentity({ db, kind }) {
  if (!db) throw new Error('ownershipByIdentity requires a database');
  const orgByIdentity = new Map(
    db.prepare('SELECT identity_id, org_id FROM memberships').all()
      .map(row => [row.identity_id, row.org_id]));

  const keysByOrg = new Map();
  for (const row of db.prepare('SELECT org_id, resource_key FROM resource_owners WHERE kind=?').all(kind)) {
    if (!keysByOrg.has(row.org_id)) keysByOrg.set(row.org_id, []);
    keysByOrg.get(row.org_id).push(row.resource_key);
  }

  const keysByIdentity = new Map();
  for (const [identityId, orgId] of orgByIdentity) {
    keysByIdentity.set(identityId, keysByOrg.get(orgId) || []);
  }
  return { orgByIdentity, keysByIdentity };
}

// Which sites each account's organization owns, straight from the
// authorization ledger. Returns { orgByIdentity: Map<identityId, orgId>,
// domainsByIdentity: Map<identityId, string[]> }.
function siteOwnershipByIdentity({ db }) {
  const { orgByIdentity, keysByIdentity } = ownershipByIdentity({ db, kind: 'site' });
  return { orgByIdentity, domainsByIdentity: keysByIdentity };
}

// Which databases each account's organization owns. Unlike mail (below),
// database ownership in resource_owners is keyed by the database's own name,
// one row per database, so — like sites — no live read is needed to count
// them. Returns { databasesByIdentity: Map<identityId, string[]> }.
function databaseOwnershipByIdentity({ db }) {
  const { keysByIdentity } = ownershipByIdentity({ db, kind: 'database' });
  return { databasesByIdentity: keysByIdentity };
}

// Real bytes on disk for a set of domains, via the privileged `site.storage`
// job — the same socket-gated, root-side path every other write and read in
// this product goes through, never a direct `execSync` from the web process.
// `runPrivilegedJob` is injected so this stays testable without a real box:
// `(name, params) => Promise<result>`, the same shape `privilegedOps.run`
// already has in server.js.
async function siteStorageBytes({ domains, runPrivilegedJob }) {
  if (!domains.length) return new Map();
  const result = await runPrivilegedJob('site.storage', { domains });
  return new Map(Object.entries(result.usage || {}));
}

// Mailbox count per domain. Unlike sites and databases, mail ownership in
// resource_owners is scoped by domain — one row per domain no matter how
// many mailboxes it holds — so the count itself has to come from the real
// mail state, not the ledger. `mail.list` already answers for the whole box
// in one call (it backs the Mail app's own domain list), so this reads it
// once and groups locally rather than asking once per domain.
async function mailboxCountsByDomain({ runPrivilegedJob }) {
  const result = await runPrivilegedJob('mail.list', {});
  const counts = new Map();
  for (const entry of result.mailboxes || []) {
    counts.set(entry.domain, (counts.get(entry.domain) || 0) + 1);
  }
  return counts;
}

// Backup count per domain, same shape as mailboxCountsByDomain and for the
// same reason: backups live on disk keyed by domain, not in resource_owners,
// and `backup.list` called with no domain already answers for every domain
// on the box in one pass.
async function backupCountsByDomain({ runPrivilegedJob }) {
  const result = await runPrivilegedJob('backup.list', {});
  const counts = new Map();
  for (const entry of result.backups || []) {
    counts.set(entry.domain, (counts.get(entry.domain) || 0) + 1);
  }
  return counts;
}

module.exports = {
  siteOwnershipByIdentity, siteStorageBytes,
  databaseOwnershipByIdentity, mailboxCountsByDomain, backupCountsByDomain,
};
