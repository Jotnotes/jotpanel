'use strict';

// Migration is the one part of this panel whose input was written by a machine
// on somebody else's server. Everything here is exercised without a network and
// without a mail server, because a hand-written protocol parser and a plan
// rebuilder are exactly the code that must not be proved only by pointing it at
// a live box and watching it work once.

const assert = require('assert/strict');
const { takeLine, readAstring, parseListLine, parseStatusLine, decodeModifiedUtf7 } = require('./imapSource');
const { getOperation, migrationPlan } = require('./catalogue');
const { planFromCpanel, grantLevel, wholeMegabytes } = require('./cpanelPlan');
const { parseCpanelArchive } = require('./cpanelArchive');

function testALineEndsAtTheEndOfTheLineUnlessALiteralSaysOtherwise() {
  const simple = takeLine('* OK ready\r\nnext line\r\n');
  assert.equal(simple.line, '* OK ready');
  assert.equal(simple.rest, 'next line\r\n');

  // Nothing to take yet: half a line is not a line.
  assert.equal(takeLine('* OK rea'), null);

  // A literal carries its own length and the line continues after it. Splitting
  // on CRLF here would end the line inside the folder name and lose the rest.
  const literal = takeLine('* LIST (\\HasNoChildren) "/" {9}\r\nOld\r\npost (\\Marked)\r\nafter\r\n');
  assert.equal(literal.line, '* LIST (\\HasNoChildren) "/" "Old\r\npost" (\\Marked)');
  assert.equal(literal.rest, 'after\r\n');

  // A literal whose octets have not all arrived is not a line yet either.
  assert.equal(takeLine('* LIST () "/" {40}\r\nonly a few\r\n'), null);
}

function testAQuotedNameSurvivesItsOwnPunctuation() {
  assert.deepEqual(readAstring('  "INBOX"', 0), { value: 'INBOX', next: 9 });
  assert.equal(readAstring('"a \\"quoted\\" name"', 0).value, 'a "quoted" name');
  assert.equal(readAstring('"back\\\\slash"', 0).value, 'back\\slash');
  assert.equal(readAstring('NIL "x"', 0).value, 'NIL');
  // An unterminated quote is not a name, and guessing at one is how a parser
  // reads the next command as data.
  assert.equal(readAstring('"never closed', 0), null);
}

function testTheFolderListIsReadTheWayServersActuallyWriteIt() {
  const dovecot = parseListLine('* LIST (\\HasNoChildren) "." "INBOX.Sent"');
  assert.equal(dovecot.name, 'INBOX.Sent');
  assert.equal(dovecot.delimiter, '.');
  assert.equal(dovecot.selectable, true);

  const courier = parseListLine('* LIST (\\Noselect \\HasChildren) "/" Archive');
  assert.equal(courier.name, 'Archive');
  // A container cannot be asked for a message count, and asking is an error on
  // every server, so the counting pass has to know to skip it.
  assert.equal(courier.selectable, false);

  const nilDelimiter = parseListLine('* LIST (\\HasNoChildren) NIL "INBOX"');
  assert.equal(nilDelimiter.delimiter, null);

  // Not a folder line at all.
  assert.equal(parseListLine('* STATUS "INBOX" (MESSAGES 1)'), null);
  assert.equal(parseListLine('a001 OK LIST completed'), null);
}

function testAFolderNameComesBackInTheAlphabetItWasWrittenIn() {
  // Modified UTF-7, which is what the protocol specifies for folder names. A
  // preview that shows &AOk- instead of e-acute looks corrupted before it has
  // copied anything, and nobody clicks the next button after that.
  assert.equal(decodeModifiedUtf7('&AOk-l&AOk-ments'), 'éléments');
  assert.equal(decodeModifiedUtf7('INBOX'), 'INBOX');
  assert.equal(decodeModifiedUtf7('R&AOk-pertoire'), 'Répertoire');
  // An ampersand of its own is written &- and is still an ampersand.
  assert.equal(decodeModifiedUtf7('Bed &- Breakfast'), 'Bed & Breakfast');
  // Nonsense is returned rather than thrown, because one strange folder name
  // must not end an inspection that has already read four hundred good ones.
  assert.equal(typeof decodeModifiedUtf7('&notbase64'), 'string');
}

