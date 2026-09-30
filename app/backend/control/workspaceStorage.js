'use strict';

// The three states a workspace object can be in, and the fact that on hosting
// they are physics rather than a setting.
//
// Dropbox can afford to keep sharing as a flag on a row, because there is no
// web server anywhere near the bytes and nothing reaches them except Dropbox's
// own code. Here there is a web server, it is the whole product, and a file
// that lands inside a document root is on the public internet from that moment
// whether or not any row says so. So the states are defined by where the bytes
// are, and the row records the decision rather than enforcing it:
//
//   private   the bytes live in the account's own store, which is outside every
//             document root, and no route serves anything from there
//   shared    the same bytes in the same place, reachable only through a signed
//             link with an expiry, which is issued and revoked separately
//   public    a COPY of the bytes written into a site's document root, served by
//             nginx on the customer's own domain
//
// Three things follow from that and they are the reason this file exists rather
// than a `state` column and some good intentions.
//
// First, sharing moves nothing. A shared object is a private object with a link
// against it, so revoking a share is instant and cannot half fail, and an
// expired link falls back to private on its own with no cleanup pass.
//
// Second, publishing copies rather than moves. If publishing moved the bytes,
// unpublishing would have to move them back, and a failure halfway leaves the
// customer's file in a document root with the panel believing it is private,
// which is the exact accident this model exists to prevent. Copying means the
// source is never in play, unpublish is a delete of the copy, and a failed
// unpublish leaves something visible that the panel still knows is visible.
//
// Third, an object is in exactly one state. Publishing something that is shared
// revokes its links in the same transaction, because otherwise a person is
// holding a link they believe is private and expiring to a file that is in fact
// on the open web forever, and that gap is the sort of thing that gets written
// up rather than fixed quietly.
//
// What this file is NOT about: `pub_files` and `uploads/<user>/published/` are
// the panel's own small publisher, serving at `/sites/:userId/:site/*` from the
// panel process. That predates the workspace and is left exactly as it is. The
// workspace's `public` state means the customer's real document root under
// `/srv/jotpanel-sites`, reached through the privileged operations layer, because
// that is the differentiator and a path on somebody else's subdomain is not.

const path = require('path');
const fs = require('fs');

const storageRoots = require('./storageRoots');

const PRIVATE = 'private';
const SHARED = 'shared';
const PUBLIC = 'public';
const STATES = [PRIVATE, SHARED, PUBLIC];

// The entitlement keys the plan ladder will carry. Named here, and only here,
// so that the rows added later are the rows this model already asks for and
// nobody has to rename a column in a customer database to make the two agree.
const ENTITLEMENTS = {
  storageBytes: 'workspace_storage_bytes',
  publish: 'workspace_publish',
  shareLinks: 'workspace_share_links',
  versionDays: 'workspace_version_days',
  connectors: 'workspace_external_connectors',
};

// ── Where the bytes live ─────────────────────────────────────────────────────

// The store is the vault's existing private root and deliberately not a fourth
// directory beside it. The vault already holds the customer's files, already has
// upload, download, rename and delete against it, and `storageRoots` already
// proves that nothing under it is ever served by any route. A separate workspace
// tree would be a second store for the same objects, needing the same proof
// again, and the two would drift.
function rootsFor(uploadsDir, userId) {
  const roots = storageRoots.rootsFor(uploadsDir, userId);
  return { base: roots.base, store: roots.private };
}

function ensureStore(uploadsDir, userId) {
  return storageRoots.ensureRoot(uploadsDir, userId, storageRoots.PRIVATE);
}

// Asserted at boot, not asserted in a comment.
//
// Everything above rests on one claim: the store is not inside anything the web
// serves. That claim is true of the default layout and would stop being true if
// somebody set `UPLOADS_DIR` to a path under `/srv/jotpanel-sites` on a box where
// disk is cheaper there, and the panel would carry on writing private files into
// a document root without a single error. So it is checked against the real
// paths at start, and a box that fails it should refuse to run rather than serve
// somebody's tax return.
//
// Both directions, because both are fatal in the same way. A store inside a
// document root publishes every private file. A document root inside the store
// publishes every private file that happens to sit under it, and is the easier
// of the two to arrive at by accident.
function assertOutsideDocroots(store, docroots = []) {
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const storeReal = real(store);
  for (const docroot of docroots) {
    if (!docroot) continue;
    const docrootReal = real(docroot);
    if (storeReal === docrootReal) {
      throw new Error(`the workspace store and the document root ${docroot} are the same directory, so every private file is on the web`);
    }
    if (storageRoots.isInside(docrootReal, storeReal)) {
      throw new Error(`the workspace store ${store} is inside the document root ${docroot}, so every private file is on the web`);
    }
    if (storageRoots.isInside(storeReal, docrootReal)) {
      throw new Error(`the document root ${docroot} is inside the workspace store ${store}, so private files under it are on the web`);
    }
  }
  return true;
}

