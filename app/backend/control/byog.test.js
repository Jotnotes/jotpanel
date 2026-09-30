'use strict';

// What a device on somebody's desk is not allowed to do, tested where it lives.
//
// The interesting tests here are all refusals. A helper that connects and
// answers a prompt is the easy half and the end-to-end run proves that on real
// machines. What has to hold under a hostile reading is that the credential
// cannot be reproduced, that one account cannot reach another account's
// computer, that an answer cannot be replayed or forged, that revocation takes
// effect on the job in flight rather than on the next restart, and that a
// private conversation cannot be quietly finished in somebody's cloud.

const assert = require('assert/strict');
const Database = require('better-sqlite3');
const { createByogService, looksLikeDeviceToken } = require('./byog');
const { looksLikeApiKey } = require('./apiKeys');

function fresh(opts = {}) {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE IF NOT EXISTS settings (user_id TEXT PRIMARY KEY, data TEXT)');
  const byog = createByogService({ db, log: () => {}, ...opts });
  return { db, byog };
}

// A link the tests can read. The service never learns what an Express response
// is, which is the seam that makes dispatch testable without a socket.
function fakeWriter() {
  const sent = [];
  return {
    sent,
    closed: null,
    send(event, data) { if (this.closed) throw new Error('closed'); sent.push({ event, data }); },
    close(reason) { this.closed = reason || 'closed'; },
    last(event) { return [...sent].reverse().find(m => m.event === event); },
  };
}

function pairDevice(byog, userId, over = {}) {
  const { code } = byog.issuePairCode(userId);
  return byog.pair({
    code, name: 'Test box', platform: 'darwin', arch: 'arm64', agentVersion: '1.0.0', engineKind: 'ollama',
    models: [{ name: 'qwen2.5:7b', paramSize: '7.6B' }, { name: 'qwen2.5-coder:14b' }],
    ...over,
  });
}

function connect(byog, deviceId) {
  const writer = fakeWriter();
  const detach = byog.attachLink(byog.getRow(deviceId), writer);
  return { writer, detach };
}

async function run() {
  // Several of these settle a promise, so they are awaited one at a time. A
  // test that quietly returned a rejected promise into the void would report a
  // pass it never earned.
  for (const test of [
    testTheDeviceTokenIsShownOnceAndKeptNowhere,
    testADeviceCredentialIsNotAPanelCredential,
    testAPairingCodeIsSingleUseShortLivedAndNotStoredInTheClear,
    testASecondCodeInvalidatesTheFirst,
    testOneUserCannotReachAnotherUsersComputer,
    testRevocationKillsTheLinkAndTheJobInFlight,
    testASecondHelperDisplacesTheFirst,
    testTheJobCarriesNoUrlNoCommandAndNoCredential,
    testAnAnswerIsAcceptedOnceAndOnlyWithItsOwnNonce,
    testADeviceAtItsConcurrencyLimitRefusesRatherThanQueuesForever,
    testAnOversizeRequestIsRefusedBeforeItIsSent,
    testLosingTheLinkFailsTheJobImmediately,
    testFailuresRestTheDeviceAndSuccessRevivesIt,
    testPolicyDecidesWhetherTheDeviceIsEvenConsidered,
    testTheRouterPrefersJudgementElsewhereButMechanicalWorkHere,
    testAVisionRequestNeedsAVisionModel,
    testANonCommercialModelIsNeverChosenForYouButMayBePinned,
    testStreamedIsTrueOnlyOnceSomethingReachedTheUser,
    testAnIdleButHealthyLinkIsNotAgedOut,
  ]) {
    await test();
  }
  console.log('byog tests passed');
}

