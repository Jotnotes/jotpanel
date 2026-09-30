'use strict';

// The symlink race, tested on a real filesystem.
//
// A site's own user has SFTP into its own tree and can put a link anywhere in
// it. Every write the panel makes into a site therefore has to assume that what
// it is about to open may have been swapped for a link since it was checked.
// This is cPanel's symlink escalation, which is named in COMPETITIVE_POSITION.md
// as one worth testing against, and these are the two primitives that stop it.

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { copyIntoSite, writeIntoSite } = require('./privilegedJobs');

function inATemporaryTree(work) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-nofollow-'));
  try { work(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function testAWriteWillNotFollowALinkOutOfTheSite() {
  inATemporaryTree(root => {
    const outside = path.join(root, 'shadow');
    fs.writeFileSync(outside, 'root:x:0:0\n');
    const inside = path.join(root, 'site.php');
    fs.symlinkSync(outside, inside);

    // The file the caller named is a link. Following it would write the panel's
    // content into a file outside the site, as root.
    assert.throws(() => writeIntoSite(inside, '<?php system($_GET["c"]); ?>'), error => error.code === 'ELOOP');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'root:x:0:0\n');
  });
}

function testAnUploadWillNotFollowALinkEither() {
  inATemporaryTree(root => {
    const outside = path.join(root, 'authorized_keys');
    fs.writeFileSync(outside, 'ssh-ed25519 the-real-one\n');
    const staged = path.join(root, 'upload');
    fs.writeFileSync(staged, 'ssh-ed25519 the-attackers-one\n');
    const inside = path.join(root, 'logo.png');
    fs.symlinkSync(outside, inside);

    assert.throws(() => copyIntoSite(staged, inside), error => error.code === 'ELOOP');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'ssh-ed25519 the-real-one\n');
  });
}

function testAnOrdinaryWriteStillWorks() {
  // The defence is worth nothing if it also refuses the ordinary case, so both
  // primitives are exercised on a plain file and on an overwrite.
  inATemporaryTree(root => {
    const target = path.join(root, 'index.php');
    writeIntoSite(target, '<?php echo 1;');
    assert.equal(fs.readFileSync(target, 'utf8'), '<?php echo 1;');
    writeIntoSite(target, 'shorter');
    // Truncated rather than overlaid, which is the bug you get from forgetting
    // O_TRUNC once the open is being built by hand.
    assert.equal(fs.readFileSync(target, 'utf8'), 'shorter');
    assert.equal(fs.statSync(target).mode & 0o777, 0o640);

    const staged = path.join(root, 'staged.bin');
    // Larger than the one megabyte copy buffer, so the chunk loop is exercised
    // rather than only its first pass.
    const payload = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
    fs.writeFileSync(staged, payload);
    const placed = path.join(root, 'placed.bin');
    copyIntoSite(staged, placed);
    assert.deepEqual(fs.readFileSync(placed), payload);
  });
}

function run() {
  const tests = [
    testAWriteWillNotFollowALinkOutOfTheSite,
    testAnUploadWillNotFollowALinkEither,
    testAnOrdinaryWriteStillWorks,
  ];
  for (const test of tests) { test(); console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`); }
  console.log(`no-follow tests passed (${tests.length})`);
}

run();
