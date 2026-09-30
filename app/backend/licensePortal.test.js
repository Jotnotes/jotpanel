'use strict';

// The customer portal, broken by trying to be somebody else.
//
// The portal exists because a token shown once on a redirect page is not a
// delivery mechanism. Everything here is an attempt to reach seats that
// belong to another address, or to get in without proving you can read the
// address that paid.

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arca-portal-')), 'licenses.db');
process.env.LICENSE_DB = DB;
process.env.LICENSE_ADMIN_KEY = 'test-admin-key-for-portal';
process.env.LICENSE_BASE_URL = 'https://license.test';
delete process.env.BREVO_API_KEY; // no mail in tests; sendEmail refuses and says so

const { app, db } = require('./license-server');

let base = '';
const hash = v => crypto.createHash('sha256').update(String(v)).digest('hex');

async function call(method, route, { form, cookie } = {}) {
  const headers = {};
  if (form) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${base}${route}`, {
    method, headers, redirect: 'manual',
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  return { status: res.status, location: res.headers.get('location') || '', text: await res.text() };
}

// A signed-in browser, without going through the email we cannot read in a test.
function signIn(email) {
  const raw = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO portal_sessions (token_hash,email,expires_at) VALUES (?,?,?)')
    .run(hash(raw), email, new Date(Date.now() + 3600e3).toISOString());
  return `jp_portal=${encodeURIComponent(raw)}`;
}

function makeAllocation(email, seats, name = null) {
  const id = `alloc_${crypto.randomBytes(8).toString('hex')}`;
  db.prepare('INSERT INTO allocations (id,parent_id,holder_email,holder_name,seats,token_hash,token_prefix) VALUES (?,NULL,?,?,?,?,?)')
    .run(id, email, name, seats, hash(crypto.randomBytes(8).toString('hex')), crypto.randomBytes(4).toString('hex'));
  return id;
}

async function run() {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    const mine = makeAllocation('owner@example.com', 10, 'Owner Hosting');
    const theirs = makeAllocation('stranger@example.com', 10, 'Stranger Hosting');

    // ── Signing in must not say who is a customer ──
    {
      const known = await call('POST', '/portal/signin', { form: { email: 'owner@example.com' } });
      const unknown = await call('POST', '/portal/signin', { form: { email: 'nobody@example.com' } });
      assert.equal(known.status, unknown.status, 'a customer and a stranger get the same status');
      assert.equal(known.location, unknown.location, 'a customer and a stranger get the same page');
      const links = db.prepare('SELECT email FROM portal_links').all();
      assert.deepEqual(links.map(l => l.email), ['owner@example.com'], 'only the real customer got a link made');
    }
    console.log('ok  sign-in answers identically for a customer and a stranger, and only mints a link for the customer');

    // ── A link that is not ours, or is spent, or has expired ──
    {
      const forged = await call('GET', '/portal/enter?token=not-a-real-token');
      assert.equal(forged.status, 401, 'a made-up sign-in token is refused');

      const raw = crypto.randomBytes(16).toString('base64url');
      db.prepare('INSERT INTO portal_links (token_hash,email,expires_at,used_at) VALUES (?,?,?,?)')
        .run(hash(raw), 'owner@example.com', new Date(Date.now() + 3600e3).toISOString(), new Date().toISOString());
      const spent = await call('GET', `/portal/enter?token=${raw}`);
      assert.equal(spent.status, 401, 'a link that has already been used is refused');

      const old = crypto.randomBytes(16).toString('base64url');
      db.prepare('INSERT INTO portal_links (token_hash,email,expires_at) VALUES (?,?,?)')
        .run(hash(old), 'owner@example.com', new Date(Date.now() - 1000).toISOString());
      const expired = await call('GET', `/portal/enter?token=${old}`);
      assert.equal(expired.status, 401, 'an expired link is refused');
    }
    console.log('ok  forged, spent and expired sign-in links are all refused');

    // ── A real link signs you in exactly once ──
    {
      const raw = crypto.randomBytes(16).toString('base64url');
      db.prepare('INSERT INTO portal_links (token_hash,email,expires_at) VALUES (?,?,?)')
        .run(hash(raw), 'owner@example.com', new Date(Date.now() + 3600e3).toISOString());
      const first = await call('GET', `/portal/enter?token=${raw}`);
      assert.equal(first.status, 302);
      assert.equal(first.location, '/portal/home');
      const again = await call('GET', `/portal/enter?token=${raw}`);
      assert.equal(again.status, 401, 'the same link cannot be used twice');
    }
    console.log('ok  a real link signs in once and is dead afterwards');

    // ── Signed out, the portal shows nothing ──
    {
      const home = await call('GET', '/portal/home');
      assert.equal(home.location, '/portal', 'no session means no portal');
      const issue = await call('POST', '/portal/issue', { form: { allocation_id: mine, email: 'x@y.com' } });
      assert.equal(issue.location, '/portal', 'an unauthenticated write is bounced to sign-in');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses').get().n, 0, 'and issued nothing');
    }
    console.log('ok  an unauthenticated visitor can neither see nor issue anything');

    // ── THE hole: signed in as myself, acting on somebody else's allocation ──
    {
      const cookie = signIn('owner@example.com');
      const stolen = await call('POST', '/portal/issue', { form: { allocation_id: theirs, email: 'victim@example.com' }, cookie });
      assert.match(decodeURIComponent(stolen.location), /not yours/, 'issuing from a stranger allocation is refused');

      const split = await call('POST', '/portal/split', { form: { allocation_id: theirs, email: 'me@example.com', seats: '5' }, cookie });
      assert.match(decodeURIComponent(split.location), /not yours/, 'splitting a stranger allocation is refused');

      const regen = await call('POST', '/portal/regenerate', { form: { allocation_id: theirs }, cookie });
      assert.match(decodeURIComponent(regen.location), /not yours/, 'replacing a stranger token is refused');

      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses WHERE allocation_id=?').get(theirs).n, 0, 'nothing was issued from it');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE parent_id=?').get(theirs).n, 0, 'nothing was carved off it');
    }
    console.log('ok  a signed-in customer cannot issue, split or re-key an allocation belonging to another address');

    // ── My own allocation works, and the arithmetic still holds ──
    {
      const cookie = signIn('owner@example.com');
      const issued = await call('POST', '/portal/issue', { form: { allocation_id: mine, email: 'customer@example.com' }, cookie });
      assert.match(decodeURIComponent(issued.location), /Key issued to customer@example.com: ARCA-/, 'a key comes back to the holder');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM licenses WHERE allocation_id=?').get(mine).n, 1);

      const tooMany = await call('POST', '/portal/split', { form: { allocation_id: mine, email: 'reseller@example.com', seats: '50' }, cookie });
      assert.match(decodeURIComponent(tooMany.location), /would hand out 50 servers and you have 9 left/, 'the seat arithmetic is enforced in the portal too');

      const ok = await call('POST', '/portal/split', { form: { allocation_id: mine, email: 'reseller@example.com', seats: '4' }, cookie });
      assert.match(decodeURIComponent(ok.location), /4 servers handed to reseller@example.com/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE parent_id=?').get(mine).n, 1);
    }
    console.log('ok  the holder can issue and split, and cannot hand out seats that do not exist');

    // ── Replacing the token kills the old one ──
    {
      const cookie = signIn('owner@example.com');
      const before = db.prepare('SELECT token_hash FROM allocations WHERE id=?').get(mine).token_hash;
      const res = await call('POST', '/portal/regenerate', { form: { allocation_id: mine }, cookie });
      const after = db.prepare('SELECT token_hash FROM allocations WHERE id=?').get(mine).token_hash;
      assert.notEqual(before, after, 'the stored credential actually changed');
      assert.match(res.location, /^\/portal\/home\?token=arcalloc_/, 'the new token is shown once on the way back');
    }
    console.log('ok  replacing the allocation token changes the stored credential and shows the new one once');

    // ── Signing out ends it ──
    {
      const cookie = signIn('owner@example.com');
      await call('POST', '/portal/signout', { cookie });
      const after = await call('GET', '/portal/home', { cookie });
      assert.equal(after.location, '/portal', 'the session is gone, not just the cookie');
    }
    console.log('ok  signing out destroys the session server-side');

    console.log('licence portal tests passed');
  } finally {
    server.close();
  }
}

run().catch(err => { console.error(err); process.exit(1); });
