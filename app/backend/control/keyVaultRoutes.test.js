'use strict';

// The key vault routes, driven over real HTTP against a real vault, and then
// each defence switched off in a copy to prove a test fails without it.

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const { scrubSecrets } = require('./egressGuard');

const ROOT = __dirname;
const KEY = 'sk-proj-VaultRouteSecret0123456789abcdef'; // gitleaks:allow (a fake key the test needs)
const KEY2 = 'sk-proj-VaultRouteSecondKey9876543210zyx'; // gitleaks:allow (a fake key the test needs)

async function scenarios(dir, { max = 4 } = {}) {
  const { mountKeyVaultRoutes } = require(path.join(dir, 'keyVaultRoutes.js'));
  const { createProviderKeyService } = require(path.join(dir, 'providerKeys.js'));
  const db = new Database(':memory:');
  let keys = createProviderKeyService({ db, secret: 'test-vault-secret' });
  const audits = [];
  let byok = true;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.t = s => s; next(); });
  const auth = (req, res, next) => {
    const who = req.headers['x-user'];
    if (!who) return res.status(401).json({ error: 'No token' });
    req.user = { id: who };
    next();
  };
  mountKeyVaultRoutes(app, {
    auth, providerKeys: new Proxy({}, { get: (_t, p) => keys[p] }),
    audit: (userId, action, _req, details) => audits.push({ userId, action, details }),
    scrubSecrets,
    keyableProvider: id => (['openai', 'anthropic'].includes(id) ? id : null),
    hostAllowsByok: () => byok,
    identityKey: req => `ip:${req.ip}`,
    max,
  });
  // A broken copy that throws answers 500 quietly; the checks, not a stack trace, decide.
  app.use((_err, _req, res, _next) => res.status(500).json({ error: 'failed' }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, user, body) => {
    const r = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json', ...(user ? { 'x-user': user } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, text: await r.text() };
  };
  const auditText = () => JSON.stringify(audits);
  const ciphertexts = () => db.prepare('SELECT secret_enc, revoked_at FROM provider_keys').all();

  try {
    // Signing in is required for every route.
    assert.equal((await call('GET', '/api/ai/keys')).status, 401, 'list needs a session');
    assert.equal((await call('PUT', '/api/ai/keys/openai', null, { key: KEY })).status, 401, 'save needs a session');
    assert.equal((await call('DELETE', '/api/ai/keys/openai')).status, 401, 'remove needs a session');

    // Save: answers with a fingerprint, never the key; the audit line names no key.
    const saved = await call('PUT', '/api/ai/keys/openai', 'alice', { key: KEY, label: 'work' });
    assert.equal(saved.status, 200);
    assert.ok(!saved.text.includes(KEY) && !saved.text.includes(KEY.slice(-6)), 'save answer carries no key');
    assert.ok(JSON.parse(saved.text).fingerprint, 'save answers with a fingerprint');
    const listed = await call('GET', '/api/ai/keys', 'alice');
    assert.ok(!listed.text.includes(KEY) && !listed.text.includes('secret_enc'), 'list carries no key or ciphertext');
    assert.equal(JSON.parse(listed.text).keys.length, 1);
    assert.equal(JSON.parse((await call('GET', '/api/ai/keys', 'bob')).text).keys.length, 0, 'another person sees nothing');
    assert.ok(audits.some(a => a.action === 'provider_key_saved' && a.userId === 'alice'), 'a save is audited');

    // Another person cannot remove it.
    await call('DELETE', '/api/ai/keys/openai', 'bob');
    assert.equal(JSON.parse((await call('GET', '/api/ai/keys', 'alice')).text).keys.length, 1, 'bob cannot remove alice’s key');

    // Replacing a key blanks the old ciphertext.
    assert.equal((await call('PUT', '/api/ai/keys/openai', 'alice', { key: KEY2, label: 'work' })).status, 200);
    const afterRotate = ciphertexts();
    assert.equal(afterRotate.filter(r => r.revoked_at).length, 1);
    assert.equal(afterRotate.find(r => r.revoked_at).secret_enc, '', 'a replaced key keeps no ciphertext');
    assert.ok(afterRotate.find(r => !r.revoked_at).secret_enc.length > 0, 'the live key is still sealed');

    // Removing a key blanks it and is audited.
    const removed = await call('DELETE', '/api/ai/keys/openai?label=work', 'alice');
    assert.equal(JSON.parse(removed.text).removed, true);
    assert.ok(ciphertexts().every(r => r.secret_enc === ''), 'a removed key keeps no ciphertext');
    assert.ok(audits.some(a => a.action === 'provider_key_removed' && a.userId === 'alice'), 'a removal is audited');

    // Refusals are audited, and a key typed into the address never reaches the audit.
    const before = audits.length;
    assert.equal((await call('PUT', `/api/ai/keys/${KEY}`, 'carol', { key: KEY })).status, 400);
    assert.equal((await call('PUT', '/api/ai/keys/openai', 'carol', { key: 'short' })).status, 400);
    byok = false;
    assert.equal((await call('PUT', '/api/ai/keys/openai', 'carol', { key: KEY })).status, 403, 'a host that forbids own keys is obeyed');
    byok = true;
    const refusals = audits.slice(before).filter(a => a.action === 'provider_key_refused' && a.userId === 'carol');
    assert.equal(refusals.length, 3, 'each refusal is audited');
    assert.ok(!auditText().includes(KEY) && !auditText().includes(KEY2), 'no audit line carries a key');
    assert.equal(JSON.parse((await call('GET', '/api/ai/keys', 'carol')).text).keys.length, 0, 'refused saves stored nothing');

    // Rate limit: failures count, removals count, each person has their own budget.
    // carol has used 3 of her writes on refusals; one more is allowed, then refused.
    assert.equal((await call('DELETE', '/api/ai/keys/openai', 'carol')).status, 200, 'the last write in budget');
    const limited = await call('PUT', '/api/ai/keys/openai', 'carol', { key: KEY });
    assert.equal(limited.status, 429, 'writes past the budget are refused, failures included');
    assert.equal((await call('DELETE', '/api/ai/keys/openai', 'carol')).status, 429, 'removal shares the budget');
    assert.equal(JSON.parse((await call('GET', '/api/ai/keys', 'carol')).text).keys.length, 0, 'the refused save stored nothing');
    assert.ok(audits.some(a => a.action === 'provider_key_refused' && a.userId === 'carol' && /rate limited/.test(a.details)), 'a rate-limit refusal is audited');
    assert.equal((await call('PUT', '/api/ai/keys/openai', 'dave', { key: KEY })).status, 200, 'another person keeps their own budget');

    // Ciphertext a previous version left on revoked rows is wiped at start.
    db.prepare("UPDATE provider_keys SET secret_enc='left-over' WHERE revoked_at IS NOT NULL").run();
    keys = createProviderKeyService({ db, secret: 'test-vault-secret' });
    assert.ok(db.prepare('SELECT secret_enc FROM provider_keys WHERE revoked_at IS NOT NULL').all().every(r => r.secret_enc === ''), 'leftover ciphertext is wiped at start');
  } finally {
    server.close();
  }
}

