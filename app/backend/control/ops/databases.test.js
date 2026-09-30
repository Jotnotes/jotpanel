'use strict';

// Two database engines behind one set of operations.
//
// The risk in adding a second engine is not that Postgres does not work. It is
// that the panel now has two of something it used to have one of, and every
// place that assumed one is a place that can quietly do the work on the wrong
// server. These check that the engine travels with the request and that an
// engine nobody recognises is refused rather than guessed at.

const assert = require('assert/strict');
const { OPERATIONS, getOperation } = require('./catalogue');
const { SPECS } = require('./privilegedJobs');

const DATABASE_OPERATIONS = OPERATIONS.filter(op => op.capability.startsWith('database.'));

function testEveryDatabaseOperationCarriesTheEngine() {
  // A database operation that drops the engine on the floor is one that will be
  // carried out on whichever server the daemon happens to find first, which on
  // a machine with both is a coin toss over somebody's data.
  const sample = { name: 'shop', username: 'shopuser', password: 'Str0ngPass.99', privileges: 'all', engine: 'postgres', uploadId: 'up_1', sql: 'SELECT 1' };
  const dropped = [];
  for (const op of DATABASE_OPERATIONS) {
    let params;
    try { params = op.normalize(sample); } catch (error) { dropped.push(`${op.id} refused a valid sample: ${error.message}`); continue; }
    if (params.engine !== 'postgres') dropped.push(`${op.id} lost the engine (got ${JSON.stringify(params.engine)})`);
  }
  assert.deepEqual(dropped, []);
  // Seven writes; the dump and the table listing are reads and live in READS.
  assert.ok(DATABASE_OPERATIONS.length >= 7, `only ${DATABASE_OPERATIONS.length} database operations were checked`);
}

function testAnEngineNobodyKnowsIsRefused() {
  const create = getOperation('database.create');
  assert.throws(() => create.normalize({ name: 'shop', engine: 'oracle' }), /database engine/);
  assert.throws(() => create.normalize({ name: 'shop', engine: 'postgres; DROP DATABASE x' }), /database engine/);
  // And no engine at all is allowed, because a machine with one server should
  // not make anybody choose.
  assert.equal(create.normalize({ name: 'shop' }).engine, undefined);
}

function testBothEnginesCanBeInstalledAsTheirOwnStack() {
  const ids = OPERATIONS.filter(op => op.capability === 'stack.install').map(op => op.id);
  assert.ok(ids.includes('stack.install.database'), 'MariaDB has no installer row');
  assert.ok(ids.includes('stack.install.postgres'), 'PostgreSQL has no installer row');
  // Named for what they are. "Install the fixed PostgreSQL package set" is a
  // sentence somebody can approve; "install database" is not.
  const postgres = getOperation('stack.install.postgres');
  assert.match(postgres.label({}), /PostgreSQL/);
  assert.equal(postgres.risk, 'elevated');
}

function testTheNamedJobsAllAcceptAnEngine() {
  // The catalogue emits `engine` on every database operation, so every job
  // behind one has to accept it or the action dies at the socket after it has
  // already been approved.
  const missing = [];
  for (const [job, [allowed]] of Object.entries(SPECS)) {
    if (!job.startsWith('database.') || job === 'database.list') continue;
    if (!allowed.includes('engine')) missing.push(job);
  }
  assert.deepEqual(missing, []);
}

function run() {
  const tests = [
    testEveryDatabaseOperationCarriesTheEngine,
    testAnEngineNobodyKnowsIsRefused,
    testBothEnginesCanBeInstalledAsTheirOwnStack,
    testTheNamedJobsAllAcceptAnEngine,
  ];
  for (const test of tests) { test(); console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`); }
  console.log(`database tests passed (${tests.length})`);
}

run();
