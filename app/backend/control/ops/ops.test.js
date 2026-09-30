'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { createActionStore } = require('../actionStore');
const { createHostBackend } = require('./hostBackend');
const { createHestiaBackend } = require('./hestiaBackend');
const { createOpsEngine } = require('./engine');
const { createServerOpsService } = require('../serverOps');
const { createOwnershipService } = require('../ownership');
const { getOperation, OPERATIONS } = require('./catalogue');
const { executeNamedJob, parseMailQueue } = require('./privilegedJobs');

async function run() {
  testCatalogueRefusesBadInput();
  testDestructiveOperationsDemandTypedConfirmation();
  testEveryOperationDeclaresItsResourceScope();
  await testEngineOrdersBackendsAndExplainsGaps();
  await testServiceControlIsVerifiedAgainstSystemd();
  await testServiceControlFailsWhenTheUnitDoesNotComeBack();
  await testFirewallProbeTestsPermissionNotPresence();
  await testRefreshReprobesTheMachine();
  await testMailQueueParsesRealPostqueueOutput();
  await testPrivilegedCatalogueRejectsCommands();
  await testProcessKillRefusesToStopThePanel();
  await testLogTailAndSearchReadRealFiles();
  await testFilePermissionsStayInsideTheAccount();
  await testHestiaWritesAreClosedUntilVerified();
  await testHestiaMailboxCreateIsVerifiedByReadingItBack();
  await testProposeApproveExecuteRecordsAVerifiedResult();
  await testUnverifiedResultsAreRecordedAsFailures();
  await testGeneratedCredentialsAreHandedBackOnce();
  await testMailboxPasswordCanBeGeneratedOnTheServer();
  await testTheOwnerCanChooseThePasswordInstead();
  await testProposalsAreRefusedWhenTheCapabilityIsAbsent();
  await testSurfaceIsScopedForMachineCredentials();
  testFirstIdentityOnABoxOutranksEveryoneWhoFollows();
  await testAnEndUserMayClaimAnUnclaimedResourceButNotSomeoneElses();
  await testServerWideOperationsAreReservedToTheOperator();
  await testDeletingASiteReleasesItsNameForSomeoneElseToClaim();
  await testAnEndUserReadsOnlyTheirOwnResources();
  await testAReadThatNamesSomeoneElsesResourceIsRefused();
  await testTheMachinesOwnStateIsOperatorOnly();
  await testAQueuedMessageIsShownToWhoeverSentIt();
  await testAMigrationClaimsEverythingItCreated();
  await testAMigrationIsMeteredAgainstThePackage();
  await testAMigrationHandsBackItsGeneratedPasswordsOnce();
  await testAMigrationIsCarriedOutForAnAccountRatherThanByOne();
  await testANarrowedCallerIsRefusedTheCapabilitiesItDoesNotHold();
  console.log('server-operations tests passed');
}

// ── Catalogue ──────────────────────────────────────────────────────
function testCatalogueRefusesBadInput() {
  assert.throws(() => getOperation('database.create').normalize({ name: 'drop; --' }), /not a valid database name/);
  assert.throws(() => getOperation('mail.mailbox.create').normalize({ domain: 'not a domain', account: 'sales', password: 'x'.repeat(12) }), /not a domain name/);
  assert.throws(() => getOperation('process.kill').normalize({ pid: 'all' }), /whole number/);
  assert.throws(() => getOperation('file.permissions').normalize({ target: 'x', mode: '999' }), /not a valid permissions/);
  assert.throws(() => getOperation('dns.record.create').normalize({ zone: 'example.com', type: 'PTR', value: 'x' }), /record type/);
  assert.throws(() => getOperation('service.restart').normalize({ unit: 'nginx; rm -rf /' }), /not a valid service name/);
  assert.equal(getOperation('service.restart').normalize({ unit: 'tomcat9' }).verb, 'restart');
  assert.equal(getOperation('mail.queue.delete').normalize({ id: 'all' }).id, 'ALL');

  // Anything the machine underneath would reject is caught here, before it can
  // become an approved action sitting in the record waiting to fail.
  assert.throws(() => getOperation('sshkey.add').normalize({ key: 'not-a-key' }), /does not look like a public key/);
  assert.throws(() => getOperation('database.user.create').normalize({ username: 'app', password: "short'" }), /10–128 characters/);
  assert.throws(() => getOperation('database.user.create').normalize({ username: 'app', password: "has spaces and 'quotes'" }), /10–128 characters/);
  assert.equal(
    getOperation('sshkey.add').normalize({ key: `ssh-ed25519 ${'A'.repeat(40)}  steve@laptop` }).key,
    `ssh-ed25519 ${'A'.repeat(40)} steve@laptop`);
}

function testDestructiveOperationsDemandTypedConfirmation() {
  for (const operation of OPERATIONS) {
    if (operation.risk === 'destructive') {
      assert.ok(operation.confirm, `${operation.id} is destructive and must demand typed confirmation`);
    }
  }
  assert.equal(getOperation('database.drop').confirm, 'DROP');
  assert.equal(getOperation('system.reboot').confirm, 'REBOOT');
}

// Every write names which of its own parameters is the resource an owner
// check has to run against, or says plainly that it acts on the whole
// machine. This is what lets the ownership check live in one place instead
// of being written once per handler and forgotten in the ninety-seventh:
// a row with no scope, or a scope that does not match what normalize()
// actually reads, is refused here rather than found later on a live box.
function testEveryOperationDeclaresItsResourceScope() {
  // Two of these name no thing on the machine and are deliberately odd.
  // `organization` names an account, and ownership.js answers it from the
  // provider hierarchy instead of `resource_owners`. `own` names nothing at
  // all: it acts on the caller's own organization, which is how a provider
  // makes a package to sell. serverOps must not claim either into the resource
  // table, and neither may carry a resource parameter.
  const KINDS = new Set(['site', 'mailbox', 'database', 'zone', 'backup', 'server', 'organization', 'own']);
  const NO_RESOURCE = new Set(['server', 'own']);
  for (const operation of OPERATIONS) {
    assert.ok(operation.scope, `${operation.id} has no resource scope declared`);
    assert.ok(KINDS.has(operation.scope.kind), `${operation.id} declares an unknown scope kind: ${operation.scope.kind}`);
    if (NO_RESOURCE.has(operation.scope.kind)) {
      assert.ok(!operation.scope.param, `${operation.id} is ${operation.scope.kind}-scoped and must not also name a resource parameter`);
    } else {
      assert.ok(typeof operation.scope.param === 'string' && operation.scope.param,
        `${operation.id} is ${operation.scope.kind}-scoped and must name the parameter that identifies the resource`);
      const source = operation.normalize.toString();
      const needle = `p.${operation.scope.param}`;
      assert.ok(source.includes(needle), `${operation.id} declares scope.param '${operation.scope.param}' but normalize() never reads ${needle}`);
    }
  }
}

// ── Engine ─────────────────────────────────────────────────────────
function stubBackend(name, available, missing = {}) {
  return {
    name,
    capabilities: async () => ({
      capabilities: new Map(Object.entries(available).map(([id, run]) => [id, { id, kind: 'read', backend: name, run }])),
      missing: new Map(Object.entries(missing)),
      state: { stub: true },
    }),
  };
}