// ── Paths, and the escape that has already worked once here ─────────────────

// This is the same shape as `sitePath` in the privileged worker and it is the
// same shape on purpose. On 2026-08-28 a customer wrote a file outside their own
// site through an ordinary write, by putting a symlink in a directory partway
// along the path and asking the panel to write through it. Three separate checks
// each looked sufficient and none of them was: `path.resolve` is lexical so it
// never follows a link, `O_NOFOLLOW` guards only the last component, and a
// realpath check only fires when the target already exists, which for a write is
// exactly when it does not.
//
// So the deepest ancestor that does exist is resolved and checked, since that is
// the first thing on the path the kernel can be made to follow. A leaf that does
// not exist yet cannot itself be a link, and everything above it is now covered
// whether it exists or not.
//
// The workspace has not been attacked this way yet. It has SFTP into the same
// bytes and a sync client coming, which is the same set of hands on the same
// tree, so it gets the same gate before it needs it rather than after.
// `subject` names the tree in the refusal, because this gate guards two of them.
// A customer publishing to their own website who is told the path leaves "the
// workspace" has been handed the wrong noun for the thing they were looking at,
// and a refusal a person cannot place is a refusal they read as a bug.
function containedPath(root, relative, { mustExist = false, subject = 'workspace' } = {}) {
  const resolvedRoot = path.resolve(root);
  const clean = String(relative == null ? '' : relative).replace(/^\/+/, '');
  if (clean.includes('\0')) throw new Error('That path is not valid');
  const target = path.resolve(resolvedRoot, clean);
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`That path is outside the ${subject}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(`That path leaves the ${subject} through a link`);
    }
  } else if (mustExist) {
    throw new Error('That path does not exist');
  }
  let ancestor = target;
  while (ancestor !== resolvedRoot && ancestor.startsWith(resolvedRoot + path.sep) && !fs.existsSync(ancestor)) {
    ancestor = path.dirname(ancestor);
  }
  const realAncestor = fs.realpathSync(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw new Error(`That path leaves the ${subject} through a link`);
  }
  return { root: resolvedRoot, target, relative: path.relative(resolvedRoot, target) };
}

// A path inside one account's own store. The account id is part of the root, so
// one customer naming another customer's path gets a refusal from the geometry
// rather than from a permission check somebody has to remember to write.
function resolveInStore(uploadsDir, userId, relative, options = {}) {
  const { store } = rootsFor(uploadsDir, userId);
  return containedPath(store, relative, options);
}

// The domain check is the conservative one from the privileged worker, repeated
// rather than imported because that module is the root-side worker and this runs
// in the panel process. A domain here becomes a directory name under the site
// root, so the set of things it may contain is the narrow question.
function siteDomain(value) {
  const clean = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(clean) || clean.includes('..')) {
    throw new Error(`${value} is not a domain name`);
  }
  return clean;
}

// Where a public copy would go, worked out here so that the audit row written
// before the copy and the copy itself are describing the same path.
//
// This resolves and refuses. It does not write, and it does not need the panel
// process to be able to reach the site root at all, which it usually cannot: the
// copy is performed by the privileged layer, and this is what that layer is
// handed. `mustExist` is therefore false by default and the ancestor walk is
// skipped when the site root is not present on this process's filesystem, since
// a check that throws because the panel cannot see `/srv` would refuse every
// legitimate publish on a real box.
function publicTargetFor({ siteRoot, domain, documentRoot = 'public', relative }) {
  const name = siteDomain(domain);
  const base = path.resolve(siteRoot, name);
  const docroot = path.resolve(base, String(documentRoot || 'public').replace(/^\/+/, ''));
  if (docroot !== base && !docroot.startsWith(base + path.sep)) {
    throw new Error('That document root is outside the site');
  }
  const clean = String(relative == null ? '' : relative).replace(/^\/+/, '');
  if (clean.includes('\0')) throw new Error('That path is not valid');
  if (!clean) throw new Error('A published file needs a name');
  const target = path.resolve(docroot, clean);
  if (!target.startsWith(docroot + path.sep)) throw new Error('That path is outside the site');
  // Only when this process can actually see the tree. On a box where it can, a
  // link already sitting in the document root is caught before anything is
  // proposed; on a box where it cannot, the privileged worker's own `sitePath`
  // is the gate that matters and it runs the same walk against the real tree.
  if (fs.existsSync(docroot)) {
    const { relative: within } = containedPath(docroot, clean, { subject: 'site' });
    return { domain: name, docroot, target, relative: within };
  }
  return { domain: name, docroot, target, relative: path.relative(docroot, target) };
}

// ── The state of a row, which the row decides and the caller never declares ──

// Derived, never accepted. A caller asking to publish names an object and a
// destination; it does not get to say what state anything is in, because a
// control built on a value the client sent is a control that can be turned off
// by the client. The columns are the truth: something is public when there is a
// record of a copy in a document root, shared when there is an unexpired link
// against it, and private otherwise, which is also what an unknown or corrupt
// value means.
function stateOf(row, { activeShares = 0 } = {}) {
  if (!row) return PRIVATE;
  if (row.published_domain && row.published_path) return PUBLIC;
  if (activeShares > 0) return SHARED;
  return PRIVATE;
}

// Who can reach an object in each state, said once so that a route, a test and a
// screen can all ask the same question instead of each carrying its own idea.
const REACH = {
  [PRIVATE]: { owner: true, linkHolder: false, internet: false, servedBy: null },
  [SHARED]: { owner: true, linkHolder: true, internet: false, servedBy: 'panel, against a signed link' },
  [PUBLIC]: { owner: true, linkHolder: true, internet: true, servedBy: 'the web server, from the document root' },
};

function reachability(state) {
  return REACH[state] || REACH[PRIVATE];
}

// ── Transitions ─────────────────────────────────────────────────────────────

// The whole state machine in one table, so that steps built later wire it rather
// than re-deciding it, and so that a transition nobody thought about is a
// refusal rather than a default.
//
// `copies` means bytes are written somewhere new and the source is untouched.
// `removes` means bytes are deleted, and it is only ever the copy.
// `revokesShares` means outstanding links are killed in the same transaction.
// `audited` means an audit row, and every state change that alters who can reach
// the object is audited, which is all of them.
const TRANSITIONS = {
  [`${PRIVATE}->${SHARED}`]: {
    copies: false, removes: false, revokesShares: false, audited: true,
    entitlement: ENTITLEMENTS.shareLinks,
    action: 'workspace_shared',
    describe: 'a signed link was issued, the file did not move',
  },
  [`${SHARED}->${PRIVATE}`]: {
    copies: false, removes: false, revokesShares: true, audited: true,
    entitlement: null,
    action: 'workspace_unshared',
    describe: 'the links were revoked, the file did not move',
  },
  [`${PRIVATE}->${PUBLIC}`]: {
    copies: true, removes: false, revokesShares: false, audited: true,
    entitlement: ENTITLEMENTS.publish,
    action: 'workspace_published',
    describe: 'a copy was written into the document root and is on the open internet',
  },
  [`${SHARED}->${PUBLIC}`]: {
    copies: true, removes: false, revokesShares: true, audited: true,
    entitlement: ENTITLEMENTS.publish,
    action: 'workspace_published',
    // The links go, and this is the reason. Somebody holding a link believes
    // they hold something expiring and countable. Once a copy is in a document
    // root that belief is false, and leaving the link alive would let the panel
    // keep telling them it is true.
    describe: 'a copy was written into the document root, and the links were revoked because they promised an expiry the public copy does not have',
  },
  [`${PUBLIC}->${PRIVATE}`]: {
    copies: false, removes: true, revokesShares: false, audited: true,
    entitlement: null,
    action: 'workspace_unpublished',
    describe: 'the copy in the document root was deleted, the original was never touched',
  },
  [`${PUBLIC}->${SHARED}`]: {
    copies: false, removes: true, revokesShares: false, audited: true,
    entitlement: ENTITLEMENTS.shareLinks,
    action: 'workspace_unpublished',
    describe: 'the copy in the document root was deleted and a signed link was issued in its place',
  },
};

function planTransition(from, to) {
  if (!STATES.includes(from)) throw new Error(`${from} is not a state`);
  if (!STATES.includes(to)) throw new Error(`${to} is not a state`);
  if (from === to) return null;
  const plan = TRANSITIONS[`${from}->${to}`];
  if (!plan) throw new Error(`${from} to ${to} is not a change this workspace makes`);
  return { from, to, ...plan };
}

// The question every transition that reaches the internet has to answer out
// loud, kept separate from the plan because a screen asks it before the plan is
// made and an audit row repeats it afterwards.
function crossesIntoPublic(from, to) {
  return to === PUBLIC && from !== PUBLIC;
}

// Deleting the source of something that is on the public web leaves the copy
// there, serving, with nothing in the panel pointing at it any more. That is an
// orphan on the open internet and it is the one thing this model exists to make
// impossible, so the delete is refused and says which action clears it. Not a
// permission problem, so not a 403: it is an ordering problem, and the sentence
// says the order.
function refusalForDelete(state) {
  if (state !== PUBLIC) return null;
  return 'This file is published on your site. Unpublish it first, then delete it, otherwise the copy on the web would be left with nothing pointing at it.';
}

module.exports = {
  PRIVATE, SHARED, PUBLIC, STATES, ENTITLEMENTS,
  rootsFor, ensureStore, assertOutsideDocroots,
  containedPath, resolveInStore, publicTargetFor, siteDomain,
  stateOf, reachability, planTransition, crossesIntoPublic, refusalForDelete,
  TRANSITIONS,
};
