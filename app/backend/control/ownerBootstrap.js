'use strict';

// Who holds this machine's capacity, and when they start holding it.
//
// The box's own operator organization is the entitlement root: the top of the
// tree, holding everything the machine can do, because there is nobody above it
// to allocate from. Every reseller and every customer is allocated downward from
// there, and the root itself is bounded by the machine rather than by a package
// somebody sold it.
//
// This lives in its own file, and is called from two places, because of the
// order a machine is really built in. The panel boots, and its startup
// migration looks for the operator and finds nothing, because no account exists
// yet. Then the installer creates the owner over the loopback bootstrap surface
// and its membership is written. Between those two moments there is nobody to
// mark, and after them nothing was marking anybody.
//
// What that cost: a freshly installed box's owner held zero of every metric with
// source "missing". It could not create a site, a database or a mailbox. It
// could not assign a package to a customer either, because a parent holding zero
// cannot grant anything. And it could not give itself one, correctly, because an
// account cannot change its own limits. The machine could not provision anybody
// from the moment it was built, and the first regression run on a genuinely
// clean machine is what found it.
//
// It is invisible on a box that has ever restarted. The startup migration runs
// again on the next boot, finds the operator that now exists, and repairs it
// without saying anything. Both clean regression runs recorded zero panel
// restarts, which is why this needed a machine built from nothing to see.
//
// ONE-TIME AND IDEMPOTENT BY CONSTRUCTION, not by a flag that could be cleared.
// A box has exactly one `hosting_company` membership and cannot be made to have
// two: `ensureMembership` gives that role to the first membership ever written
// and to no other, `ensureMembershipForExisting` refuses to write the first one
// at all, and `setRole` refuses to grant the role to anybody. `markRoot` is
// INSERT OR IGNORE besides. So this may be called on every boot and after every
// bootstrap attempt, and can only ever name the same organization.
//
// It grants nothing and reaches nothing. It names the organization that is
// already the operator, and it is not an authorization decision: an account that
// is not already `hosting_company` cannot be reached by this code at all.
function ensureEntitlementRoot({ db, entitlements }) {
  if (!db || !entitlements) throw new Error('ensureEntitlementRoot needs a database and the entitlements service');
  // Creation order, then id, so a database that somehow held two would settle on
  // the same one every time rather than on whichever the query happened to
  // return. Deterministic beats fast on a query that runs once.
  const operator = db.prepare(`SELECT org_id FROM memberships WHERE role='hosting_company'
    ORDER BY created_at ASC, identity_id ASC LIMIT 1`).get();
  if (!operator) return null;
  if (entitlements.isRoot(operator.org_id)) return { orgId: operator.org_id, created: false };
  entitlements.markRoot(operator.org_id, 'bootstrap');
  return { orgId: operator.org_id, created: true };
}

module.exports = { ensureEntitlementRoot };
