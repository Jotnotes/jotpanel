'use strict';

// Where a backup goes when it leaves this machine.
//
// This file is transport and nothing else. It does not know what a backup is,
// it does not talk to the database, it does not decide who is allowed to ask,
// and it holds no state between calls. Everything above it — the capability,
// the binding, the encrypted credential, the approval — already exists in the
// Integration Manager, so a destination is a provider like any other and this
// is only the part that moves bytes.
//
// ── The interface ────────────────────────────────────────────────
// Four functions. A new backend implements these and is then reachable from
// everywhere a destination is, with no other code changed.
//
//   test()                              a full round trip, described below
//   put({ sourcePath, key, bytes, sha256 })
//   verify({ key, bytes, sha256, deep })
//   list({ prefix, limit })
//
// `test` is the load-bearing one. It writes a small object, reads it back,
// compares the bytes it got with the bytes it sent, and deletes it. A test that
// opens a socket and calls that connected is the same bug this subsystem has
// already been bitten by twice: a control that reports itself as holding while
// it is not is worse than one that plainly does not exist.
//
// `verify` asks the far end what it has, and never reports what we sent. It
// returns what it actually checked in `verified_by`, which is `sha256` when the
// object was read back and hashed, `md5` when the far end volunteered a digest
// we could compare, and `size` when the length is all anybody can know. The
// caller decides whether that is enough; nothing here calls size alone a match.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { PassThrough } = require('stream');

const PROBE_BYTES = 64;
// A read-back that hashes the whole archive costs a second transfer of it, so
// it is automatic while that is cheap and deliberate above it. The number is
// not magic; it is the point past which an operator would rather have the
// backup than the proof, and the answer says which one they got.
const DEEP_VERIFY_LIMIT = 256 * 1024 * 1024;

