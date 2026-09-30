'use strict';

// The rules about which names out of somebody else's archive are allowed to
// become paths on this machine, tested without a machine.
//
// This is the part of a migration that handles the least trusted input in the
// product: entry names written by a panel nobody here controls, on a server
// nobody here controls, chosen by whoever put the account together. The class of
// bug is current rather than historical, zip slip and unsafe link handling both,
// so the checks are per file and after resolution rather than a pattern test on
// the way in.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { membersUnder, writeMembers, countFiles } = require('./migrationContent');

const bytes = value => Buffer.from(value);

function archive(pairs) {
  return new Map(pairs.map(([name, body]) => [name, bytes(body)]));
}

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'arca-migration-content-'));
}

function run() {
  testOnlyWhatIsUnderThePrefixComesOut();
  testTheClimbingNamesNeverBecomeMembers();
  testAPrefixThatMatchesNothingIsEmptyRatherThanEverything();
  testWritingIsCountedInFilesAndBytes();
  testZipSlipIsRefusedAtWriteTimeToo();
  testCountFilesIsTheReadBackAndIgnoresLinks();
  console.log('migration-content tests passed');
}

function testOnlyWhatIsUnderThePrefixComesOut() {
  const entries = archive([
    ['cpmove-alice/homedir/public_html/index.php', '<?php'],
    ['cpmove-alice/homedir/public_html/css/site.css', 'body{}'],
    // A sibling whose name begins with the same letters. A prefix compared as a
    // string rather than as a path boundary would take this too, and the site
    // would quietly receive another site's files.
    ['cpmove-alice/homedir/public_html_old/secret.txt', 'no'],
    ['cpmove-alice/homedir/mail/example.com/joe/cur/1.', 'mail'],
  ]);

  const files = membersUnder(entries, 'cpmove-alice/homedir/public_html/');
  assert.deepEqual(files.map(f => f.relative).sort(), ['css/site.css', 'index.php']);

  // A prefix given without its trailing slash means the same thing.
  assert.equal(membersUnder(entries, 'cpmove-alice/homedir/public_html').length, 2);

  const mail = membersUnder(entries, 'cpmove-alice/homedir/mail/example.com/joe/');
  assert.deepEqual(mail.map(f => f.relative), ['cur/1.']);
}

function testTheClimbingNamesNeverBecomeMembers() {
  const entries = archive([
    ['cpmove-alice/homedir/public_html/ok.txt', 'fine'],
    ['cpmove-alice/homedir/public_html/../../../etc/passwd', 'root:x:0:0'],
    ['cpmove-alice/homedir/public_html/a/../../b/escape.txt', 'no'],
    ['cpmove-alice/homedir/public_html/sub/', ''],
  ]);
  const files = membersUnder(entries, 'cpmove-alice/homedir/public_html/');
  assert.deepEqual(files.map(f => f.relative), ['ok.txt']);
}

function testAPrefixThatMatchesNothingIsEmptyRatherThanEverything() {
  const entries = archive([['cpmove-alice/homedir/public_html/index.php', '<?php']]);
  assert.deepEqual(membersUnder(entries, 'cpmove-alice/homedir/nothing/'), []);
  // An empty prefix is the dangerous one: read as "match everything" it would
  // empty an entire archive into one site's document root.
  assert.deepEqual(membersUnder(entries, ''), []);
  assert.deepEqual(membersUnder(entries, null), []);
  assert.deepEqual(membersUnder(entries, '/'), []);
}

function testWritingIsCountedInFilesAndBytes() {
  const root = scratch();
  try {
    const result = writeMembers(root, [
      { relative: 'index.php', data: bytes('<?php echo 1;') },
      { relative: 'css/site.css', data: bytes('body{}') },
    ]);
    assert.equal(result.written, 2);
    assert.equal(result.bytes, '<?php echo 1;'.length + 'body{}'.length);
    assert.equal(fs.readFileSync(path.join(root, 'css/site.css'), 'utf8'), 'body{}');
    // The directory was made on the way, because an archive lists files and
    // leaves the folders implied.
    assert.ok(fs.statSync(path.join(root, 'css')).isDirectory());
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testZipSlipIsRefusedAtWriteTimeToo() {
  const root = scratch();
  const outside = path.join(root, '..', `escaped-${process.pid}.txt`);
  try {
    // membersUnder already drops these, and this is the second line: a caller
    // that built members some other way still cannot write out of the tree.
    const result = writeMembers(path.join(root, 'site'), [
      { relative: 'kept.txt', data: bytes('yes') },
      { relative: `../../escaped-${process.pid}.txt`, data: bytes('no') },
    ]);
    assert.equal(result.written, 1);
    assert.equal(fs.existsSync(outside), false, 'a member resolving outside the root must not be written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    try { fs.unlinkSync(outside); } catch { /* it should never have existed */ }
  }
}

function testCountFilesIsTheReadBackAndIgnoresLinks() {
  const root = scratch();
  try {
    writeMembers(root, [
      { relative: 'a.txt', data: bytes('a') },
      { relative: 'deep/b.txt', data: bytes('b') },
      { relative: 'deep/deeper/c.txt', data: bytes('c') },
    ]);
    assert.equal(countFiles(root), 3);
    // A link is not a file that was placed, and following one would count
    // whatever it points at, which is how a read-back agrees with itself about
    // work it never did.
    fs.symlinkSync('/etc', path.join(root, 'link'));
    assert.equal(countFiles(root), 3);
    assert.equal(countFiles(path.join(root, 'nothing-here')), 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

run();
