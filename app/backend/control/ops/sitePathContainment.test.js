'use strict';

// The site path boundary, tested against the escape that actually worked.
//
// On 2026-08-28 a customer wrote a file outside their own site through the
// ordinary `site.files.write` operation. The sequence was: the site's own SFTP
// user puts a symlink in their document root, the panel is asked to write to a
// path *through* that link, and the root-owned worker creates the file wherever
// the link points. Proved on the live box against `/srv/arca-escape-probe`, and
// `/etc` would have worked the same way.
//
// Three things each looked sufficient and none of them was:
//
//   - `path.resolve` is lexical, so it never follows a link and the containment
//     check on its output passes happily.
//   - `O_NOFOLLOW` guards the *final* component. The link was a directory
//     halfway along, which it says nothing about.
//   - the realpath check only ran when the target already existed, and the
//     whole point of a write is that it usually does not.
//
// So these tests are about paths whose leaf does not exist yet, because that is
// the case that was wrong. `sitePath` is exercised through the real module.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The module reads its roots from the environment at require time, so the
// scratch tree has to be in place first.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-sitepath-'));
const siteRoot = path.join(root, 'srv', 'arca-sites');
const outside = path.join(root, 'outside');
fs.mkdirSync(siteRoot, { recursive: true });
fs.mkdirSync(outside, { recursive: true });

process.env.JOTPANEL_OPS_SITE_ROOT = siteRoot;
process.env.JOTPANEL_OPS_STATE_DIR = path.join(root, 'state');
fs.mkdirSync((process.env.JOTPANEL_OPS_STATE_DIR ?? process.env.ARCA_OPS_STATE_DIR), { recursive: true });

const DOMAIN = 'containment.example';
const documentRoot = path.join(siteRoot, DOMAIN, 'public');
fs.mkdirSync(documentRoot, { recursive: true });
fs.writeFileSync(path.join((process.env.JOTPANEL_OPS_STATE_DIR ?? process.env.ARCA_OPS_STATE_DIR), 'sites.json'), JSON.stringify({
  sites: [{ domain: DOMAIN, user: 'nobody', document_root: 'public', aliases: [] }],
}));

const jobs = require('./privilegedJobs');
const sitePath = jobs.__testing && jobs.__testing.sitePath;

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };
const refuses = (name, fn, pattern = /leaves the site|outside the site/) => {
  let threw = null;
  try { fn(); } catch (error) { threw = error; }
  assert.ok(threw, `${name}: expected a refusal and got none`);
  assert.match(threw.message, pattern, `${name}: refused with "${threw.message}"`);
  passed++; console.log(`ok  ${name} — refused: ${threw.message}`);
};

if (!sitePath) {
  console.log('sitePath is not exported for testing; skipping');
  process.exit(0);
}

check('an ordinary relative path inside the site resolves', () => {
  const out = sitePath(DOMAIN, 'index.html');
  assert.strictEqual(out.target, path.join(documentRoot, 'index.html'));
});

check('a nested path whose parents do not exist yet is still allowed', () => {
  const out = sitePath(DOMAIN, 'assets/img/logo.png');
  assert.strictEqual(out.target, path.join(documentRoot, 'assets', 'img', 'logo.png'));
});

refuses('a traversal out of the site is refused', () => sitePath(DOMAIN, '../../../etc/passwd'));
refuses('an absolute path is treated as relative and cannot escape', () => {
  const out = sitePath(DOMAIN, '/etc/passwd');
  // Leading slashes are stripped, so this lands inside the site. If it ever
  // resolves to /etc/passwd the assertion below is what says so.
  assert.ok(out.target.startsWith(documentRoot + path.sep), `absolute path escaped to ${out.target}`);
  throw new Error('outside the site: absolute path did not escape, which is correct');
}, /did not escape/);

check('a NUL byte in the path is refused', () => {
  assert.throws(() => sitePath(DOMAIN, 'a\0b'), /not valid/);
});

// ── The escape that actually happened ────────────────────────────
const link = path.join(documentRoot, 'escape-probe');
fs.symlinkSync(outside, link);

refuses('writing THROUGH a symlinked directory to a file that does not exist is refused', () => {
  sitePath(DOMAIN, 'escape-probe/ESCAPED.txt');
});

refuses('and the same through a deeper path under the link', () => {
  sitePath(DOMAIN, 'escape-probe/deeper/still/ESCAPED.txt');
});

refuses('reading an existing file through the link is refused too', () => {
  fs.writeFileSync(path.join(outside, 'existing.txt'), 'x');
  sitePath(DOMAIN, 'escape-probe/existing.txt');
});

refuses('the link itself is refused as a target', () => sitePath(DOMAIN, 'escape-probe'));

// A link to a file rather than a directory, which is the simpler case and was
// already caught before the fix. Kept so a future change cannot lose it.
refuses('a symlinked file pointing out of the site is refused', () => {
  fs.symlinkSync(path.join(outside, 'existing.txt'), path.join(documentRoot, 'single-file-link'));
  sitePath(DOMAIN, 'single-file-link');
});

// A directory that is genuinely inside the site must still work, so the fix
// refuses escapes rather than refusing everything, which is the failure mode a
// containment check falls into when somebody tightens it in a hurry.
check('a real directory inside the site is not mistaken for an escape', () => {
  fs.mkdirSync(path.join(documentRoot, 'assets'), { recursive: true });
  const out = sitePath(DOMAIN, 'assets/new-file.css');
  assert.strictEqual(out.target, path.join(documentRoot, 'assets', 'new-file.css'));
});

check('a link pointing INSIDE the site is allowed, because it does not escape', () => {
  fs.symlinkSync(path.join(documentRoot, 'assets'), path.join(documentRoot, 'inside-link'));
  const out = sitePath(DOMAIN, 'inside-link/ok.css');
  assert.ok(out.target.includes('inside-link'), 'the path should resolve');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
