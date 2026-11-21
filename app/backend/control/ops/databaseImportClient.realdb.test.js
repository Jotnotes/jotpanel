'use strict';

// REAL-DATABASE regression test: a customer's uploaded SQL must not be able to make the IMPORT CLIENT do anything (M6, 2026-11-21).
//
// The 2026-11-10 security repair (audit blocker B1) made a customer's file run as an account with privileges on ONE database, so the
// server refuses anything outside it. That protects the server. It does not protect the machine the CLIENT runs on, because the
// command-line client has commands of its own, handled before a statement is ever sent: `system` and `\!` run a shell command,
// `source` and `\.` read a local file, `\T` and `tee` write one, `pager` starts a program. The worker runs that client as root, so a
// customer's upload that contained one line of `system ...` ran it as root on the host. Found on the VM on 2026-11-21 by running the
// real client; the repair is `--binary-mode`, which switches those commands off for piped input and leaves `DELIMITER`.
//
//   MariaDB   an uploaded file with each client command in it runs none of them, and an ordinary dump (routine with DELIMITER,
//             view, trigger, event) still imports
//   PostgreSQL (only where psql is installed) a customer cannot import SQL through the panel at all: the path ran the file as the
//             postgres superuser through psql, whose own `\!` and `COPY ... TO PROGRAM` run commands. PostgreSQL is outside the GA
//             definition (MariaDB 10.11 is the tested engine), so the customer path is closed rather than made safe.
//
// Needs root and a running MariaDB; says NOT EXERCISED and exits 2 where it cannot run. Deliberately not in test:unit; named
// *.test.js so the customer bundle excludes it. Run on the local VM: limactl shell navproof -- sudo node <this file>.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MARIA = ['/usr/bin/mariadb', '/usr/bin/mysql'].find(p => fs.existsSync(p));
const DUMP = ['/usr/bin/mariadb-dump', '/usr/bin/mysqldump'].find(p => fs.existsSync(p));
const PSQL = ['/usr/bin/psql', '/usr/local/bin/psql'].find(p => fs.existsSync(p));
const notExercised = (why) => { console.log(`NOT EXERCISED: ${why}. This is not a pass. Run it as root on a machine with MariaDB.`); process.exit(2); };
if (typeof process.getuid === 'function' && process.getuid() !== 0) notExercised('it must run as root');
if (!MARIA || !DUMP) notExercised('there is no mariadb or mysql client on this machine');
const probe = spawnSync(MARIA, ['--batch', '--skip-column-names', '-e', 'SELECT 1'], { encoding: 'utf8' });
if (probe.status !== 0 || probe.stdout.trim() !== '1') notExercised('the MariaDB root socket did not answer');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-import-client-'));
process.env.JOTPANEL_OPS_STATE_DIR = path.join(ROOT, 'state');
process.env.JOTPANEL_OPS_SITE_ROOT = path.join(ROOT, 'sites');
process.env.JOTPANEL_OPS_BACKUP_ROOT = path.join(ROOT, 'backups');
const { executeNamedJob: job } = require(path.join(__dirname, 'privilegedJobs.js'));