async function expectMutantCaught(name, run) {
  try { await run(); } catch (error) {
    if (error instanceof assert.AssertionError) { console.log(`  ok  CAUGHT       ${name}`); return; }
    throw new Error(`${name}: the mutant crashed instead of failing a check (${error.message})`);
  }
  throw new Error(`${name}: the defence was removed and every check still passed`);
}

(async () => {
  await scenarios(ROOT);

  // Inside control/ so the copies resolve the same node_modules.
  const dir = fs.mkdtempSync(path.join(ROOT, '.keyvault-mutants-'));
  const source = name => fs.readFileSync(path.join(ROOT, name), 'utf8');
  try {
    const mutants = [
      ['save needs a session', 'keyVaultRoutes.js', "app.put('/api/ai/keys/:provider', auth, ", "app.put('/api/ai/keys/:provider', "],
      ['list is the caller’s own', 'keyVaultRoutes.js', 'providerKeys.list(ownKeyScope(req))', "providerKeys.list({ kind: 'identity', id: 'alice' })"],
      ['save is rate limited', 'keyVaultRoutes.js', "app.put('/api/ai/keys/:provider', auth, writeLimiter, ", "app.put('/api/ai/keys/:provider', auth, "],
      ['removal is rate limited', 'keyVaultRoutes.js', "app.delete('/api/ai/keys/:provider', auth, writeLimiter, ", "app.delete('/api/ai/keys/:provider', auth, "],
      ['failures count against the budget', 'keyVaultRoutes.js', 'windowMs, max,', 'windowMs, max, skipFailedRequests: true,'],
      ['budget is per person', 'keyVaultRoutes.js', "keyGenerator: req => `vault:${req.user ? `user:${req.user.id}` : identityKey(req)}`,", "keyGenerator: () => 'vault',"],
      ['rate-limit refusal is audited', 'keyVaultRoutes.js', "audit(req.user && req.user.id, 'provider_key_refused', req, `rate limited: ${req.method}`);", ''],
      ['refusals are audited', 'keyVaultRoutes.js', "const refuse = (req, res, status, why, message) => {\n    audit(", "const refuse = (req, res, status, why, message) => {\n    (() => {})("],
      ['refusal audit is scrubbed', 'keyVaultRoutes.js', "req, scrubSecrets(`${String(req.params.provider)", "req, (`${String(req.params.provider)"],
      ['host can forbid own keys', 'keyVaultRoutes.js', 'if (!hostAllowsByok()) return', 'if (false) return'],
      ['save answer has no key', 'keyVaultRoutes.js', 'fingerprint: saved.fingerprint, rotated: saved.rotated });', 'fingerprint: saved.fingerprint, rotated: saved.rotated, key });'],
      ['replaced key is blanked', 'providerKeys.js', "revoked_by=?, secret_enc='' WHERE id=?", 'revoked_by=? WHERE id=?'],
      ['removed key is blanked', 'providerKeys.js', "SET revoked_at=?, revoked_by=?, secret_enc=''\n          WHERE scope_kind=? AND scope_id=? AND provider_id=? AND label=?", 'SET revoked_at=?, revoked_by=?\n          WHERE scope_kind=? AND scope_id=? AND provider_id=? AND label=?'],
      ['leftover ciphertext wiped at start', 'providerKeys.js', "db.prepare(\"UPDATE provider_keys SET secret_enc='' WHERE revoked_at IS NOT NULL AND secret_enc != ''\").run();", ''],
    ];
    for (const [i, [name, file, find, replace]] of mutants.entries()) {
      const text = source(file);
      assert.ok(text.includes(find), `${name}: mutation target exists`);
      const sub = path.join(dir, `m${i}`);
      fs.mkdirSync(sub);
      for (const f of ['keyVaultRoutes.js', 'providerKeys.js']) fs.writeFileSync(path.join(sub, f), f === file ? text.replace(find, () => replace) : source(f));
      await expectMutantCaught(name, () => scenarios(sub));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  console.log('key vault route tests passed (session, own scope, per-person write budget, audited refusals, blanked revocations; 14 defences caught when removed)');
})().catch(error => { console.error(error); process.exit(1); });
