'use strict';

// Host key verification for SFTP backup destinations, against a real SSH
// server rather than a stub.
//
// The defect this covers: `client.connect()` was called with no `hostVerifier`,
// and ssh2 with no verifier accepts whatever key answers on the port. Anybody
// able to get between this machine and the backup destination therefore
// received the entire backup and the credential that opens it, and neither end
// said anything. A backup transport that cannot tell its own destination from
// an impostor is not a backup transport.
//
// These run a genuine ssh2 server in-process with a known host key, so what is
// being checked is the real handshake and the real fingerprint, not a mock of
// one. Host key verification happens before authentication, which is the
// property that matters: a wrong host never receives the password.

const assert = require('assert/strict');
const crypto = require('crypto');
const { createDestination } = require('./backupDestinations');

let ssh2;
try { ssh2 = require('ssh2'); } catch { ssh2 = null; }

function hostKeyPem() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
}

// The fingerprint the destination is expected to compute, worked out here from
// the server's own key by a different route, so a bug that made both sides
// agree on a wrong answer would still be caught.
function expectedFingerprint(pem) {
  const blob = ssh2.utils.parseKey(pem).getPublicSSH();
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

async function withServer(pem, fn) {
  const server = new ssh2.Server({ hostKeys: [pem] }, client => {
    // Anything that gets this far has passed host verification. These tests are
    // about what happens before that, so the session itself is left to hang up.
    client.on('authentication', ctx => ctx.accept());
    client.on('ready', () => client.end());
    client.on('error', () => { /* the client walking away is the expected case */ });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn(server.address().port); }
  finally { server.close(); }
}

function destination(port, fingerprint) {
  return createDestination('sftp.generic', JSON.stringify({
    host: '127.0.0.1', port, username: 'backup', password: 'not-used-because-it-never-gets-there',
    directory: '/backups', ...(fingerprint ? { host_key_fingerprint: fingerprint } : {}),
  }));
}

async function attempt(port, fingerprint) {
  try {
    await destination(port, fingerprint).list({});
    return { ok: true, code: null, message: null };
  } catch (error) {
    return { ok: false, code: error.code || null, message: error.message };
  }
}

async function testAnUnpinnedDestinationRefusesAndSaysWhatItSaw() {
  const pem = hostKeyPem();
  await withServer(pem, async port => {
    const result = await attempt(port, null);
    assert.equal(result.ok, false, 'a destination with no pinned key must not connect');
    assert.equal(result.code, 'SFTP_HOST_KEY_UNPINNED');
    // The refusal has to be actionable. A wall that says "handshake failed"
    // sends whoever is debugging it to the network, and they will eventually
    // reach for a flag that turns the check off.
    assert.match(result.message, /SHA256:[A-Za-z0-9+/]{43}/, 'the refusal carries the fingerprint it was offered');
    assert.match(result.message, /ssh-keyscan/, 'and how to check it against the real server');
    assert.equal(result.message.includes(expectedFingerprint(pem)), true,
      'and it is this server\'s actual fingerprint, not an invented one');
  });
}

async function testTheRightFingerprintGetsPastVerification() {
  const pem = hostKeyPem();
  await withServer(pem, async port => {
    const result = await attempt(port, expectedFingerprint(pem));
    // The server above hangs up rather than serving SFTP, so the call still
    // fails, with ssh2-sftp-client's own generic code. What must be true is
    // that it did not fail on the host key: the handshake was accepted and the
    // connection moved past verification to the part this test does not serve.
    assert.equal(['SFTP_HOST_KEY_UNPINNED', 'SFTP_HOST_KEY_MISMATCH'].includes(result.code), false,
      `a correct fingerprint must not be a host key failure: ${result.code} ${result.message}`);
    assert.equal(/host key/i.test(result.message || ''), false, result.message || '');
  });
}

async function testAChangedFingerprintIsRefusedAndNamesBoth() {
  const pem = hostKeyPem();
  const somebodyElse = expectedFingerprint(hostKeyPem());
  await withServer(pem, async port => {
    const result = await attempt(port, somebodyElse);
    assert.equal(result.ok, false, 'a server presenting a different key must not be trusted');
    assert.equal(result.code, 'SFTP_HOST_KEY_MISMATCH');
    assert.equal(result.message.includes(somebodyElse), true, 'the refusal says what was expected');
    assert.equal(result.message.includes(expectedFingerprint(pem)), true, 'and what was offered');
    assert.match(result.message, /nothing was sent/i, 'and that no data left this machine');
  });
}

function testAFingerprintThatIsNotAFingerprintIsRefusedBeforeAnythingConnects() {
  assert.throws(() => destination(22, 'not-a-fingerprint'), /SHA256:/,
    'a malformed pin must be refused when the destination is built, not at connect time');
  assert.throws(() => destination(22, 'SHA256:tooshort'), /43 characters/);
}

function testTheDestinationSaysWhetherItIsPinned() {
  const pem = hostKeyPem();
  const fingerprint = expectedFingerprint(pem);
  assert.equal(destination(22, fingerprint).describe().host_key_pinned, true);
  assert.equal(destination(22, null).describe().host_key_pinned, false,
    'an operator has to be able to see that a destination is not pinned');
}

async function run() {
  if (!ssh2) {
    console.log('  (no ssh2 in this build, so the host key tests cannot run — that is a gap, not a pass)');
    process.exitCode = 1;
    return;
  }
  for (const test of [
    testAFingerprintThatIsNotAFingerprintIsRefusedBeforeAnythingConnects,
    testTheDestinationSaysWhetherItIsPinned,
    testAnUnpinnedDestinationRefusesAndSaysWhatItSaw,
    testTheRightFingerprintGetsPastVerification,
    testAChangedFingerprintIsRefusedAndNamesBoth,
  ]) {
    await test();
    console.log(`  \x1b[32m✓\x1b[0m ${test.name.replace(/^test/, '')}`);
  }
  console.log('sftp host key tests passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
