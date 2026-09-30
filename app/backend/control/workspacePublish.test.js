'use strict';

// Publish and unpublish, tested against the ways they quietly stop being safe.
//
// Four families here. The entitlement, which has to refuse before anything is
// staged and has to read a metric nobody assigned as off rather than on. The
// ownership of the destination, because the domain arrives in a request body and
// a control built on a client-declared value is a control the client can turn
// off. The containment, which is the gate from the 2026-08-28 escape asked of a
// path that leaves the site through a link partway along. And the record, which
// has to describe the same address the copy went to, and has to be written for
// refusals as well as for successes.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const wp = require('./workspacePublish');
const ws = require('./workspaceStorage');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-publish-'));
const siteRoot = path.join(tmp, 'srv', 'arca-sites');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(path.join(siteRoot, 'example.com', 'public'), { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const SITES = [
  { domain: 'example.com', document_root: 'public' },
  { domain: 'staging.example.com', document_root: 'public' },
];
const UNLIMITED = { maxUnlimited: true, missing: false };
const FILE = { id: 'f1', name: 'report.pdf', published_domain: null, published_path: null };
const PUBLISHED = {
  id: 'f2', name: 'report.pdf',
  published_domain: 'example.com', published_path: 'report.pdf',
  published_at: '2026-08-31T10:00:00.000Z',
};

const publish = extra => wp.planPublish({
  file: FILE, domain: 'example.com', relative: 'report.pdf',
  sites: SITES, siteRoot, entitlement: UNLIMITED, ...extra,
});

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const refuses = (name, plan, pattern, status) => {
  assert.strictEqual(plan.ok, false, `${name}: expected a refusal and the plan was allowed`);
  if (pattern) assert.match(plan.reason, pattern, `${name}: refused with "${plan.reason}"`);
  if (status) assert.strictEqual(plan.status, status, `${name}: answered ${plan.status}`);
  passed++; console.log(`ok  ${name} — refused ${plan.status}: ${plan.reason}`);
};

// ── The entitlement, which is a cap and not a report ────────────────────────

// A cap checked after the bytes have moved has described something rather than
// prevented it, so the refusal has to come before the destination is resolved
// and before a staging slot is reserved.
check('an account with the entitlement may publish', () => {
  assert.strictEqual(wp.mayPublish(UNLIMITED).allowed, true);
  assert.strictEqual(wp.mayPublish({ maxValue: 1, missing: false }).allowed, true);
});

// The direction that matters. Missing means off, because missing meaning on is a
// box where nobody has filled in the plan ladder yet letting every account
// publish, and the first anyone hears of it is a file already on the web.
refuses('a metric nobody assigned is off rather than on',
  publish({ entitlement: { missing: true } }), /not part of your plan/, 403);
refuses('a metric assigned as zero is off',
  publish({ entitlement: { maxValue: 0, missing: false } }), /not part of your plan/, 403);
refuses('no entitlement at all is off',
  publish({ entitlement: null }), /not part of your plan/, 403);

check('the entitlement is refused before the destination is even resolved', () => {
  // A path that would fail containment, behind an entitlement that fails first.
  // The reason has to be the plan and not the path, or a person who may not
  // publish learns the shape of the site root by being told about it.
  const plan = publish({ entitlement: { missing: true }, relative: '../../etc/passwd' });
  assert.strictEqual(plan.status, 403);
  assert.match(plan.reason, /not part of your plan/);
  assert.ok(!plan.place, 'a destination was resolved for an account that may not publish');
});

check('the entitlement key is the one the plan ladder will grow', () => {
  assert.strictEqual(wp.PUBLISH_ENTITLEMENT, ws.ENTITLEMENTS.publish);
  assert.strictEqual(wp.PUBLISH_ENTITLEMENT, 'workspace_publish');
});

// ── The destination belongs to this account, checked rather than trusted ────

// The domain arrives in a request body. It is matched against what the account
// actually owns rather than used, so naming somebody else's site is refused by
// the geometry rather than by a permission check somebody has to remember.
refuses('a domain this account does not own is refused',
  publish({ domain: 'someone-else.com' }), /not a website on this account/, 404);
refuses('an account with no sites is told so rather than shown an empty picker',
  publish({ sites: [] }), /do not have a website/, 404);
refuses('a domain that is not a domain is refused',
  publish({ domain: '../../../etc' }), /is not a domain name/, 400);

check('a trailing dot and a capital letter are the same site, not a near miss', () => {
  const plan = publish({ domain: 'EXAMPLE.com.' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.place.domain, 'example.com');
});

check('a second site the account owns is an ordinary destination', () => {
  // This is the whole of the staging answer. A staging target is a site, so it
  // needs no mode, no second document root and no new concept.
  const plan = publish({ domain: 'staging.example.com' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.public_url, 'https://staging.example.com/report.pdf');
});

// ── Containment, which is the gate from the escape that worked here ─────────

refuses('a traversal out of the document root is refused',
  publish({ relative: '../../../etc/cron.d/evil' }), /outside the site/, 400);
refuses('an empty path is refused rather than publishing the document root',
  publish({ relative: '' }), /needs a name/, 400);
refuses('a NUL byte is refused',
  publish({ relative: 'report\0.pdf' }), /not valid/, 400);

check('an absolute path is treated as relative and cannot escape', () => {
  const plan = publish({ relative: '/etc/passwd' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.place.path, 'etc/passwd');
  assert.ok(!plan.place.path.startsWith('/'), 'an absolute path stayed absolute');
});

// The 2026-08-28 escape, which three separate checks each looked sufficient for
// and none was. The link is partway along the path and the leaf does not exist,
// which is the case `path.resolve` misses because it is lexical, `O_NOFOLLOW`
// misses because it guards only the last component, and a realpath check misses
// because it fires only when the target already exists.
check('a symlink partway along the path, to a leaf that does not exist, is refused', () => {
  const docroot = path.join(siteRoot, 'example.com', 'public');
  const link = path.join(docroot, 'assets');
  fs.symlinkSync(outside, link);
  try {
    const plan = publish({ relative: 'assets/escaped.txt' });
    assert.strictEqual(plan.ok, false, 'a write through a symlinked directory was allowed');
    assert.match(plan.reason, /leaves the site through a link|outside the site/);
    assert.ok(!fs.existsSync(path.join(outside, 'escaped.txt')), 'the plan touched the disk');
    passed++; console.log(`ok  a symlink partway along the path is refused — ${plan.reason}`);
  } finally { fs.unlinkSync(link); }
});

check('a real folder inside the document root is not mistaken for an escape', () => {
  const nested = path.join(siteRoot, 'example.com', 'public', 'docs');
  fs.mkdirSync(nested, { recursive: true });
  const plan = publish({ relative: 'docs/report.pdf' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.place.path, 'docs/report.pdf');
});

check('a folder that does not exist yet is still a legitimate destination', () => {
  // `site.files.place` calls ensureDir on the parent, so typing a path into the
  // dialog creates the folder. Refusing here would refuse the ordinary case.
  const plan = publish({ relative: 'not-made-yet/deeper/report.pdf' });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.place.path, path.join('not-made-yet', 'deeper', 'report.pdf'));
});

// ── The state is derived, and the caller never declares it ──────────────────

check('the caller naming a state is ignored, and the row decides', () => {
  const plan = wp.planPublish({
    file: { ...FILE, state: 'public', published: true },
    domain: 'example.com', relative: 'report.pdf',
    sites: SITES, siteRoot, entitlement: UNLIMITED,
  });
  assert.strictEqual(plan.from, ws.PRIVATE, 'a declared state was believed');
  assert.strictEqual(plan.to, ws.PUBLIC);
});

refuses('a file that is already published is refused rather than quietly moved',
  wp.planPublish({ file: PUBLISHED, domain: 'example.com', relative: 'elsewhere.pdf',
    sites: SITES, siteRoot, entitlement: UNLIMITED }),
  /already published/, 409);

check('publishing something shared revokes its links in the same change', () => {
  const plan = publish({ activeShares: 2 });
  assert.strictEqual(plan.from, ws.SHARED);
  assert.strictEqual(plan.revokesShares, true,
    'a link promising an expiry was left alive against a copy that has none');
});

check('publishing something private revokes nothing, because there is nothing to revoke', () => {
  assert.strictEqual(publish().revokesShares, false);
});

check('crossing into public is flagged, because that is what the dialog asks about', () => {
  assert.strictEqual(publish().crossesIntoPublic, true);
});

// ── The record describes the copy that was actually made ────────────────────

check('the URL, the place and the record all name the same address', () => {
  const plan = publish({ relative: 'docs/report.pdf' });
  assert.strictEqual(plan.public_url, 'https://example.com/docs/report.pdf');
  assert.strictEqual(plan.place.path, 'docs/report.pdf');
  assert.strictEqual(plan.record.published_path, 'docs/report.pdf');
  assert.strictEqual(plan.record.published_domain, 'example.com');
  assert.match(plan.audit.details, /https:\/\/example\.com\/docs\/report\.pdf/);
});

check('the place is shaped exactly as site.files.place takes it', () => {
  const plan = publish();
  assert.deepStrictEqual(Object.keys(plan.place).sort(), ['domain', 'path']);
});

check('the audit action is the one the state machine names, not one invented here', () => {
  assert.strictEqual(publish().audit.action, ws.TRANSITIONS['private->public'].action);
  assert.strictEqual(publish().audit.action, 'workspace_published');
});

check('a refusal has a row of its own', () => {
  const row = wp.auditForRefusal('publish', FILE, wp.REFUSALS.notEntitled);
  assert.strictEqual(row.action, 'workspace_publish_refused');
  assert.match(row.details, /report\.pdf/);
  assert.match(row.details, /not part of your plan/);
});

// ── Unpublishing ────────────────────────────────────────────────────────────

check('unpublishing reads the destination off the row, never off the request', () => {
  // Taking the path from the request would let a caller name a path in their own
  // document root that this file was never published to, and have the panel
  // delete it. That is a delete wearing an unpublish's clothes.
  const plan = wp.planUnpublish({ file: PUBLISHED });
  assert.deepStrictEqual(plan.remove, { domain: 'example.com', path: 'report.pdf' });
});

check('unpublishing something already private is a success and not an error', () => {
  const plan = wp.planUnpublish({ file: FILE });
  assert.strictEqual(plan.ok, true);
  assert.strictEqual(plan.noop, true);
  assert.strictEqual(plan.to, ws.PRIVATE);
});

check('a file with live links falls back to shared rather than to private', () => {
  const plan = wp.planUnpublish({ file: PUBLISHED, activeShares: 1 });
  assert.strictEqual(plan.to, ws.SHARED);
  assert.strictEqual(plan.audit.action, 'workspace_unpublished');
});

check('unpublishing clears every published column, so no half state survives', () => {
  const plan = wp.planUnpublish({ file: PUBLISHED });
  assert.deepStrictEqual(plan.record,
    { published_domain: null, published_path: null, published_at: null, published_by: null });
  assert.strictEqual(ws.stateOf({ ...PUBLISHED, ...plan.record }), ws.PRIVATE);
});

check('the record still names the address it was removed from', () => {
  const plan = wp.planUnpublish({ file: PUBLISHED });
  assert.strictEqual(plan.was_public_url, 'https://example.com/report.pdf');
  assert.match(plan.audit.details, /https:\/\/example\.com\/report\.pdf/);
  assert.strictEqual(plan.public_url, null);
});

check('unpublish needs no entitlement, because it only ever narrows reach', () => {
  const plan = wp.planUnpublish({ file: PUBLISHED });
  assert.strictEqual(plan.ok, true);
});

// ── The two halves agree with each other ────────────────────────────────────

check('publish then unpublish returns the row to exactly what it was', () => {
  const out = publish();
  const row = { ...FILE, ...out.record };
  assert.strictEqual(ws.stateOf(row), ws.PUBLIC);
  const back = wp.planUnpublish({ file: row });
  assert.strictEqual(ws.stateOf({ ...row, ...back.record }), ws.PRIVATE);
});

check('a file deleted while public is still refused by the storage model', () => {
  const out = publish();
  const row = { ...FILE, ...out.record };
  assert.ok(ws.refusalForDelete(ws.stateOf(row)), 'the orphan-on-the-web refusal stopped firing');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