function testTheDeviceTokenIsShownOnceAndKeptNowhere() {
  const { db, byog } = fresh();
  const paired = pairDevice(byog, 'alice');
  assert.match(paired.token, /^arcadev_[a-f0-9]{12}_[a-f0-9]{48}$/);

  const stored = JSON.stringify(db.prepare('SELECT * FROM byog_devices').all());
  const secret = paired.token.split('_')[2];
  assert.equal(stored.includes(secret), false, 'the device secret must not be recoverable from the row');
  assert.equal(stored.includes(paired.token), false);

  assert.equal(byog.verifyToken(paired.token).id, paired.deviceId);
  // A real prefix with the wrong secret is not a near miss, it is a refusal.
  const forged = `arcadev_${paired.token.split('_')[1]}_${'a'.repeat(48)}`;
  assert.equal(byog.verifyToken(forged), null);
  for (const rubbish of ['', null, undefined, 42, {}, 'arcadev_', 'arcadev_zz_zz']) {
    assert.equal(byog.verifyToken(rubbish), null);
  }
}

function testADeviceCredentialIsNotAPanelCredential() {
  const { byog } = fresh();
  const paired = pairDevice(byog, 'alice');
  // The two namespaces must not overlap in either direction, because the auth
  // middleware tells token shapes apart by their own prefix. A device token
  // that read as an API key would arrive at the panel's routes wearing the
  // identity of the person who paired it.
  assert.equal(looksLikeApiKey(paired.token), false);
  assert.equal(looksLikeDeviceToken(paired.token), true);
  assert.equal(looksLikeDeviceToken(`arca_${'a'.repeat(12)}_${'b'.repeat(48)}`), false);
}

function testAPairingCodeIsSingleUseShortLivedAndNotStoredInTheClear() {
  let clock = new Date('2026-08-27T10:00:00Z');
  const { db, byog } = fresh({ now: () => clock });
  const { code } = byog.issuePairCode('alice');
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM byog_pair_codes').all()).includes(code.replace('-', '')), false);

  // Case and punctuation are the person's typing, not the secret.
  const paired = byog.pair({ code: code.toLowerCase(), name: 'Mac' });
  assert.equal(paired.name, 'Mac');
  assert.throws(() => byog.pair({ code, name: 'again' }), /already been used/);

  const second = byog.issuePairCode('alice').code;
  clock = new Date(clock.getTime() + 16 * 60 * 1000);
  assert.throws(() => byog.pair({ code: second, name: 'late' }), /expired/);
  assert.throws(() => byog.pair({ code: 'AAAAA-BBBBB', name: 'guess' }), /not valid/);
}

function testASecondCodeInvalidatesTheFirst() {
  const { byog } = fresh();
  const first = byog.issuePairCode('alice').code;
  byog.issuePairCode('alice');
  // A code read out on a support call must stop working the moment a new one is
  // generated, or every code ever issued stays live for its full window.
  assert.throws(() => byog.pair({ code: first, name: 'stale' }), /not valid/);
}

function testOneUserCannotReachAnotherUsersComputer() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  connect(byog, alice.deviceId);

  assert.equal(byog.ownedDevice('mallory', alice.deviceId), null);
  // The refusal for "not yours" is the same as for "no such thing", so device
  // ids cannot be enumerated by reading the error.
  assert.equal(byog.ownedDevice('mallory', 'dev_does_not_exist'), null);
  assert.throws(
    () => byog.dispatch({ userId: 'mallory', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] }),
    /not on this account/);
  assert.deepEqual(byog.listDevices('mallory'), []);
  // And selection only ever looks at the caller's own rows.
  assert.equal(byog.selectDevice('mallory', { task: 'chat' }).device, null);
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).device.id, alice.deviceId);
}

function testRevocationKillsTheLinkAndTheJobInFlight() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const { writer } = connect(byog, alice.deviceId);
  const running = byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
  const settled = running.promise.then(() => 'resolved', e => e.code);

  byog.revokeDevice('alice', alice.deviceId);

  return settled.then(code => {
    assert.equal(code, 'link_lost', 'a job in flight must fail on revoke, not finish');
    assert.equal(writer.last('revoked') !== undefined, true);
    assert.equal(writer.closed !== null, true);
    // The token stops verifying on the very next call rather than at restart.
    assert.equal(byog.verifyToken(alice.token), null);
    assert.deepEqual(byog.listDevices('alice'), []);
    assert.throws(() => byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'x', messages: [] }), /not on this account/);
  });
}

