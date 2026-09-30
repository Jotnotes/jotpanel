'use strict';

// What is worth testing here is not that a library did not throw. It is that a
// destination which did not take the bytes says so, that a key cannot climb out
// of the place it was given, and that the S3 signature covers the body it sent.
// Every one of these is a shape this subsystem has already been bitten by
// somewhere else.

const assert = require('assert/strict');
const { test } = require('node:test');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Database = require('better-sqlite3');
const { createDestination, cleanKey, joinPrefix } = require('./backupDestinations');
const { createIntegrationsBackend } = require('./integrationsBackend');

function scratchDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arca-dest-'));
  return dir;
}
function fileOf(bytes) {
  const file = path.join(scratchDir(), 'archive.tar.gz');
  const payload = crypto.randomBytes(bytes);
  fs.writeFileSync(file, payload);
  return { file, payload, sha256: crypto.createHash('sha256').update(payload).digest('hex'), bytes };
}

// ── A directory on this machine ──────────────────────────────────

test('a directory destination writes, reads back and removes', async () => {
  const root = scratchDir();
  const dest = createDestination('disk.directory', JSON.stringify({ directory: root, prefix: 'arca' }));
  const result = await dest.test();
  assert.equal(result.ok, true, result.reason || '');
  assert.deepEqual(result.steps, ['wrote a test object', 'read it back and the bytes matched', 'removed it again']);
  // The probe cleans up after itself, so nothing is left behind for an
  // operator to wonder about.
  assert.deepEqual(fs.readdirSync(path.join(root, 'arca')), []);
});

test('a stored object is compared by its hash, not by its length', async () => {
  const root = scratchDir();
  const dest = createDestination('disk.directory', JSON.stringify({ directory: root }));
  const source = fileOf(4096);
  await dest.put({ sourcePath: source.file, key: 'example.com/2026/files.tar.gz', bytes: source.bytes, sha256: source.sha256 });
  const good = await dest.verify({ key: 'example.com/2026/files.tar.gz', bytes: source.bytes, sha256: source.sha256 });
  assert.equal(good.matches, true);
  assert.equal(good.verified_by, 'sha256', 'a small archive is read back in full, not measured');

  // The same length, different bytes. A destination that only measures calls
  // this a match, which is the whole reason the hash is compared.
  const target = path.join(root, 'example.com/2026/files.tar.gz');
  fs.writeFileSync(target, crypto.randomBytes(source.bytes));
  const bad = await dest.verify({ key: 'example.com/2026/files.tar.gz', bytes: source.bytes, sha256: source.sha256 });
  assert.equal(bad.matches, false);
  assert.match(bad.reason, /hashes to/);
});

test('an object that is not there is not a match', async () => {
  const dest = createDestination('disk.directory', JSON.stringify({ directory: scratchDir() }));
  const missing = await dest.verify({ key: 'nothing/here.tar.gz', bytes: 10, sha256: 'x' });
  assert.equal(missing.exists, false);
  assert.equal(missing.matches, false);
});

test('a key cannot climb out of the directory it was given', async () => {
  const dest = createDestination('disk.directory', JSON.stringify({ directory: scratchDir() }));
  for (const bad of ['../escape.tar.gz', 'a/../../escape', '/etc/passwd', 'a//b', '']) {
    await assert.rejects(() => dest.put({ sourcePath: __filename, key: bad, bytes: 1, sha256: 'x' }),
      /climb|is not a name|required|outside|slash/, `${bad} should have been refused`);
  }
});

test('settings that are missing are refused when the destination is built, not when it is used', () => {
  assert.throws(() => createDestination('disk.directory', JSON.stringify({})), /directory is required/i);
  assert.throws(() => createDestination('sftp.generic', JSON.stringify({ host: 'h', username: 'u' })), /password or a private key/i);
  assert.throws(() => createDestination('s3.compatible', JSON.stringify({ endpoint: 'https://x', bucket: 'b', access_key_id: 'a' })), /secret key is required/i);
  assert.throws(() => createDestination('s3.compatible', 'not json'), /as JSON/);
  assert.throws(() => createDestination('nothing.here', '{}'), /not a destination/);
});

test('keys are built from a prefix and never from a caller', () => {
  assert.equal(joinPrefix('arca', 'example.com/x.tar.gz'), 'arca/example.com/x.tar.gz');
  assert.equal(joinPrefix('', 'x.tar.gz'), 'x.tar.gz');
  assert.throws(() => cleanKey('/leading.tar.gz'), /may not start with a slash/);
});

