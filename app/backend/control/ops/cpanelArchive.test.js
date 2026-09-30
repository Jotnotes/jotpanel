'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseCpanelArchive, CPANEL_PATHS } = require('./cpanelArchive');

const bytes = value => Buffer.from(String(value), 'utf8');

test('builds a migration plan without dropping shared grants, mail, files, or statistics', () => {
  const entries = new Map([
    ['cpmove-alice/cp/alice', bytes([
      'USER=alice',
      'DNS=example.com',
      'CONTACTEMAIL=owner@example.com',
      'PLAN=business',
      'QUOTA=512',
      'PHPVERSION=ea-php81'
    ].join('\n'))],
    ['cpmove-alice/quota', bytes(512 * 1024 * 1024)],
    ['cpmove-alice/userdata/main', bytes([
      'main_domain: example.com',
      'addon_domains:',
      '  addon.example.net: addon'
    ].join('\n'))],
    ['cpmove-alice/userdata/example.com', bytes([
      'servername: example.com',
      'documentroot: /home/alice/public_html',
      'phpversion: ea-php82'
    ].join('\n'))],
    ['cpmove-alice/userdata/addon.example.net', bytes([
      'servername: addon.example.net',
      'documentroot: /home/alice/sites/addon',
      'phpversion: ea-php81'
    ].join('\n'))],
    ['cpmove-alice/addons', bytes('addon.example.net: addon')],
    ['cpmove-alice/mysql/alice_app.sql', bytes('CREATE TABLE app (id INT);')],
    ['cpmove-alice/mysql/alice_audit.sql', bytes('CREATE TABLE audit (id INT);')],
    ['cpmove-alice/mysql.sql', bytes([
      "GRANT SELECT, INSERT ON alice_app.* TO 'alice_shared'@'localhost';",
      "GRANT SELECT ON alice_audit.* TO 'alice_shared'@'localhost';"
    ].join('\n'))],
    ['cpmove-alice/homedir/etc/example.com/passwd', bytes([
      'info:$6$hash:1001:1001::/home/alice/mail/example.com/info:/usr/local/cpanel/bin/noshell',
      'support:$6$hash:1002:1002::/home/alice/mail/example.com/support:/usr/local/cpanel/bin/noshell',
      'sales:$6$hash:1003:1003::/home/alice/mail/example.com/sales:/usr/local/cpanel/bin/noshell'
    ].join('\n'))],
    ['cpmove-alice/homedir/etc/example.com/quota', bytes([
      'info:104857600',
      'support:209715200',
      'sales:52428800'
    ].join('\n'))],
    ['cpmove-alice/va/example.com', bytes('sales: support@example.com')],
    ['cpmove-alice/homedir/public_html/index.html', bytes('<h1>Main</h1>')],
    ['cpmove-alice/homedir/sites/addon/index.php', bytes('<?php echo "addon";')],
    ['cpmove-alice/dnszones/example.com.db', bytes([
      '$TTL 3600',
      '@ IN A 192.0.2.10',
      'www 600 IN CNAME example.com.'
    ].join('\n'))],
    ['cpmove-alice/cron/alice', bytes('15 2 * * * /home/alice/bin/backup')],
    ['cpmove-alice/proftpdpasswd', bytes('designer:x:1001:1001::/home/alice/public_html:/usr/local/cpanel/bin/ftpsh')],
    ['cpmove-alice/homedir/tmp/awstats/awstats082026.example.com.txt', bytes([
      'AWSTATS DATA FILE 7.9 (build 20230108)',
      'BEGIN_GENERAL 2',
      'TotalVisits 12',
      'TotalUnique 7',
      'END_GENERAL',
      'BEGIN_TIME 2',
      '0 5 10 1000 0 0 0',
      '1 7 14 2000 0 0 0',
      'END_TIME'
    ].join('\n'))],
    ['cpmove-alice/homedir/public_html/../../outside.txt', bytes('hostile')]
  ]);

  const plan = parseCpanelArchive(entries);

  assert.deepEqual(plan.account, {
    user: 'alice',
    mainDomain: 'example.com',
    contactEmail: 'owner@example.com',
    plan: 'business',
    quotaMb: 512,
    phpVersion: 'ea-php82'
  });
  assert.deepEqual(
    plan.domains.map(({ domain, kind, documentRoot, phpVersion }) => ({ domain, kind, documentRoot, phpVersion })),
    [
      { domain:'example.com', kind:'main', documentRoot:'public_html', phpVersion:'ea-php82' },
      { domain:'addon.example.net', kind:'addon', documentRoot:'sites/addon', phpVersion:'ea-php81' }
    ]
  );

  assert.equal(plan.databases.length, 2);
  assert.deepEqual(plan.dbUsers, [{ username:'alice_shared' }]);
  for (const database of plan.databases) {
    assert.equal(database.users.length, 1);
    assert.equal(database.users[0].username, 'alice_shared');
  }
  assert.deepEqual(plan.databases.find(row => row.name === 'alice_app').users[0].privileges, ['INSERT', 'SELECT']);
  assert.deepEqual(plan.databases.find(row => row.name === 'alice_audit').users[0].privileges, ['SELECT']);

  assert.equal(plan.mailboxes.length, 3);
  assert.ok(plan.mailboxes.every(mailbox => mailbox.hasPassword === false));
  assert.equal(plan.mailboxes.find(mailbox => mailbox.account === 'support').quotaMb, 200);
  assert.deepEqual(plan.forwarders, [{ from:'sales@example.com', to:'support@example.com' }]);

  assert.equal(plan.files.find(file => file.relativePath === 'public_html/index.html').domain, 'example.com');
  assert.equal(plan.files.find(file => file.relativePath === 'sites/addon/index.php').domain, 'addon.example.net');
  assert.ok(!plan.files.some(file => file.relativePath.includes('outside.txt')));
  assert.ok(plan.warnings.some(warning => warning.includes('hostile archive path')));
  assert.ok(plan.warnings.some(warning => warning.includes('password hashes cannot be reused')));

  assert.deepEqual(plan.statistics, [{
    domain:'example.com',
    month:8,
    year:2026,
    source:'awstats',
    visits:12,
    uniqueVisitors:7,
    pages:12,
    hits:24,
    bandwidthBytes:3000,
    archivePath:'homedir/tmp/awstats/awstats082026.example.com.txt'
  }]);
  assert.deepEqual(plan.cron, [{ schedule:'15 2 * * *', command:'/home/alice/bin/backup' }]);
  assert.deepEqual(plan.ftpAccounts, [{ username:'designer', path:'public_html' }]);
  assert.equal(plan.dns[0].records.length, 2);

  for (const key of [
    'domains', 'databases', 'dbUsers', 'mailboxes', 'forwarders',
    'autoresponders', 'dns', 'cron', 'ftpAccounts', 'files',
    'statistics', 'rawLogs', 'certificates', 'warnings', 'unsupported'
  ]) assert.ok(Array.isArray(plan[key]), key + ' must always be an array');

  assert.ok(CPANEL_PATHS.awstats.includes('homedir/tmp/awstats/awstatsMMYYYY.<domain>.txt'));
});