async function testEngineOrdersBackendsAndExplainsGaps() {
  const engine = createOpsEngine({
    backends: [
      stubBackend('hestia', { 'service.list': async () => ({ from: 'hestia' }) }, { 'service.control': 'attached read-only' }),
      stubBackend('host', { 'service.list': async () => ({ from: 'host' }), 'process.list': async () => ({ from: 'host' }) }, { 'service.control': 'no sudo' }),
    ],
  });

  // The panel underneath owns anything it covers; the host fills the rest.
  assert.equal((await engine.run('service.list')).data.from, 'hestia');
  assert.equal((await engine.run('process.list')).data.backend || (await engine.run('process.list')).data.from, 'host');

  // A gap keeps every backend's reason, because "no sudo" and "read-only" are
  // different problems with different fixes.
  const reason = await engine.reasonFor('service.control');
  assert.match(reason, /hestia: attached read-only/);
  assert.match(reason, /host: no sudo/);

  // Something nothing claims still gets a usable sentence rather than silence.
  assert.match(await engine.reasonFor('database.list'), /Nothing attached to this panel provides database.list/);
  await assert.rejects(() => engine.run('database.list'), error => error.unavailable === 'database.list');
}

// ── Services ───────────────────────────────────────────────────────
function scriptedRunner(script) {
  const calls = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, ...args].join(' '));
      for (const [pattern, response] of script) {
        if (pattern.test([file, ...args].join(' '))) {
          return { ok: true, code: 0, stdout: '', stderr: '', missing: false, timedOut: false, ...response };
        }
      }
      return { ok: false, code: 1, stdout: '', stderr: 'unscripted command', missing: false, timedOut: false };
    },
  };
}

function namedJobClient(handlers = {}) {
  const calls = [];
  return {
    calls,
    client: {
      probe: async () => ({ ok: true, reason: null }),
      run: async (job, params) => {
        calls.push({ job, params });
        if (handlers[job]) return handlers[job](params);
        throw new Error(`${job} is unavailable in this test`);
      },
    },
  };
}

const SHOW_ACTIVE = [
  'Id=tomcat.service', 'Description=Apache Tomcat', 'LoadState=loaded', 'ActiveState=active', 'SubState=running',
  'UnitFileState=enabled', 'ActiveEnterTimestamp=Thu 2026-08-13 09:00:00 UTC', 'MemoryCurrent=402653184',
  'MainPID=821', 'NRestarts=0', 'Result=success',
].join('\n');

async function testServiceControlIsVerifiedAgainstSystemd() {
  const runner = scriptedRunner([
    [/^systemctl --version/, { stdout: 'systemd 252' }],
    [/^systemctl show tomcat\.service/, { stdout: SHOW_ACTIVE }],
    [/^(ps|journalctl|apt-get|ufw|postqueue|mysql|psql|tar|chmod)/, { ok: false, missing: true, error: 'absent' }],
  ]);
  const jobs = namedJobClient({ 'service.control': async () => ({ accepted: true }) });
  const host = createHostBackend({ env: {}, run: runner.run, privilegedClient: jobs.client });
  const { capabilities } = await host.capabilities();
  const control = capabilities.get('service.control');
  assert.ok(control, 'service control should be offered when systemd and sudo are both present');

  const result = await control.run({ unit: 'tomcat', verb: 'restart' });
  assert.equal(result.verified, true);
  assert.equal(result.state.active, 'active');
  assert.equal(result.state.memory_bytes, 402653184);
  assert.equal(result.state.uptime_seconds >= 0, true);
  // The state is read back from systemd after the change, not inferred.
  assert.ok(runner.calls.some(c => c.startsWith('systemctl show tomcat.service')));
  assert.deepEqual(jobs.calls.find(call => call.job === 'service.control'), { job: 'service.control', params: { unit: 'tomcat.service', verb: 'restart' } });
}

async function testServiceControlFailsWhenTheUnitDoesNotComeBack() {
  const dead = SHOW_ACTIVE.replace('ActiveState=active', 'ActiveState=failed').replace('SubState=running', 'SubState=dead');
  const runner = scriptedRunner([
    [/^systemctl --version/, { stdout: 'systemd 252' }],
    [/^systemctl show/, { stdout: dead }],        // and the unit is dead anyway
    [/^(ps|journalctl|apt-get|ufw|postqueue|mysql|psql|tar|chmod)/, { ok: false, missing: true }],
  ]);
  const jobs = namedJobClient({ 'service.control': async () => ({ accepted: true }) });
  const host = createHostBackend({ env: {}, run: runner.run, privilegedClient: jobs.client });
  const { capabilities } = await host.capabilities();
  await assert.rejects(
    () => capabilities.get('service.control').run({ unit: 'tomcat', verb: 'restart' }),
    /tomcat\.service is failed\/dead after restart/
  );
}

async function testFirewallProbeTestsPermissionNotPresence() {
  const runner = scriptedRunner([
    [/^ufw --version/, { stdout: 'ufw 0.36' }],
    [/^ps /, { stdout: '' }],
    [/./, { ok: false, missing: true, error: 'absent' }],
  ]);
  const jobs = namedJobClient();
  const host = createHostBackend({ env: {}, run: runner.run, privilegedClient: jobs.client });
  const report = await host.capabilities();
  assert.equal(report.capabilities.has('firewall.list'), false, 'ufw on disk is not enough');
  assert.match(report.missing.get('firewall.list'), /permission probe failed/);
  assert.match(report.missing.get('firewall.list'), /probe\.firewall is unavailable/);
}

// Found on a real box: jotpanel-ops was stopped, the socket was gone, and the panel
// still offered the firewall. The engine refreshed its own cache and called the
// backend again, but the backend handed back a probe it had memoised at
// startup, so a capability outlived the privilege behind it. A refresh has to
// reach the machine or it is not a refresh.
async function testRefreshReprobesTheMachine() {
  let privileged = true;
  const client = {
    probe: async () => (privileged ? { ok: true, reason: null } : { ok: false, reason: 'the service is not reachable' }),
    run: async job => {
      if (!privileged) throw new Error('the privileged operations service is not reachable');
      if (job === 'probe.firewall') return { available: true, active: true, rules: [] };
      throw new Error(`${job} is unavailable in this test`);
    },
  };
  const runner = scriptedRunner([
    [/^ps /, { stdout: '' }],
    [/./, { ok: false, missing: true, error: 'absent' }],
  ]);
  const host = createHostBackend({ env: {}, run: runner.run, privilegedClient: client });
  const engine = createOpsEngine({ backends: [host] });

  assert.equal(await engine.has('firewall.list'), true, 'the firewall reads while the service is up');

  privileged = false;
  assert.equal(await engine.has('firewall.list'), true, 'the cache is allowed to be stale until asked');

  await engine.refresh();
  assert.equal(await engine.has('firewall.list'), false, 'a refresh must re-probe the machine, not replay the old answer');
  assert.match(await engine.reasonFor('firewall.list'), /permission probe failed/);
}

// Captured verbatim from postqueue -p on the Vultr box, Postfix 3.8.6. The
// shipped parser split this on blank lines, which made the column header the
// head of the first block and silently dropped A356C3003DD from every read.
// A queue holding exactly one message therefore read as empty, which is the
// worst possible way for this to be wrong.
const REAL_POSTQUEUE = [
  '-Queue ID-  --Size-- ----Arrival Time---- -Sender/Recipient-------',
  'A356C3003DD    2305 Sun Aug 16 20:36:27  MAILER-DAEMON',
  '(connect to panel.viabandwidth.com[2606:4700:130:436c::1]:25: Network is unreachable)',
  '                                         postmaster@panel.viabandwidth.com',
  '',
  'A1AD13003DE*   2305 Sun Aug  6 20:36:27  sender@example.com',
  '     (connect to panel.viabandwidth.com[172.64.80.1]:25: Connection timed out)',
  '                                         one@example.net',
  '                                         two@example.net',
  '',
  '-- 4 Kbytes in 2 Requests.',
  '',
].join('\n');

