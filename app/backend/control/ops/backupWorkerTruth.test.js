'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  FAILURE_CODES,
  activeFault,
  namesDigest,
  tableNamesFromSql,
  truncateSqlToTableCount,
  verifyArtifactFacts,
  verifyDatabaseObjectSet,
  verifyManifestArtifactSet,
} = require('./backupWorkerTruth');

const workerRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-backup-truth-'));
process.env.JOTPANEL_OPS_STATE_DIR = path.join(workerRoot, 'state');
process.env.JOTPANEL_OPS_SITE_ROOT = path.join(workerRoot, 'sites');
process.env.JOTPANEL_OPS_BACKUP_ROOT = path.join(workerRoot, 'backups');
const { backupCreate } = require('./privilegedJobs');

function testAnEmptyArtifactCannotBecomeSuccess() {
  const result = verifyArtifactFacts({
    bytes: 0,
    createdAtMs: Date.parse('2026-08-25T01:00:00.000Z'),
    sourceObservedAt: '2026-08-25T00:59:00.000Z',
  });
  assert.equal(result.code, FAILURE_CODES.ARTIFACT_EMPTY,
    'a command returning zero with a zero-byte file is the CyberPanel failure this check exists to stop');
}

function testAManifestMissingOneArtifactIsRefused() {
  const result = verifyManifestArtifactSet(['files-1', 'mail-2'], ['files-1']);
  assert.equal(result.code, FAILURE_CODES.MANIFEST_MISMATCH,
    'a readable archive is still incomplete when the manifest drops a required artifact');
  assert.equal(verifyManifestArtifactSet(['files-1'], ['files-1']), null);
}

function testADatabaseDumpIsMeasuredByItsOwnObjectSet() {
  const mysql = 'CREATE TABLE `orders` (\n id int\n);\nCREATE TABLE `users` (\n id int\n);';
  const postgres = 'CREATE TABLE public.accounts (\n id bigint\n);\nCREATE TABLE public."Order Items" (\n id bigint\n);';
  assert.deepEqual(tableNamesFromSql(mysql), ['orders', 'users']);
  assert.deepEqual(tableNamesFromSql(postgres), ['Order Items', 'accounts']);

  const expected = Array.from({ length: 80 }, (_, index) => `table_${String(index + 1).padStart(2, '0')}`);
  const sql = expected.map(name => `CREATE TABLE \`${name}\` (\n id int\n);\nINSERT INTO \`${name}\` VALUES (1);`).join('\n');
  const partial = truncateSqlToTableCount(sql, 22);
  const captured = tableNamesFromSql(partial);
  assert.equal(captured.length, 22, 'the test-machine seam changes the dump bytes to the specified 22-of-80 shape');
  const result = verifyDatabaseObjectSet(expected, captured);
  assert.equal(result.code, FAILURE_CODES.DATABASE_OBJECT_SET_MISMATCH);
  assert.match(result.summary, /22 of 80/);
  assert.notEqual(namesDigest(expected), namesDigest(captured));
}

function testAnOldArtifactIsRejectedEvenWhenItsChecksumMatches() {
  const result = verifyArtifactFacts({
    bytes: 12,
    createdAtMs: Date.parse('2026-08-24T23:55:00.000Z'),
    sourceObservedAt: '2026-08-25T00:00:00.000Z',
    expectedSha256: 'same',
    actualSha256: 'same',
  });
  assert.equal(result.code, FAILURE_CODES.ARTIFACT_STALE,
    'copying an old dump into a fresh run directory must not make it fresh');
}

function testFaultInjectionCannotBeSelectedWithoutTheWorkerGate() {
  assert.equal(activeFault({ ARCA_BACKUP_FAULT: 'empty-artifact' }), null,
    'the fault name alone is inert, so no web parameter can switch it on');
  assert.equal(activeFault({ ARCA_BACKUP_FAULT_INJECTION: '1', ARCA_BACKUP_FAULT: 'empty-artifact' }), 'empty-artifact');
  assert.equal(activeFault({ ARCA_BACKUP_FAULT_INJECTION: '1', ARCA_BACKUP_FAULT: 'anything-else' }), null);
}

async function testTheWorkerFaultSeamsRefuseTheBytesTheyActuallyProduced() {
  const makeSite = domain => {
    const root = path.join((process.env.JOTPANEL_OPS_SITE_ROOT ?? process.env.ARCA_OPS_SITE_ROOT), domain);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), `backup fixture for ${domain}\n`);
  };

  makeSite('ordinary.example.test');
  delete process.env.JOTPANEL_BACKUP_FAULT_INJECTION;
  delete process.env.JOTPANEL_BACKUP_FAULT;
  const ordinary = await backupCreate({ domain: 'ordinary.example.test', parts: ['files'], keep: 2 });
  assert.equal(ordinary.run_truth.status, 'succeeded');
  assert.equal(ordinary.run_truth.artifacts[0].state, 'verified');

  for (const [fault, code] of [
    ['empty-artifact', FAILURE_CODES.ARTIFACT_EMPTY],
    ['manifest-mismatch', FAILURE_CODES.MANIFEST_MISMATCH],
    ['stale-artifact', FAILURE_CODES.ARTIFACT_STALE],
  ]) {
    const domain = `${fault}.example.test`;
    makeSite(domain);
    process.env.JOTPANEL_BACKUP_FAULT_INJECTION = '1';
    process.env.JOTPANEL_BACKUP_FAULT = fault;
    await assert.rejects(
      () => backupCreate({ domain, parts: ['files'], keep: 2 }),
      error => {
        assert.equal(error.code, code);
        assert.equal(error.backupRun.status, 'failed');
        assert.equal(error.backupRun.failure_code, code);
        return true;
      },
      `${fault} must be discovered by the normal worker verifier`,
    );
  }
}

async function run() {
  try {
    for (const test of [
      testAnEmptyArtifactCannotBecomeSuccess,
      testAManifestMissingOneArtifactIsRefused,
      testADatabaseDumpIsMeasuredByItsOwnObjectSet,
      testAnOldArtifactIsRejectedEvenWhenItsChecksumMatches,
      testFaultInjectionCannotBeSelectedWithoutTheWorkerGate,
      testTheWorkerFaultSeamsRefuseTheBytesTheyActuallyProduced,
    ]) {
      await test();
      console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`);
    }
    console.log('backup worker truth tests passed');
  } finally {
    delete process.env.JOTPANEL_BACKUP_FAULT_INJECTION;
    delete process.env.JOTPANEL_BACKUP_FAULT;
    fs.rmSync(workerRoot, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
