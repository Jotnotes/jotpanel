'use strict';

// The drift tests.
//
// This panel is four lists that have to agree with each other: the operations a
// screen can offer, the capabilities a backend claims, the named jobs the root
// daemon will run, and the parameters each of those jobs accepts. Nothing forces
// them to agree. When they stop agreeing the failure is always the same shape
// and always the worst one this product can produce: an action is proposed,
// shown to the owner, approved by them, and only then discovered to be
// impossible. A panel whose whole claim is that the record is true cannot afford
// to record an approval for something it was never going to be able to do.
//
// Every check here is static. No box, no network, no root. They are the tests
// that outlive the session, which is the point: the defects they catch are
// introduced by editing one list and forgetting the other three, which is a
// thing a person does on a Tuesday six months from now.

const assert = require('assert/strict');
const { OPERATIONS, READS, READ_SCOPES, getOperation } = require('./catalogue');
const { SPECS } = require('./privilegedJobs');
const { createNativeStackBackend } = require('./nativeStackBackend');
const { SECTIONS } = require('../serverOps');

// A client that says yes to everything and writes down what it was asked for.
// The backend registers its capabilities from what the machine answers, so a
// machine that answers yes to everything registers all of them, which is the
// only way to see the whole map at once.
function recordingClient() {
  const calls = [];
  return {
    calls,
    probe: async () => ({ ok: true }),
    run: async (job, params = {}) => {
      calls.push({ job, params });
      if (job === 'stack.probe') return { stack: params.stack, available: true };
      if (job === 'migrate.imap.probe') return { available: true };
      if (job === 'mail.list') return { domains: [], mailboxes: [], catchalls: [] };
      if (job === 'php.versions') return { versions: [], default: null };
      return {};
    },
  };
}

async function everyCapabilityAndItsJob() {
  const client = recordingClient();
  const backend = createNativeStackBackend({ client });
  const { capabilities } = await backend.capabilities();
  const map = new Map();
  for (const [id, capability] of capabilities) {
    const before = client.calls.length;
    // Invoking the capability is what reveals which job it points at. The
    // parameters are empty on purpose: this is asking what it would call, not
    // asking it to do anything.
    try { await capability.run({}); } catch { /* a mapper that throws on empty input is still a mapper */ }
    const made = client.calls.slice(before);
    if (made.length) map.set(id, made[made.length - 1]);
  }
  return map;
}

async function testEveryCapabilityPointsAtAJobThatExists() {
  const map = await everyCapabilityAndItsJob();
  assert.ok(map.size > 30, `only ${map.size} capabilities resolved to a job, which means this test is not looking at the real map`);
  const missing = [...map.entries()].filter(([, call]) => !SPECS[call.job]);
  assert.deepEqual(missing.map(([id, call]) => `${id} -> ${call.job}`), [],
    'a capability points at a privileged job that does not exist, so the action would be proposed, approved, and then refused by the daemon');
}

async function testNoCapabilitySendsAJobAParameterItRefuses() {
  // executeNamedJob rejects any key the job did not declare, by design. A
  // backend that maps a parameter the job does not accept produces an action
  // that is approved and then dies at the socket with "does not accept".
  const map = await everyCapabilityAndItsJob();
  const wrong = [];
  for (const [id, call] of map) {
    const spec = SPECS[call.job];
    if (!spec) continue;
    const [allowed] = spec;
    for (const key of Object.keys(call.params || {})) {
      if (!allowed.includes(key)) wrong.push(`${id} -> ${call.job} sends "${key}", which that job does not accept`);
    }
  }
  assert.deepEqual(wrong, []);
}