function testAMessageCountIsReadWithAndWithoutTheSizeExtension() {
  const both = parseStatusLine('* STATUS "INBOX" (MESSAGES 4213 SIZE 918273645)');
  assert.equal(both.name, 'INBOX');
  assert.equal(both.messages, 4213);
  assert.equal(both.bytes, 918273645);

  // Most servers in the field predate RFC 8438 and answer with the count alone.
  const older = parseStatusLine('* STATUS INBOX.Sent (MESSAGES 12)');
  assert.equal(older.messages, 12);
  assert.equal(older.bytes, null);
}

function testTheImportedPlanIsRebuiltRatherThanAccepted() {
  const plan = migrationPlan({
    account: 'oldcustomer',
    domains: [{ domain: 'Example.COM', documentRoot: 'public_html' }],
    databases: [{ name: 'shop', users: [{ username: 'shopuser', privileges: 'read' }] }],
    mailboxes: [{ domain: 'example.com', account: 'sales', quotaMb: 500 }],
    forwarders: [{ from: 'info@example.com', to: 'sales@example.com' }],
    warnings: ['one cron job could not be read'],
    // Everything below is what a parser somewhere else might send and this
    // machine has no use for. None of it may arrive.
    command: 'rm -rf /',
    shell: { run: 'curl evil' },
    domains_extra: [{ domain: 'other.com' }],
  });
  assert.deepEqual(Object.keys(plan).sort(), [
    'account', 'archiveId', 'databases', 'domains', 'files', 'forwarders', 'mailboxes', 'source', 'statistics', 'unsupported', 'warnings',
  ]);
  // The archive reference is a token or it is nothing. A plan that arrives
  // naming a path is naming a file on this machine, which is the whole reason
  // the panel resolves the id itself and never takes one.
  assert.equal(plan.archiveId, null);
  assert.equal(migrationPlan({ archiveId: '../../etc/passwd' }).archiveId, null);
  assert.equal(migrationPlan({ archiveId: `mig_${'a'.repeat(16)}` }).archiveId, `mig_${'a'.repeat(16)}`);
  // Archive member names are rebuilt with the same suspicion as everything
  // else: a prefix that climbs is dropped, not repaired.
  const hostile = migrationPlan({
    domains: [{ domain: 'example.com', filesPrefix: '../../root/' }],
    databases: [{ name: 'shop', dumpPath: '/etc/shadow' }],
    mailboxes: [{ domain: 'example.com', account: 'sales', mailPrefix: 'ok/mail/example.com/sales/' }],
  });
  assert.equal(hostile.domains[0].filesPrefix, null);
  assert.equal(hostile.databases[0].dumpPath, null);
  assert.equal(hostile.mailboxes[0].mailPrefix, 'ok/mail/example.com/sales/');
  assert.equal(plan.domains[0].domain, 'example.com');
  assert.equal(plan.mailboxes[0].address, 'sales@example.com');
  assert.equal(plan.databases[0].users[0].privileges, 'read');
  assert.equal(plan.command, undefined);
  assert.equal(plan.shell, undefined);
}

function testAPlanThatIsNotAPlanIsRefused() {
  assert.throws(() => migrationPlan(null), /migration plan is required/);
  assert.throws(() => migrationPlan([]), /migration plan is required/);
  // A name that is not a domain is refused here rather than reaching a job.
  assert.throws(() => migrationPlan({ domains: [{ domain: 'not a domain' }] }), /not a domain name/);
  // A document root that climbs is refused by the same helper the rest of the
  // panel uses, so there is one answer to this question and not two.
  assert.throws(() => migrationPlan({ domains: [{ domain: 'example.com', documentRoot: '../../etc' }] }), /document root/);
  // A list with no end is how a parser turns a migration into a denial of
  // service against the machine it is migrating into.
  assert.throws(() => migrationPlan({ mailboxes: Array.from({ length: 5001 }, () => ({ domain: 'example.com', account: 'a' })) }), /more than one migration will carry/);
}