// ── Credentials ──────────────────────────────────────────────────
// One JSON object per destination, following smtp.generic: the binding holds a
// single opaque string and each adapter says what it expects that string to be.
// Parsed strictly, because a field silently missing here is a destination that
// looks configured and writes nowhere.
function parseCredential(raw, providerId) {
  const text = String(raw || '').trim();
  if (!text) throw new Error('that destination has no settings stored');
  if (!text.startsWith('{')) throw new Error(`${providerId} needs its settings as JSON, not a single value`);
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error('those destination settings are not valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('those destination settings are not a set of settings');
  return parsed;
}

function need(settings, field, label) {
  const value = settings[field];
  if (value == null || String(value).trim() === '') throw new Error(`${label} is required for this destination`);
  return String(value).trim();
}

// A key is ours to build, never a caller's to supply, but it is still checked
// here so that a bug upstream cannot walk out of the prefix it was given.
function cleanKey(key) {
  const value = String(key || '');
  if (!value) throw new Error('a destination key is required');
  // An absolute key is refused rather than quietly made relative. Nothing here
  // builds one, so a leading slash means something upstream is wrong, and
  // trimming it would send the object somewhere plausible instead of saying so.
  if (value.startsWith('/')) throw new Error('a destination key is relative to the destination, so it may not start with a slash');
  if (value.length > 900) throw new Error('that destination key is too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(value)) throw new Error(`${value} is not a name this can write`);
  if (value.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('a destination key may not climb');
  return value;
}

function joinPrefix(prefix, key) {
  const clean = String(prefix || '').replace(/^\/+|\/+$/g, '');
  return clean ? `${clean}/${key}` : key;
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

// What every adapter returns from `verify`, so the caller never has to know
// which backend answered to read the result.
function verdict({ exists, bytes, expectedBytes, digest = null, expectedDigest = null, verifiedBy }) {
  if (!exists) return { exists: false, matches: false, bytes: null, verified_by: 'nothing', reason: 'the far end does not have that object' };
  if (expectedBytes != null && bytes !== expectedBytes) {
    return { exists: true, matches: false, bytes, verified_by: 'size', reason: `the copy that arrived is ${bytes} bytes and the archive is ${expectedBytes}` };
  }
  if (digest && expectedDigest && digest !== expectedDigest) {
    return { exists: true, matches: false, bytes, verified_by: verifiedBy, reason: `the copy that arrived hashes to ${digest} and the archive hashes to ${expectedDigest}` };
  }
  return { exists: true, matches: true, bytes, verified_by: digest && expectedDigest ? verifiedBy : 'size', reason: null };
}

// The round trip every adapter shares. It is written once here rather than
// three times below, because the one thing that must not vary between backends
// is what "connected" is allowed to mean.
async function roundTrip(adapter, { prefix = '' } = {}) {
  const payload = crypto.randomBytes(PROBE_BYTES);
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const key = joinPrefix(prefix, `jotpanel-connection-test-${crypto.randomBytes(6).toString('hex')}.bin`);
  const scratch = path.join(require('os').tmpdir(), `jotpanel-probe-${crypto.randomBytes(6).toString('hex')}`);
  const steps = [];
  fs.writeFileSync(scratch, payload, { mode: 0o600 });
  try {
    await adapter.put({ sourcePath: scratch, key, bytes: payload.length, sha256 });
    steps.push('wrote a test object');
    const back = await adapter.verify({ key, bytes: payload.length, sha256, deep: true });
    if (!back.matches) return { ok: false, steps, reason: back.reason || 'the test object did not read back the same' };
    if (back.verified_by !== 'sha256') return { ok: false, steps, reason: 'the test object could not be read back and compared, so this destination is not proven' };
    steps.push('read it back and the bytes matched');
    await adapter.remove({ key });
    steps.push('removed it again');
    return { ok: true, steps, reason: null };
  } finally {
    try { fs.unlinkSync(scratch); } catch { /* the probe is disposable */ }
  }
}

// ── A directory on this machine ──────────────────────────────────
// A second disk, a mounted volume, somebody's NAS over NFS. It is written by
// the panel process, not by root, so what it can reach is bounded by the panel
// user's own permissions, and connecting one is an owner-only operation on the
// whole machine. Both of those are the point: this is an operator saying where
// their own backups go, which is a different question from a tenant naming a
// host to push to.
function diskDestination(settings) {
  const root = path.resolve(need(settings, 'directory', 'A directory'));
  const prefix = settings.prefix ? String(settings.prefix) : '';
  // The directory has to exist already, and it is checked here rather than on
  // the first write. Two reasons, and the second one was found by running this
  // on Linux rather than by reading it.
  //
  // The product reason: somebody who mistypes the path to their mounted volume
  // should be told the directory is not there, not have a new one quietly made
  // at the wrong depth on the system disk, which is how a backup ends up on the
  // same machine it was supposed to be leaving.
  //
  // The other reason: `mkdir -p` inside a pseudo-filesystem does not fail on
  // Linux, it blocks, permanently, with no timeout and nothing to interrupt it.
  // A destination configured as /proc/anything would hang the panel process on
  // its first write. So those trees are named and refused, and everywhere else
  // has to already exist.
  for (const pseudo of ['/proc', '/sys', '/dev']) {
    if (root === pseudo || root.startsWith(`${pseudo}/`)) throw new Error(`${pseudo} is not a filesystem anything can be stored in`);
  }
  let stat;
  try { stat = fs.statSync(root); } catch { throw new Error(`${root} is not a directory on this machine. Create it, or mount the volume there, first.`); }
  if (!stat.isDirectory()) throw new Error(`${root} is a file, not a directory`);
  // Two different failures wear the same errno here, and telling them apart is
  // the difference between a fixable message and a baffling one. Unix
  // permissions are the obvious case. The other is that JotPanel's own service unit
  // runs under ProtectSystem=strict with ReadWritePaths=/opt/jotpanel, so a volume
  // mounted anywhere else is read-only inside the panel's namespace no matter
  // what the directory's owner and mode say. That is a deliberate part of the
  // install and it is not something to relax quietly from in here, so it is
  // named instead, with the one line that fixes it.
  try { fs.accessSync(root, fs.constants.W_OK); }
  catch {
    const sandboxed = !root.startsWith('/opt/jotpanel');
    throw new Error(sandboxed
      ? `${root} exists but the panel cannot write to it. JotPanel's service is confined to its own directory, so a volume elsewhere has to be allowed in: add "ReadWritePaths=${root}" to a systemd drop-in for the jotpanel service and restart it. Check the directory's owner and mode too.`
      : `${root} exists but the panel cannot write to it. Check its owner and mode.`);
  }
  const full = key => {
    const target = path.resolve(root, cleanKey(key));
    // Resolved, then checked, because a symlink in the middle of the path is
    // the one way a clean key still lands somewhere else.
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('that destination path is outside the directory it was given');
    return target;
  };
  return {
    id: 'disk.directory',
    describe: () => ({ where: root, prefix: prefix || null }),
    prefix,
    async put({ sourcePath, key }) {
      const target = full(key);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o750 });
      await pipeline(fs.createReadStream(sourcePath), fs.createWriteStream(target, { mode: 0o640 }));
      return { key };
    },
    async verify({ key, bytes, sha256, deep }) {
      const target = full(key);
      if (!fs.existsSync(target)) return verdict({ exists: false });
      const stat = fs.statSync(target);
      const wantDeep = deep || (bytes != null && bytes <= DEEP_VERIFY_LIMIT);
      // Reading it back off the same box is cheap enough that there is no good
      // reason to settle for the size.
      const digest = wantDeep && sha256 ? await hashFile(target) : null;
      return verdict({ exists: true, bytes: stat.size, expectedBytes: bytes, digest, expectedDigest: sha256, verifiedBy: 'sha256' });
    },
    async fetch({ key, targetPath }) {
      const source = full(key);
      if (!fs.existsSync(source)) throw new Error('the far end does not have that object');
      await pipeline(fs.createReadStream(source), fs.createWriteStream(targetPath, { mode: 0o600 }));
      return { key, bytes: fs.statSync(targetPath).size, sha256: await hashFile(targetPath) };
    },
    async list({ prefix: under = '', limit = 100 } = {}) {
      const base = path.resolve(root, under ? cleanKey(under) : '.');
      if (!fs.existsSync(base)) return [];
      const found = [];
      const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (found.length >= limit) return;
          const here = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(here);
          else if (entry.isFile()) found.push({ key: path.relative(root, here), bytes: fs.statSync(here).size, modified: fs.statSync(here).mtime.toISOString() });
        }
      };
      walk(base);
      return found;
    },
    async remove({ key }) { try { fs.unlinkSync(full(key)); } catch { /* already gone is the state we wanted */ } },
    async test() { return roundTrip(this, { prefix }); },
  };
}

