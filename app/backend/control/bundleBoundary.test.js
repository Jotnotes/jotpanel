'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '../../..');
const script = path.join(root, 'scripts/build-customer-bundle.sh');
const source = fs.readFileSync(script, 'utf8');
for (const name of ['license-server.js', 'engine-server.js']) {
  assert.ok(source.includes(`--exclude='app/backend/${name}'`));
  assert.ok(source.includes(`STAGE/app/backend/${name}`));
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-bundle-test-'));
const output = path.join(temp, 'customer.tar.gz');
try {
  const built = spawnSync('bash', [script, output], { cwd: root, encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const listed = spawnSync('tar', ['-tzf', output], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout.includes('app/backend/license-server.js'), false);
  assert.equal(listed.stdout.includes('app/backend/licenseAllocations.test.js'), false);
  assert.equal(listed.stdout.includes('app/backend/engine-server.js'), false);
  assert.equal(listed.stdout.includes('app/backend/engine-server.test.js'), false);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log('customer bundle excludes internal license and engine services');
