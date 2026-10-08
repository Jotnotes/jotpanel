'use strict';

// A site that was created, listed, configured and reloaded — and served 404 for
// ever.
//
// REPRODUCED on a clean install of this release candidate, through the real
// customer path: POST /api/panel/server/propose with job site.create and
// documentRoot "/var/www/acceptance.example.com/public", then /approve, then
// /execute. The answer was 200 with status "executed", the panel listed the
// site, the vhost was written and nginx reloaded. Measured on the box:
//
//   drwxr-xr-x root:root  /srv/jotpanel-sites/acceptance.example.com
//   drwxr-x--- root:root  /srv/jotpanel-sites/acceptance.example.com/var
//   drwxr-x--- root:root  .../var/www
//   drwxr-x--- root:root  .../var/www/acceptance.example.com
//   drwxr-x--- web_acceptance_...:www-data  .../public             <- leaf right
//   -rw-r----- web_acceptance_...:www-data  .../public/index.html  <- leaf right
//
// The leading slash was stripped, the four-deep path was mirrored inside the
// site, and the mirrored directories were left root:root 0750. nginx runs as
// www-data, which is neither root nor in group root, so it had no SEARCH
// permission on the way down: `stat() ... failed (13: Permission denied)`.
// The leaf's own ownership and mode were correct the whole time.
//
// Three defences, tested here rather than described:
//   1. an absolute document root is refused, at the proposal and again at the
//      executor, instead of being quietly turned into a path nobody typed;
//   2. any directory invented between the site's base and its document root is
//      searchable by the web service user — including on a machine that already
//      has the 0750 ones, because mkdirSync does not re-mode what exists;
//   3. the read-back answers the serving question itself, so this can never
//      report "executed" again while the path would 404.
//
// Runs as an ordinary user with no server up: every check is about modes and
// about the permission arithmetic the kernel would do, on a scratch tree.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-docroot-'));
const siteRoot = path.join(root, 'srv', 'jotpanel-sites');
fs.mkdirSync(siteRoot, { recursive: true });
process.env.JOTPANEL_OPS_SITE_ROOT = siteRoot;
process.env.JOTPANEL_OPS_STATE_DIR = path.join(root, 'state');
fs.mkdirSync(process.env.JOTPANEL_OPS_STATE_DIR, { recursive: true });

const DOMAIN = 'acceptance.example.com';
const ABSOLUTE = `/var/www/${DOMAIN}/public`;
const MIRRORED = `var/www/${DOMAIN}/public`;

fs.writeFileSync(path.join(process.env.JOTPANEL_OPS_STATE_DIR, 'sites.json'), JSON.stringify({
  sites: [{ domain: DOMAIN, user: 'web_acceptance_test', document_root: 'public', aliases: [] }],
}));

const jobs = require('./privilegedJobs');
const { OPERATIONS } = require('./catalogue');
const t = jobs.__testing || {};
for (const name of ['documentRoot', 'siteRelativeRoot', 'mirroredDocumentDirs', 'ensureMirroredDocumentDirs', 'documentRootAccessFailure']) {
  assert.ok(typeof t[name] === 'function', `${name} is not exported for testing`);
}

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const refuses = (name, fn, pattern) => {
  let threw = null;
  try { fn(); } catch (error) { threw = error; }
  assert.ok(threw, `${name}: expected a refusal and got none`);
  assert.match(threw.message, pattern, `${name}: refused with "${threw.message}"`);
  passed++; console.log(`ok  ${name} — refused: ${threw.message}`);
};

// The web server, as this test's kernel would see it: an account that is not
// this test's own user, in the one group the site's document root is shared
// with and in nothing else. That is exactly nginx's position on the box — it
// has www-data on the leaf, and it has root:root on everything above.
//
// A second group this test user already belongs to stands in for www-data where
// one exists, so the leaf is genuinely group-shared and the directories above it
// are genuinely not. Where the user has only its primary group, the same
// distinction is written as modes: a root:root 0750 directory offers an account
// outside group root precisely what 0700 offers it, which is nothing.
const OTHER_GIDS = (process.getgroups ? [...new Set(process.getgroups())] : []).filter(gid => gid !== process.getgid());
const SHARED_GID = OTHER_GIDS.length ? OTHER_GIDS[0] : process.getgid();
const ROOT_ONLY_MODE = SHARED_GID === process.getgid() ? 0o700 : 0o750;
const WEB = { user: 'www-data', uid: 65534, gids: [SHARED_GID] };
assert.notStrictEqual(WEB.uid, process.getuid(), 'the stand-in web user must not be this test user');
const shareWithWeb = target => { if (SHARED_GID !== process.getgid()) fs.chownSync(target, process.getuid(), SHARED_GID); };