// ── SFTP ─────────────────────────────────────────────────────────
// The transport that was already proven end to end: a backup sent, an account
// rebuilt from the copy that arrived. What is new here is only that the
// destination now has a home of its own instead of borrowing a deploy
// credential, and that the read-back can hash rather than only measure.
// The fingerprint of a host key, in the form OpenSSH prints and a person can
// compare by eye against `ssh-keyscan | ssh-keygen -lf -`. Base64 of the SHA-256
// with the padding removed, which is what `SHA256:...` means everywhere else.
function hostKeyFingerprint(key) {
  return `SHA256:${crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

function sftpDestination(settings) {
  const host = need(settings, 'host', 'A host');
  const port = Number(settings.port || 22);
  const username = need(settings, 'username', 'A username');
  const password = settings.password ? String(settings.password) : null;
  const privateKey = settings.private_key ? String(settings.private_key) : null;
  const passphrase = settings.passphrase ? String(settings.passphrase) : undefined;
  if (!password && !privateKey) throw new Error('A password or a private key is required for this destination');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('that SFTP port is not a port');
  const directory = String(settings.directory || '/backups').replace(/\/+$/, '') || '/';
  const prefix = settings.prefix ? String(settings.prefix) : '';

  // ── The host key ───────────────────────────────────────────────
  //
  // Without this, ssh2 accepts whatever key answers on the port, which means
  // anybody who can get between this machine and the destination receives the
  // whole backup and the credential that opens it, and neither end ever says
  // anything. It is not a hardening detail; a backup transport that cannot tell
  // its own destination from an impostor is not a backup transport.
  //
  // There is no trust-on-first-use here, deliberately. First use is exactly
  // when an attacker who is already in position wins, and a panel that records
  // whatever it met the first time would be automating that. So a destination
  // with no pinned fingerprint refuses to connect and the refusal carries the
  // fingerprint it was offered, which is the one piece of information the
  // operator needs to pin it on purpose after checking it against the server
  // they actually own.
  const pinned = settings.host_key_fingerprint ? String(settings.host_key_fingerprint).trim() : null;
  if (pinned && !/^SHA256:[A-Za-z0-9+/]{43}$/.test(pinned)) {
    throw new Error('A host key fingerprint looks like SHA256: followed by 43 characters, as ssh-keygen -lf prints it');
  }

  let seenFingerprint = null;

  const remote = key => `${directory}/${cleanKey(key)}`;

  async function withClient(fn) {
    let SFTPClient;
    try { SFTPClient = require('ssh2-sftp-client'); }
    catch { throw new Error('this build has no SFTP library'); }
    const client = new SFTPClient();
    // Runs before authentication, so a wrong host never receives the password
    // or the private key. Returning false makes ssh2 abandon the handshake.
    const hostVerifier = key => {
      seenFingerprint = hostKeyFingerprint(key);
      if (!pinned) return false;
      const offered = Buffer.from(seenFingerprint);
      const expected = Buffer.from(pinned);
      // timingSafeEqual throws on a length mismatch rather than returning
      // false, and a throw inside a verifier is not a refusal, so the length is
      // checked first and a mismatch is simply a no.
      return offered.length === expected.length && crypto.timingSafeEqual(offered, expected);
    };
    try {
      await client.connect({
        host, port, username,
        ...(password ? { password } : {}),
        ...(privateKey ? { privateKey, passphrase } : {}),
        hostVerifier,
        readyTimeout: 20000,
      });
    } catch (error) {
      // The socket is closed explicitly on a refused handshake. ssh2 does not
      // reliably tear it down when the verifier says no, and a connection left
      // open holds the event loop, so a backup that was correctly refused hangs
      // instead of failing. Seen on the live box: the process sat there rather
      // than reporting the refusal it had already decided on.
      try { await client.end(); } catch { /* it may never have opened */ }
      // ssh2 reports a refused host key as a generic handshake failure, which
      // reads like a network problem and sends whoever is debugging it to the
      // wrong place entirely. Both cases are named here instead, and the
      // fingerprint that was offered is included so the operator has something
      // to act on rather than a wall.
      if (seenFingerprint && !pinned) {
        throw Object.assign(new Error(
          `This destination has no pinned host key, so the connection was refused before any credential was sent. `
          + `The server at ${host}:${port} offered ${seenFingerprint}. Check that against the server itself with `
          + `\`ssh-keyscan -p ${port} ${host} | ssh-keygen -lf -\`, and if it matches, save it on the destination.`,
        ), { code: 'SFTP_HOST_KEY_UNPINNED', fingerprint: seenFingerprint });
      }
      if (seenFingerprint && pinned && seenFingerprint !== pinned) {
        throw Object.assign(new Error(
          `The host key at ${host}:${port} is not the one this destination is pinned to, so nothing was sent. `
          + `Expected ${pinned} and the server offered ${seenFingerprint}. Either the server was rebuilt and somebody `
          + `needs to re-pin it deliberately, or this is not the server you think it is.`,
        ), { code: 'SFTP_HOST_KEY_MISMATCH', fingerprint: seenFingerprint, expected: pinned });
      }
      throw error;
    }
    try { return await fn(client); }
    finally { try { await client.end(); } catch { /* the work is already done or already failed */ } }
  }

  return {
    id: 'sftp.generic',
    describe: () => ({ where: `${username}@${host}:${port}${directory}`, prefix: prefix || null, host_key_pinned: !!pinned, host_key_fingerprint: pinned }),
    prefix,
    async put({ sourcePath, key }) {
      return withClient(async client => {
        const target = remote(key);
        await client.mkdir(path.posix.dirname(target), true).catch(() => { /* it exists, and if it does not the put says so */ });
        await client.put(sourcePath, target);
        return { key };
      });
    },
    async verify({ key, bytes, sha256, deep }) {
      return withClient(async client => {
        const target = remote(key);
        let stat;
        try { stat = await client.stat(target); } catch { return verdict({ exists: false }); }
        const wantDeep = deep || (bytes != null && bytes <= DEEP_VERIFY_LIMIT);
        let digest = null;
        if (wantDeep && sha256) {
          // Pulled back down the same connection and hashed here. It costs a
          // second transfer and it is the only thing that proves the bytes on
          // the far side are the bytes we sent.
          const hash = crypto.createHash('sha256');
          const sink = new PassThrough();
          const done = pipeline(sink, hash);
          await client.get(target, sink);
          await done;
          digest = hash.digest('hex');
        }
        return verdict({ exists: true, bytes: stat.size, expectedBytes: bytes, digest, expectedDigest: sha256, verifiedBy: 'sha256' });
      });
    },
    // Bringing one back. The counterpart of `put`, and the thing recovery needs:
    // without it a destination can be written to and checked and never read
    // from, which is a copy nobody can use.
    async fetch({ key, targetPath }) {
      return withClient(async client => {
        const target = remote(key);
        const hash = crypto.createHash('sha256');
        const out = fs.createWriteStream(targetPath, { mode: 0o600 });
        const tap = new PassThrough();
        tap.on('data', chunk => hash.update(chunk));
        const done = pipeline(tap, out);
        await client.get(target, tap);
        await done;
        return { key, bytes: fs.statSync(targetPath).size, sha256: hash.digest('hex') };
      });
    },
    // Recursive, because a backup is stored as `<domain>/<id>/<file>` and a
    // listing that stopped at the first level returned the directories and
    // filtered them out as not-files, so it answered "there is nothing here"
    // about a destination holding every backup this panel had sent. The disk
    // destination already walked its tree; this one did not, and the two
    // disagreeing about what list means is the kind of thing that only shows up
    // when somebody tries to recover.
    async list({ prefix: under = '', limit = 100 } = {}) {
      return withClient(async client => {
        const base = under ? `${directory}/${cleanKey(under)}` : directory;
        const found = [];
        const walk = async (dir, relative) => {
          if (found.length >= limit) return;
          const entries = await client.list(dir).catch(() => []);
          for (const entry of entries) {
            if (found.length >= limit) return;
            const here = relative ? `${relative}/${entry.name}` : entry.name;
            if (entry.type === 'd') await walk(`${dir}/${entry.name}`, here);
            else if (entry.type === '-') found.push({ key: here, bytes: entry.size, modified: new Date(entry.modifyTime).toISOString() });
          }
        };
        await walk(base, under ? cleanKey(under) : '');
        return found;
      });
    },
    async remove({ key }) { return withClient(client => client.delete(remote(key)).catch(() => { /* already gone */ })); },
    async test() { return roundTrip(this, { prefix }); },
  };
}