function testCopyingAMailboxRefusesInputThatWouldBecomeASecondCommand() {
  const pull = getOperation('migrate.imap.pull');
  const good = pull.normalize({ host: 'mail.old-host.example', username: 'sales@example.com', password: 'correct horse', domain: 'example.com', account: 'sales' });
  assert.equal(good.port, 993);
  assert.equal(good.security, 'tls');
  // The default is the safe one. Mirroring over the top of existing mail is a
  // different row with a typed word on it.
  assert.equal(good.replace, false);

  // A line break in a credential is how a client that builds strings sends a
  // command nobody asked for, both at the far end and in the Dovecot
  // configuration file this writes.
  assert.throws(() => pull.normalize({ host: 'mail.example.com', username: 'a\r\nLOGOUT', password: 'x'.repeat(12), domain: 'example.com', account: 'sales' }), /one line/);
  assert.throws(() => pull.normalize({ host: 'mail.example.com', username: 'sales', password: 'pass\nX LOGIN a b', domain: 'example.com', account: 'sales' }), /one line/);
  assert.throws(() => pull.normalize({ host: 'mail example com', username: 'sales', password: 'x'.repeat(12), domain: 'example.com', account: 'sales' }), /not a mail server name/);
}

function testTheMirrorIsDestructiveAndSaysSo() {
  const replace = getOperation('migrate.imap.replace');
  assert.equal(replace.risk, 'destructive');
  assert.equal(replace.confirm, 'REPLACE');
  assert.equal(replace.normalize({ host: 'mail.example.com', username: 'sales', password: 'x'.repeat(12), domain: 'example.com', account: 'sales' }).replace, true);

  // And the ordinary copy is not, because refusing to overwrite is what makes
  // it ordinary.
  const pull = getOperation('migrate.imap.pull');
  assert.equal(pull.risk, 'standard');
  assert.equal(pull.confirm, undefined);
}

function testTheMigrationSummarySaysNothingIsCutOver() {
  const apply = getOperation('migrate.apply');
  const params = apply.normalize({ plan: { domains: [{ domain: 'example.com' }], mailboxes: [{ domain: 'example.com', account: 'sales' }] } });
  assert.match(apply.label(params), /1 website, 1 mailbox/);
  // The single most important sentence in the whole function, because the fear
  // that stops people moving is that their mail stops arriving mid-move.
  assert.match(apply.summary(params), /Nothing is switched over/);
  assert.match(apply.summary(params), /DNS is untouched/);
}


// ── The adapter, between the parser and the executor ───────────────
// Written against the contract the parser was asked for, not against the code
// that came back, and it stays that way until the parser is on this machine.

function testTheAdapterCarriesWhatCanBeBuilt() {
  const plan = planFromCpanel({
    account: { user: 'oldcust', mainDomain: 'example.com' },
    domains: [
      { domain: 'example.com', kind: 'main', documentRoot: 'public_html' },
      { domain: 'shop.example.com', kind: 'subdomain', documentRoot: 'public_html/shop' },
    ],
    databases: [{ name: 'oldcust_shop', users: [{ username: 'oldcust_s', privileges: 'all' }], dumpPath: 'mysql/oldcust_shop.sql' }],
    mailboxes: [{ address: 'sales@example.com', domain: 'example.com', account: 'sales', quotaMb: 500 }],
    forwarders: [{ from: 'info@example.com', to: 'sales@example.com' }],
    files: [{ relativePath: 'index.php', domain: 'example.com', sizeBytes: 12 }],
    statistics: [{ domain: 'example.com', month: 7, year: 2026, visits: 900 }],
    warnings: [], unsupported: [],
  });
  assert.equal(plan.source, 'cpanel');
  assert.equal(plan.account, 'oldcust');
  assert.equal(plan.domains.length, 2);
  assert.equal(plan.domains[0].documentRoot, 'public_html');
  assert.equal(plan.databases[0].users[0].username, 'oldcust_s');
  assert.equal(plan.mailboxes[0].account, 'sales');
  assert.equal(plan.forwarders[0].to, 'sales@example.com');
}