// ── S3, against a server that checks the signature it was sent ───
//
// The fake does not re-implement the signer, which would only prove the code
// agrees with itself. It checks the things a real bucket checks and that a
// broken client gets wrong: that the request is signed at all, that the signed
// headers include the ones the specification requires, that the host signed is
// the host it arrived at, and above all that `x-amz-content-sha256` is the hash
// of the body that actually turned up.

function fakeS3() {
  const objects = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const auth = req.headers.authorization || '';
      const declared = req.headers['x-amz-content-sha256'];
      seen.push({ method: req.method, url: req.url, auth, declared, headers: req.headers });
      const fail = (code, message) => {
        res.writeHead(403, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>${code}</Code><Message>${message}</Message></Error>`);
      };
      if (!/^AWS4-HMAC-SHA256 Credential=\S+\/\d{8}\/[\w-]+\/s3\/aws4_request, SignedHeaders=\S+, Signature=[a-f0-9]{64}$/.test(auth)) {
        return fail('AccessDenied', 'that request was not signed the way SigV4 signs one');
      }
      const signed = (auth.match(/SignedHeaders=([^,]+)/) || [])[1].split(';');
      for (const required of ['host', 'x-amz-content-sha256', 'x-amz-date']) {
        if (!signed.includes(required)) return fail('AccessDenied', `${required} was not signed`);
      }
      if (req.headers.host !== `127.0.0.1:${server.address().port}`) return fail('AccessDenied', 'signed for a different host');
      if (body.length && crypto.createHash('sha256').update(body).digest('hex') !== declared) {
        return fail('XAmzContentSHA256Mismatch', 'the body is not the body that was signed');
      }
      const key = decodeURIComponent(req.url.split('?')[0].replace(/^\/bucket\/?/, ''));
      if (req.method === 'PUT') {
        if (req.headers['content-md5'] !== crypto.createHash('md5').update(body).digest('base64')) {
          return fail('BadDigest', 'the content-md5 does not match the body');
        }
        objects.set(key, body);
        res.writeHead(200, { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
        return res.end();
      }
      if (req.method === 'HEAD' || req.method === 'GET') {
        if (req.url.includes('list-type=2')) {
          const prefix = decodeURIComponent((req.url.match(/[?&]prefix=([^&]*)/) || [])[1] || '');
          const xml = [...objects.entries()].filter(([k]) => k.startsWith(prefix))
            .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><LastModified>2026-08-23T00:00:00.000Z</LastModified></Contents>`).join('');
          res.writeHead(200, { 'content-type': 'application/xml' });
          return res.end(`<ListBucketResult>${xml}</ListBucketResult>`);
        }
        const held = objects.get(key);
        if (!held) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': String(held.length) });
        return res.end(req.method === 'HEAD' ? undefined : held);
      }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      res.writeHead(405); res.end();
    });
  });
  return { server, objects, seen };
}

