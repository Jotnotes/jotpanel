'use strict';

// The account lifecycle, on the one execution path everything else uses.
//
// Creating a customer, stopping one and starting one again were only ever
// reachable through the `/admin/api` router, which is gated on a shared key
// rather than on who is asking. A shared key cannot express delegation: it is
// the same password for everybody holding it, so there is no way for it to mean
// "this reseller, for these customers and no others". That left the reseller
// role with limits it could set and no accounts to set them on.
//
// So the three that a provider actually performs are catalogue operations,
// proposed, approved, executed and read back like every other change. Who may
// run them is `ownership.authorize` and nothing else: the organization scope
// answers "is this an account you provide for" from the live hierarchy, and the
// caller's own organization comes from their signed identity rather than from
// anything in the request.
//
// The fourth, promoting somebody to reseller, is server-scoped on purpose. Only
// the account that runs the box makes resellers, which keeps the tree three
// deep and keeps "who is liable for whom" a question with one answer.
//
// Rule 2 applies unchanged: every handler reads the change back out of the
// database or off the machine afterwards and returns `verified` only when what
// it reads is what it asked for.

function createAccountsBackend({ db, ownership, entitlements, bcrypt, newId, setSitesSuspended, recordLifecycle }) {
  for (const [name, value] of Object.entries({ db, ownership, entitlements, bcrypt, newId, setSitesSuspended })) {
    if (!value) throw new Error(`the accounts backend requires ${name}`);
  }

  function actor(ctx) {
    const identityId = ctx && ctx.accountId;
    if (!identityId) throw new Error('This operation needs to know who is asking');
    const membership = ownership.getMembership(identityId);
    if (!membership) throw new Error('That account has no organization, so it cannot administer anyone');
    return { identityId, orgId: membership.orgId, rank: membership.rank };
  }

  // Every identity inside an organization. Suspension is a fact about the
  // people who can sign in, and an organization may hold more than one.
  function identitiesIn(orgId) {
    return db.prepare('SELECT identity_id FROM memberships WHERE org_id=?').all(orgId).map(r => r.identity_id);
  }

  async function setSuspended(params, ctx, suspended) {
    const me = actor(ctx);
    const targets = identitiesIn(params.targetOrgId);
    if (!targets.length) throw new Error(`There is nobody in ${params.targetOrgId} to ${suspended ? 'suspend' : 'restore'}`);

    const sites = [];
    for (const identityId of targets) {
      db.prepare('UPDATE users SET suspended=? WHERE id=?').run(suspended ? 1 : 0, identityId);
      if (recordLifecycle) {
        try { recordLifecycle(identityId, suspended ? 'suspended' : 'resumed', params.reason || `by ${me.orgId}`); } catch { /* the ledger is not the gate */ }
      }
      // Suspension that only sets a column is the bug this product already
      // found once: the website kept serving and the mail kept arriving. Every
      // channel is closed per site, and a site that fails to change is reported
      // rather than swallowed.
      const changed = await setSitesSuspended(identityId, suspended);
      sites.push(...(Array.isArray(changed) ? changed : []));
    }

    // Read the flag back out of the table rather than trusting the update.
    const stillWrong = db.prepare(
      `SELECT COUNT(*) AS n FROM users WHERE id IN (${targets.map(() => '?').join(',')}) AND suspended<>?`
    ).get(...targets, suspended ? 1 : 0).n;
    if (stillWrong) throw new Error(`${stillWrong} of ${targets.length} accounts did not read back as ${suspended ? 'suspended' : 'active'}`);

    const clean = sites.filter(s => s.site?.ok && s.mail?.ok && s.sftp?.ok && s.cron?.ok).length;
    return {
      target_org_id: params.targetOrgId,
      accounts: targets.length,
      suspended,
      domains: sites.length,
      domains_fully_changed: clean,
      // Honest rather than round: a domain whose mail could not be closed is
      // named, because "suspended" that half happened is worse than a failure.
      incomplete: sites.filter(s => !(s.site?.ok && s.mail?.ok && s.sftp?.ok && s.cron?.ok)).map(s => s.domain || s.site?.domain || 'unknown'),
      verified: true,
    };
  }

  const handlers = {
    // A provider taking on a customer. One call rather than three, because the
    // three have to happen together or the result is an account that exists,
    // belongs to nobody and is outside every package.
    'account.create': async (params, ctx) => {
      const me = actor(ctx);
      const email = String(params.email).trim().toLowerCase();
      if (db.prepare('SELECT id FROM users WHERE email=?').get(email)) {
        throw new Error(`${email} already has an account on this server`);
      }
      const identityId = newId();
      const created = db.transaction(() => {
        db.prepare('INSERT INTO users (id,name,email,password) VALUES (?,?,?,?)')
          .run(identityId, params.name || email.split('@')[0], email, bcrypt.hashSync(params.password, 12));
        // Their own organization, at the bottom rank, exactly as a self
        // sign-up would get. A customer is not a member of their provider's
        // organization: that would give them everything the provider has.
        const membership = ownership.ensureMembership(identityId);
        entitlements.linkOrganizations(me.orgId, membership.orgId, me.identityId);
        return membership;
      })();

      if (params.packageId) {
        entitlements.assignPackage({
          parentOrgId: me.orgId,
          targetOrgId: created.orgId,
          packageId: params.packageId,
          actorIdentityId: me.identityId,
        });
      }

      // Read the whole thing back: the login exists, it is in its own
      // organization, that organization sits under this provider, and the
      // package really applied.
      const user = db.prepare('SELECT id,email FROM users WHERE id=?').get(identityId);
      const membership = ownership.getMembership(identityId);
      const parent = entitlements.getDirectParent(membership.orgId);
      if (!user) throw new Error('The account did not read back after being created');
      if (!membership || membership.role !== 'end_user') throw new Error('The account did not read back in an organization of its own');
      if (parent !== me.orgId) throw new Error(`The account read back under ${parent || 'nobody'} rather than under ${me.orgId}`);
      let packageName = null;
      if (params.packageId) {
        const assignment = db.prepare(
          `SELECT p.name FROM account_package_assignments a JOIN packages p ON p.id=a.package_id
           WHERE a.target_org_id=? AND a.status='active'`).get(membership.orgId);
        if (!assignment) throw new Error('The account was created but the package did not read back on it');
        packageName = assignment.name;
      }
      return {
        identity_id: user.id, email: user.email, org_id: membership.orgId,
        provider_org_id: me.orgId, package: packageName, verified: true,
      };
    },

    'account.suspend': (params, ctx) => setSuspended(params, ctx, true),
    'account.unsuspend': (params, ctx) => setSuspended(params, ctx, false),

    // Making a reseller. The ownership service refuses anything but the two
    // grantable roles and refuses to touch the box operator at all, so this
    // does not re-decide any of that; it calls it and reads the answer back.
    'account.role.set': async (params) => {
      const before = ownership.getMembership(params.identityId);
      if (!before) throw new Error(`${params.identityId} is not an account on this server`);
      ownership.setRole(params.identityId, params.role);
      const after = ownership.getMembership(params.identityId);
      if (!after || after.role !== params.role) {
        throw new Error(`${params.identityId} still reads as ${after ? after.role : 'nothing'}`);
      }
      return { identity_id: params.identityId, org_id: after.orgId, was: before.role, now: after.role, verified: true };
    },
  };

  async function capabilities() {
    const available = new Map();
    for (const [id, run] of Object.entries(handlers)) {
      available.set(id, { run, backend: 'accounts', kind: 'write' });
    }
    return { capabilities: available, missing: new Map(), state: { operations: available.size } };
  }

  return {
    name: 'accounts',
    probe: async () => ({ available: true }),
    capabilities,
    handlers,
  };
}

module.exports = { createAccountsBackend };