function testTheAdapterNamesEverythingItCannotBuild() {
  const plan = planFromCpanel({
    domains: [
      { domain: 'example.com', kind: 'main', documentRoot: 'public_html' },
      { domain: 'example.net', kind: 'parked' },
    ],
    dns: [{ zone: 'example.com', records: [] }],
    cron: [{ schedule: '0 3 * * *', command: 'php /home/oldcust/cron.php' }],
    ftpAccounts: [{ username: 'uploads', path: 'public_html' }],
    certificates: [{ domain: 'example.com', kind: 'key' }],
    autoresponders: [{ address: 'sales@example.com', subject: 'Away' }],
    rawLogs: [{ domain: 'example.com', archivePath: 'logs/example.com-Jul-2026.gz' }],
  });
  const said = plan.unsupported.map(entry => `${entry.what} ${entry.why}`).join(' | ');
  // A parked domain is another name for a site, not a second site. Building one
  // gives it an empty document root and the migration looks finished.
  assert.match(said, /parked domain/);
  assert.equal(plan.domains.length, 1);
  for (const expected of [/DNS zone/, /scheduled job/, /FTP account/, /SSL certificate/, /automatic replies/, /raw access log/]) {
    assert.match(said, expected);
  }
  // And every one of them says why, because a list of things that did not
  // happen with no reasons beside them is a complaint rather than a report.
  for (const entry of plan.unsupported) assert.ok(entry.why && entry.why.length > 20, `${entry.what} has no reason`);
}

function testTheAdapterSaysADatabaseArrivesEmpty() {
  const plan = planFromCpanel({ databases: [{ name: 'oldcust_shop', dumpPath: 'mysql/oldcust_shop.sql' }] });
  // An empty database with the right name is not a migrated database, and
  // somebody who believes it is will point a live site at it.
  assert.match(plan.warnings.join(' '), /created empty/);
  assert.equal(plan.databases.length, 1);
}

function testTheAdapterCountsTheStatisticsEveryoneElseDrops() {
  const plan = planFromCpanel({
    statistics: [
      { domain: 'example.com', month: 6, year: 2026, visits: 800 },
      { domain: 'example.com', month: 7, year: 2026, visits: 900 },
    ],
  });
  assert.equal(plan.statistics.length, 2);
  assert.match(plan.warnings.join(' '), /2 month\(s\) of web statistics/);
}

function testTheAdaptersOutputSurvivesTheCatalogue() {
  // The two halves have to agree or the plan is refused at the door, so the
  // adapter's own output is put through the rebuilder the operation uses.
  const plan = migrationPlan(planFromCpanel({
    account: { user: 'oldcust' },
    domains: [{ domain: 'Example.com', kind: 'main', documentRoot: 'public_html' }],
    mailboxes: [{ domain: 'example.com', account: 'Sales', quotaMb: 500 }],
    cron: [{ schedule: '0 3 * * *', command: 'php cron.php' }],
  }));
  assert.equal(plan.domains[0].domain, 'example.com');
  assert.equal(plan.mailboxes[0].address, 'sales@example.com');
  assert.match(plan.unsupported.join(' '), /scheduled job.*cron line is a command/);
}