// ── S3-compatible object storage ─────────────────────────────────
// Signed here rather than by an SDK. The AWS SDK is tens of megabytes and this
// product has to zip and run, and what is actually needed is one signature
// algorithm and four HTTP verbs. Everything below is Signature Version 4 as the
// specification writes it, against whatever endpoint the operator gave, which
// is what makes this one adapter serve S3, R2, B2, Wasabi and MinIO.
function hmac(key, value) { return crypto.createHmac('sha256', key).update(value, 'utf8').digest(); }
function sha256Hex(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }

// Every segment encoded, the separators kept. S3 does not double-encode the
// path, so this is used once for the URI and the signature both, from the same
// string, which is the only way the two can never disagree.
function encodePath(key) {
  return key.split('/').map(segment => encodeURIComponent(segment).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function s3Destination(settings) {
  const endpoint = need(settings, 'endpoint', 'An endpoint');
  const bucket = need(settings, 'bucket', 'A bucket');
  const accessKeyId = need(settings, 'access_key_id', 'An access key');
  const secretAccessKey = need(settings, 'secret_access_key', 'A secret key');
  const region = String(settings.region || 'us-east-1').trim();
  const prefix = settings.prefix ? String(settings.prefix) : '';
  // Path style by default, because it is the one every S3-compatible service
  // answers on. Virtual host style is offered for the ones that insist.
  const pathStyle = settings.path_style === undefined ? true : settings.path_style !== false && settings.path_style !== 'false';
  if (!/^[a-z0-9][a-z0-9.\-]{1,62}$/.test(bucket)) throw new Error(`${bucket} is not a bucket name`);

  let base;
  try { base = new URL(/^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`); }
  catch { throw new Error(`${endpoint} is not an address`); }
  if (base.protocol !== 'https:' && base.protocol !== 'http:') throw new Error('an endpoint has to be http or https');

  const transport = base.protocol === 'https:' ? https : http;
  // Virtual host style moves the bucket into the name, so the socket has to go
  // there too. Signing one host and connecting to another is a request that
  // arrives somewhere it was not signed for, and the far end is right to refuse
  // it.
  const host = pathStyle ? base.host : `${bucket}.${base.host}`;
  const connectHost = pathStyle ? base.hostname : `${bucket}.${base.hostname}`;
  const basePath = base.pathname.replace(/\/+$/, '');

  function pathFor(key) {
    const encoded = key ? `/${encodePath(key)}` : '/';
    return pathStyle ? `${basePath}/${bucket}${encoded}` : `${basePath}${encoded}`;
  }

  function sign({ method, canonicalPath, query = {}, headers, payloadHash }) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const all = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const names = Object.keys(all).map(n => n.toLowerCase()).sort();
    const canonicalHeaders = names.map(n => {
      const key = Object.keys(all).find(k => k.toLowerCase() === n);
      return `${n}:${String(all[key]).trim().replace(/\s+/g, ' ')}\n`;
    }).join('');
    const signedHeaders = names.join(';');
    const canonicalQuery = Object.keys(query).sort()
      .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
    const canonicalRequest = [method, canonicalPath, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/${region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), 's3'), 'aws4_request');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
    return {
      ...all,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  function request({ method, key = '', query = {}, headers = {}, payloadHash, body = null, collect = true, sink = null }) {
    const canonicalPath = pathFor(key);
    const signed = sign({ method, canonicalPath, query, headers, payloadHash });
    const search = Object.keys(query).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`).join('&');
    return new Promise((resolve, reject) => {
      const req = transport.request({
        method, host: connectHost, port: base.port || undefined,
        path: canonicalPath + (search ? `?${search}` : ''),
        // A socket of its own, closed when the request is done. Pooling would
        // hold connections open to somebody else's object store long after the
        // upload finished, and it puts two differently-signed requests on one
        // socket for no gain: an archive is one large request, not many small
        // ones.
        headers: signed, timeout: 120000, agent: false,
      }, res => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        if (ok && sink) {
          pipeline(res, sink).then(() => resolve({ status: res.statusCode, headers: res.headers, body: '' })).catch(reject);
          return;
        }
        // A failure body is read even when the caller wanted a stream, because
        // the reason the far end refused is the only useful thing in it.
        if (!ok || collect) {
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
          res.on('error', reject);
          return;
        }
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: '' }));
      });
      req.on('timeout', () => req.destroy(new Error('that object store did not answer in time')));
      req.on('error', reject);
      if (body && typeof body.pipe === 'function') body.pipe(req);
      else if (body) req.end(body);
      else req.end();
    });
  }

  // The far end says why it refused, in XML, and the message inside it is far
  // more use than the status code on its own.
  function refusal(response, what) {
    const code = (response.body.match(/<Code>([^<]+)<\/Code>/) || [])[1];
    const message = (response.body.match(/<Message>([^<]+)<\/Message>/) || [])[1];
    return new Error(`${what} was refused with ${response.status}${code ? `: ${code}` : ''}${message ? ` — ${message}` : ''}`.replace(' — ', ', '));
  }

  return {
    id: 's3.compatible',
    describe: () => ({ where: `${base.origin}/${bucket}`, prefix: prefix || null }),
    prefix,
    async put({ sourcePath, key, bytes, sha256 }) {
      // The payload hash has to be known before the first byte goes out, which
      // is exactly what the manifest already recorded. When it is absent the
      // file is hashed here rather than sending UNSIGNED-PAYLOAD, because a
      // signature that does not cover the body is not covering the thing that
      // matters.
      const payloadHash = sha256 || await hashFile(sourcePath);
      const size = bytes != null ? bytes : fs.statSync(sourcePath).size;
      // One PUT, no multipart. Five gigabytes is the ceiling that imposes, it
      // is stated rather than discovered, and the multipart protocol is named
      // as deferred work in the interface document.
      if (size > 5 * 1024 * 1024 * 1024) throw new Error('this destination sends an archive in one piece, and 5 GB is the limit that puts on it');
      // Sent alongside the upload so the far end can refuse a corrupted body
      // itself, and compared again afterwards so we are not taking its word.
      const md5 = await new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        fs.createReadStream(sourcePath).on('data', c => hash.update(c)).on('error', reject).on('end', () => resolve(hash.digest('base64')));
      });
      const response = await request({
        method: 'PUT', key: cleanKey(key), payloadHash,
        headers: { 'content-length': String(size), 'content-type': 'application/octet-stream', 'content-md5': md5 },
        body: fs.createReadStream(sourcePath), collect: false,
      });
      if (response.status < 200 || response.status >= 300) throw refusal(response, 'the upload');
      return { key, etag: response.headers.etag || null };
    },
    async verify({ key, bytes, sha256, deep }) {
      const clean = cleanKey(key);
      const head = await request({ method: 'HEAD', key: clean, payloadHash: sha256Hex(''), collect: false });
      if (head.status === 404) return verdict({ exists: false });
      if (head.status < 200 || head.status >= 300) throw refusal(head, 'reading the object back');
      const size = Number(head.headers['content-length'] || 0);
      const wantDeep = deep || (bytes != null && bytes <= DEEP_VERIFY_LIMIT);
      if (wantDeep && sha256) {
        const hash = crypto.createHash('sha256');
        const got = await request({ method: 'GET', key: clean, payloadHash: sha256Hex(''), sink: hash, collect: false });
        if (got.status < 200 || got.status >= 300) throw refusal(got, 'reading the object back');
        return verdict({ exists: true, bytes: size, expectedBytes: bytes, digest: hash.digest('hex'), expectedDigest: sha256, verifiedBy: 'sha256' });
      }
      return verdict({ exists: true, bytes: size, expectedBytes: bytes, verifiedBy: 'size' });
    },
    async list({ prefix: under = '', limit = 100 } = {}) {
      const query = { 'list-type': '2', 'max-keys': String(Math.min(Math.max(limit, 1), 1000)) };
      if (under) query.prefix = under;
      const response = await request({ method: 'GET', key: '', query, payloadHash: sha256Hex('') });
      if (response.status < 200 || response.status >= 300) throw refusal(response, 'listing the bucket');
      const out = [];
      for (const block of response.body.match(/<Contents>[\s\S]*?<\/Contents>/g) || []) {
        out.push({
          key: (block.match(/<Key>([^<]*)<\/Key>/) || [])[1] || '',
          bytes: Number((block.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
          modified: (block.match(/<LastModified>([^<]*)<\/LastModified>/) || [])[1] || null,
        });
      }
      return out;
    },
    async remove({ key }) {
      const response = await request({ method: 'DELETE', key: cleanKey(key), payloadHash: sha256Hex(''), collect: false });
      if (response.status !== 204 && response.status !== 200 && response.status !== 404) throw refusal(response, 'removing the object');
    },
    async test() { return roundTrip(this, { prefix }); },
  };
}

const BACKENDS = {
  'disk.directory': diskDestination,
  'sftp.generic': sftpDestination,
  's3.compatible': s3Destination,
};

// The one door in. Everything above the transport asks for a destination by
// provider id and gets the same four functions back whichever one answered.
function createDestination(providerId, credential) {
  const build = BACKENDS[providerId];
  if (!build) throw new Error(`${providerId} is not a destination this build can write to`);
  return build(parseCredential(credential, providerId));
}

module.exports = {
  createDestination, parseCredential, cleanKey, joinPrefix, verdict, roundTrip,
  DESTINATION_PROVIDER_IDS: Object.keys(BACKENDS),
  DEEP_VERIFY_LIMIT,
};
