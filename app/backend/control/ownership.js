'use strict';

const crypto = require('crypto');

// Identity → Organization → Role → Capability → Resource Scope → Operation.
//
// This is the ownership half of the single chokepoint. `serverOps.propose`
// asks it two questions: which organization and role does this identity
// carry, and who — if anyone — already owns the resource this operation
// names. Everything about "may this actor do this" is answered from those
// two facts plus the operation's own `scope` declaration in the catalogue.
// Nothing here executes a machine change; it only says yes, no, or unclaimed.
//
// Four role names exist in the product (vendor, hosting_company, reseller,
// end_user — see docs/GA_PRODUCT_DEFINITION.md). This file assigns two of them
// on its own: `hosting_company` for the box's own operator, decided at startup
// in creation order, and `end_user` for everyone else. `reseller` is granted
// deliberately, by the box operator, through `setRole` below and the
// `account.role.set` operation that calls it; it is never inferred and never
// self-assigned. `vendor` is never a local login on a customer's box and
// cannot be granted here at all.
const HIERARCHY = Object.freeze({ vendor: 4, hosting_company: 3, reseller: 2, end_user: 1 });
const TOP_TWO = HIERARCHY.hosting_company; // vendor and hosting_company both outrank this

// `administersOrg(actorOrgId, targetOrgId)` is handed in rather than worked out
// here, because the answer lives in the entitlements hierarchy and this file
// deliberately knows nothing about packages. Without one, organization-scoped
// operations are reserved to the box operator, which fails closed.
function createOwnershipService({ db, now = () => new Date(), administersOrg = null } = {}) {
  if (!db) throw new Error('the ownership service requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memberships (
      identity_id TEXT PRIMARY KEY,
      org_id      TEXT NOT NULL,
      role        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS resource_owners (
      kind         TEXT NOT NULL,
      resource_key TEXT NOT NULL,
      org_id       TEXT NOT NULL,
      created_by   TEXT,
      created_at   TEXT NOT NULL,
      PRIMARY KEY (kind, resource_key)
    );
  `);

  // A box that already had users before this file existed backfills once, in
  // the order the accounts were actually created: the earliest account on the
  // box becomes its operator, and everyone who signed up after it — including
  // any self-registered probe account, which is exactly the hole this closes
  // — lands in a fresh organization of their own at the bottom rank. A fresh
  // install has no rows to backfill, so its first real identity gets the same
  // top rank the moment it first proposes anything, through the same rule
  // below: the first membership ever written on this box outranks every one
  // after it.
  if (tableExists('users')) {
    const unmembered = db.prepare(`
      SELECT id FROM users
      WHERE id NOT IN (SELECT identity_id FROM memberships)
      ORDER BY created_at ASC, id ASC
    `).all();
    for (const { id } of unmembered) ensureMembership(id);
  }

  function tableExists(name) {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }

  function newOrg(name) {
    const id = `org_${crypto.randomBytes(8).toString('hex')}`;
    db.prepare('INSERT INTO organizations (id,name,created_at) VALUES (?,?,?)').run(id, name, now().toISOString());
    return id;
  }

  function getMembership(identityId) {
    const row = db.prepare('SELECT identity_id, org_id, role FROM memberships WHERE identity_id=?').get(identityId);
    if (!row) return null;
    return { identityId: row.identity_id, orgId: row.org_id, role: row.role, rank: HIERARCHY[row.role] || 0 };
  }

  // Idempotent: an identity that already has a membership keeps it untouched.
  // The very first membership this box ever writes is the operator; every one
  // after it is a new, separate organization at the lowest rank, because
  // nothing has told this file otherwise yet. Promoting an identity to
  // `reseller` is a deliberate future write to this table, not a decision
  // made here.
  function ensureMembership(identityId) {
    const existing = getMembership(identityId);
    if (existing) return existing;
    const isFirstEver = db.prepare('SELECT COUNT(*) AS n FROM memberships').get().n === 0;
    const role = isFirstEver ? 'hosting_company' : 'end_user';
    const orgId = newOrg(isFirstEver ? 'This server' : `Account ${identityId}`);
    db.prepare('INSERT INTO memberships (identity_id,org_id,role,created_at) VALUES (?,?,?,?)')
      .run(identityId, orgId, role, now().toISOString());
    return getMembership(identityId);
  }

  // For an identity that already exists on a box that already has an operator.
  //
  // The backfill above runs once, at startup, in creation order, and that is
  // what decides which identity is the operator. Anybody who registers after
  // that had no organization at all until the next restart: nothing they made
  // could be claimed to them, their entitlements could not be evaluated, and a
  // reseller could not take them on as a customer, because there was nothing to
  // take on. A sign-up was invisible to the whole ownership system until
  // somebody happened to restart the panel.
  //
  // This closes that, and deliberately refuses to close more. It never writes
  // the first membership on a box: who the operator is stays a question
  // answered at startup in creation order, and never by whoever happens to sign
  // in first.
  function ensureMembershipForExisting(identityId) {
    if (!identityId) return null;
    const existing = getMembership(identityId);
    if (existing) return existing;
    if (db.prepare('SELECT COUNT(*) AS n FROM memberships').get().n === 0) return null;
    return ensureMembership(identityId);
  }

  function resolveOwner(kind, key) {
    const row = db.prepare('SELECT org_id, created_by FROM resource_owners WHERE kind=? AND resource_key=?').get(kind, key);
    return row ? { orgId: row.org_id, createdBy: row.created_by } : null;
  }

  // Who has a claim on this resource, which is not always a row of its own
  // kind. Four of the kinds are keyed by a domain name, and a domain is one
  // thing however many ways it is used: an account that owns the site owns the
  // mail on it, the backups of it and its zone, whether or not it has got
  // round to creating any of them. Without this, a domain claimed as a site by
  // one account left `mailbox`, `backup` and `zone` unclaimed for anybody else
  // to take, and left the owner's own backup list looking empty until the
  // first backup wrote a row.
  const DOMAIN_KINDS = new Set(['site', 'mailbox', 'backup', 'zone']);

  function claimant(kind, key) {
    const direct = resolveOwner(kind, key);
    if (direct) return direct;
    return DOMAIN_KINDS.has(kind) ? resolveOwner('site', key) : null;
  }

  // Does this organization own the thing, rather than merely not be barred
  // from it. The list readings narrow with this: unclaimed is excluded here,
  // where on the way in it is allowed, because a customer's own list is what
  // they own and a resource nobody has claimed is not on it.
  function orgOwns(orgId, kind, key) {
    const owner = claimant(kind, String(key == null ? '' : key));
    return !!owner && owner.orgId === orgId;
  }

  // ── Reach ────────────────────────────────────────────────────────
  //
  // How far an actor's authority extends, and the one place that answers it.
  //
  // The sentence was already written correctly in `actingFor` below: your own
  // organization always, anything beneath you if you provide for it, anything
  // on the box if you run the box. It was only ever applied there, so a hoster
  // could migrate an account in on a customer's behalf but a reseller could not
  // touch the customer afterwards: `authorize` and `authorizeRead` compared
  // organization ids for equality and refused everything else. That made the
  // reseller role unusable rather than merely unbuilt, because a provider who
  // cannot act for the accounts beneath them provides nothing.
  //
  // Everything reaches through here now, so there is one answer rather than
  // three, and `administersOrg` is asked of the entitlements hierarchy rather
  // than of anything a caller said about itself.
  function withinReach(membership, targetOrgId) {
    if (!membership || !targetOrgId) return false;
    if (membership.orgId === targetOrgId) return true;
    if (membership.rank >= TOP_TWO) return true;
    // A provider reaches the accounts beneath it, and only while it is one:
    // `administersOrg` reads the live subtree, so ending a link ends the reach
    // in the same breath rather than at the next restart.
    return !!(administersOrg && administersOrg(membership.orgId, targetOrgId));
  }

  // The same question about a resource rather than an organization, which is
  // what the list readings narrow with. Unclaimed stays excluded, exactly as
  // before: reaching an account does not conjure ownership of things nobody
  // has claimed.
  function reaches(membership, kind, key) {
    const owner = claimant(kind, String(key == null ? '' : key));
    return !!owner && withinReach(membership, owner.orgId);
  }

  // Promotion between the two grantable roles, and nothing else.
  //
  // `hosting_company` is deliberately not grantable. Who runs the box is
  // decided at startup in creation order, and a product where the operator can
  // be handed out is a product where the operator can be taken over. `vendor`
  // is not a local login at all. So this writes `reseller` or `end_user`, and
  // refuses everything else rather than trusting its caller to have checked.
  const GRANTABLE_ROLES = new Set(['reseller', 'end_user']);
  function setRole(identityId, role) {
    if (!GRANTABLE_ROLES.has(role)) {
      return refuse(`${role} is not a role that can be granted. Only reseller and end_user can.`);
    }
    const membership = getMembership(identityId);
    if (!membership) return refuse('That account has no organization, so it has no role to change');
    if (membership.rank >= TOP_TWO) {
      return refuse('That is the account that runs this box, and its role is not something to change');
    }
    db.prepare('UPDATE memberships SET role=? WHERE identity_id=?').run(role, identityId);
    return getMembership(identityId);
  }

  // First write wins, and only the first: a resource already claimed is never
  // reassigned by this call, so a create-then-recreate never launders
  // ownership from one organization to another.
  function claim(kind, key, orgId, createdBy) {
    if (resolveOwner(kind, key)) return;
    db.prepare('INSERT INTO resource_owners (kind,resource_key,org_id,created_by,created_at) VALUES (?,?,?,?,?)')
      .run(kind, key, orgId, createdBy || null, now().toISOString());
  }

  function release(kind, key) {
    db.prepare('DELETE FROM resource_owners WHERE kind=? AND resource_key=?').run(kind, key);
  }

  // The single yes/no the chokepoint asks. `operation.scope` comes straight
  // off the catalogue row; `params` is already normalized. Throws with a
  // plain sentence on refusal, and marks the error `forbidden` so the HTTP
  // layer answers 403 rather than 400.
  function authorize(identityId, operation, params) {
    const membership = ensureMembership(identityId);
    const scope = operation.scope;
    if (!scope) return refuse(`${operation.id} has no resource scope declared, so it refuses rather than guesses`);

    if (scope.kind === 'server') {
      if (membership.rank < TOP_TWO) {
        return refuse(`${operation.label(params)} acts on the whole machine, which is reserved to the account that runs this box`);
      }
      return membership;
    }

    // An organization is not a thing on the machine, so there is no
    // `resource_owners` row to consult. What decides it is the hierarchy: a
    // provider may administer the accounts beneath it and nothing else. The
    // target's own account is excluded on purpose — an account raising its own
    // ceiling is not an override, it is the absence of one.
    // An operation on the caller's own organization rather than on anybody
    // else's: making a package to sell, and nothing that names a target. It is
    // reserved to a provider because an account with no customers has nobody to
    // sell to, and drawing the screen for them would be a button that does
    // nothing.
    if (scope.kind === 'own') {
      if (membership.rank >= HIERARCHY.reseller) return membership;
      return refuse(`${operation.label(params)} is something a provider does, and this account is not one`);
    }

    if (scope.kind === 'organization') {
      const targetOrgId = params[scope.param];
      if (targetOrgId === membership.orgId) {
        return refuse(scope.selfRefusal || 'An account cannot change its own limits');
      }
      if (withinReach(membership, targetOrgId)) return membership;
      return refuse(`${targetOrgId} is not an account this one provides for`);
    }

    const key = params[scope.param];
    const owner = claimant(scope.kind, key);
    // Reach rather than equality. The operator runs the box, a provider reaches
    // the accounts beneath it, and everybody reaches their own. An unclaimed
    // resource is claimable by whoever gets there first, which is the rule the
    // write path has always had.
    if (owner && !withinReach(membership, owner.orgId)) {
      return refuse(`${key} belongs to a different account`);
    }
    return membership;
  }

  // The read half of the same question, asked from `serverOps.read` against
  // the scope the catalogue declares beside each reading. A read is refused for
  // the same two reasons a write is — the machine belongs to the account that
  // runs it, and a named resource belongs to whoever claimed it — and the list
  // readings are never refused here at all, because narrowing them to what this
  // organization owns is a better answer than an error.
  function authorizeRead(identityId, reading, scope, params = {}) {
    if (!identityId) return refuse(`${reading} is read on behalf of an account and this request carries none`);
    if (!scope) return refuse(`${reading} has no read scope declared, so it refuses rather than guesses`);
    const membership = ensureMembership(identityId);
    if (membership.rank >= TOP_TWO) return membership; // the operator reads anything on their own box

    if (scope.kind === 'server') {
      return refuse(`${reading} reads the state of the whole machine, which is reserved to the account that runs this box`);
    }
    // Nothing left to ask: 'own' is already answered for this caller alone by
    // the engine, and 'open' holds nothing that belongs to an account.
    if (scope.kind === 'own' || scope.kind === 'open') return membership;

    if (scope.param) {
      const key = params[scope.param];
      if (key === undefined || key === null || key === '') {
        // A keyed reading with no key is answered for the whole box, so it is
        // refused unless the reading also knows how to narrow that answer.
        if (scope.narrow) return membership;
        return refuse(`${reading} reads one resource and this request named none`);
      }
      const owner = claimant(scope.kind, String(key));
      // The read half of the same reach rule. Without it a provider could act
      // on a customer's site and then be refused when it read the result back,
      // which is a worse failure than being refused outright.
      if (owner && !withinReach(membership, owner.orgId)) return refuse(`${key} belongs to a different account`);
      return membership;
    }
    return membership; // a list reading: narrowed by the caller, not refused here
  }

  // Whose account is this being done FOR.
  //
  // Most operations are done by an account for itself and this question does not
  // arise. A migration is the exception: a hoster moves a customer in, and every
  // site, database and mailbox it creates belongs to that customer rather than to
  // the hoster who pressed the button. Without asking, the resources were claimed
  // for whoever proposed, which since reads narrow by ownership meant the
  // customer could not see the account that had just been moved in for them, and
  // no package applied to it either.
  //
  // The rule is the one already used for changing another account's limits: your
  // own organization always, anything beneath you if you provide for it, anything
  // on the box if you run the box. The organization has to exist, because a
  // resource claimed for a typo belongs to nobody and looks exactly like the bug
  // this is here to fix.
  function actingFor(identityId, targetOrgId) {
    const membership = getMembership(identityId);
    if (!membership) refuse('This identity has no organization, so nothing can be claimed for it');
    if (!targetOrgId || targetOrgId === membership.orgId) return membership.orgId;
    const exists = db.prepare('SELECT 1 FROM memberships WHERE org_id=? LIMIT 1').get(targetOrgId);
    if (!exists) refuse(`There is no account ${targetOrgId} on this server`);
    if (withinReach(membership, targetOrgId)) return targetOrgId;
    return refuse(`${targetOrgId} is not an account this one provides for`);
  }

  function refuse(message) {
    const error = new Error(message);
    error.forbidden = true;
    throw error;
  }

  return { HIERARCHY, TOP_TWO, ensureMembership, ensureMembershipForExisting, getMembership, setRole, resolveOwner, claimant, orgOwns, withinReach, reaches, claim, release, authorize, authorizeRead, actingFor };
}

module.exports = { createOwnershipService, HIERARCHY, TOP_TWO };