test('keeps both AWStats and Webalizer rows for the same month and warns', () => {
  const entries = new Map([
    ['homedir/tmp/awstats/awstats072025.example.com.txt', bytes([
      'AWSTATS DATA FILE 7.8',
      'BEGIN_GENERAL 2',
      'TotalVisits 20',
      'TotalUnique 10',
      'END_GENERAL',
      'BEGIN_DAY 1',
      '20250701 30 40 5000 20',
      'END_DAY'
    ].join('\n'))],
    ['homedir/tmp/webalizer/example.com/webalizer.hist', bytes('7 2025 44 40 11 6 1 31 33 22')]
  ]);

  const plan = parseCpanelArchive(entries);
  assert.equal(plan.statistics.length, 2);
  assert.deepEqual(plan.statistics.map(row => row.source), ['awstats', 'webalizer']);
  assert.equal(plan.statistics[1].bandwidthBytes, 6 * 1024);
  assert.ok(plan.warnings.some(warning => warning.includes('both rows were retained')));
});

test('detects Plesk and DirectAdmin archives by name', () => {
  assert.throws(
    () => parseCpanelArchive(new Map([['backup_info_260819.xml', bytes('<backup/>')]])),
    /Plesk/
  );
  assert.throws(
    () => parseCpanelArchive(new Map([['backup/user.conf', bytes('username=alice')]])),
    /DirectAdmin/
  );
});

test('accepts a home-directory-only cPanel backup without inventing account facts', () => {
  const plan = parseCpanelArchive(new Map([
    ['public_html/index.html', bytes('hello')]
  ]));
  assert.deepEqual(plan.account, {
    user:null,
    mainDomain:null,
    contactEmail:null,
    plan:null,
    quotaMb:null,
    phpVersion:null
  });
  assert.deepEqual(plan.files[0], {
    archivePath:'public_html/index.html',
    relativePath:'public_html/index.html',
    domain:null,
    sizeBytes:5
  });
  assert.ok(plan.warnings.some(warning => warning.includes('home-directory-only')));
});