// The other direction, and the one that shipped broken. The check above finds a
// parameter the job REFUSES, which fails loudly at the socket. This finds a
// parameter the job silently IGNORES, because the backend function destructures
// the keys it wants and anything else falls on the floor. That is how
// dns.record.delete spent its life sending a row id nothing downstream had ever
// heard of: the operation was proposed, approved, executed and reported as
// done, having matched no record at all. Nothing failed, which is worse.
function testNoOperationSendsAParameterNothingReads() {
  const fs = require('fs');
  const host = fs.readFileSync(`${__dirname}/hostBackend.js`, 'utf8');
  // Where the backend hands a capability to a named function rather than
  // straight to a job, the function's own destructuring is the contract.
  const handlers = {};
  for (const call of host.matchAll(/add\('([^']+)',\s*'(?:read|write)',\s*([A-Za-z_][A-Za-z0-9_]*)\)/g)) handlers[call[1]] = call[2];

  // Swapped for the file's contents at execute time, by name, on purpose.
  const CARRIED_ELSEWHERE = new Set(['database.import:uploadId']);

  const dropped = [];
  for (const operation of OPERATIONS) {
    const handler = handlers[operation.capability];
    if (!handler) continue;
    const declaration = host.match(new RegExp(`function ${handler}\\(\\{([^}]*)\\}`));
    if (!declaration) continue;
    // Comments are stripped from both sides before anything is matched.
    // Without this the scan is blind to any parameter that has a comment above
    // it: the key regex wants a comma or a brace immediately before the name,
    // and a comment sits between them. `backup.schedule.set` gained an
    // `offsite` parameter with an explanation above it, the backend dropped it
    // on the floor, the operation still answered 200 with a schedule that did
    // not do what was asked, and this test said nothing. Found by running the
    // thing on a live box, which is the only reason it was found at all.
    const uncomment = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const accepts = uncomment(declaration[1]).split(',').map(part => part.trim().split(/[:=]/)[0].trim()).filter(Boolean);
    const source = operation.normalize.toString();
    const body = uncomment(source.slice(source.indexOf('({') + 2, source.lastIndexOf('})')));
    const keys = [...body.matchAll(/(^|[,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(match => match[2]);
    for (const key of new Set(keys)) {
      if (!accepts.includes(key) && !CARRIED_ELSEWHERE.has(`${operation.id}:${key}`)) {
        dropped.push(`${operation.id} sends "${key}", which ${handler}() never reads`);
      }
    }
  }
  assert.deepEqual(dropped, []);
}

function testEveryOperationCanBeReachedFromAScreen() {
  // An operation whose capability no section lists is unreachable: the panel
  // builds its screens from SECTIONS, so nothing would ever draw it.
  const onScreen = new Set(SECTIONS.flatMap(section => section.capabilities));
  const orphans = OPERATIONS.filter(op => !onScreen.has(op.capability)).map(op => `${op.id} needs ${op.capability}`);
  assert.deepEqual(orphans, []);
}

function testEveryReadIsSomethingAScreenAsksFor() {
  const onScreen = new Set(SECTIONS.flatMap(section => section.capabilities));
  // Reads that no section declares are not wrong in themselves, but they are
  // invisible to the capability report, so a screen using one cannot explain
  // why it is unavailable. That explanation is the product.
  const unexplained = Object.entries(READS).filter(([, capability]) => !onScreen.has(capability))
    .map(([resource, capability]) => `${resource} reads ${capability}, which no section declares`);
  assert.deepEqual(unexplained, []);
}

// Every reading says whose answer it is, the way every write says which of its
// parameters names the resource. This is the check that stops the next reading
// being added without one and quietly answering for the whole box, which is
// exactly how the readings came to leak in the first place.
function testEveryReadDeclaresWhoseAnswerItIs() {
  const KINDS = new Set(['server', 'own', 'open', 'site', 'mailbox', 'database', 'zone', 'backup']);
  for (const reading of Object.keys(READS)) {
    const scope = READ_SCOPES[reading];
    assert.ok(scope, `${reading} has no read scope declared`);
    assert.ok(scope.kind || scope.narrow, `${reading} declares neither a scope kind nor a way to narrow its list`);
    if (scope.kind) {
      assert.ok(KINDS.has(scope.kind), `${reading} declares an unknown read scope kind: ${scope.kind}`);
      const keyed = !['server', 'own', 'open'].includes(scope.kind);
      assert.equal(typeof scope.param === 'string' && !!scope.param, keyed,
        `${reading} is ${scope.kind}-scoped and must ${keyed ? '' : 'not '}name the parameter that identifies the resource`);
    }
    if (scope.narrow) assert.equal(typeof scope.narrow, 'function', `${reading} declares a narrow that is not a function`);
  }
  const stray = Object.keys(READ_SCOPES).filter(reading => !READS[reading]);
  assert.deepEqual(stray, [], 'a read scope with no reading behind it is a scope nothing enforces');
}

function testEveryOperationDescribesItselfWithoutThrowing() {
  // label and summary run against normalized parameters when the proposal is
  // written into the record. One that throws turns a legitimate action into an
  // error the owner cannot act on, and it only happens for the shapes nobody
  // tried by hand.
  const sample = {
    domain: 'example.com', zone: 'example.com', unit: 'nginx.service', name: 'shop', username: 'shopuser',
    account: 'sales', address: 'sales@example.com', user: 'someone', password: 'Passw0rd!x9', entry: 'server.js',
    runtime: 'node', target: 'public/thing', archive: 'thing.tar.gz', sources: ['a', 'b'], path: 'index.php',
    mode: '640', port: 8080, protocol: 'tcp', index: 1, id: 'A1B2C3', line: 'ssh-ed25519 AAAA', type: 'A',
    value: '203.0.113.9', command: 'nginx -t', message: 'away', forward: 'other@example.com', stack: 'web',
    template: '8.3', documentRoot: 'public', staged: `stage_${'a'.repeat(32)}`, content: 'x', dir: '',
    key: `ssh-ed25519 ${'A'.repeat(40)} steve@higashi.edu`, application: 'wordpress', quotaMb: 100,
    plan: { domains: [{ domain: 'example.com' }] }, host: 'mail.example.com', entryPath: 'server.js',
    privileges: 'all', securityOnly: true, verb: 'allow', into: '', alias: 'www.example.com',
  };
  const broken = [];
  for (const op of OPERATIONS) {
    let params;
    try { params = op.normalize(sample); } catch { continue; } // refusing the sample is fine; this is about describing
    for (const part of ['label', 'summary']) {
      try {
        const text = op[part](params);
        if (typeof text !== 'string' || !text.trim()) broken.push(`${op.id}.${part} produced nothing`);
      } catch (error) { broken.push(`${op.id}.${part} threw: ${error.message}`); }
    }
  }
  assert.deepEqual(broken, []);
}

function testEveryDestructiveOperationAsksForAWordAndSaysWhatGoes() {
  const wrong = [];
  for (const op of OPERATIONS) {
    if (op.risk !== 'destructive') continue;
    if (!op.confirm) wrong.push(`${op.id} is destructive and asks for no typed word`);
    if (!/^[A-Z]{3,12}$/.test(op.confirm || '')) wrong.push(`${op.id} asks for "${op.confirm}", which is not a word somebody can type`);
  }
  assert.deepEqual(wrong, []);
  // And the risk levels are the four the approval queue knows. A fifth would be
  // rendered as nothing at all.
  const unknown = OPERATIONS.filter(op => !['read-only', 'standard', 'elevated', 'destructive'].includes(op.risk));
  assert.deepEqual(unknown.map(op => `${op.id} is ${op.risk}`), []);
}

function testOperationIdsAreUniqueAndResolvable() {
  const seen = new Set();
  const duplicates = [];
  for (const op of OPERATIONS) {
    if (seen.has(op.id)) duplicates.push(op.id);
    seen.add(op.id);
    assert.equal(getOperation(op.id).id, op.id);
  }
  assert.deepEqual(duplicates, []);
}

async function run() {
  const tests = [
    testEveryCapabilityPointsAtAJobThatExists,
    testNoCapabilitySendsAJobAParameterItRefuses,
    testNoOperationSendsAParameterNothingReads,
  testEveryOperationCanBeReachedFromAScreen,
    testEveryReadIsSomethingAScreenAsksFor,
    testEveryReadDeclaresWhoseAnswerItIs,
    testEveryOperationDescribesItselfWithoutThrowing,
    testEveryDestructiveOperationAsksForAWordAndSaysWhatGoes,
    testOperationIdsAreUniqueAndResolvable,
  ];
  for (const test of tests) { await test(); console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`); }
  console.log(`drift tests passed (${tests.length})`);
}

run().catch(error => { console.error(error); process.exitCode = 1; });

// ── Removing one zone declaration from named.conf ───────────────────
//
// A pattern cannot do this and the first attempt proved it on a live machine:
// `zone "name" \{[^}]*\};?` stops at the closing brace of
// `allow-transfer { none; }`, leaves `;\n};` behind, and `rndc reconfig`
// refuses the result with "unexpected token". These are the cases that
// mattered, written down so the next person does not rediscover them.
function testRemovingOneZoneDeclarationCountsBraces() {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'privilegedJobs.js'), 'utf8');
  const fn = src.match(/function withoutZoneDeclaration[\s\S]*?\n}\n/);
  assert.ok(fn, 'withoutZoneDeclaration should exist in privilegedJobs.js');
  // eslint-disable-next-line no-eval
  const withoutZoneDeclaration = eval(`(${fn[0].replace(/^function /, 'function ')})`);

  const block = name => `zone "${name}" {\n    type master;\n    file "/etc/bind/jotpanel-zones/db.${name}";\n    allow-transfer { none; };\n};\n`;
  const balanced = text => (text.match(/{/g) || []).length === (text.match(/}/g) || []).length;

  const two = block('a.test') + block('b.test');
  const gone = withoutZoneDeclaration(two, 'a.test');
  assert.ok(balanced(gone), 'the file must still balance, which the regular expression version did not');
  assert.ok(!gone.includes('"a.test"'), 'the named zone is removed');
  assert.ok(gone.includes('"b.test"'), 'and its neighbour is not');
  assert.ok(!/^\s*;/.test(gone), 'no stray semicolon is left where the block was');

  // The last block in the file, which is where an off-by-one shows.
  const last = withoutZoneDeclaration(two, 'b.test');
  assert.ok(balanced(last) && last.includes('"a.test"') && !last.includes('"b.test"'));

  // A zone that is not there changes nothing at all.
  assert.equal(withoutZoneDeclaration(two, 'c.test'), two);

  // A name with regex characters in it is a name, not a pattern.
  const odd = block('a-b.test') + block('axb.test');
  const oddGone = withoutZoneDeclaration(odd, 'a-b.test');
  assert.ok(oddGone.includes('"axb.test"') && !oddGone.includes('"a-b.test"'));

  // An unbalanced file is left exactly as found rather than guessed at: the
  // caller's own read-back refuses, which is better than writing something worse.
  const broken = 'zone "a.test" {\n    allow-transfer { none; };\n';
  assert.equal(withoutZoneDeclaration(broken, 'a.test'), broken);

  console.log('  ok  one zone declaration is removed by counting braces, and the file still balances');
}
testRemovingOneZoneDeclarationCountsBraces();

// ── No two services may default to the same port ────────────────────
//
// ARCA_TTS_PORT and ARCA_BOOTSTRAP_PORT both defaulted to 9998: the Resident
// voice and the loopback surface that creates a machine's first owner. Which
// one got the port was a race. It could not reach a supported GA install
// because the bundle excludes the virtual environment the voice needs, but the
// bundle ships the script that creates it, so a GA box was one documented
// command away from losing the surface its installer depends on.
function testNoTwoDefaultPortsCollide() {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'server.js'), 'utf8');
  const defaults = new Map();
  const pattern = /process\.env\.(ARCA_[A-Z_]*PORT|PORT)\s*\|\|\s*'?(\d{2,5})'?/g;
  let hit;
  while ((hit = pattern.exec(src)) !== null) {
    const [, name, port] = hit;
    if (!defaults.has(port)) defaults.set(port, new Set());
    defaults.get(port).add(name);
  }
  const collisions = [...defaults.entries()]
    .filter(([, names]) => names.size > 1)
    .map(([port, names]) => `${port} is the default for ${[...names].join(' and ')}`);
  assert.deepEqual(collisions, [], collisions.join('; '));
  console.log(`  ok  no two services default to the same port (${defaults.size} defaults checked)`);
}
testNoTwoDefaultPortsCollide();