function testASecondHelperDisplacesTheFirst() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const first = connect(byog, alice.deviceId);
  const second = connect(byog, alice.deviceId);
  assert.equal(first.writer.last('displaced') !== undefined, true);
  assert.equal(first.writer.closed, 'displaced');
  assert.equal(second.writer.closed, null);
  // One device, one link. Two would mean a job going to whichever socket the
  // map happened to hold.
  assert.equal(byog.present(byog.getRow(alice.deviceId)).online, true);
}

function testTheJobCarriesNoUrlNoCommandAndNoCredential() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const { writer } = connect(byog, alice.deviceId);
  byog.dispatch({
    userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b',
    system: 'you are helpful', maxTokens: 200,
    messages: [{ role: 'user', content: 'hello' }],
  });
  const job = writer.last('job').data;
  const asText = JSON.stringify(job);
  // This is the property that stops a compromised Arca turning somebody's
  // laptop into an outbound proxy or a shell. The helper picks its endpoint out
  // of its own config and there is nothing in the job that could redirect it.
  assert.equal(/https?:\/\//.test(asText), false, 'a job must carry no URL');
  assert.equal(Object.keys(job).sort().join(','), 'deadlineSeconds,jobId,maxTokens,messages,model,nonce,stream,system');
  assert.equal('endpoint' in job, false);
  assert.equal('url' in job, false);
  assert.equal('command' in job, false);
  assert.equal(asText.includes(alice.token), false);
}

function testAnAnswerIsAcceptedOnceAndOnlyWithItsOwnNonce() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const { writer } = connect(byog, alice.deviceId);
  const running = byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
  const issued = writer.last('job').data;

  assert.throws(() => byog.claimJob(alice.deviceId, issued.jobId, 'not-the-nonce'), /does not match/);
  assert.throws(() => byog.claimJob(alice.deviceId, 'job_made_up', issued.nonce), /not open on this device/);

  const job = byog.claimJob(alice.deviceId, issued.jobId, issued.nonce);
  assert.equal(job.finish({ text: 'hello there', inTok: 5, outTok: 2 }), true);
  return running.promise.then(result => {
    assert.equal(result.text, 'hello there');
    // Replay: the same answer arriving twice, or a second machine answering the
    // same id, finds nothing to answer.
    assert.throws(() => byog.claimJob(alice.deviceId, issued.jobId, issued.nonce), /not open on this device/);
    assert.equal(byog.present(byog.getRow(alice.deviceId)).jobsOk, 1);
  });
}

function testADeviceAtItsConcurrencyLimitRefusesRatherThanQueuesForever() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice', { maxConcurrent: 1 });
  connect(byog, alice.deviceId);
  const first = byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'one' }] });
  first.promise.catch(() => {});
  // Busy is a routing fact, not an error page: the caller falls back on it.
  assert.throws(() => byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'two' }] }), /already running/);
  const clamped = pairDevice(byog, 'bob', { maxConcurrent: 99 });
  assert.equal(byog.getRow(clamped.deviceId).max_concurrent, 4, 'a device cannot declare unlimited concurrency for itself');
}

function testAnOversizeRequestIsRefusedBeforeItIsSent() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const { writer } = connect(byog, alice.deviceId);
  const huge = 'x'.repeat(byog.constants.MAX_JOB_BYTES + 1024);
  assert.throws(() => byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: huge }] }), /at most/);
  assert.equal(writer.last('job'), undefined, 'nothing oversize should ever reach the wire');
}

function testLosingTheLinkFailsTheJobImmediately() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const { detach } = connect(byog, alice.deviceId);
  const running = byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
  const settled = running.promise.then(() => 'resolved', e => e.code);
  detach(); // the lid closed
  return settled.then(code => {
    assert.equal(code, 'link_lost');
    assert.equal(byog.present(byog.getRow(alice.deviceId)).online, false);
    assert.throws(() => byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [] }), /not connected/);
  });
}

