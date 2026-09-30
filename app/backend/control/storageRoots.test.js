'use strict';

// The private/published boundary, tested the way somebody would attack it.
// Every case here is a path that looks like it belongs to the published
// directory and does not.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { rootsFor, ensureRoot, isInside, servedPathFor, crossesIntoPublic, planRelocation } = require('./storageRoots');

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-storage-'));
const USER = 'u_test';
const roots = rootsFor(uploads, USER);
ensureRoot(uploads, USER, 'private');
ensureRoot(uploads, USER, 'published');

const write = (dir, name, body = 'x') => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

const publishedFile = write(roots.published, 'index.html', '<h1>public</h1>');
const privateFile = write(roots.private, 'tax-return.pdf', 'private');

check('a published file is served', () => {
  assert.strictEqual(servedPathFor(uploads, USER, publishedFile), fs.realpathSync(publishedFile));
});

check('a private file is never served, even asked for by its real path', () => {
  assert.strictEqual(servedPathFor(uploads, USER, privateFile), null);
});

// The row is the only thing saying which directory a file is in, so the case
// that matters is a row that points somewhere it should not.
check('a row pointing out of the published directory with .. is refused', () => {
  const sneaky = path.join(roots.published, '..', 'private', 'tax-return.pdf');
  assert.strictEqual(servedPathFor(uploads, USER, sneaky), null);
});

check('a sibling directory with the same prefix is not inside it', () => {
  assert.strictEqual(isInside(roots.published, `${roots.published}-other/x`), false);
  const other = path.join(roots.base, 'published-other');
  fs.mkdirSync(other, { recursive: true });
  const decoy = write(other, 'x.html');
  assert.strictEqual(servedPathFor(uploads, USER, decoy), null);
});

check('the published directory itself is not a file to serve', () => {
  assert.strictEqual(servedPathFor(uploads, USER, roots.published), null);
});

// The reason the check resolves symlinks rather than comparing strings.
check('a symlink inside published pointing at a private file is refused', () => {
  const link = path.join(roots.published, 'looks-public.pdf');
  fs.symlinkSync(privateFile, link);
  assert.strictEqual(servedPathFor(uploads, USER, link), null);
});

check('another account\'s published file is not served under this account', () => {
  const other = rootsFor(uploads, 'u_other');
  ensureRoot(uploads, 'u_other', 'published');
  const theirs = write(other.published, 'theirs.html');
  assert.strictEqual(servedPathFor(uploads, USER, theirs), null);
  assert.strictEqual(servedPathFor(uploads, 'u_other', theirs), fs.realpathSync(theirs));
});

check('a missing file and a nonsense row are both simply not served', () => {
  assert.strictEqual(servedPathFor(uploads, USER, path.join(roots.published, 'gone.html')), null);
  assert.strictEqual(servedPathFor(uploads, USER, ''), null);
  assert.strictEqual(servedPathFor(uploads, USER, null), null);
  assert.strictEqual(servedPathFor(uploads, USER, '/etc/passwd'), null);
});

check('moving a private file into the published directory is flagged as crossing', () => {
  assert.strictEqual(crossesIntoPublic(uploads, USER, privateFile, path.join(roots.published, 'tax-return.pdf')), true);
  assert.strictEqual(crossesIntoPublic(uploads, USER, publishedFile, path.join(roots.private, 'index.html')), false);
  assert.strictEqual(crossesIntoPublic(uploads, USER, privateFile, path.join(roots.private, 'copy.pdf')), false);
});

// Relocation, for boxes that carry files from before the split.
check('legacy rows are planned into the directory their table implies', () => {
  const legacyPrivate = write(roots.base, 'old-private.pdf');
  const legacyPublished = write(roots.base, 'old-page.html');
  const plan = planRelocation({
    uploadsDir: uploads,
    rows: [
      { id: 'f1', user_id: USER, disk_path: legacyPrivate, published: false },
      { id: 'p1', user_id: USER, disk_path: legacyPublished, published: true },
      // Already in the right place, so it is not touched.
      { id: 'p2', user_id: USER, disk_path: publishedFile, published: true },
    ],
  });
  assert.strictEqual(plan.length, 2);
  assert.strictEqual(plan.find(p => p.id === 'f1').to, path.join(roots.private, 'old-private.pdf'));
  assert.strictEqual(plan.find(p => p.id === 'p1').to, path.join(roots.published, 'old-page.html'));
});

check('a row pointing outside the account directory is left alone rather than moved', () => {
  const elsewhere = write(uploads, 'not-ours.pdf');
  const plan = planRelocation({ uploadsDir: uploads, rows: [{ id: 'f9', user_id: USER, disk_path: elsewhere, published: false }] });
  assert.deepStrictEqual(plan, []);
});

fs.rmSync(uploads, { recursive: true, force: true });
console.log(`\n${passed} checks passed`);
