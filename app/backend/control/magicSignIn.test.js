'use strict';

// A sign-in link must not walk past a second factor, a suspension or a reuse.

const assert = require('assert');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const jwt = require('jsonwebtoken');
const { createMagicSignIn } = require('./magicSignIn');

const db = new Database(':memory:');
db.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, plan TEXT, suspended INTEGER DEFAULT 0);
         CREATE TABLE magic_tokens (token TEXT, email TEXT, used INTEGER DEFAULT 0, expires_at TEXT);`);
const magicHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');
const SECRET = 'test-secret';
const withTotp = new Set(['u_2fa']);
const audits = [];
const handler = createMagicSignIn({ db, magicHash, jwt, JWT_SECRET: SECRET,
  twoFactor: { isEnabled: id => withTotp.has(id) }, audit: (id, action) => audits.push(action) });

const call = token => new Promise(resolve => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(body) { resolve({ status: this.code, body }); } };
  handler({ query: { token }, t: s => s }, res);
});
const link = (email, opts = {}) => {
  const t = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO magic_tokens (token,email,used,expires_at) VALUES (?,?,?,?)')
    .run(magicHash(t), email, opts.used ? 1 : 0, opts.expired ? '2000-01-01T00:00:00Z' : '2999-01-01T00:00:00Z');
  return t;
};
db.prepare("INSERT INTO users (id,name,email) VALUES ('u_plain','p','plain@example.com'),('u_2fa','t','totp@example.com')").run();
db.prepare("INSERT INTO users (id,name,email,suspended) VALUES ('u_off','s','off@example.com',1)").run();

(async () => {
  let r = await call(link('plain@example.com'));
  assert.strictEqual(r.status, 200); assert.ok(r.body.token, 'no second factor: a session');

  const t2 = link('totp@example.com');
  r = await call(t2);
  assert.strictEqual(r.status, 200);
  assert.ok(!r.body.token, 'second factor on: the link must not return a session');
  assert.strictEqual(r.body.two_factor_required, true);
  assert.strictEqual(jwt.verify(r.body.challenge, SECRET).purpose, 'two_factor');
  assert.ok(audits.includes('magic_verified_awaiting_code'));

  r = await call(t2);
  assert.strictEqual(r.status, 401, 'a spent link is refused');

  r = await call(link('off@example.com'));
  assert.strictEqual(r.status, 403, 'a suspended account gets nothing');

  r = await call(link('plain@example.com', { expired: true }));
  assert.strictEqual(r.status, 401, 'an expired link is refused');

  console.log('magicSignIn: 5 checks passed');
})().catch(e => { console.error(e); process.exit(1); });
