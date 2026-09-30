'use strict';

const crypto = require('crypto');
const { panelSetting } = require('../panelSettings');

const FAILURE_CODES = Object.freeze({
  ARTIFACT_EMPTY: 'ARTIFACT_EMPTY',
  ARCHIVE_INVALID: 'ARCHIVE_INVALID',
  MANIFEST_MISMATCH: 'MANIFEST_MISMATCH',
  DATABASE_OBJECT_SET_MISMATCH: 'DATABASE_OBJECT_SET_MISMATCH',
  ARTIFACT_STALE: 'ARTIFACT_STALE',
});

const FAULTS = new Set([
  'empty-artifact',
  'manifest-mismatch',
  'database-object-set-mismatch',
  'stale-artifact',
]);

function namesDigest(values) {
  const names = [...new Set((values || []).map(value => String(value)))].sort();
  return crypto.createHash('sha256').update(names.join('\n')).digest('hex');
}

// SQL dumps use three forms here: MySQL backticks, PostgreSQL's schema.name
// and PostgreSQL quoted identifiers. Reading the CREATE statements gives the
// object set actually carried by the dump rather than trusting the dump
// process's exit code, which is how a partial dump can otherwise be called a
// backup.
function tableNamesFromSql(sql) {
  const tables = [];
  for (const line of String(sql || '').split(/\r?\n/)) {
    const match = line.match(/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(.+?)\s*\(/i);
    if (!match) continue;
    const pieces = splitQualifiedIdentifier(match[1]);
    const table = unquoteIdentifier(pieces[pieces.length - 1] || '');
    if (table) tables.push(table);
  }
  return [...new Set(tables)].sort();
}

function splitQualifiedIdentifier(value) {
  const pieces = [];
  let current = '';
  let quote = null;
  for (const char of String(value || '').trim()) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === '`') { quote = char; current += char; continue; }
    if (char === '.') { pieces.push(current.trim()); current = ''; continue; }
    current += char;
  }
  if (current.trim()) pieces.push(current.trim());
  return pieces;
}

function unquoteIdentifier(value) {
  const clean = String(value || '').trim();
  if ((clean.startsWith('"') && clean.endsWith('"')) || (clean.startsWith('`') && clean.endsWith('`'))) {
    const quote = clean[0];
    return clean.slice(1, -1).replace(new RegExp(`${quote}${quote}`, 'g'), quote);
  }
  return clean;
}

function verifyArtifactFacts({ bytes, createdAtMs, sourceObservedAt, expectedSha256, actualSha256 }) {
  if (!(Number(bytes) > 0)) return failure(FAILURE_CODES.ARTIFACT_EMPTY, 'The backup artifact is empty.');
  // Filesystems do not all keep sub-second mtimes. Two seconds admits that
  // rounding and still rejects the old dump copied in by the fault seam, whose
  // timestamp is moved back by five minutes.
  if (Number.isFinite(createdAtMs) && Number.isFinite(Date.parse(sourceObservedAt))
      && createdAtMs < Date.parse(sourceObservedAt) - 2000) {
    return failure(FAILURE_CODES.ARTIFACT_STALE, 'The backup artifact predates this run.');
  }
  if (expectedSha256 && actualSha256 && expectedSha256 !== actualSha256) {
    return failure(FAILURE_CODES.MANIFEST_MISMATCH, 'The artifact checksum does not match the manifest.');
  }
  return null;
}

function verifyDatabaseObjectSet(expected, captured) {
  const wanted = [...new Set((expected || []).map(String))].sort();
  const got = [...new Set((captured || []).map(String))].sort();
  if (wanted.length !== got.length || wanted.some((name, index) => name !== got[index])) {
    return failure(
      FAILURE_CODES.DATABASE_OBJECT_SET_MISMATCH,
      `The database dump contains ${got.length} of ${wanted.length} expected table(s).`,
      { expected: wanted, captured: got },
    );
  }
  return null;
}

function verifyManifestArtifactSet(expectedIds, manifestIds) {
  const expected = [...new Set((expectedIds || []).map(String))].sort();
  const present = [...new Set((manifestIds || []).map(String))].sort();
  if (expected.length !== present.length || expected.some((id, index) => id !== present[index])) {
    return failure(FAILURE_CODES.MANIFEST_MISMATCH, 'The manifest does not name every artifact produced by this run.');
  }
  return null;
}

// This is deliberately an environment-only switch. It is a worker seam for a
// test machine, not a catalogue parameter and not something a web request can
// choose. Each value names the exact Section 6 fault it exists to cause.
function activeFault(env = process.env) {
  if (panelSetting("BACKUP_FAULT_INJECTION", undefined, env) !== '1') return null;
  const fault = String(panelSetting("BACKUP_FAULT", undefined, env) || '').trim();
  return FAULTS.has(fault) ? fault : null;
}

// The database mismatch fault has to change the dump, not merely the answer
// describing it. Stopping before the twenty-third CREATE TABLE produces the
// specified 22-of-80 shape on the test fixture while leaving the detector to
// discover the captured set from the bytes it will actually keep.
function truncateSqlToTableCount(sql, keep = 22) {
  const lines = String(sql || '').split(/\r?\n/);
  let seen = 0;
  const kept = [];
  for (const line of lines) {
    if (/^CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+/i.test(line)) {
      seen += 1;
      if (seen > keep) break;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function failure(code, summary, details = null) {
  return { code, summary, details };
}

module.exports = {
  FAILURE_CODES,
  activeFault,
  namesDigest,
  tableNamesFromSql,
  truncateSqlToTableCount,
  verifyArtifactFacts,
  verifyDatabaseObjectSet,
  verifyManifestArtifactSet,
};