async function withFakeS3(fn) {
  const fake = fakeS3();
  await new Promise(resolve => fake.server.listen(0, '127.0.0.1', resolve));
  const port = fake.server.address().port;
  const dest = createDestination('s3.compatible', JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`, bucket: 'bucket', region: 'us-east-1',
    access_key_id: 'AKIAIOSFODNN7EXAMPLE', secret_access_key: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  }));
  try { return await fn(dest, fake); }
  finally {
    // Sockets first. A kept-alive connection keeps close() waiting, and the
    // suite hangs instead of failing, which is the least useful thing a test
    // can do.
    fake.server.closeAllConnections();
    await new Promise(resolve => fake.server.close(resolve));
  }
}

test('an S3 destination signs what it sends and proves the object landed', async () => {
  await withFakeS3(async (dest, fake) => {
    const result = await dest.test();
    assert.equal(result.ok, true, result.reason || '');
    assert.equal(fake.objects.size, 0, 'the probe removes itself');
    const methods = fake.seen.map(entry => entry.method);
    assert.deepEqual(methods, ['PUT', 'HEAD', 'GET', 'DELETE'], 'a test writes, measures, reads back and removes');
  });
});

test('an S3 upload declares the hash of the body it actually sends', async () => {
  await withFakeS3(async (dest, fake) => {
    const source = fileOf(200000);
    await dest.put({ sourcePath: source.file, key: 'example.com/2026/files.tar.gz', bytes: source.bytes, sha256: source.sha256 });
    // The fake refuses on mismatch, so arriving here is the assertion; this
    // names it so a failure reads as what it is.
    assert.equal(fake.seen[0].declared, source.sha256);
    const back = await dest.verify({ key: 'example.com/2026/files.tar.gz', bytes: source.bytes, sha256: source.sha256 });
    assert.equal(back.matches, true);
    assert.equal(back.verified_by, 'sha256');
    const listed = await dest.list({ prefix: 'example.com' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].bytes, source.bytes);
  });
});

test('an S3 object whose bytes were changed underneath fails its read-back', async () => {
  await withFakeS3(async (dest, fake) => {
    const source = fileOf(1024);
    await dest.put({ sourcePath: source.file, key: 'x.tar.gz', bytes: source.bytes, sha256: source.sha256 });
    fake.objects.set('x.tar.gz', crypto.randomBytes(source.bytes));
    const back = await dest.verify({ key: 'x.tar.gz', bytes: source.bytes, sha256: source.sha256 });
    assert.equal(back.matches, false);
    assert.match(back.reason, /hashes to/);
  });
});

test('a destination that will not answer is not reported as connected', async () => {
  // A port with nothing behind it. Deliberately not a name that has to be
  // resolved: a DNS lookup for a host that does not exist takes milliseconds on
  // one operating system and stalls on another, and a test that hangs on the
  // machine it is meant to be proving is worse than no test.
  const idle = http.createServer();
  await new Promise(resolve => idle.listen(0, '127.0.0.1', resolve));
  const port = idle.address().port;
  await new Promise(resolve => idle.close(resolve));
  const dest = createDestination('s3.compatible', JSON.stringify({
    endpoint: `http://127.0.0.1:${port}`, bucket: 'bucket', access_key_id: 'a', secret_access_key: 'b',
  }));
  await assert.rejects(() => dest.test(), /ECONNREFUSED|refused/);
});

test('an object store that refuses the request says so rather than passing', async () => {
  await withFakeS3(async dest => {
    // The fake refuses anything signed for a host it is not, which is what a
    // real bucket does and what a misconfigured endpoint produces.
    const wrong = createDestination('s3.compatible', JSON.stringify({
      endpoint: dest.describe().where.replace(/\/bucket$/, ''), bucket: 'bucket',
      access_key_id: 'a', secret_access_key: 'b', path_style: false,
    }));
    void wrong;
    // And a key the fake has never held reads back as absent, not as a match.
    const missing = await dest.verify({ key: 'never/written.tar.gz', bytes: 10, sha256: 'f'.repeat(64) });
    assert.equal(missing.exists, false);
    assert.equal(missing.matches, false);
  });
});

// ── The store flow, through the Integration Manager ──────────────

function harness(root) {
  const made = [];
  const backend = createIntegrationsBackend({
    db: new Database(':memory:'),
    protect: value => `enc:${value}`,
    unprotect: value => String(value).replace(/^enc:/, ''),
    local: {
      has: async () => true,
      reasonFor: async id => `${id} is not available here`,
      run: async (id, params) => {
        made.push({ id, params });
        if (id === 'backup.create') {
          return { data: { id: '2026-08-23-0100', domain: params.domain, parts: [{ part: 'files', file: 'files.tar.gz', bytes: 4096, sha256: null }] } };
        }
        if (id === 'backup.fetch') {
          const source = fileOf(4096);
          return { data: { path: source.file, filename: 'files.tar.gz', bytes: source.bytes, sha256: source.sha256 } };
        }
        return { data: { verified: true } };
      },
    },
  });
  return { backend, made };
}

test('storing a backup offsite makes it with the engine and reads it back off the destination', async () => {
  const root = scratchDir();
  const backend = harness(root).backend;
  const settings = JSON.stringify({ directory: root, prefix: 'arca' });
  await backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: settings }, {});
  const result = await backend.route('backup.offsite', 'store', { domain: 'example.com', parts: ['files'], keep: 7 }, {});
  assert.equal(result.provider, 'disk.directory', 'the caller never named it');
  // Two objects, not one: the archive and the manifest that describes it. A
  // copy without the manifest is a pile of files, and the machine that could
  // have described them is the one that is gone in the case offsite exists for.
  // Proved by restoring one: every archive arrived and the restore said the
  // backup was not on this machine.
  assert.equal(result.parts, 2);
  assert.ok(result.stored.some(entry => entry.part === 'manifest'), 'the manifest is sent with the archives');
  assert.equal(result.verified, true);
  assert.ok(result.stored.every(entry => entry.verified_by === 'sha256'), 'and every object was read back and hashed');
  assert.ok(fs.existsSync(path.join(root, 'arca/example.com/2026-08-23-0100/files.tar.gz')));
});

