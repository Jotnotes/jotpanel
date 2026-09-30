'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-layout-'));
const oldRoot = path.join(root, 'opt/arca');
fs.mkdirSync(path.join(oldRoot, 'app/backend'), { recursive: true });
fs.mkdirSync(path.join(oldRoot, 'data'), { recursive: true });
fs.mkdirSync(path.join(root, 'srv/arca-sites/example.test/public'), { recursive: true });
fs.mkdirSync(path.join(root, 'etc/postfix'), { recursive: true });
fs.writeFileSync(path.join(oldRoot, 'app/backend/server.js'), '// fixture\n');
// A real database whose rows are still only in the write-ahead log, as a panel
// stopped without a checkpoint leaves it. The files are copied while the
// connection is open, so the log is not folded in first.
{
  const Database = require('better-sqlite3');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-wal-'));
  const live = new Database(path.join(scratch, 'arca.db'));
  live.pragma('journal_mode = WAL');
  live.pragma('wal_autocheckpoint = 0');
  live.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
  for (let i = 0; i < 25; i++) live.prepare('INSERT INTO users (id) VALUES (?)').run(`u${i}`);
  for (const side of ['', '-wal', '-shm']) fs.copyFileSync(path.join(scratch, `arca.db${side}`), path.join(oldRoot, `data/arca.db${side}`));
  live.close(); fs.rmSync(scratch, { recursive: true, force: true });
  assert.ok(fs.statSync(path.join(oldRoot, 'data/arca.db-wal')).size > 0, 'fixture: the rows are in the log');
}
fs.writeFileSync(path.join(root, 'srv/arca-sites/example.test/public/index.html'), 'site');
fs.writeFileSync(path.join(root, 'etc/postfix/arca-mailboxes'), 'owner@example.test example.test/owner/\n');
// Files a service loads by wildcard, and one it names explicitly.
const WILDCARD = [
  ['etc/nginx/conf.d/arca.conf', 'etc/nginx/conf.d/jotpanel.conf'],
  ['etc/fail2ban/jail.d/arca.conf', 'etc/fail2ban/jail.d/jotpanel.conf'],
  ['etc/dovecot/conf.d/99-arca-panel.conf', 'etc/dovecot/conf.d/99-jotpanel-panel.conf'],
  ['etc/ssh/sshd_config.d/arca-sftp.conf', 'etc/ssh/sshd_config.d/jotpanel-sftp.conf'],
];
for (const [old] of WILDCARD) { fs.mkdirSync(path.dirname(path.join(root, old)), { recursive: true }); fs.writeFileSync(path.join(root, old), '# managed\n'); }
fs.mkdirSync(path.join(root, 'etc/nginx/snippets'), { recursive: true });
fs.writeFileSync(path.join(root, 'etc/nginx/snippets/arca-webmail.conf'), '# snippet\n');
fs.writeFileSync(path.join(oldRoot, '.env'), [
  'ARCA_DATA_DIR=/opt/arca/data',
  'ARCA_OPS_SITE_ROOT=/srv/arca-sites',
  'ARCA_LICENSE_URL=https://license.jotnotes.com',
  '',
].join('\n'));

const migration = path.resolve(__dirname, '../../deploy/migrate-layout.sh');
const run = spawnSync('bash', ['-c', 'source "$1"; migrate_jotpanel_layout; migrate_jotpanel_layout', 'test', migration], {
  env: { ...process.env, JOTPANEL_LAYOUT_TEST_ROOT: root }, encoding: 'utf8',
});
assert.equal(run.status, 0, run.stderr);

const newRoot = path.join(root, 'opt/jotpanel');
{
  const Database = require('better-sqlite3');
  const db = new Database(path.join(newRoot, 'data/jotpanel.db'), { readonly: true });
  let accounts = 0;
  try { accounts = db.prepare('SELECT count(*) c FROM users').get().c; } catch { /* no table: the rows were lost */ }
  assert.equal(accounts, 25, 'every account survives the rename, including those only in the write-ahead log');
  db.close();
  assert.ok(!fs.existsSync(path.join(newRoot, 'data/arca.db-wal')), 'no orphaned log is left under the old name');
}
assert.equal(fs.readFileSync(path.join(root, 'srv/jotpanel-sites/example.test/public/index.html'), 'utf8'), 'site');
assert.equal(fs.readFileSync(path.join(root, 'etc/postfix/jotpanel-mailboxes'), 'utf8'), 'owner@example.test example.test/owner/\n');
assert.equal(fs.realpathSync(oldRoot), fs.realpathSync(newRoot), 'old install path remains an alias');
// A leftover link in a wildcard folder makes the service read its file twice
// (nginx refused its whole configuration on the first real upgrade).
for (const [old, now] of WILDCARD) {
  assert.equal(fs.readFileSync(path.join(root, now), 'utf8'), '# managed\n', `${now} moved`);
  assert.ok(!fs.existsSync(path.join(root, old)) && !isLink(path.join(root, old)), `${old} must not remain in a folder loaded by wildcard`);
}
assert.equal(fs.readFileSync(path.join(root, 'etc/nginx/snippets/arca-webmail.conf'), 'utf8'), '# snippet\n', 'a file named explicitly keeps its old name as a link');
const env = fs.readFileSync(path.join(newRoot, '.env'), 'utf8');
assert.match(env, /^JOTPANEL_DATA_DIR=\/opt\/jotpanel\/data$/m);
assert.match(env, /^JOTPANEL_OPS_SITE_ROOT=\/srv\/jotpanel-sites$/m);
assert.match(env, /^JOTPANEL_LICENSE_URL=https:\/\/license\.jotnotes\.com$/m);
assert.doesNotMatch(env, /^ARCA_/m, 'the migrated config writes only new names');

fs.rmSync(root, { recursive: true, force: true });
console.log('panel layout compatibility: 16 passed');