function testAnArchiveTheParserCouldNotReadIsRefused() {
  assert.throws(() => planFromCpanel(null), /nothing this panel can read/);
  assert.throws(() => planFromCpanel([]), /nothing this panel can read/);
  // An archive with nothing in it is a plan that builds nothing, not an error.
  const empty = planFromCpanel({});
  assert.deepEqual(empty.domains, []);
  // One warning, and it is the honest one: a plan read without keeping the
  // archive can build the shape of an account and cannot fill it. Said at the
  // preview rather than discovered afterwards in an empty document root.
  assert.equal(empty.warnings.length, 1);
  assert.match(empty.warnings[0], /cannot fill them/);
  assert.deepEqual(planFromCpanel({}, { archiveId: `mig_${'b'.repeat(16)}` }).warnings, []);
}


// ── The two halves against each other ──────────────────────────────
// The parser is a separate piece of work by a separate author against a written
// contract, and it diverged from that contract in two places that both matter.
// These are the tests that caught them, so they stay.

function testAReadOnlyGrantStaysReadOnly() {
  // The contract said privileges was a word. The parser sends the privilege
  // names it actually read out of the archive's GRANT statements, and the first
  // version of the adapter treated every list as full access, which quietly
  // handed a reporting user the right to write to the database it reads.
  assert.equal(grantLevel(['SELECT']), 'read');
  assert.equal(grantLevel(['SELECT', 'SHOW VIEW']), 'read');
  assert.equal(grantLevel(['SELECT', 'INSERT']), 'all');
  assert.equal(grantLevel(['ALL PRIVILEGES']), 'all');
  assert.equal(grantLevel(['select']), 'read');
  // The word form still works, because the contract said it would.
  assert.equal(grantLevel('read'), 'read');
  assert.equal(grantLevel('all'), 'all');
  // And a grant nobody can read is full access with a warning beside it rather
  // than a silent guess.
  const plan = planFromCpanel({ databases: [{ name: 'shop', users: [{ username: 'mystery' }] }] });
  assert.equal(plan.databases[0].users[0].privileges, 'all');
  assert.match(plan.warnings.join(' '), /did not record what mystery/);
}

function testARealMailboxQuotaDoesNotThrowOutTheWholePlan() {
  // cPanel keeps the quota in bytes and the parser divides, so a real mailbox
  // arrives as 488.28125 MB. The executor takes whole megabytes and refuses
  // anything else, so one ordinary mailbox would have refused the entire plan.
  assert.equal(wholeMegabytes(488.28125), 489);
  assert.equal(wholeMegabytes(0), 0);
  assert.equal(wholeMegabytes(null), 0);
  assert.equal(wholeMegabytes(-1), 0);
  const plan = migrationPlan(planFromCpanel({ mailboxes: [{ domain: 'example.com', account: 'sales', quotaMb: 488.28125 }] }));
  assert.equal(plan.mailboxes[0].quotaMb, 489);
}

function testARealArchiveGoesAllTheWayThrough() {
  // The whole path, from the entries an unpacked archive gives up to the plan
  // the operation will accept, with nothing stubbed in between.
  const file = text => Buffer.from(text);
  const entries = new Map([
    ['cpmove-oldcust/meta/homedir_paths', file('/home/oldcust\n')],
    ['cpmove-oldcust/cp/oldcust', file('DNS=example.com\nUSER=oldcust\nCONTACTEMAIL=me@example.com\n')],
    ['cpmove-oldcust/homedir/public_html/index.php', file('<?php echo 1;')],
    ['cpmove-oldcust/homedir/etc/example.com/passwd', file('sales:x:1:1::/home/oldcust/mail/example.com/sales:/sbin/nologin\n')],
    ['cpmove-oldcust/homedir/etc/example.com/quota', file('sales:512000000\n')],
    ['cpmove-oldcust/mysql/oldcust_shop.sql', file('CREATE TABLE t(id int);')],
    ['cpmove-oldcust/mysql.sql', file("GRANT SELECT ON `oldcust_shop`.* TO 'readonly'@'localhost';")],
    ['cpmove-oldcust/cron/oldcust', file('0 3 * * * php /home/oldcust/cron.php\n')],
  ]);
  const plan = migrationPlan(planFromCpanel(parseCpanelArchive(entries)));
  assert.equal(plan.account, 'oldcust');
  assert.equal(plan.source, 'cpanel');
  assert.equal(plan.domains[0].domain, 'example.com');
  assert.equal(plan.mailboxes[0].address, 'sales@example.com');
  assert.equal(plan.databases[0].users[0].privileges, 'read');
  // The cron job is not built and the plan says which one and why.
  assert.match(plan.unsupported.join(' '), /scheduled job/);
  // And the thing every migration drops is at least counted.
  assert.match(plan.warnings.join(' '), /database\(s\) are created empty/);
}

