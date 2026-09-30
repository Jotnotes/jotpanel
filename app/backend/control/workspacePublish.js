'use strict';

// Publishing a workspace file into a customer's own document root, and taking it
// back out again.
//
// This is the half of the operation that does not wait for a screen. Where the
// picker sits, whether the path is editable and whether the confirmation is a
// typed word or a sentence with a URL in it are all decided in
// `docs/WORKSPACE_PUBLISH_DESIGN.md`, and none of them changes any line here.
// What is here is the part that is the same whatever the screen decides: the
// destination is resolved and refused, the entitlement is checked before
// anything moves, the transition is the one the state machine allows, and every
// outcome including a refusal has a row written for it.
//
// WHAT THIS DOES NOT DO, ON PURPOSE
//
// It does not move bytes and it cannot. The panel process does not own the site
// tree and should not be able to write into it, so the copy is performed by the
// privileged layer: `staging.reserve` gives a slot, the panel copies the private
// file into that slot, and `site.files.place` moves it into the document root
// and gives it to the site's own user. Unpublishing is `site.files.delete`.
//
// So what this module produces is a *plan*: the resolved destination, the
// transition, the entitlement verdict, the audit line and the URL, all decided
// together and handed to the route, which is what calls the privileged layer.
// Deciding them together is the point rather than a convenience. The audit row
// written before the copy and the copy itself have to be describing the same
// path, or the record is a record of something that did not happen.
//
// THE DIRECTION THE HANDOFF HAD BACKWARDS
//
// `site.files.stage` is not on this path. It is the download half, copying a
// file *out* of a site to where the panel can read it, and it refuses a
// directory. Publishing is `staging.reserve` then `site.files.place`. Named here
// because a reader coming from the work order will look for `stage` and it is
// the wrong operation.

const workspaceStorage = require('./workspaceStorage');

const { PRIVATE, SHARED, PUBLIC } = workspaceStorage;

// The entitlement that decides whether this account may put anything on the open
// internet at all. Named in `workspaceStorage.ENTITLEMENTS` so that the row the
// plan ladder grows later is the row this code already asks for.
const PUBLISH_ENTITLEMENT = workspaceStorage.ENTITLEMENTS.publish;

// Every sentence a person can be shown, in one place, because the screen prints
// these rather than writing its own. A refusal that is phrased one way in a test,
// another way in a route and a third way on screen is three chances to say
// something untrue about where somebody's file is.
const REFUSALS = {
  notEntitled: 'Publishing to your website is not part of your plan.',
  noSite: 'You do not have a website on this server to publish to yet.',
  notYourSite: 'That is not a website on this account.',
  occupied: 'Something is already published at that address. Choose another path, or unpublish it first.',
  alreadyPublic: 'This file is already published. Unpublish it first to move it somewhere else.',
};

// ── The entitlement, checked before anything is staged ──────────────────────

// A cap that is checked after the response arrives is a report and not a cap,
// and the same is true of a copy: an entitlement checked after the bytes are in
// the document root has not prevented anything, it has described it.
//
// The shape handed in is the one `entitlements.effectiveEntitlement` answers, so
// this reads a verdict rather than re-deriving one. A metric nobody has assigned
// is `missing`, and missing is off rather than on. That direction matters more
// than it looks: the opposite default means a box where the plan ladder has not
// been filled in yet lets every account publish, and the first time anyone finds
// out is when a file is already on the web.
function mayPublish(entitlement) {
  if (!entitlement) return { allowed: false, reason: REFUSALS.notEntitled };
  if (entitlement.missing) return { allowed: false, reason: REFUSALS.notEntitled };
  if (entitlement.maxUnlimited) return { allowed: true, reason: null };
  const value = Number(entitlement.maxValue);
  if (!Number.isFinite(value) || value <= 0) return { allowed: false, reason: REFUSALS.notEntitled };
  return { allowed: true, reason: null };
}

// ── The address, which is half the product ──────────────────────────────────

// Said once, here, so that the dialog that shows it before the copy, the row
// that links to it afterwards and the audit line that records it are all the
// same string. Three places assembling a URL from parts is three places that can
// disagree about a slash, and the one that disagrees is the one the customer
// hands to somebody else.
function publicUrl(domain, relative) {
  const name = workspaceStorage.siteDomain(domain);
  const clean = String(relative == null ? '' : relative).replace(/^\/+/, '');
  return `https://${name}/${clean}`;
}

// ── The plan for publishing ─────────────────────────────────────────────────