// ── 1. The absolute document root is refused, not reinterpreted ───
const operation = id => OPERATIONS.find(entry => entry.id === id);

refuses('site.create refuses an absolute document root at the proposal',
  () => operation('site.create').normalize({ domain: DOMAIN, documentRoot: ABSOLUTE }),
  /folder inside the site, not a path on the server/);

refuses('site.document-root refuses the same input at the proposal',
  () => operation('site.document-root').normalize({ domain: DOMAIN, documentRoot: ABSOLUTE }),
  /folder inside the site, not a path on the server/);

refuses('and the executor refuses it too, so a stale proposal cannot slip through',
  () => t.siteRelativeRoot(ABSOLUTE),
  /no leading slash/);

check('the refusal says what to type instead', () => {
  let message = '';
  try { t.siteRelativeRoot(ABSOLUTE); } catch (error) { message = error.message; }
  assert.match(message, /public/, 'the refusal does not name a document root that works');
});

// ── The relative default, which works and must keep working ───────
check('the default "public" is accepted unchanged at the proposal', () => {
  assert.strictEqual(operation('site.create').normalize({ domain: DOMAIN, documentRoot: 'public' }).documentRoot, 'public');
  assert.strictEqual(operation('site.create').normalize({ domain: DOMAIN }).documentRoot, 'public');
  assert.strictEqual(operation('site.document-root').normalize({ domain: DOMAIN, documentRoot: 'public' }).documentRoot, 'public');
});

check('the default "public" is accepted unchanged at the executor', () => {
  assert.strictEqual(t.siteRelativeRoot('public'), 'public');
  assert.strictEqual(t.siteRelativeRoot(undefined), 'public');
  assert.strictEqual(t.siteRelativeRoot(''), 'public');
});

check('a nested relative root, which a cPanel migration can hand over, is still accepted', () => {
  assert.strictEqual(operation('site.create').normalize({ domain: DOMAIN, documentRoot: 'public_html/shop' }).documentRoot, 'public_html/shop');
  assert.strictEqual(t.siteRelativeRoot('public_html/shop'), 'public_html/shop');
});

check('the default root invents no intermediate directories at all', () => {
  assert.deepStrictEqual(t.mirroredDocumentDirs({ domain: DOMAIN, document_root: 'public' }), []);
});

// The flow that worked on the box, rebuilt here so a fix that broke it would be
// caught: base 0755 root-owned, document root 0750 shared with the web group.
const base = path.join(siteRoot, DOMAIN);
const shallow = path.join(base, 'public');
fs.mkdirSync(shallow, { recursive: true });
fs.chmodSync(siteRoot, 0o755);
fs.chmodSync(base, 0o755);
fs.chmodSync(shallow, 0o750);
shareWithWeb(shallow);
fs.writeFileSync(path.join(shallow, 'index.html'), `${DOMAIN}\n`);
fs.chmodSync(path.join(shallow, 'index.html'), 0o640);
shareWithWeb(path.join(shallow, 'index.html'));

check('the relative default serves: the web user can traverse and read it end to end', () => {
  const failure = t.documentRootAccessFailure(shallow, WEB, path.join(shallow, 'index.html'), { from: root });
  assert.strictEqual(failure, null, `the working flow was reported as broken: ${failure}`);
});

// ── 2. The mirrored directories, which is where the 404 lived ─────
//
// A machine that already has this document root on file — the install the defect
// was reproduced on, and an upgrade of it — reaches the same code with the
// directories already there at 0750. That is the case mkdirSync cannot fix.
const site = { domain: DOMAIN, document_root: MIRRORED, owner_uid: process.getuid() };
const deep = t.documentRoot(site);
const expected = [path.join(base, 'var'), path.join(base, 'var', 'www'), path.join(base, 'var', 'www', DOMAIN)];

check('an absolute root that does reach the executor stays inside the site', () => {
  assert.strictEqual(deep, path.join(base, MIRRORED));
  assert.ok(deep.startsWith(`${base}${path.sep}`), `${deep} left the site directory`);
  assert.deepStrictEqual(t.mirroredDocumentDirs(site), expected);
});

// The broken machine, exactly as measured: root-owned 0750 all the way down,
// leaf correct.
for (const dir of expected) { fs.mkdirSync(dir, { recursive: true }); fs.chmodSync(dir, ROOT_ONLY_MODE); }
fs.mkdirSync(deep, { recursive: true });
fs.chmodSync(deep, 0o750);
shareWithWeb(deep);
fs.writeFileSync(path.join(deep, 'index.html'), `${DOMAIN}\n`);
fs.chmodSync(path.join(deep, 'index.html'), 0o640);
shareWithWeb(path.join(deep, 'index.html'));