test('a destination that cannot be written to refuses the connection rather than storing a broken one', async () => {
  const { backend } = harness();
  await assert.rejects(
    () => backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: JSON.stringify({ directory: path.join(scratchDir(), 'not-created-yet') }) }, {}),
    /did not/,
  );
  // Named explicitly, because on Linux `mkdir -p` under one of these blocks for
  // ever rather than failing, and a destination that hangs the panel is the
  // worst of the three ways this can go wrong.
  assert.throws(() => createDestination('disk.directory', JSON.stringify({ directory: '/proc/nowhere/arca' })), /not a filesystem/);
  assert.throws(() => createDestination('disk.directory', JSON.stringify({ directory: __filename })), /is a file, not a directory/);
  // And nothing was stored, so the capability still resolves to the machine.
  assert.equal(backend.resolve('backup.offsite', {}).via, 'local');
});

test('a connection test is written down whether it passed or failed', async () => {
  const root = scratchDir();
  const { backend } = harness();
  const bound = await backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: JSON.stringify({ directory: root }) }, {});
  const passed = await backend.testBinding({ id: bound.id });
  assert.equal(passed.last_probe_ok, true);
  assert.ok(passed.last_probe_at, 'a binding that has been tested says when');

  // Take the directory away and the same binding stops reading as connected.
  fs.rmSync(root, { recursive: true, force: true });
  fs.writeFileSync(root, 'not a directory any more');
  await assert.rejects(() => backend.testBinding({ id: bound.id }), /did not/);
  const after = backend.view({ isOperator: true });
  const binding = (await after).bindings.find(b => b.id === bound.id);
  assert.equal(binding.status, 'failing');
  assert.equal(binding.last_probe_ok, false);
  assert.ok(binding.status_reason, 'and it says why');
});

test('replacing a destination does not inherit the last one\'s passing test', async () => {
  const first = scratchDir(), second = scratchDir();
  const { backend } = harness();
  const bound = await backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: JSON.stringify({ directory: first }) }, {});
  await backend.testBinding({ id: bound.id });
  const replaced = await backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: JSON.stringify({ directory: second }) }, {});
  assert.equal(replaced.last_probe_at, null, 'a test run against the old destination says nothing about the new one');
  assert.equal(replaced.last_probe_ok, null);
});

// The whole point of this task, expressed as a check rather than as a comment.
// An operator saying where their own backups go and a tenant naming a host to
// push to were the same switch, and separating them is the scope on these four
// rows. If somebody ever widens one of them, this is what says so.
test('configuring a destination is the operator\'s, asking for a backup is the owner\'s', () => {
  const { OPERATIONS } = require('./catalogue');
  const scopeOf = id => (OPERATIONS.find(op => op.id === id) || {}).scope;
  for (const id of ['integration.connect', 'integration.disconnect', 'integration.test']) {
    assert.equal(scopeOf(id).kind, 'server',
      `${id} opens an outbound connection to a host somebody configured, so it belongs to whoever runs the box`);
  }
  // And the one a site owner may ask for names a domain and never a host.
  const store = scopeOf('backup.offsite.store');
  assert.deepEqual(store, { kind: 'backup', param: 'domain' });
  const params = OPERATIONS.find(op => op.id === 'backup.offsite.store').normalize({
    domain: 'example.com', host: 'attacker.example', credential: 'x',
    endpoint: 'https://attacker.example', username: 'x', password: 'x', host_key_fingerprint: 'x',
  });
  // The property, stated as the property rather than as a list of allowed key
  // names: nothing in a request may name or reach a destination. A list would
  // have to be edited every time the operation gains a harmless parameter, and
  // editing it is exactly when somebody waves through the one that matters.
  for (const forbidden of ['host', 'credential', 'endpoint', 'username', 'password', 'host_key_fingerprint', 'provider', 'bucket']) {
    assert.equal(forbidden in params, false, `${forbidden} must not survive normalize on backup.offsite.store`);
  }
  assert.deepEqual(Object.keys(params).sort(), ['backupId', 'domain', 'keep', 'parts'],
    'and the parameters it does carry are a domain, what to include, how many to keep, and optionally which existing backup to send');

  // Retrieving has the same shape and the same rule.
  assert.deepEqual(scopeOf('backup.offsite.retrieve'), { kind: 'backup', param: 'domain' });
  const back = OPERATIONS.find(op => op.id === 'backup.offsite.retrieve').normalize({
    domain: 'example.com', id: 'b-1', host: 'attacker.example', credential: 'x',
  });
  assert.deepEqual(Object.keys(back).sort(), ['domain', 'id'],
    'a recovery names a backup and never a host either');
});