async function testMailQueueParsesRealPostqueueOutput() {
  const messages = parseMailQueue(REAL_POSTQUEUE);
  assert.equal(messages.length, 2, 'the first message must not be eaten by the column header');
  assert.deepEqual(messages.map(m => m.id), ['A356C3003DD', 'A1AD13003DE']);

  const [first, second] = messages;
  assert.equal(first.sender, 'MAILER-DAEMON', 'a bounce has no address for a sender');
  assert.equal(first.active, false);
  assert.deepEqual(first.recipients, ['postmaster@panel.viabandwidth.com']);
  assert.match(first.reason, /Network is unreachable/, 'why it is stuck is the point of looking');

  assert.equal(second.active, true, 'the * marks an active message');
  assert.equal(second.arrived, 'Sun Aug 6 20:36:27', 'ctime pads a single-digit day with a space');
  assert.deepEqual(second.recipients, ['one@example.net', 'two@example.net']);

  assert.deepEqual(parseMailQueue('Mail queue is empty\n'), []);
  assert.equal(parseMailQueue('Q1AbCdEf2345   900 Mon Sep  1 01:02:03  a@b.co\n')[0].id, 'Q1AbCdEf2345',
    'long queue ids are an operator setting, not an impossibility');
}

async function testPrivilegedCatalogueRejectsCommands() {
  await assert.rejects(() => executeNamedJob('command.run', { command: 'id' }), /Unknown privileged job/);
  await assert.rejects(() => executeNamedJob('service.control', { unit: 'nginx', verb: 'reload', command: 'id' }), /does not accept: command/);
}

async function testProcessKillRefusesToStopThePanel() {
  const host = createHostBackend({ env: {}, run: scriptedRunner([[/^ps/, { stdout: '1 0 root 0.0 0.0 10:00 1024 /sbin/init\n' }]]).run });
  const { capabilities } = await host.capabilities();
  const kill = capabilities.get('process.kill');
  await assert.rejects(() => kill.run({ pid: process.pid }), /the panel itself/);
  await assert.rejects(() => kill.run({ pid: 1 }), /above 1/);
  await assert.rejects(() => kill.run({ pid: 4242, signal: 'BOOM' }), /Unsupported signal/);
}