let passes = 0; let failures = 0;
const check = (condition, message, detail) => {
  if (condition) { passes += 1; console.log(`  ok   ${message}`); } else { failures += 1; console.log(`  FAIL ${message}${detail ? ` — ${detail}` : ''}`); }
  return !!condition;
};
function sql(statement, db) {
  const args = ['--batch', '--skip-column-names', '--default-character-set=utf8mb4']; if (db) args.push(db);
  const r = spawnSync(MARIA, args, { input: `${statement};\n`, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(((r.stderr || '').split('\n').find(l => /^ERROR/.test(l)) || `exit ${r.status}`).slice(0, 220));
  return r.stdout.trim();
}
function raw(text, db) {
  const args = ['--batch', '--skip-column-names']; if (db) args.push(db);
  const r = spawnSync(MARIA, args, { input: text, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(((r.stderr || '').split('\n').find(l => /^ERROR/.test(l)) || `exit ${r.status}`).slice(0, 220));
  return r.stdout.trim();
}
const attempt = async (name, params) => { try { return { ok: true, value: await job(name, params) }; } catch (error) { return { ok: false, error: String(error.message || error), code: error.code }; } };
const dbs = [];
function tenant(label) {
  const db = `jotpanel_ic${crypto.randomBytes(3).toString('hex')}${label}`;
  sql(`DROP DATABASE IF EXISTS ${db}; CREATE DATABASE ${db} CHARACTER SET utf8mb4`);
  sql('CREATE TABLE t (id INT PRIMARY KEY, v VARCHAR(40))', db);
  dbs.push(db);
  return db;
}
// World-writable on purpose: the postgres and mysql OS users must be ABLE to create a marker, or an attack that ran would look like one that did not.
const MARKS = fs.mkdtempSync('/tmp/arca-ic-marks-'); fs.chmodSync(MARKS, 0o777);
const marker = (name) => path.join(MARKS, `marker_${name}`);
const exists = (p) => fs.existsSync(p);
const tableExists = (db, table) => sql(`SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='${db}' AND table_name='${table}'`) === '1';

async function main() {
  console.log('\n── M6.1 MariaDB: the import client\'s own commands in a customer\'s file ──');
  const db = tenant('a');
  const sourced = marker('sourced.sql');
  fs.writeFileSync(sourced, 'CREATE TABLE sourced_marker (id INT);\n'); fs.chmodSync(sourced, 0o644);
  const attacks = [
    ['system', `system touch ${marker('system')}\n`, () => exists(marker('system'))],
    ['\\!', `\\! touch ${marker('bang')}\n`, () => exists(marker('bang'))],
    ['source', `source ${sourced}\n`, () => tableExists(db, 'sourced_marker')],
    ['\\.', `\\. ${sourced}\n`, () => tableExists(db, 'sourced_marker')],
    ['tee', `tee ${marker('tee')}\nSELECT 1;\n`, () => exists(marker('tee'))],
    ['\\T', `\\T ${marker('tee2')}\nSELECT 1;\n`, () => exists(marker('tee2'))],
    ['pager', `pager touch ${marker('pager')};\nSELECT 1;\n`, () => exists(marker('pager'))],
  ];
  for (const [label, text, happened] of attacks) {
    const r = await attempt('database.import', { name: db, sql: `INSERT IGNORE INTO t VALUES (1, 'before');\n${text}` });
    check(!happened(), `a "${label}" line in the uploaded file does nothing on the machine`, happened() ? 'IT RAN: the file, table or marker it was meant to create exists' : '');
    check(!r.ok, `and the import of that file is reported as failed, not as a success`, r.ok ? 'it reported success' : '');
  }

  console.log('\n── M6.2 MariaDB: an ordinary dump still imports ──');
  {
    const source = tenant('src');
    sql(`INSERT INTO t VALUES (1,'one'),(2,'two'); CREATE VIEW v_t AS SELECT id FROM t; CREATE TABLE audit (n INT); CREATE TRIGGER trg AFTER INSERT ON t FOR EACH ROW INSERT INTO audit VALUES (NEW.id)`, source);
    raw("DELIMITER //\nCREATE PROCEDURE bump() BEGIN INSERT INTO t VALUES (99,'p'); END//\nDELIMITER ;\n", source);
    const dump = spawnSync(DUMP, ['--routines', '--triggers', '--events', '--single-transaction', source], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    check(dump.status === 0 && /CREATE PROCEDURE|DELIMITER/.test(dump.stdout), 'a dump with a routine (DELIMITER), a view and a trigger is produced');
    const target = tenant('dst');
    const r = await attempt('database.import', { name: target, sql: dump.stdout });
    check(r.ok, 'and the customer import accepts it', r.ok ? '' : r.error);
    check(r.ok && tableExists(target, 'audit') && sql(`SELECT COUNT(*) FROM information_schema.routines WHERE routine_schema='${target}'`) === '1', 'the tables and the routine are there afterwards');
    check(r.ok && sql('SELECT COUNT(*) FROM t', target) === '2', 'with the rows');
  }

  console.log('\n── M6.2b MariaDB: a statement in an upload that runs too long is stopped by the server ──');
  {
    const target = tenant('slow');
    process.env.JOTPANEL_IMPORT_MAX_STATEMENT_SECONDS = '2';
    const started = Date.now();
    const r = await attempt('database.import', { name: target, sql: 'SELECT SLEEP(20);\n' });
    const took = (Date.now() - started) / 1000;
    check(!r.ok && /max_statement_time|interrupted|timeout/i.test(r.error), 'a statement that runs past the limit is stopped by the server and the import fails', r.ok ? 'it ran to the end' : r.error);
    check(took < 12, `and it is stopped near the limit, not after the statement's own twenty seconds (${took.toFixed(1)} s)`);
    const limits = sql(`SELECT CONCAT(max_user_connections, ' ', max_statement_time) FROM mysql.user WHERE user LIKE 'jpimp\\_%' ORDER BY 1 LIMIT 1`);
    check(/^2 /.test(limits), `the import account carries a connection limit of two (${limits})`);
    delete process.env.JOTPANEL_IMPORT_MAX_STATEMENT_SECONDS;
    const ok = await attempt('database.import', { name: target, sql: 'INSERT INTO t VALUES (5, \'after\');\n' });
    check(ok.ok, 'and with the limit back at its default an ordinary import goes through', ok.ok ? '' : ok.error);
  }

  console.log('\n── M6.3 PostgreSQL: a customer cannot import SQL through the panel ──');
  if (!PSQL) {
    console.log('  NOT EXERCISED: psql is not installed on this machine. This part is not a pass.');
  } else {
    const name = `jotpanel_pg${crypto.randomBytes(3).toString('hex')}`;
    const made = await attempt('database.create', { name, engine: 'postgres' });
    check(made.ok, 'a PostgreSQL database is created through the panel', made.ok ? '' : made.error);
    if (made.ok) {
      const attacksPg = [
        ['COPY ... TO PROGRAM', `COPY (SELECT 1) TO PROGRAM 'touch ${marker('pg_program')}';\n`, () => exists(marker('pg_program'))],
        ['\\! (a psql shell escape)', `\\! touch ${marker('pg_bang')}\n`, () => exists(marker('pg_bang'))],
        ['a plain table', 'CREATE TABLE customer_table (id int);\n', () => spawnSync('runuser', ['-u', 'postgres', '--', PSQL, '-d', name, '-Atc', "SELECT to_regclass('customer_table') IS NOT NULL"], { encoding: 'utf8' }).stdout.trim() === 't'],
      ];
      for (const [label, text, happened] of attacksPg) {
        const r = await attempt('database.import', { name, sql: text, engine: 'postgres' });
        check(!r.ok && /PostgreSQL/i.test(r.error) && /not available|not offered|MariaDB/i.test(r.error), `a customer's ${label} import is refused in words`, r.ok ? 'it was ACCEPTED' : r.error);
        check(!happened(), `and nothing it asked for happened on the machine`, happened() ? 'IT RAN' : '');
      }
      await attempt('database.drop', { name, engine: 'postgres' });
    }
  }
}

main().catch(error => { failures += 1; console.log(`  FAIL the run itself broke: ${error.stack || error}`); }).finally(() => {
  for (const db of dbs) { try { sql(`DROP DATABASE IF EXISTS ${db}`); } catch { /* gone */ } }
  try { sql("DROP USER IF EXISTS 'jpimp_probe'@'localhost'"); } catch { /* none */ }
  fs.rmSync(ROOT, { recursive: true, force: true }); fs.rmSync(MARKS, { recursive: true, force: true });
  console.log(`\nimport client: ${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
});
