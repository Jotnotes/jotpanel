'use strict';

// The three-state model, tested against the ways it can quietly stop being true.
//
// Two families of test here. The first is the geometry: the store is outside
// every document root, and a path cannot be talked out of the store by a link or
// a `..`. The second is the state machine: the states are exclusive, a public
// copy never consumes its source, and the transitions nobody designed are
// refusals rather than defaults.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ws = require('./workspaceStorage');
const storageRoots = require('./storageRoots');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-workspace-'));
const uploads = path.join(tmp, 'uploads');
const siteRoot = path.join(tmp, 'srv', 'arca-sites');
const outside = path.join(tmp, 'outside');
fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(siteRoot, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

const USER = 'u_ws';
const store = ws.ensureStore(uploads, USER);

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const refuses = (name, fn, pattern) => {
  let threw = null;
  try { fn(); } catch (error) { threw = error; }
  assert.ok(threw, `${name}: expected a refusal and got none`);
  if (pattern) assert.match(threw.message, pattern, `${name}: refused with "${threw.message}"`);
  passed++; console.log(`ok  ${name} — refused: ${threw.message}`);
};

// ── The store is where the model says it is ─────────────────────────────────

check('the store is the vault private root and not a fourth directory beside it', () => {
  assert.strictEqual(store, storageRoots.rootsFor(uploads, USER).private);
  assert.strictEqual(ws.rootsFor(uploads, USER).store, store);
});

// The claim the whole model rests on, asked of the route that does the serving
// rather than of a comment.
check('nothing in the store is served by the panel, asked of the serving gate itself', () => {
  const file = path.join(store, 'tax-return.pdf');
  fs.writeFileSync(file, 'private');
  assert.strictEqual(storageRoots.servedPathFor(uploads, USER, file), null);
});

check('a store beside the document roots passes the boot assertion', () => {
  assert.strictEqual(ws.assertOutsideDocroots(store, [siteRoot, path.join(uploads, USER, 'published')]), true);
});

refuses('a store inside a document root is refused at boot', () => {
  const bad = path.join(siteRoot, 'example.com', 'public', 'uploads');
  fs.mkdirSync(bad, { recursive: true });
  ws.assertOutsideDocroots(bad, [siteRoot]);
}, /is inside the document root/);

// The easier of the two to arrive at by accident, and just as fatal.
refuses('a document root inside the store is refused at boot', () => {
  const nested = path.join(store, 'sites');
  fs.mkdirSync(nested, { recursive: true });
  ws.assertOutsideDocroots(store, [nested]);
}, /is inside the workspace store/);

refuses('the store and a document root being the same directory is refused', () => {
  ws.assertOutsideDocroots(store, [store]);
}, /the same directory/);

// ── Paths ───────────────────────────────────────────────────────────────────

check('an ordinary path inside the store resolves', () => {
  const r = ws.resolveInStore(uploads, USER, 'invoices/2026/march.pdf');
  assert.strictEqual(r.target, path.join(store, 'invoices', '2026', 'march.pdf'));
  assert.strictEqual(r.relative, path.join('invoices', '2026', 'march.pdf'));
});

refuses('a path climbing out of the store is refused', () => {
  ws.resolveInStore(uploads, USER, '../published/index.html');
}, /outside the workspace/);

refuses('a leading slash does not make it an absolute path somewhere else', () => {
  ws.resolveInStore(uploads, USER, '/../../../etc/passwd');
}, /outside the workspace/);

refuses('a NUL byte in a path is refused', () => {
  ws.resolveInStore(uploads, USER, 'ok\0.pdf');
}, /not valid/);

check('one account cannot name another account\'s store, because the id is the root', () => {
  ws.ensureStore(uploads, 'u_other');
  const mine = ws.resolveInStore(uploads, USER, 'x.pdf').target;
  const theirs = ws.resolveInStore(uploads, 'u_other', 'x.pdf').target;
  assert.notStrictEqual(mine, theirs);
});

// The escape that actually worked on this codebase on 2026-08-28, in the shape
// that made it work: a link partway along the path, and a leaf that does not
// exist yet, which is the case a realpath check never sees.
check('a link partway along the path is caught even when the leaf does not exist', () => {
  const link = path.join(store, 'escape');
  fs.symlinkSync(outside, link);
  let threw = null;
  try { ws.containedPath(store, 'escape/NEW-FILE.txt'); } catch (error) { threw = error; }
  assert.ok(threw, 'a write through a link out of the store was allowed');
  assert.match(threw.message, /leaves the workspace through a link/);
  assert.strictEqual(fs.existsSync(path.join(outside, 'NEW-FILE.txt')), false);
});

refuses('an existing file reached through a link out of the store is refused', () => {
  fs.writeFileSync(path.join(outside, 'theirs.txt'), 'x');
  ws.containedPath(store, 'escape/theirs.txt', { mustExist: true });
}, /leaves the workspace through a link/);

refuses('mustExist means what it says', () => {
  ws.resolveInStore(uploads, USER, 'nothing-here.pdf', { mustExist: true });
}, /does not exist/);

// ── The public target ───────────────────────────────────────────────────────

check('a public target lands in the site document root', () => {
  const t = ws.publicTargetFor({ siteRoot, domain: 'Example.COM.', relative: 'brochure.pdf' });
  assert.strictEqual(t.domain, 'example.com');
  assert.strictEqual(t.target, path.join(siteRoot, 'example.com', 'public', 'brochure.pdf'));
});

check('a site with its own document root is honoured', () => {
  const t = ws.publicTargetFor({ siteRoot, domain: 'example.com', documentRoot: 'public_html/live', relative: 'a/b.txt' });
  assert.strictEqual(t.target, path.join(siteRoot, 'example.com', 'public_html', 'live', 'a', 'b.txt'));
});

refuses('a publish target climbing out of the document root is refused', () => {
  ws.publicTargetFor({ siteRoot, domain: 'example.com', relative: '../../../../etc/cron.d/pwn' });
}, /outside the site/);

refuses('a document root climbing out of the site is refused', () => {
  ws.publicTargetFor({ siteRoot, domain: 'example.com', documentRoot: '../../etc', relative: 'x' });
}, /outside the site/);

refuses('a publish target with no name is refused', () => {
  ws.publicTargetFor({ siteRoot, domain: 'example.com', relative: '' });
}, /needs a name/);

refuses('something that is not a domain does not become a directory name', () => {
  ws.publicTargetFor({ siteRoot, domain: '../../../etc', relative: 'x' });
}, /is not a domain name/);

// The panel usually cannot see /srv at all, and a check that throws because of
// that would refuse every legitimate publish on a real box.
check('a site root this process cannot see still yields a target', () => {
  const t = ws.publicTargetFor({ siteRoot: path.join(tmp, 'not-here'), domain: 'example.com', relative: 'index.html' });
  assert.strictEqual(t.target, path.join(tmp, 'not-here', 'example.com', 'public', 'index.html'));
});

// ...but where it can see the tree, a link already sitting in the document root
// is caught before anything is proposed.
check('a link in a visible document root is caught before a publish is proposed', () => {
  const docroot = path.join(siteRoot, 'linked.example', 'public');
  fs.mkdirSync(docroot, { recursive: true });
  fs.symlinkSync(outside, path.join(docroot, 'assets'));
  let threw = null;
  try { ws.publicTargetFor({ siteRoot, domain: 'linked.example', relative: 'assets/logo.png' }); }
  catch (error) { threw = error; }
  assert.ok(threw, 'a publish through a link out of the document root was allowed');
});

// ── The state of a row ──────────────────────────────────────────────────────

check('state is derived from the row and never from what a caller says', () => {
  assert.strictEqual(ws.stateOf({ state: 'public' }), ws.PRIVATE);
  assert.strictEqual(ws.stateOf({ published_domain: 'example.com', published_path: 'a.pdf' }), ws.PUBLIC);
  assert.strictEqual(ws.stateOf({}, { activeShares: 1 }), ws.SHARED);
  assert.strictEqual(ws.stateOf({}, { activeShares: 0 }), ws.PRIVATE);
  assert.strictEqual(ws.stateOf(null), ws.PRIVATE);
});

// Exclusive, and public wins, because public is the one that is true of the
// internet whatever else is also recorded.
check('a row that is both published and shared reads as public', () => {
  assert.strictEqual(ws.stateOf({ published_domain: 'example.com', published_path: 'a.pdf' }, { activeShares: 3 }), ws.PUBLIC);
});

check('reachability says the same thing everywhere it is asked', () => {
  assert.strictEqual(ws.reachability(ws.PRIVATE).internet, false);
  assert.strictEqual(ws.reachability(ws.SHARED).internet, false);
  assert.strictEqual(ws.reachability(ws.SHARED).linkHolder, true);
  assert.strictEqual(ws.reachability(ws.PUBLIC).internet, true);
  assert.strictEqual(ws.reachability('nonsense').internet, false);
});

// ── Transitions ─────────────────────────────────────────────────────────────

check('sharing moves no bytes', () => {
  const plan = ws.planTransition(ws.PRIVATE, ws.SHARED);
  assert.strictEqual(plan.copies, false);
  assert.strictEqual(plan.removes, false);
  assert.strictEqual(plan.audited, true);
});

check('publishing copies and never consumes the source', () => {
  const plan = ws.planTransition(ws.PRIVATE, ws.PUBLIC);
  assert.strictEqual(plan.copies, true);
  assert.strictEqual(plan.removes, false);
  assert.strictEqual(plan.entitlement, ws.ENTITLEMENTS.publish);
});

check('unpublishing removes only the copy', () => {
  const plan = ws.planTransition(ws.PUBLIC, ws.PRIVATE);
  assert.strictEqual(plan.removes, true);
  assert.strictEqual(plan.copies, false);
});

// The gap that would otherwise let somebody hold a link they believe is
// expiring to a file that is in fact on the open web forever.
check('publishing something shared revokes its links in the same change', () => {
  assert.strictEqual(ws.planTransition(ws.SHARED, ws.PUBLIC).revokesShares, true);
  assert.strictEqual(ws.planTransition(ws.SHARED, ws.PRIVATE).revokesShares, true);
});

check('every transition is audited, because every one of them changes who can reach the file', () => {
  for (const plan of Object.values(ws.TRANSITIONS)) {
    assert.strictEqual(plan.audited, true);
    assert.ok(plan.action, 'a transition with no audit action');
    assert.ok(plan.describe, 'a transition with no sentence for the record');
  }
});

check('a transition to the state it is already in is nothing to do, not an error', () => {
  assert.strictEqual(ws.planTransition(ws.PUBLIC, ws.PUBLIC), null);
});

refuses('a state nobody defined is refused rather than defaulted', () => {
  ws.planTransition(ws.PRIVATE, 'sort-of-public');
}, /is not a state/);

check('crossing into public is the question a screen asks before the plan is made', () => {
  assert.strictEqual(ws.crossesIntoPublic(ws.PRIVATE, ws.PUBLIC), true);
  assert.strictEqual(ws.crossesIntoPublic(ws.SHARED, ws.PUBLIC), true);
  assert.strictEqual(ws.crossesIntoPublic(ws.PUBLIC, ws.PRIVATE), false);
  assert.strictEqual(ws.crossesIntoPublic(ws.PRIVATE, ws.SHARED), false);
});

// ── The orphan on the public web ────────────────────────────────────────────

check('deleting the source of a published file is refused, and says the order', () => {
  const refusal = ws.refusalForDelete(ws.PUBLIC);
  assert.ok(refusal, 'deleting a published file was allowed, which orphans the copy on the web');
  assert.match(refusal, /Unpublish it first/);
  assert.strictEqual(ws.refusalForDelete(ws.PRIVATE), null);
  assert.strictEqual(ws.refusalForDelete(ws.SHARED), null);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