// ── Logs ───────────────────────────────────────────────────────────
async function testLogTailAndSearchReadRealFiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-ops-log-'));
  const file = path.join(dir, 'error.log');
  const lines = Array.from({ length: 500 }, (_, i) => `2026-08-13 line ${i} ${i % 50 === 0 ? 'upstream timed out' : 'ok'}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);

  const host = createHostBackend({
    env: { ARCA_OPS_LOG_PATHS: `web-error:Website errors:${file}` },
    run: scriptedRunner([[/./, { ok: false, missing: true }]]).run,
    logCandidates: [],
  });
  const { capabilities } = await host.capabilities();

  const tail = await capabilities.get('log.tail').run({ id: 'web-error', lines: 20 });
  assert.equal(tail.line_count, 20);
  assert.equal(tail.lines[19], lines[499]);

  const found = await capabilities.get('log.search').run({ id: 'web-error', query: 'upstream timed out' });
  assert.equal(found.match_count, 10);
  assert.equal(found.matches[0].line_number, 1);
  assert.equal(found.lines_scanned, 500);
  assert.equal(found.capped, false);

  // A capped search returns exactly the cap, in file order, and says it
  // stopped. Reporting more matches than it can show, or showing a slice from
  // the middle of the file, is how a log search quietly lies.
  const capped = await capabilities.get('log.search').run({ id: 'web-error', query: 'line', limit: 25 });
  assert.equal(capped.capped, true);
  assert.equal(capped.match_count, 25);
  assert.equal(capped.matches.length, 25);
  assert.equal(capped.matches[0].line_number, 1);
  assert.equal(capped.matches[24].line_number, 25);

  const download = await capabilities.get('log.download').run({ id: 'web-error' });
  assert.equal(download.truncated, false);
  assert.equal(download.sending_bytes, fs.statSync(file).size);

  await assert.rejects(() => capabilities.get('log.tail').run({ id: 'nope' }), /No readable log is registered/);
  fs.rmSync(dir, { recursive: true, force: true });
}

async function testFilePermissionsStayInsideTheAccount() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-ops-files-'));
  fs.mkdirSync(path.join(root, 'owner'), { recursive: true });
  fs.writeFileSync(path.join(root, 'owner', 'index.html'), '<h1>hello</h1>');
  fs.writeFileSync(path.join(root, 'other-account-secret'), 'not yours');

  const host = createHostBackend({
    env: {},
    run: scriptedRunner([[/^tar/, { stdout: 'tar 1.34' }]]).run,
    fileRootFor: ctx => path.join(root, ctx.accountId),
  });
  const { capabilities } = await host.capabilities();
  const ctx = { accountId: 'owner' };

  const changed = await capabilities.get('file.permissions').run({ target: 'index.html', mode: '640' }, ctx);
  assert.equal(changed.mode, '640');
  assert.equal(changed.verified, true);
  assert.equal(fs.statSync(path.join(root, 'owner', 'index.html')).mode & 0o777, 0o640);

  // The escape attempt is refused before anything touches the filesystem.
  await assert.rejects(() => capabilities.get('file.permissions').run({ target: '../other-account-secret', mode: '777' }, ctx), /outside the account file area/);
  assert.notEqual(fs.statSync(path.join(root, 'other-account-secret')).mode & 0o777, 0o777);
  fs.rmSync(root, { recursive: true, force: true });
}

// ── Hestia ─────────────────────────────────────────────────────────
function stubHestia(responses) {
  const calls = [];
  return {
    calls,
    adapter: {
      name: 'hestia', host: 'panel.example',
      callCommand: async (cmd, args) => {
        calls.push({ cmd, args });
        const handler = responses[cmd];
        if (typeof handler === 'function') return handler(args, calls);
        if (handler === undefined) throw new Error(`Hestia ${cmd} — command failed (exit 1)`);
        return handler;
      },
    },
  };
}

async function testHestiaWritesAreClosedUntilVerified() {
  const { adapter } = stubHestia({});
  const backend = createHestiaBackend({ adapter, allowWrites: false });
  const { capabilities, missing } = await backend.capabilities();
  assert.ok(capabilities.has('mail.mailbox.list'), 'reads are safe and are offered');
  assert.equal(capabilities.has('mail.mailbox.create'), false, 'writes must stay closed until the argument order is checked');
  assert.match(missing.get('mail.mailbox.create'), /positional arguments whose order has not been checked/);

  const open = await createHestiaBackend({ adapter, allowWrites: true }).capabilities();
  assert.ok(open.capabilities.has('mail.mailbox.create'));
}

async function testHestiaMailboxCreateIsVerifiedByReadingItBack() {
  let created = false;
  const { adapter, calls } = stubHestia({
    'v-add-mail-account': () => { created = true; return null; },
    'v-list-mail-accounts': () => (created ? { sales: { QUOTA: '1024', U_DISK: '0', FWD: '', AUTOREPLY: 'no', SUSPENDED: 'no' } } : {}),
  });
  const backend = createHestiaBackend({ adapter, allowWrites: true });
  const { capabilities } = await backend.capabilities();
  const ctx = { panelUser: 'owner' };

  const made = await capabilities.get('mail.mailbox.create').run(
    { domain: 'example.com', account: 'sales', password: 'a-long-password', quotaMb: 1024 }, ctx);
  assert.equal(made.address, 'sales@example.com');
  assert.equal(made.verified, true);
  assert.deepEqual(calls[0].args, ['owner', 'example.com', 'sales', 'a-long-password', '1024']);
  assert.equal(calls[1].cmd, 'v-list-mail-accounts');

  // Hestia answering "fine" while the mailbox is not there must be a failure.
  const quiet = stubHestia({ 'v-add-mail-account': null, 'v-list-mail-accounts': {} });
  const silent = await createHestiaBackend({ adapter: quiet.adapter, allowWrites: true }).capabilities();
  await assert.rejects(
    () => silent.capabilities.get('mail.mailbox.create').run({ domain: 'example.com', account: 'sales', password: 'a-long-password' }, ctx),
    /was not in Hestia's mailbox list after the create/
  );
}


// ── Moving an account in ───────────────────────────────────────────
// A migration is the one operation that creates many things at once, and both
// of the rules every other creating operation obeys were missing from it: what
// it makes was claimed by nobody, and what it makes counted against nothing.

function migrationHarness(handler, { entitlements = null } = {}) {
  const db = new Database(':memory:');
  const actionStore = createActionStore({ db });
  const ownership = createOwnershipService({ db });
  const engine = createOpsEngine({
    backends: [{
      name: 'stub',
      capabilities: async () => ({
        capabilities: new Map([['migrate.apply', { id: 'migrate.apply', kind: 'write', backend: 'stub', run: handler }]]),
        missing: new Map(),
        state: {},
      }),
    }],
  });
  return { db, actionStore, ownership, service: createServerOpsService({ engine, actionStore, ownership, entitlements }) };
}

const ONE_ACCOUNT_PLAN = {
  domains: [{ domain: 'moved.example', documentRoot: 'public' }],
  databases: [{ name: 'shop', users: [{ username: 'shop_user', privileges: 'all' }] }],
  mailboxes: [
    { domain: 'moved.example', account: 'sales', quotaMb: 500 },
    { domain: 'moved.example', account: 'info', quotaMb: 500 },
  ],
};

async function testAMigrationClaimsEverythingItCreated() {
  const { db, actionStore, ownership, service } = migrationHarness(async () => ({
    verified: true,
    counts: { done: 4, failed: 0 },
    // What the job says it made. The panel claims these; it does not go looking
    // for them, because only the job knows which parts of the plan actually ran.
    claims: [
      { kind: 'site', key: 'moved.example' },
      { kind: 'database', key: 'shop' },
      { kind: 'mailbox', key: 'moved.example' },
      { kind: 'mailbox', key: 'moved.example' },
    ],
  }));

  await proposeApproveExecute(service, actionStore, 'owner', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN });
  const mine = ownership.getMembership('owner').orgId;
  assert.ok(mine, 'the first identity on the box has an organization');

  // Every kind the migration created now belongs to the account that asked for
  // it. Without this the reads, which narrow by ownership, showed the person who
  // had just moved in an empty panel.
  assert.equal(ownership.orgOwns(mine, 'site', 'moved.example'), true);
  assert.equal(ownership.orgOwns(mine, 'database', 'shop'), true);
  assert.equal(ownership.orgOwns(mine, 'mailbox', 'moved.example'), true);
  // Mail is tracked by domain, so two mailboxes on one domain are one claim and
  // not two rows. A second row would double-count the domain in every meter that
  // reads this table.
  const mailRows = db.prepare("SELECT COUNT(*) AS n FROM resource_owners WHERE kind='mailbox' AND resource_key='moved.example'").get();
  assert.equal(mailRows.n, 1);

  // A resource somebody else already owns is left alone rather than taken. The
  // claim is first-write-wins everywhere else and a migration is not an
  // exception to it.
  db.prepare("INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','taken.example','org_someone_else',?)").run(new Date().toISOString());
  const second = migrationHarness(async () => ({
    verified: true, counts: { done: 1, failed: 0 }, claims: [{ kind: 'site', key: 'taken.example' }],
  }));
  second.db.prepare("INSERT INTO resource_owners (kind, resource_key, org_id, created_at) VALUES ('site','taken.example','org_someone_else',?)").run(new Date().toISOString());
  await proposeApproveExecute(second.service, second.actionStore, 'owner', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN });
  const held = second.db.prepare("SELECT org_id FROM resource_owners WHERE kind='site' AND resource_key='taken.example'").get();
  assert.equal(held.org_id, 'org_someone_else');
}

async function testAMigrationIsMeteredAgainstThePackage() {
  const asked = [];
  const allowing = {
    admitProposal: async (orgId, effects, createProposal) => {
      asked.push({ orgId, effects });
      return { ok: true, proposal: createProposal() };
    },
    releaseHolds: () => {},
  };
  const { actionStore, service } = migrationHarness(async () => ({ verified: true, counts: { done: 4, failed: 0 } }), { entitlements: allowing });
  await proposeApproveExecute(service, actionStore, 'owner', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN });

  // The size of a migration is not known until the plan is read, so the row
  // gives a function and the service resolves it. One site, one database, two
  // mailboxes, and nothing asked for a metric the plan does not touch.
  assert.equal(asked.length, 1);
  assert.deepEqual(asked[0].effects, [
    { metric: 'sites_count', delta: 1 },
    { metric: 'databases_count', delta: 1 },
    { metric: 'mailboxes_count', delta: 2 },
  ]);

  // And a package that cannot take it refuses before a card exists, exactly as
  // a single site.create would.
  const refusing = {
    admitProposal: async () => ({ ok: false, code: 'ENTITLEMENT_LIMIT_EXCEEDED', metric: 'sites_count', used: 5, holds: 0, delta: 1, maximum: 5 }),
    releaseHolds: () => {},
  };
  const tight = migrationHarness(async () => ({ verified: true }), { entitlements: refusing });
  await assert.rejects(() => tight.service.propose('owner', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN }), /exceed the website limit/);
  assert.equal(tight.actionStore.list({ accountId: 'owner' }).length, 0, 'a refused migration must not leave a card behind');
}

async function testAMigrationHandsBackItsGeneratedPasswordsOnce() {
  const password = 'a-generated-mailbox-password';
  const { actionStore, service } = migrationHarness(async () => ({
    verified: true,
    counts: { done: 2, failed: 0 },
    credentials_generated: 1,
    deliver_once: [{ what: 'mailbox sales@moved.example', username: 'sales@moved.example', password }],
  }));

  const executed = await proposeApproveExecute(service, actionStore, 'owner', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN });
  assert.deepEqual(executed.deliver_once, [{ what: 'mailbox sales@moved.example', username: 'sales@moved.example', password }]);

  // And the durable record holds none of it. An archive carries hashes the new
  // machine cannot reuse, so these passwords exist nowhere else in readable
  // form; writing them into the action history would put every migrated
  // password in the clear for ever.
  const stored = JSON.stringify(actionStore.get(executed.id));
  assert.equal(stored.includes(password), false, 'the recorded action must not hold the delivered password');
  assert.equal(actionStore.get(executed.id).executionResult.deliver_once, undefined);
}

// A hoster moves a customer in. The sites, databases and mailboxes belong to
// the customer, not to the hoster who pressed the button, and both halves of
// that follow: the claims land on the customer's organization and the customer's
// package is what the migration is measured against.
async function testAMigrationIsCarriedOutForAnAccountRatherThanByOne() {
  const metered = [];
  const entitlements = {
    admitProposal: async (orgId, effects, createProposal) => {
      metered.push(orgId);
      return { ok: true, proposal: createProposal() };
    },
    releaseHolds: () => {},
  };
  const { db, actionStore, ownership, service } = migrationHarness(async () => ({
    verified: true, counts: { done: 1, failed: 0 }, claims: [{ kind: 'site', key: 'theirs.example' }],
  }), { entitlements });

  // The operator, and a customer who exists on this box.
  ownership.ensureMembership('operator');
  ownership.ensureMembership('customer');
  const operatorOrg = ownership.getMembership('operator').orgId;
  const customerOrg = ownership.getMembership('customer').orgId;
  assert.notEqual(operatorOrg, customerOrg);

  await proposeApproveExecute(service, actionStore, 'operator', 'migrate.apply',
    { plan: ONE_ACCOUNT_PLAN, targetOrgId: customerOrg });

  assert.equal(ownership.orgOwns(customerOrg, 'site', 'theirs.example'), true, 'the customer owns what was moved in for them');
  assert.equal(ownership.orgOwns(operatorOrg, 'site', 'theirs.example'), false, 'and the hoster who ran it does not');
  assert.deepEqual(metered, [customerOrg], 'the customer\'s package is what it was measured against');

  // An account that does not exist is refused rather than claimed to. A resource
  // claimed for a typo belongs to nobody, which looks exactly like the bug this
  // whole change is here to fix.
  await assert.rejects(() => service.propose('operator', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN, targetOrgId: 'org_typo' }),
    /no account org_typo on this server/);
  assert.equal(actionStore.list({ accountId: 'operator' }).length, 1, 'and no card was left behind by the refusal');

  // Nobody may move an account in for somebody they do not provide for. The
  // second identity here is an ordinary account, so naming the operator's own
  // organization is refused before anything is staged.
  db.prepare("UPDATE memberships SET role='end_user' WHERE identity_id='customer'").run();
  await assert.rejects(() => service.propose('customer', 'migrate.apply', { plan: ONE_ACCOUNT_PLAN, targetOrgId: operatorOrg }),
    /reserved to the account that runs this box|is not an account this one provides for/);
  console.log('  ok  a migration is carried out for an account rather than by one');
}

// A caller can be narrower than the account it belongs to. Today that is an API
// key: it carries its holder's identity, so every ownership and entitlement check
// downstream is the one that would run for them, and its scope can only take
// things away.
async function testANarrowedCallerIsRefusedTheCapabilitiesItDoesNotHold() {
  const { service } = multiOpsHarness({
    'site.create': async params => ({ domain: params.domain, verified: true }),
    'site.delete': async params => ({ domain: params.domain, deleted: true, verified: true }),
  });
  const mayCreateOnly = { permits: capability => capability === 'site.create' };

  const created = await service.propose('owner', 'site.create', { domain: 'scoped.example' }, mayCreateOnly);
  assert.ok(created.id, 'the capability the key holds still works');

  // Refused before the capability is even resolved against the machine, so a
  // key learns nothing about what this box can do outside its own scope.
  await assert.rejects(() => service.propose('owner', 'site.delete', { domain: 'scoped.example' }, mayCreateOnly),
    error => error.forbidden === true && /not scoped for site.delete/.test(error.message));

  // Reads are narrowed by the same list, because a key that may not delete a
  // site should not be able to read the machine's own state either.
  await assert.rejects(() => service.read('server-sites', {}, mayCreateOnly), /not scoped for site.list/);

  // And a caller with no scope list at all is a person, not a key with nothing
  // allowed. Absent must never read as empty.
  const asPerson = await service.propose('owner', 'site.delete', { domain: 'scoped.example' }, {});
  assert.ok(asPerson.id);
  console.log('  ok  a narrowed caller is refused the capabilities it does not hold');
}

// ── Propose, approve, execute ──────────────────────────────────────
function opsHarness(capability, handler, { kind = 'write' } = {}) {
  const db = new Database(':memory:');
  const actionStore = createActionStore({ db });
  const ownership = createOwnershipService({ db });
  const engine = createOpsEngine({
    backends: [{
      name: 'stub',
      capabilities: async () => ({
        capabilities: new Map([[capability, { id: capability, kind, backend: 'stub', run: handler }]]),
        missing: new Map(),
        state: {},
      }),
    }],
  });
  return { db, actionStore, ownership, service: createServerOpsService({ engine, actionStore, ownership }) };
}

// The ownership tests need more than one capability answering on the same
// engine — a site created with one operation and deleted with another — so
// this builds a harness from a map of capability to handler instead of one
// pair, sharing a single db (and therefore a single membership table) across
// every proposal in the test.
function multiOpsHarness(handlers) {
  const db = new Database(':memory:');
  const actionStore = createActionStore({ db });
  const ownership = createOwnershipService({ db });
  const engine = createOpsEngine({
    backends: [{
      name: 'stub',
      capabilities: async () => ({
        capabilities: new Map(Object.entries(handlers).map(([capability, run]) => [capability, { id: capability, kind: 'write', backend: 'stub', run }])),
        missing: new Map(),
        state: {},
      }),
    }],
  });
  return { db, actionStore, ownership, service: createServerOpsService({ engine, actionStore, ownership }) };
}

async function proposeApproveExecute(service, actionStore, userId, operation, input, confirmText) {
  const proposed = await service.propose(userId, operation, input);
  actionStore.approve(proposed.id, { approvedBy: userId, confirmText });
  return service.execute(proposed.id, userId);
}

async function testProposeApproveExecuteRecordsAVerifiedResult() {
  const seen = [];
  const { actionStore, service } = opsHarness('service.control', async params => {
    seen.push(params);
    return { unit: 'nginx.service', verb: 'restart', verified: true, state: { active: 'active' } };
  });

  const proposed = await service.propose('owner', 'service.restart', { unit: 'nginx' });
  assert.equal(proposed.status, 'pending');
  assert.equal(proposed.label, 'Restart nginx');
  assert.equal(proposed.riskLevel, 'elevated');
  assert.equal(seen.length, 0, 'proposing must not run anything');

  // Approval is its own step and still runs nothing.
  actionStore.approve(proposed.id, { approvedBy: 'owner' });
  assert.equal(seen.length, 0);

  const executed = await service.execute(proposed.id, 'owner');
  assert.equal(executed.status, 'executed');
  assert.equal(executed.executionResult.verified, true);
  assert.deepEqual(seen, [{ unit: 'nginx', verb: 'restart' }]);

  // A password never reaches the readable half of the record.
  const secrets = opsHarness('database.user.create', async () => ({ username: 'arca_reports', verified: true }));
  const withSecret = await secrets.service.propose('owner', 'database.user.create', { username: 'reports', password: 'a-long-password' });
  assert.equal(withSecret.metadata.params.password, '[protected]');
  assert.equal(withSecret.call.params.password, 'a-long-password', 'the executing body still carries the real value');
}

// The assistant generates the password because nobody typed one. If it is not
// handed back on the run that made it, the mailbox exists and nobody can sign
// in to it, which is the whole operation failing while showing a green card.
async function testGeneratedCredentialsAreHandedBackOnce() {
  const { actionStore, service } = opsHarness('mail.mailbox.create', async () => ({ address: 'sales@example.com', verified: true }));
  const proposed = await service.propose('owner', 'mail.mailbox.create',
    { domain: 'example.com', account: 'sales', password: 'generated-one' }, {}, { deliver: ['password'] });
  assert.deepEqual(proposed.metadata.deliverOnce, ['password']);
  assert.equal(proposed.metadata.params.password, '[protected]', 'the readable half of the record never carries it');

  actionStore.approve(proposed.id, { approvedBy: 'owner' });
  const executed = await service.execute(proposed.id, 'owner');
  assert.equal(executed.deliver_once.length, 1);
  assert.equal(executed.deliver_once[0].password, 'generated-one');
  assert.equal(executed.deliver_once[0].username, 'sales@example.com');
  // Shown once means shown once: it is on the response and in nothing kept.
  assert.equal(JSON.stringify(actionStore.get(proposed.id).executionResult).includes('generated-one'), false);
  assert.equal(JSON.stringify(actionStore.get(proposed.id).metadata).includes('generated-one'), false);

  // A person filling in the form asks for no delivery and gets none.
  const typed = opsHarness('mail.mailbox.create', async () => ({ address: 'a@example.com', verified: true }));
  const byHand = await typed.service.propose('owner', 'mail.mailbox.create', { domain: 'example.com', account: 'a', password: 'typed-by-hand' });
  assert.equal(byHand.metadata.deliverOnce, undefined);
  typed.actionStore.approve(byHand.id, { approvedBy: 'owner' });
  assert.equal((await typed.service.execute(byHand.id, 'owner')).deliver_once, undefined);
}

async function testMailboxPasswordCanBeGeneratedOnTheServer() {
  let received;
  const { actionStore, service } = opsHarness('mail.mailbox.create', async params => {
    received = params.password;
    return { address: 'generated@example.com', verified: true };
  });
  const proposed = await service.propose('owner', 'mail.mailbox.create',
    { domain: 'example.com', account: 'generated' }, {}, { generate: ['password'] });
  assert.deepEqual(proposed.metadata.deliverOnce, ['password']);
  assert.equal(proposed.metadata.params.password, '[protected]');
  assert.equal(JSON.stringify({ label: proposed.label, summary: proposed.summary, metadata: proposed.metadata }).includes(received || 'not-yet-known'), false,
    'audit-facing proposal text must not contain the generated password');

  actionStore.approve(proposed.id, { approvedBy: 'owner' });
  const executed = await service.execute(proposed.id, 'owner');
  assert.match(received, /^[A-Za-z0-9_-]{24}$/);
  assert.equal(executed.deliver_once[0].password, received);
  assert.equal(JSON.stringify(actionStore.get(proposed.id)).includes(received), false,
    'the generated password must not remain in the action/audit record');
  await assert.rejects(() => service.execute(proposed.id, 'owner'), /already run/,
    'a second fetch of the one-time password must fail');
  await assert.rejects(() => service.propose('owner', 'mail.mailbox.create',
    { domain: 'example.com', account: 'bad' }, {}, { generate: ['domain'] }), /cannot generate/);
}

// A mailbox has a user and a password and the person whose mailbox it is types
// the password. Generating one is the fallback, not the rule.
async function testTheOwnerCanChooseThePasswordInstead() {
  const seen = [];
  const { actionStore, service } = opsHarness('mail.mailbox.create', async params => {
    seen.push(params.password);
    return { address: 'sales@example.com', verified: true };
  });
  const proposed = await service.propose('owner', 'mail.mailbox.create',
    { domain: 'example.com', account: 'sales', password: 'generated-one' }, {}, { deliver: ['password'] });

  const amended = service.supplySecret(proposed.id, 'owner', 'password', 'the-one-they-typed');
  assert.equal(amended.call.params.password, 'the-one-they-typed');
  assert.equal(amended.metadata.params.password, '[protected]');
  assert.deepEqual(amended.metadata.deliverOnce, [], 'nothing to hand back: they chose it');
  assert.deepEqual(amended.metadata.chosenByOwner, ['password']);

  actionStore.approve(amended.id, { approvedBy: 'owner' });
  const executed = await service.execute(amended.id, 'owner');
  assert.deepEqual(seen, ['the-one-they-typed'], 'the machine got the password its owner chose');
  assert.equal(executed.deliver_once, undefined);

  // Only a parameter the panel generated can be replaced, and only while the
  // card is still a question rather than a record.
  assert.throws(() => service.supplySecret(amended.id, 'owner', 'password', 'again-and-again'), /no password for you to choose/);
  // And the password an owner types is held to the floor the machine holds,
  // rather than being trusted because a person typed it.
  const floor = opsHarness('mail.mailbox.create', async () => ({ address: 'c@example.com', verified: true }));
  const short = await floor.service.propose('owner', 'mail.mailbox.create',
    { domain: 'example.com', account: 'c', password: 'generated-one' }, {}, { deliver: ['password'] });
  assert.throws(() => floor.service.supplySecret(short.id, 'owner', 'password', 'short'), /10 to 200 characters/);
  const late = opsHarness('mail.mailbox.create', async () => ({ address: 'b@example.com', verified: true }));
  const staged = await late.service.propose('owner', 'mail.mailbox.create',
    { domain: 'example.com', account: 'b', password: 'generated-one' }, {}, { deliver: ['password'] });
  late.actionStore.approve(staged.id, { approvedBy: 'owner' });
  assert.throws(() => late.service.supplySecret(staged.id, 'owner', 'password', 'far-too-late-now'), /is approved, not pending/);
  const other = opsHarness('service.control', async () => ({ unit: 'nginx.service', verb: 'restart', verified: true }));
  const restart = await other.service.propose('owner', 'service.restart', { unit: 'nginx' });
  assert.throws(() => other.service.supplySecret(restart.id, 'owner', 'unit', 'sshd'), /no unit for you to choose/);
  assert.throws(() => service.supplySecret(amended.id, 'somebody-else', 'password', 'x'), /not found/);
}

async function testUnverifiedResultsAreRecordedAsFailures() {
  const { actionStore, service } = opsHarness('service.control', async () => ({ unit: 'nginx.service', verb: 'restart' }));
  const proposed = await service.propose('owner', 'service.restart', { unit: 'nginx' });
  actionStore.approve(proposed.id, { approvedBy: 'owner' });
  await assert.rejects(() => service.execute(proposed.id, 'owner'), /without confirming the change against the server/);
  const after = actionStore.get(proposed.id);
  assert.equal(after.status, 'failed');
  assert.match(after.error, /not being recorded as done/);

  // A reboot is the one thing nothing inside the machine can confirm, and it
  // says so on the record instead of claiming success.
  const reboot = opsHarness('system.reboot', async () => ({ requested: true, verified: false, note: 'nothing inside this machine can confirm it came back' }));
  const action = await reboot.service.propose('owner', 'system.reboot', {});
  reboot.actionStore.approve(action.id, { approvedBy: 'owner', confirmText: 'REBOOT' });
  const done = await reboot.service.execute(action.id, 'owner');
  assert.equal(done.status, 'executed');
  assert.equal(done.executionResult.verified, false);
  assert.match(done.executionResult.unverified_reason, /came back/);
}

async function testProposalsAreRefusedWhenTheCapabilityIsAbsent() {
  const db = new Database(':memory:');
  const actionStore = createActionStore({ db });
  const engine = createOpsEngine({
    backends: [{
      name: 'host',
      capabilities: async () => ({ capabilities: new Map(), missing: new Map([['database.create', 'no database server is reachable']]), state: {} }),
    }],
  });
  const service = createServerOpsService({ engine, actionStore, ownership: createOwnershipService({ db }) });

  await assert.rejects(() => service.propose('owner', 'database.create', { name: 'shop' }), /no database server is reachable/);
  assert.equal(actionStore.list({ accountId: 'owner' }).length, 0, 'a refused proposal must not leave a card behind');

  // And the panel is told not to draw the tool at all.
  const surface = await service.surface();
  const databases = surface.sections.find(s => s.id === 'databases');
  assert.equal(databases.available, false);
  assert.match(databases.reason, /no database server is reachable/);
  assert.equal(databases.operations.every(op => op.available === false), true);
}

async function testSurfaceIsScopedForMachineCredentials() {
  const { ownership, service } = readHarness({
    'site.list': async () => ({ sites: [] }),
    'service.list': async () => ({ services: [] }),
    'service.control': async () => ({ verified: true }),
  });
  ownership.ensureMembership('the-operator');
  const surface = await service.surface({
    accountId: 'the-operator',
    permits: capability => capability === 'site.list',
  });
  assert.equal(surface.reads.find(read => read.resource === 'server-sites').available, true);
  assert.equal(surface.reads.find(read => read.resource === 'services').available, false);
  const serviceOps = surface.sections.find(section => section.id === 'services').operations;
  assert.equal(serviceOps.some(operation => operation.available), false,
    'the catalogue must not advertise operations outside the key scope');
  assert.deepEqual(surface.reads.find(read => read.resource === 'server-sites').inputSchema.type, 'object');
}

// ── Ownership ──────────────────────────────────────────────────────
// The first identity to ever touch a box is the box's own operator. This is
// what makes a fresh install work with no setup step, and it is what the
// release blocker actually was: on a box with no such rule, a second,
// self-registered account was exactly as powerful as the first.
function testFirstIdentityOnABoxOutranksEveryoneWhoFollows() {
  const db = new Database(':memory:');
  const ownership = createOwnershipService({ db });
  const operator = ownership.ensureMembership('steve');
  const customer = ownership.ensureMembership('a-signup-that-came-later');
  assert.equal(operator.role, 'hosting_company');
  assert.equal(customer.role, 'end_user');
  assert.notEqual(operator.orgId, customer.orgId, 'a later signup gets its own organization, never the operator\'s');
  // Idempotent: asking again for the same identity returns the same
  // membership rather than re-rolling the rule and finding no one left to
  // outrank.
  assert.deepEqual(ownership.ensureMembership('steve'), operator);
}

async function testAnEndUserMayClaimAnUnclaimedResourceButNotSomeoneElses() {
  const { actionStore, service } = multiOpsHarness({
    'site.create': async params => ({ domain: params.domain, verified: true }),
    'site.document-root': async params => ({ domain: params.domain, verified: true }),
  });
  // 'operator' is the first identity this db has ever seen, so it is the
  // top-ranked account; alice and mallory both land as separate end-user
  // organizations underneath it.
  await proposeApproveExecute(service, actionStore, 'operator', 'site.create', { domain: 'operator-bootstrap.example' });
  const built = await proposeApproveExecute(service, actionStore, 'alice', 'site.create', { domain: 'alice.example' });
  assert.equal(built.status, 'executed', 'the first claim on an unclaimed domain succeeds');

  await assert.rejects(
    () => service.propose('mallory', 'site.document-root', { domain: 'alice.example', documentRoot: 'public' }),
    error => error.forbidden === true && /belongs to a different account/.test(error.message)
  );

  // Alice may still act on her own site, and the operator — the top two
  // ranks act on anything on their own box — may act on it too.
  const aliceAgain = await proposeApproveExecute(service, actionStore, 'alice', 'site.document-root', { domain: 'alice.example', documentRoot: 'public' });
  assert.equal(aliceAgain.status, 'executed');
  const operatorToo = await proposeApproveExecute(service, actionStore, 'operator', 'site.document-root', { domain: 'alice.example', documentRoot: 'public' });
  assert.equal(operatorToo.status, 'executed', 'the operator, the top of the two server-wide ranks, may act on any account\'s resource on its own box');

  // A third, ordinary account is exactly as powerless over alice's site as
  // mallory was — being a later signup grants nothing extra.
  const late = await proposeApproveExecute(service, actionStore, 'a-later-signup', 'site.document-root', { domain: 'alice.example', documentRoot: 'public' }).catch(e => e);
  assert.ok(late instanceof Error && late.forbidden, 'a later signup is an ordinary end user, not a second operator');
}

async function testServerWideOperationsAreReservedToTheOperator() {
  const { actionStore, service } = multiOpsHarness({
    'service.control': async params => ({ ...params, verified: true }),
  });
  // The very first identity to propose anything on this db becomes its
  // operator, so establish that with a throwaway proposal before the real
  // assertions.
  await proposeApproveExecute(service, actionStore, 'the-operator', 'service.restart', { unit: 'nginx' });

  await assert.rejects(
    () => service.propose('a-customer', 'service.restart', { unit: 'nginx' }),
    error => error.forbidden === true && /reserved to the account that runs this box/.test(error.message)
  );
  const asOperator = await proposeApproveExecute(service, actionStore, 'the-operator', 'service.restart', { unit: 'nginx' });
  assert.equal(asOperator.status, 'executed');
}

async function testDeletingASiteReleasesItsNameForSomeoneElseToClaim() {
  const { actionStore, ownership, service } = multiOpsHarness({
    'site.create': async params => ({ domain: params.domain, verified: true }),
    'site.delete': async params => ({ domain: params.domain, verified: true }),
  });
  await proposeApproveExecute(service, actionStore, 'first-owner', 'site.create', { domain: 'reclaimed.example' });
  assert.ok(ownership.resolveOwner('site', 'reclaimed.example'), 'the create claims the domain');

  await assert.rejects(() => service.propose('someone-else', 'site.delete', { domain: 'reclaimed.example' }), { forbidden: true });

  await proposeApproveExecute(service, actionStore, 'first-owner', 'site.delete', { domain: 'reclaimed.example' }, 'DELETE');
  assert.equal(ownership.resolveOwner('site', 'reclaimed.example'), null, 'a deleted site releases its name');

  const reclaimed = await proposeApproveExecute(service, actionStore, 'someone-else', 'site.create', { domain: 'reclaimed.example' });
  assert.equal(reclaimed.status, 'executed', 'a released name can be claimed by a different account');
}

// ── The reads ──────────────────────────────────────────────────────
// A read needs no approval, which is not the same as needing no permission.
// Signed in as a demo customer on the live box, `server-sites` answered with
// all four websites on the machine while `resource_owners` recorded that
// account's organization as owning exactly one. These three tests hold the
// boundary the write path has always had, on the way out.

// A harness whose engine answers reads, built so the ownership rows and the
// reads share one database the way they do on a real box.
function readHarness(handlers) {
  const db = new Database(':memory:');
  const actionStore = createActionStore({ db });
  const ownership = createOwnershipService({ db });
  const engine = createOpsEngine({
    backends: [{
      name: 'stub',
      capabilities: async () => ({
        capabilities: new Map(Object.entries(handlers).map(([capability, run]) => [capability, { id: capability, kind: 'read', backend: 'stub', run }])),
        missing: new Map(),
        state: {},
      }),
    }],
  });
  return { db, ownership, service: createServerOpsService({ engine, actionStore, ownership }) };
}

// The whole box answers; the customer is shown their own row and no other.
async function testAnEndUserReadsOnlyTheirOwnResources() {
  const wholeBox = {
    sites: [
      { domain: 'lakeside.example', document_root: '/srv/lakeside' },
      { domain: 'northgate.example', document_root: '/srv/northgate' },
      { domain: 'unclaimed.example', document_root: '/srv/unclaimed' },
    ],
  };
  const { ownership, service } = readHarness({ 'site.list': async () => wholeBox });
  const operator = ownership.ensureMembership('the-operator'); // first identity on the box
  const customer = ownership.ensureMembership('a-customer');
  const neighbour = ownership.ensureMembership('the-neighbour');
  assert.equal(customer.role, 'end_user');
  ownership.claim('site', 'lakeside.example', customer.orgId, 'a-customer');
  ownership.claim('site', 'northgate.example', neighbour.orgId, 'the-neighbour');

  const mine = await service.read('server-sites', {}, { accountId: 'a-customer' });
  assert.deepEqual(mine.sites.map(s => s.domain), ['lakeside.example'],
    'a customer sees the sites their organization owns and nothing else on the box');
  const theirs = await service.read('server-sites', {}, { accountId: 'the-neighbour' });
  assert.deepEqual(theirs.sites.map(s => s.domain), ['northgate.example']);

  // Unclaimed is excluded rather than shared out: a list is what you own, and
  // nobody owns that one.
  assert.equal(mine.sites.some(s => s.domain === 'unclaimed.example'), false);

  // The operator's own box still answers in full, which is the whole point of
  // the machine-wide screens.
  const asOperator = await service.read('server-sites', {}, { accountId: 'the-operator' });
  assert.deepEqual(asOperator.sites.map(s => s.domain), ['lakeside.example', 'northgate.example', 'unclaimed.example']);
  assert.equal(operator.role, 'hosting_company');

  // Narrowing does not eat the reading's own answer: what the panel needs to
  // know about where the answer came from survives it.
  assert.equal(mine._capability, 'site.list');
  assert.equal(mine._backend, 'stub');

  // A request carrying no identity at all is refused rather than answered for
  // whoever the engine happens to default to.
  await assert.rejects(() => service.read('server-sites', {}, {}), { forbidden: true });
}

// The keyed readings are the ones that hurt: a customer naming a neighbour's
// domain was listing and reading the files inside it.
async function testAReadThatNamesSomeoneElsesResourceIsRefused() {
  const { ownership, service } = readHarness({
    'site.files.list': async ({ domain }) => ({ domain, entries: [{ name: 'index.html' }] }),
    'backup.fetch': async ({ domain }) => ({ domain, path: `/var/backups/${domain}.tar.gz`, bytes: 1 }),
  });
  ownership.ensureMembership('the-operator');
  const customer = ownership.ensureMembership('a-customer');
  const neighbour = ownership.ensureMembership('the-neighbour');
  ownership.claim('site', 'lakeside.example', customer.orgId, 'a-customer');
  ownership.claim('site', 'northgate.example', neighbour.orgId, 'the-neighbour');

  const own = await service.read('site-files', { domain: 'lakeside.example' }, { accountId: 'a-customer' });
  assert.deepEqual(own.entries.map(e => e.name), ['index.html'], 'a customer still reads their own site');

  await assert.rejects(
    () => service.read('site-files', { domain: 'northgate.example' }, { accountId: 'a-customer' }),
    error => error.forbidden === true && /belongs to a different account/.test(error.message)
  );

  // A domain claimed as a site is claimed for the backups of it too, so a
  // neighbour cannot take the unclaimed `backup` row and download the archive
  // through it. The download path answers with a file rather than a page and
  // goes through the same gate.
  await assert.rejects(
    () => service.backupDownload({ domain: 'northgate.example', id: 'x', part: 'files' }, { accountId: 'a-customer' }),
    { forbidden: true }
  );
  const mineBack = await service.backupDownload({ domain: 'lakeside.example', id: 'x', part: 'files' }, { accountId: 'a-customer' });
  assert.equal(mineBack.domain, 'lakeside.example');
}

// Nothing in the load average, the process table, the firewall or the logs
// belongs to one account, and all of it describes the box.
async function testTheMachinesOwnStateIsOperatorOnly() {
  const { ownership, service } = readHarness({
    'process.list': async () => ({ processes: [{ pid: 1, command: '/sbin/init' }] }),
    'log.tail': async () => ({ id: 'auth', lines: ['sshd: accepted publickey for root'] }),
    'log.download': async () => ({ path: '/var/log/auth.log', filename: 'auth.log', sending_bytes: 1, stream: () => null }),
    'runtime.list': async () => ({ runtimes: [{ runtime: 'node', available: true }] }),
  });
  ownership.ensureMembership('the-operator');
  ownership.ensureMembership('a-customer');

  for (const reading of ['processes', 'log-tail']) {
    await assert.rejects(
      () => service.read(reading, { id: 'auth' }, { accountId: 'a-customer' }),
      error => error.forbidden === true && /reserved to the account that runs this box/.test(error.message),
      `${reading} must not answer an ordinary account`
    );
  }
  await assert.rejects(() => service.logDownload('auth', { accountId: 'a-customer' }), { forbidden: true });

  const asOperator = await service.read('processes', {}, { accountId: 'the-operator' });
  assert.equal(asOperator.processes.length, 1);

  // What the machine has installed is not one account's, and a customer needs
  // it to choose what their own site runs, so it is answered for everybody.
  const runtimes = await service.read('runtimes', {}, { accountId: 'a-customer' });
  assert.deepEqual(runtimes.runtimes.map(r => r.runtime), ['node']);
}

// The mail queue was the machine's own state, which meant the only person who
// could be told why a message had not arrived was the person who runs the box.
// That is the wrong half: a queued message carries the address it was sent
// from, and the person who wrote it is the one waiting for it. So it is a list
// now, narrowed by the mail domain the sender belongs to, and this is the test
// that it narrows rather than leaks.
async function testAQueuedMessageIsShownToWhoeverSentIt() {
  const wholeQueue = {
    source: 'postfix',
    count: 4,
    messages: [
      { id: 'AAAA1111', sender: 'sales@lakeside.example', recipients: ['buyer@example.net'], reason: 'connect timed out' },
      { id: 'BBBB2222', sender: 'info@northgate.example', recipients: ['someone@example.net'], reason: null },
      { id: 'CCCC3333', sender: 'root@unclaimed.example', recipients: ['ops@example.net'], reason: 'relay denied' },
      // The empty envelope sender a bounce is sent with. It belongs to no
      // domain, so it belongs to nobody but the operator.
      { id: 'DDDD4444', sender: '<>', recipients: ['sales@lakeside.example'], reason: 'bounce' },
    ],
  };
  const { ownership, service } = readHarness({
    'mail.queue.list': async () => wholeQueue,
    'mail.queue.action': async () => ({ verified: true }),
  });
  ownership.ensureMembership('the-operator');
  const customer = ownership.ensureMembership('a-customer');
  const neighbour = ownership.ensureMembership('the-neighbour');
  ownership.claim('mailbox', 'lakeside.example', customer.orgId, 'a-customer');
  ownership.claim('mailbox', 'northgate.example', neighbour.orgId, 'the-neighbour');

  const mine = await service.read('mail-queue', {}, { accountId: 'a-customer' });
  assert.deepEqual(mine.messages.map(m => m.id), ['AAAA1111'],
    'somebody sees the messages sent from their own mail domain and no others');
  // The number over the list has to be the number in the list. A whole-box
  // count above a narrowed list is exactly the invented number this codebase
  // refuses, and it would tell a customer three of their messages were stuck.
  assert.equal(mine.count, 1);

  const theirs = await service.read('mail-queue', {}, { accountId: 'the-neighbour' });
  assert.deepEqual(theirs.messages.map(m => m.id), ['BBBB2222']);

  // Unclaimed and unreadable senders reach the operator alone.
  assert.equal(mine.messages.some(m => m.id === 'CCCC3333' || m.id === 'DDDD4444'), false);

  const asOperator = await service.read('mail-queue', {}, { accountId: 'the-operator' });
  assert.deepEqual(asOperator.messages.map(m => m.id), ['AAAA1111', 'BBBB2222', 'CCCC3333', 'DDDD4444']);
  assert.equal(asOperator.count, 4);

  // Acting on the queue is still the machine's: retrying or deleting a queued
  // message moves the whole mail server's spool, so a customer may read why
  // theirs is stuck and may not reach into the queue. The screen prints that
  // reason rather than drawing a button that would be refused.
  await assert.rejects(
    () => service.propose('a-customer', 'mail.queue.retry', { id: 'AAAA1111' }),
    error => error.forbidden === true
  );
}

run().catch(error => { console.error(error); process.exit(1); });