function testFailuresRestTheDeviceAndSuccessRevivesIt() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  for (let i = 0; i < byog.constants.DEGRADE_AFTER_FAILURES; i++) {
    const { detach } = connect(byog, alice.deviceId);
    const running = byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
    running.promise.catch(() => {});
    detach();
  }
  const rested = byog.present(byog.getRow(alice.deviceId));
  assert.equal(rested.degraded, true);
  assert.equal(rested.jobsFailed, byog.constants.DEGRADE_AFTER_FAILURES);
  connect(byog, alice.deviceId);
  // Degraded means "stop choosing this for me automatically", not "unusable".
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).device, null);
  assert.equal(byog.selectDevice('alice', { task: 'chat', ignoreAutoRoute: true }).device.id, alice.deviceId);

  const { writer } = connect(byog, alice.deviceId);
  const running = byog.dispatch({ userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b', messages: [{ role: 'user', content: 'hi' }] });
  const issued = writer.last('job').data;
  byog.claimJob(alice.deviceId, issued.jobId, issued.nonce).finish({ text: 'ok', inTok: 1, outTok: 1 });
  return running.promise.then(() => {
    assert.equal(byog.present(byog.getRow(alice.deviceId)).degraded, false);
    assert.equal(byog.selectDevice('alice', { task: 'chat' }).device.id, alice.deviceId);
  });
}

function testPolicyDecidesWhetherTheDeviceIsEvenConsidered() {
  const { db, byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  connect(byog, alice.deviceId);
  const setPolicy = policy => db.prepare('INSERT OR REPLACE INTO settings (user_id,data) VALUES (?,?)')
    .run('alice', JSON.stringify({ byog: policy }));

  assert.equal(byog.readPolicy('alice').mode, 'auto', 'a paired device is usable without configuring anything');

  setPolicy({ mode: 'off' });
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).device, null);
  // Off means "never pick this for me", not "forget it exists": choosing it by
  // hand in Direct Chat still works.
  assert.equal(byog.selectDevice('alice', { task: 'chat', ignoreAutoRoute: true }).device.id, alice.deviceId);

  setPolicy({ mode: 'private', residentFallback: false });
  const priv = byog.selectDevice('alice', { task: 'chat' });
  assert.equal(priv.device.id, alice.deviceId);
  assert.equal(priv.policy.mode, 'private');
  assert.equal(priv.policy.residentFallback, false);

  // A pinned device that is not the one connected means no device, not "any
  // device will do". Pinning is the user saying which machine, and quietly
  // using a different one is exactly the surprise the setting exists to stop.
  setPolicy({ mode: 'auto', deviceId: 'dev_some_other_laptop' });
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).device, null);

  setPolicy({ mode: 'auto', model: 'qwen2.5-coder:14b' });
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).model, 'qwen2.5-coder:14b');
  // A pinned model the machine no longer has falls back to a sensible pick
  // rather than dispatching a job for a model that is not there.
  setPolicy({ mode: 'auto', model: 'llama-99b' });
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).model, 'qwen2.5:7b');
}

function testTheRouterPrefersJudgementElsewhereButMechanicalWorkHere() {
  const { byog } = fresh();
  // With a Frontier key present, mechanical work goes to the free machine on
  // the user's desk and judgement still escalates. That is ROADMAP.md's rule
  // applied to a second local brain, not a new one.
  for (const task of ['code', 'chat', 'summarize']) {
    assert.equal(byog.preferBefore(task, { hasFrontier: true }), true, `${task} should prefer the device`);
  }
  for (const task of ['build', 'reason', 'creative']) {
    assert.equal(byog.preferBefore(task, { hasFrontier: true }), false, `${task} should escalate first`);
  }
  // With no key at all there is nothing to escalate to, so the user's own
  // machine is the best brain available for everything.
  for (const task of ['build', 'reason', 'creative', 'chat']) {
    assert.equal(byog.preferBefore(task, { hasFrontier: false }), true);
  }
}

function testAVisionRequestNeedsAVisionModel() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  connect(byog, alice.deviceId);
  assert.equal(byog.selectDevice('alice', { needsVision: true }).device, null);

  byog.report(alice.deviceId, { models: [{ name: 'qwen2.5:7b' }, { name: 'qwen2.5vl:7b' }] });
  const seen = byog.selectDevice('alice', { needsVision: true });
  assert.equal(seen.model, 'qwen2.5vl:7b');
  // And a text request does not get handed the vision model, which is slower
  // at plain text, while one is available.
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).model, 'qwen2.5:7b');
}