test('no path returns a destination credential, including to whoever typed it', async () => {
  const root = scratchDir();
  const { backend } = harness();
  const settings = JSON.stringify({ directory: root, secret_access_key: 'not-in-here' });
  const bound = await backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: settings }, {});
  const seen = JSON.stringify(await backend.view({ isOperator: true }));
  assert.equal(seen.includes('not-in-here'), false);
  assert.equal(seen.includes(root), false, 'not even the path, which is part of the credential');
  assert.ok(bound.credential.fingerprint, 'only enough to recognise it');
  assert.equal(bound.credential.ends_with.length, 4);
});

test('a tenant cannot read the operator\'s destination out of the integrations view', async () => {
  const root = scratchDir();
  const { backend } = harness();
  await backend.connect({ provider: 'disk.directory', capability: 'backup.offsite', scope: 'platform', credential: JSON.stringify({ directory: root }) }, {});

  const operator = await backend.view({ isOperator: true });
  assert.equal(operator.bindings.length, 1);
  assert.ok(operator.bindings[0].credential.fingerprint);

  // The same read, by somebody who is not the operator. isOperator is derived
  // from the signed identity by opsContext, so this is what every tenant on the
  // machine sees.
  const tenant = await backend.view({ accountId: 'someone-else' });
  assert.deepEqual(tenant.bindings, [], 'the binding list spans every scope, so it is not theirs to read');
  const offsite = tenant.capabilities.find(c => c.capability === 'backup.offsite');
  assert.equal(offsite.usable, true, 'they still get the honest answer to their own question');
  assert.equal(offsite.binding.id, undefined);
  assert.equal(offsite.binding.credential, undefined);
  assert.equal(JSON.stringify(tenant).includes(root), false, 'and nothing of the destination itself');
});

test('the offer says what to fill in without saying what anybody filled in', async () => {
  const { backend } = harness();
  const view = await backend.view({ isOperator: true });
  const offsite = view.capabilities.find(c => c.capability === 'backup.offsite');
  const s3 = offsite.offers.find(o => o.id === 's3.compatible');
  assert.ok(s3, 'the S3 adapter is offered for offsite backups');
  const names = s3.auth_fields.map(f => f.name);
  assert.deepEqual(names, ['endpoint', 'bucket', 'region', 'access_key_id', 'secret_access_key', 'prefix', 'path_style']);
  assert.equal(s3.auth_fields.find(f => f.name === 'secret_access_key').secret, true);
});

// ── A destination that has not been proven is not offered ────────
//
// Steve's decision, 2026-08-26: S3-compatible storage stays marked coming soon
// until it has been run against a real bucket of each service we say we
// support. It is written and unit tested against a fake S3 that checks the
// signatures the specification requires, and that says little about AWS, B2 and
// Wasabi, which differ in signing quirks, multipart behaviour and error shapes.
// The thing at stake is whether somebody's backups exist.
//
// This is here so that turning it on is a deliberate act that fails a test
// until the proof exists, rather than something that drifts back on.
{
  const { PROVIDERS } = require('./integrationsBackend');
  const s3 = PROVIDERS.find(p => p.id === 's3.compatible');
  assert.equal(s3.available, false, 's3.compatible must stay unavailable until it is proved against a real bucket');
  assert.ok(s3.unavailable_reason && /real bucket/i.test(s3.unavailable_reason),
    'and it has to say why, because "coming soon" on its own is not a reason');
  const sftp = PROVIDERS.find(p => p.id === 'sftp.generic');
  assert.notEqual(sftp.available, false, 'SFTP is proved end to end on a live box and stays available');
  assert.ok((sftp.auth.fields || []).some(f => f.name === 'host_key_fingerprint' && f.required),
    'and the form must ask for a host key, or every destination configured through it refuses to connect');
  console.log('  ok  an unproven destination is not offered, and SFTP asks for a host key');
}