// Everything decided together, before anything is staged.
//
// `sites` is what this account actually owns, resolved by the caller from the
// ownership engine and never taken from the request. A domain arriving in a body
// is a client-declared value, and a control built on one is a control the client
// can turn off, so the domain is looked up in this list rather than trusted: an
// account naming somebody else's site is refused here by the geometry rather
// than by a permission check somebody has to remember to write.
function planPublish({
  file,
  domain,
  relative,
  sites = [],
  siteRoot,
  entitlement,
  activeShares = 0,
  now = null,
}) {
  if (!file) throw new Error('There is no such file.');

  // The entitlement first, because it is the cheapest refusal and because a
  // person who may not publish should not have their path validated, their site
  // resolved or a slot reserved for them on the way to being told no.
  const verdict = mayPublish(entitlement);
  if (!verdict.allowed) {
    return { ok: false, status: 403, reason: verdict.reason, entitlement: PUBLISH_ENTITLEMENT };
  }

  if (!sites.length) return { ok: false, status: 404, reason: REFUSALS.noSite };

  // The domain has to be one of this account's own, matched after normalization
  // so that a trailing dot or a capital letter is the same site rather than a
  // near miss that falls through to a refusal about something else.
  let wanted;
  try { wanted = workspaceStorage.siteDomain(domain); }
  catch (error) { return { ok: false, status: 400, reason: error.message }; }
  const site = sites.find(s => {
    try { return workspaceStorage.siteDomain(s.domain) === wanted; } catch { return false; }
  });
  if (!site) return { ok: false, status: 404, reason: REFUSALS.notYourSite };

  // The state is derived from the row and never declared by the caller. A file
  // that is already public is refused rather than quietly republished somewhere
  // else, because moving a public file to a second address without removing the
  // first leaves two copies on the web and one row pointing at one of them.
  const from = workspaceStorage.stateOf(file, { activeShares });
  if (from === PUBLIC) {
    return { ok: false, status: 409, reason: REFUSALS.alreadyPublic, state: PUBLIC };
  }

  // Resolve and refuse. This is the gate from the 2026-08-28 escape, walking the
  // deepest ancestor that exists rather than trusting `path.resolve`, which is
  // lexical, or a realpath check, which only fires when the target is already
  // there and for a write that is exactly when it is not. The privileged worker
  // runs the same walk again against the real tree as root, and both of them
  // running it is the point rather than a duplication: this one refuses before a
  // slot is reserved, and that one refuses on the filesystem that matters.
  let target;
  try {
    target = workspaceStorage.publicTargetFor({
      siteRoot,
      domain: site.domain,
      documentRoot: site.document_root || 'public',
      relative,
    });
  } catch (error) {
    return { ok: false, status: 400, reason: error.message };
  }

  // The transition, asked of the state machine rather than assumed. A transition
  // nobody defined is a refusal here rather than a default, which is what stops
  // a state being invented by whichever route was written last.
  let transition;
  try { transition = workspaceStorage.planTransition(from, PUBLIC); }
  catch (error) { return { ok: false, status: 400, reason: error.message }; }

  const url = publicUrl(site.domain, target.relative);
  return {
    ok: true,
    status: 200,
    from,
    to: PUBLIC,
    transition,
    crossesIntoPublic: workspaceStorage.crossesIntoPublic(from, PUBLIC),
    // What the privileged call is handed. Named exactly as `site.files.place`
    // takes them so the route does not reshape anything on the way and cannot
    // reshape it wrongly.
    place: { domain: site.domain, path: target.relative },
    // What is written on the row once, and only once, `execute` has come back
    // verified. Written before that, a failed copy leaves a row saying public
    // with nothing in the document root, which is the mirror of the accident the
    // whole model exists to prevent.
    record: {
      published_domain: site.domain,
      published_path: target.relative,
      published_at: now || new Date().toISOString(),
    },
    public_url: url,
    // Shares go in the same change as the copy, not afterwards. Somebody holding
    // a link believes they hold something that expires. Once there is a copy in a
    // document root that belief is false, and a link left alive would have the
    // panel keep telling them it is true.
    revokesShares: transition.revokesShares,
    audit: {
      action: transition.action,
      details: `${file.name} published to ${url}`,
    },
  };
}

// ── The plan for unpublishing ───────────────────────────────────────────────

// Deliberately gentler than publishing, and the asymmetry is the design rather
// than an oversight. Publishing widens who can reach a file and is the operation
// that can expose data, so it is confirmed against a URL the person has read.
// Unpublishing narrows it, and the worst outcome of an accidental one is a 404
// the customer fixes by pressing Publish again.
//
// `to` is private by default and may be shared, which is the state a file lands
// in when it has live links against it. It is derived rather than passed, for
// the same reason every other state here is.
function planUnpublish({ file, activeShares = 0 }) {
  if (!file) throw new Error('There is no such file.');

  const from = workspaceStorage.stateOf(file, { activeShares });
  // Already private is a success rather than an error. The button's job is to
  // make the file not-public, and a second press has already achieved that. An
  // error here would have the screen show a failure for a state the person asked
  // for and already has.
  if (from !== PUBLIC) {
    return { ok: true, status: 200, noop: true, from, to: from, public_url: null };
  }

  const to = activeShares > 0 ? SHARED : PRIVATE;
  const transition = workspaceStorage.planTransition(PUBLIC, to);
  const url = publicUrl(file.published_domain, file.published_path);
  return {
    ok: true,
    status: 200,
    noop: false,
    from: PUBLIC,
    to,
    transition,
    // What `site.files.delete` is handed. Read off the row rather than off the
    // request: the request says which file, and the row says where its copy went.
    // Taking the path from the request would let a caller name a path in their
    // own document root that this file was never published to and have the panel
    // delete it, which is a delete wearing an unpublish's clothes.
    remove: { domain: file.published_domain, path: file.published_path },
    // Cleared once the copy is actually gone. Cleared first, a failed delete
    // leaves the row private and the file on the open web, which is the exact
    // orphan the three states exist to make impossible.
    record: { published_domain: null, published_path: null, published_at: null, published_by: null },
    public_url: null,
    was_public_url: url,
    audit: {
      action: transition.action,
      details: `${file.name} unpublished from ${url}`,
    },
  };
}

// A refusal is a row too. The interesting line on the day somebody asks what
// happened is usually the attempt that did not work, and a log that records only
// successes cannot answer that question at all.
function auditForRefusal(kind, file, reason) {
  return {
    action: kind === 'unpublish' ? 'workspace_unpublish_refused' : 'workspace_publish_refused',
    details: `${(file && file.name) || 'a file'}: ${reason}`,
  };
}

module.exports = {
  PUBLISH_ENTITLEMENT, REFUSALS,
  mayPublish, publicUrl,
  planPublish, planUnpublish, auditForRefusal,
};