function testANonCommercialModelIsNeverChosenForYouButMayBePinned() {
  const { db, byog } = fresh();
  const alice = pairDevice(byog, 'alice', { models: [{ name: 'qwen2.5:3b' }] });
  connect(byog, alice.deviceId);
  // The Resident excludes this model at detection time because a sold product
  // must not pick a non-commercial licence on somebody's behalf. On a machine
  // the user owns the choice is theirs, so it stays listed and pinnable.
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).device, null);
  assert.equal(byog.present(byog.getRow(alice.deviceId)).models.length, 1);
  db.prepare('INSERT OR REPLACE INTO settings (user_id,data) VALUES (?,?)')
    .run('alice', JSON.stringify({ byog: { mode: 'auto', model: 'qwen2.5:3b' } }));
  assert.equal(byog.selectDevice('alice', { task: 'chat' }).model, 'qwen2.5:3b');
}

function testStreamedIsTrueOnlyOnceSomethingReachedTheUser() {
  const { byog } = fresh();
  const alice = pairDevice(byog, 'alice');
  const { writer } = connect(byog, alice.deviceId);
  const seen = [];
  const running = byog.dispatch({
    userId: 'alice', deviceId: alice.deviceId, model: 'qwen2.5:7b',
    messages: [{ role: 'user', content: 'hi' }], onDelta: d => seen.push(d),
  });
  const issued = writer.last('job').data;
  const job = byog.claimJob(alice.deviceId, issued.jobId, issued.nonce);
  // Before a token has reached the browser a fallback is still honest.
  assert.equal(job.streamed, false);
  job.onDelta('Hel');
  job.onDelta('lo');
  assert.equal(job.streamed, true, 'once the user has seen tokens, a silent fallback would stitch two answers together');
  job.finish({ text: 'Hello', inTok: 3, outTok: 2 });
  return running.promise.then(result => {
    assert.deepEqual(seen, ['Hel', 'lo']);
    assert.equal(result.text, 'Hello');
    assert.equal(result.byogDevice, 'Test box');
  });
}

function testAnIdleButHealthyLinkIsNotAgedOut() {
  let clock = new Date('2026-08-27T10:00:00Z');
  const { byog } = fresh({ now: () => clock });
  const alice = pairDevice(byog, 'alice');
  const { writer } = connect(byog, alice.deviceId);

  // The bug this test exists for, found in a browser and not in a suite: the
  // staleness clock was only ever reset by the device doing something, so a
  // machine that was connected, healthy and simply not being asked anything
  // dropped off after a minute. BYOG would have worked only for people who
  // talked to it at least once a minute.
  const idle = byog.constants.LINK_STALE_MS + 5000;
  clock = new Date(clock.getTime() + idle);
  assert.equal(byog.beat(alice.deviceId), true, 'a heartbeat onto a live socket must land');
  assert.notEqual(byog.linkFor(alice.deviceId), null, 'an idle but healthy link must stay usable');
  assert.equal(byog.present(byog.getRow(alice.deviceId)).online, true);
  assert.equal(writer.last('ping') !== undefined, true);

  // And the backstop still works: when the heartbeat itself stops firing,
  // the link ages out rather than lingering as a lie the router would act on.
  clock = new Date(clock.getTime() + idle);
  assert.equal(byog.linkFor(alice.deviceId), null, 'a link with no heartbeat at all must still age out');
  assert.equal(byog.present(byog.getRow(alice.deviceId)).online, false);

  // A socket that has gone away takes the link with it on the next beat.
  const second = pairDevice(byog, 'bob');
  const live = connect(byog, second.deviceId);
  live.writer.close('peer hung up');
  assert.equal(byog.beat(second.deviceId), false);
  assert.equal(byog.linkFor(second.deviceId), null);
}

run().catch(error => { console.error(error); process.exit(1); });