check('the reproduced install is diagnosed, leaf-correct and all', () => {
  const failure = t.documentRootAccessFailure(deep, WEB, path.join(deep, 'index.html'), { from: root });
  assert.ok(failure, 'the 404 chain was reported as serviceable');
  assert.match(failure, /cannot enter/);
  assert.ok(failure.includes(expected[0]), `the reason names ${failure} rather than the first directory that cannot be entered`);
  assert.match(failure, /404/, 'the reason does not say what the customer would see');
  // And the leaf itself was never the problem, which is why owning it is not a
  // read-back.
  assert.strictEqual(fs.statSync(deep).mode & 0o777, 0o750);
  assert.strictEqual(t.documentRootAccessFailure(deep, WEB, null, { from: expected[2] }), null,
    'the leaf of the reproduced chain was not serviceable, so this test is not reproducing the defect');
});

check('repairing an already-installed machine re-modes directories that already exist', () => {
  const made = t.ensureMirroredDocumentDirs(site);
  assert.deepStrictEqual(made, expected);
  for (const dir of expected) {
    const mode = fs.statSync(dir).mode & 0o777;
    assert.strictEqual(mode & 0o001, 0o001, `${dir} is mode ${mode.toString(8)}: the web user still cannot search it`);
    assert.strictEqual(mode, 0o711, `${dir} is mode ${mode.toString(8)}, not the 0711 search-only mode`);
  }
});

check('and the fresh machine gets the same modes, under any umask', () => {
  const fresh = { domain: DOMAIN, document_root: 'deep/er/still/public' };
  const previous = process.umask(0o077);
  try { t.ensureMirroredDocumentDirs(fresh); } finally { process.umask(previous); }
  for (const dir of t.mirroredDocumentDirs(fresh)) {
    assert.strictEqual(fs.statSync(dir).mode & 0o777, 0o711, `${dir} came out of mkdirSync masked and was not corrected`);
  }
});

check('no mirrored directory is group-writable, world-writable or readable', () => {
  for (const dir of [...expected, ...t.mirroredDocumentDirs({ domain: DOMAIN, document_root: 'deep/er/still/public' })]) {
    const mode = fs.statSync(dir).mode & 0o777;
    assert.strictEqual(mode & 0o022, 0, `${dir} is writable beyond its owner: ${mode.toString(8)}`);
    assert.strictEqual(mode & 0o044, 0, `${dir} can be listed by somebody other than its owner: ${mode.toString(8)}`);
  }
});

// ── 3. The read-back cannot report success for a 404 ──────────────
check('the whole chain is checked, not just the first or the last link', () => {
  const middle = expected[1];
  fs.chmodSync(middle, ROOT_ONLY_MODE);
  const failure = t.documentRootAccessFailure(deep, WEB, path.join(deep, 'index.html'), { from: root });
  assert.ok(failure && failure.includes(middle), `an unsearchable directory in the middle of the chain was missed: ${failure}`);
  fs.chmodSync(middle, 0o711);
});

check('with every mirrored directory searchable, the absolute case finally reads back as serviceable', () => {
  const failure = t.documentRootAccessFailure(deep, WEB, path.join(deep, 'index.html'), { from: root });
  assert.strictEqual(failure, null, `the repaired chain is still unserviceable: ${failure}`);
});

check('an unreadable entry file is caught too, since a 403 is not a working site', () => {
  const index = path.join(deep, 'index.html');
  fs.chmodSync(index, 0o600);
  const failure = t.documentRootAccessFailure(deep, WEB, index, { from: root });
  assert.ok(failure && failure.includes('cannot read'), `an unreadable index was reported as serviceable: ${failure}`);
  fs.chmodSync(index, 0o640);
});

check('a document root that is not there is a failure, not a success', () => {
  const missing = path.join(base, 'not', 'created');
  assert.match(t.documentRootAccessFailure(missing, WEB, null, { from: root }), /is not there/);
});

check('root is not asked the question, because root can always traverse', () => {
  fs.chmodSync(expected[0], 0o700);
  assert.strictEqual(t.documentRootAccessFailure(deep, { user: 'root', uid: 0, gids: [0] }, null, { from: root }), null);
  // And the web user is still told the truth about the same directory, which is
  // the mistake the panel made: it checked what root could do.
  assert.ok(t.documentRootAccessFailure(deep, WEB, null, { from: root }));
  fs.chmodSync(expected[0], 0o711);
});

check('the walk starts at the filesystem root when nobody says otherwise', () => {
  // The scratch tree lives under a temp directory this test user owns privately,
  // so a walk from / is expected to stop somewhere above the site. What is being
  // proved is that it walks the real chain rather than trusting a start point.
  const failure = t.documentRootAccessFailure(deep, WEB, null);
  assert.ok(failure && failure.includes('cannot enter'), `the default walk accepted a chain it had not checked: ${failure}`);
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
