'use strict';

// A stack a person can approve and the panel cannot run is a button that fails
// after they said yes. The voice install shipped exactly that way: the operation
// was in the catalogue, the packages were in the map, and the privileged job
// list — which is an allowlist on purpose — had never heard of it.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { OPERATIONS } = require('./catalogue');

const jobs = fs.readFileSync(path.join(__dirname, '..', '..', 'privileged-oneshot.js'), 'utf8');
const privileged = new Set([...jobs.matchAll(/'(stack-[a-z0-9-]+)':/g)].map(m => m[1]));
const packages = fs.readFileSync(path.join(__dirname, 'privilegedJobs.js'), 'utf8');
const known = new Set([...packages.matchAll(/^\s{2}([a-z0-9]+):\s*\[/gm)].map(m => m[1]));

const offered = OPERATIONS.filter(o => o.capability === 'stack.install')
  .map(o => o.normalize({}).stack);
assert.ok(offered.length >= 10, 'the catalogue offers stacks to install');

for (const stack of offered) {
  assert.ok(privileged.has(`stack-${stack}`),
    `"${stack}" can be approved but has no privileged job: approving it would fail`);
  assert.ok(known.has(stack) || stack === 'voice',
    `"${stack}" has no package list`);
}
assert.ok(offered.includes('voice'), 'voice is one of them');

console.log(`stack job checks passed — all ${offered.length} installable stacks can actually run`);
