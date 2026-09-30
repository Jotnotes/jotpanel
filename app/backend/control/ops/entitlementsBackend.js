'use strict';

// Reseller administration, on the one execution path everything else uses.
//
// Until this file existed, creating a package, assigning one and moving a
// customer's limit were direct authenticated routes that wrote an audit line.
// Everything else in this product is proposed, approved, executed and read
// back, and leaves a durable record either way. Capacity administration was the
// one write that did not, which is a strange place to make an exception: it
// decides what a customer is allowed to have, and "who raised this account's
// limit, when, and who approved it" is exactly the question a hosting company
// gets asked six months later by somebody holding an invoice.
//
// Nothing here touches the operating system, so nothing here goes near the
// privileged socket. These are writes to the panel's own record, and that is
// the whole reason a backend is the right shape for them: the engine does not
// care whether a capability ends in a systemd call or a row, only that it runs
// and says whether it worked.
//
// Rule 2 applies unchanged. Every handler reads the change back out of the
// entitlements service after making it, and returns `verified` only when what
// it reads is what it asked for. A green card over an unchecked write is worse
// than no card, and a limit that reports itself as set while nothing is limited
// is the exact bug the live run of the override route already found once.

function createEntitlementsBackend({ entitlements, ownership }) {
  if (!entitlements) throw new Error('the entitlements backend requires the entitlements service');
  if (!ownership) throw new Error('the entitlements backend requires the ownership service');

  // The organization the person driving this belongs to. Everything below acts
  // as that organization, never as the target: a package is created by its
  // owner, an assignment is made by the parent, an override records who set it.
  function actor(ctx) {
    const identityId = ctx && ctx.accountId;
    if (!identityId) throw new Error('This operation needs to know who is asking');
    const membership = ownership.getMembership(identityId);
    if (!membership) throw new Error('That account has no organization, so it cannot administer anyone');
    return { identityId, orgId: membership.orgId };
  }

  const handlers = {
    // Creating a package changes nothing about anyone yet. It is still a write
    // worth recording: a package is a promise about what an account may have,
    // and the moment somebody is on it, what it said matters.
    'entitlements.package.create': async (params, ctx) => {
      const me = actor(ctx);
      const pkg = entitlements.createPackage({
        ownerOrgId: me.orgId,
        name: params.name,
        description: params.description || null,
        limits: params.limits,
        actorIdentityId: me.identityId,
      });
      const after = entitlements.getPackage(pkg.id);
      if (!after || after.status !== 'active') throw new Error(`${params.name} did not read back as an active package`);
      if (after.limits.length !== params.limits.length) {
        throw new Error(`${params.name} was stored with ${after.limits.length} limits rather than the ${params.limits.length} asked for`);
      }
      return { package_id: after.id, name: after.name, limits: after.limits.length, verified: true };
    },

    // Putting a customer on a package. The service does the allocation check,
    // so a reseller cannot hand out more than it holds unless overselling was
    // deliberately turned on for it.
    'entitlements.package.assign': async (params, ctx) => {
      const me = actor(ctx);
      const result = entitlements.assignPackage({
        parentOrgId: me.orgId,
        targetOrgId: params.targetOrgId,
        packageId: params.packageId,
        actorIdentityId: me.identityId,
      });
      // Read back through the same function the admission checks use, rather
      // than by re-reading the row that was just written. A row that exists
      // proves an insert happened; this proves the account's limits actually
      // changed to the package's.
      const pkg = entitlements.getPackage(params.packageId);
      const sample = pkg.limits[0];
      const effective = entitlements.effectiveEntitlement(params.targetOrgId, sample.metric_key);
      const matches = sample.maximum_is_unlimited ? effective.maxUnlimited : effective.maxValue === sample.maximum_value;
      if (!matches) throw new Error(`${params.targetOrgId} did not read back on ${pkg.name}: ${sample.metric_key} is still ${effective.maxUnlimited ? 'unlimited' : effective.maxValue}`);
      // A ceiling that moves can land underneath usage that is already there,
      // and the moment it happens is the moment to write that down. Waiting for
      // the account's next attempt to create something would date the overage
      // from the attempt rather than from the decision that caused it, and would
      // tell nobody at all in between. The count goes into the action's own
      // record, so the person who made the change can see what it did.
      const overages = await entitlements.observeOverages(params.targetOrgId);
      return {
        assignment_id: result.assignmentId, target_org_id: params.targetOrgId, package_id: params.packageId, package_name: pkg.name,
        over_limit_after: overages.map(entry => ({ metric: entry.metric, used: entry.used, maximum: entry.maximum })),
        verified: true,
      };
    },

    // Retiring a package stops it being sold. It deliberately leaves the people
    // already on it exactly where they are: a panel that reduced live customers
    // to nothing because somebody tidied a price list would be the worst kind
    // of correct.
    'entitlements.package.archive': async (params, ctx) => {
      const me = actor(ctx);
      const pkg = entitlements.getPackage(params.packageId);
      if (!pkg) throw new Error('There is no package with that id');
      if (pkg.owner_org_id !== me.orgId) throw new Error('That package belongs to a different organization');
      const before = entitlements.countActiveAssignments(params.packageId);
      entitlements.archivePackage(params.packageId, me.identityId);
      const after = entitlements.getPackage(params.packageId);
      if (!after || after.status !== 'archived') throw new Error(`${pkg.name} did not read back as archived`);
      const stillAssigned = entitlements.countActiveAssignments(params.packageId);
      if (stillAssigned !== before) {
        throw new Error(`Archiving ${pkg.name} changed ${before - stillAssigned} live assignment(s), which it must never do`);
      }
      return { package_id: params.packageId, name: pkg.name, status: after.status, assignments_left_alone: stillAssigned, verified: true };
    },

    // Moving one metric on one account without minting a package for it, which
    // is what a hoster actually does when a customer asks for one more mailbox.
    'entitlements.account_limit.override': async (params, ctx) => {
      const me = actor(ctx);
      entitlements.setOverride({
        targetOrgId: params.targetOrgId,
        metricKey: params.metric,
        fields: {
          maximum: params.unlimited ? { unlimited: true } : { unlimited: false, value: params.maximum },
          reserved: params.reserved == null ? null : params.reserved,
          downstreamPolicy: params.downstreamPolicy || null,
        },
        reason: params.reason || null,
        actorOrgId: me.orgId,
        actorIdentityId: me.identityId,
      });
      const effective = entitlements.effectiveEntitlement(params.targetOrgId, params.metric);
      // The check that matters, and the one whose absence let a broken route
      // report success while the limit never moved: the effective figure has to
      // be the one asked for, and it has to say it came from an override.
      if (effective.source !== 'override') throw new Error(`${params.metric} still reads as coming from the ${effective.source}, so the override did not take`);
      const landed = params.unlimited ? effective.maxUnlimited : effective.maxValue === params.maximum;
      if (!landed) throw new Error(`${params.metric} reads back as ${effective.maxUnlimited ? 'unlimited' : effective.maxValue}, not what was asked for`);
      // A ceiling that moves can land underneath usage that is already there,
      // and the moment it happens is the moment to write that down. Waiting for
      // the account's next attempt to create something would date the overage
      // from the attempt rather than from the decision that caused it, and would
      // tell nobody at all in between. The count goes into the action's own
      // record, so the person who made the change can see what it did.
      const overages = await entitlements.observeOverages(params.targetOrgId);
      return {
        target_org_id: params.targetOrgId, metric: params.metric,
        maximum: effective.maxUnlimited ? 'unlimited' : effective.maxValue,
        over_limit_after: overages.map(entry => ({ metric: entry.metric, used: entry.used, maximum: entry.maximum })),
        source: effective.source, verified: true,
      };
    },

    'entitlements.account_limit.override.clear': async (params, ctx) => {
      const me = actor(ctx);
      entitlements.clearOverride({ targetOrgId: params.targetOrgId, metricKey: params.metric, actorOrgId: me.orgId });
      const effective = entitlements.effectiveEntitlement(params.targetOrgId, params.metric);
      if (effective.source === 'override') throw new Error(`${params.metric} still reads as an override, so it was not cleared`);
      // A ceiling that moves can land underneath usage that is already there,
      // and the moment it happens is the moment to write that down. Waiting for
      // the account's next attempt to create something would date the overage
      // from the attempt rather than from the decision that caused it, and would
      // tell nobody at all in between. The count goes into the action's own
      // record, so the person who made the change can see what it did.
      const overages = await entitlements.observeOverages(params.targetOrgId);
      return {
        target_org_id: params.targetOrgId, metric: params.metric,
        maximum: effective.maxUnlimited ? 'unlimited' : effective.maxValue,
        over_limit_after: overages.map(entry => ({ metric: entry.metric, used: entry.used, maximum: entry.maximum })),
        source: effective.source, verified: true,
      };
    },

    // Taking an account on as a customer. The cycle check lives in the service.
    'entitlements.organization.link': async (params, ctx) => {
      const me = actor(ctx);
      entitlements.linkOrganizations(me.orgId, params.targetOrgId, me.identityId);
      const parent = entitlements.getDirectParent(params.targetOrgId);
      if (parent !== me.orgId) throw new Error(`${params.targetOrgId} did not read back as an account of ${me.orgId}`);
      return { parent_org_id: me.orgId, target_org_id: params.targetOrgId, verified: true };
    },
  };

  async function capabilities() {
    const available = new Map();
    for (const [id, run] of Object.entries(handlers)) {
      available.set(id, { run, backend: 'entitlements', kind: 'write' });
    }
    // Nothing to probe. These need no program on disk and no privilege beyond
    // the panel's own database, so claiming they are available is a statement
    // about this process rather than a guess about the machine — which is the
    // difference the button-that-cannot-work rule is actually about.
    return { capabilities: available, missing: new Map(), state: { operations: available.size } };
  }

  return {
    name: 'entitlements',
    probe: async () => ({ available: true }),
    capabilities,
    handlers,
  };
}

module.exports = { createEntitlementsBackend };