function testAnArchiveFromSomewhereElseIsRefusedByName() {
  // Not a cPanel archive at all. The refusal is a sentence, because a stack
  // trace here sends whoever reads it looking in the wrong place.
  assert.throws(() => parseCpanelArchive(new Map()), /Not a cPanel archive/);
}


function testOneBadEntryDoesNotRefuseTheWholeArchive() {
  // Watched happening on the box: a stray file in the archive's mysql directory
  // became a database named ._oldcust_shop, the validator refused the name, and
  // the whole migration refused with it. An archive from a machine nobody here
  // controls always contains something unexpected.
  const plan = migrationPlan(planFromCpanel({
    domains: [{ domain: 'good.example', kind: 'main' }, { domain: 'not a domain', kind: 'addon' }],
    databases: [{ name: '._oldcust_shop' }, { name: 'oldcust_shop', users: [{ username: 'rw', privileges: ['ALL PRIVILEGES'] }] }],
    mailboxes: [{ domain: 'good.example', account: 'sales' }, { domain: 'good.example', account: 'not a mailbox name' }],
  }));
  assert.deepEqual(plan.domains.map(entry => entry.domain), ['good.example']);
  assert.deepEqual(plan.databases.map(entry => entry.name), ['oldcust_shop']);
  assert.deepEqual(plan.mailboxes.map(entry => entry.account), ['sales']);
  // And every one that was dropped is named, with the reason the validator
  // gave, because a migration that quietly builds three of five is the failure
  // this whole function exists to avoid.
  const said = plan.unsupported.join(' | ');
  assert.match(said, /not a domain/);
  assert.match(said, /_oldcust_shop/);
  assert.match(said, /not a mailbox name/);
}

function run() {
  const tests = [
    testALineEndsAtTheEndOfTheLineUnlessALiteralSaysOtherwise,
    testAQuotedNameSurvivesItsOwnPunctuation,
    testTheFolderListIsReadTheWayServersActuallyWriteIt,
    testAFolderNameComesBackInTheAlphabetItWasWrittenIn,
    testAMessageCountIsReadWithAndWithoutTheSizeExtension,
    testTheImportedPlanIsRebuiltRatherThanAccepted,
    testAPlanThatIsNotAPlanIsRefused,
    testCopyingAMailboxRefusesInputThatWouldBecomeASecondCommand,
    testTheMirrorIsDestructiveAndSaysSo,
    testTheMigrationSummarySaysNothingIsCutOver,
    testTheAdapterCarriesWhatCanBeBuilt,
    testTheAdapterNamesEverythingItCannotBuild,
    testTheAdapterSaysADatabaseArrivesEmpty,
    testTheAdapterCountsTheStatisticsEveryoneElseDrops,
    testTheAdaptersOutputSurvivesTheCatalogue,
    testAnArchiveTheParserCouldNotReadIsRefused,
    testAReadOnlyGrantStaysReadOnly,
    testARealMailboxQuotaDoesNotThrowOutTheWholePlan,
    testARealArchiveGoesAllTheWayThrough,
    testAnArchiveFromSomewhereElseIsRefusedByName,
    testOneBadEntryDoesNotRefuseTheWholeArchive,
  ];
  for (const test of tests) { test(); console.log(`  [32m✓[0m ${test.name.replace(/^test/, '')}`); }
  console.log(`migration tests passed (${tests.length})`);
}

run();
