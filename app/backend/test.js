#!/usr/bin/env node
/**
 * Arca Backend Test Suite
 * Tests every endpoint end-to-end against a running server.
 *
 * Usage:
 *   node test.js                    # test against localhost:3000
 *   node test.js http://myserver:3000
 *
 * Requires server to be running:
 *   cd /path/to/arca && node server.js
 */

'use strict';

const BASE        = process.argv[2] || 'http://localhost:3000';
const ADMIN_KEY   = process.env.ADMIN_KEY || 'dev_admin_key_change_this_abc123';
const TEST_EMAIL  = `test_${Date.now()}@arcatest.local`;
const TEST_PASS   = 'TestPassword123!';
const TEST_EMAIL2 = `test2_${Date.now()}@arcatest.local`;

// ── Helpers ───────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;
let token = '', userId = '', fileId = '', journalId = '', benId = '';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREY   = '\x1b[90m';
const RESET  = '\x1b[0m';
const BOLD   = '\x1b[1m';

function log(icon, label, detail = '') {
  const colour = icon === '✓' ? GREEN : icon === '✗' ? RED : YELLOW;
  console.log(`  ${colour}${icon}${RESET}  ${label}${detail ? `  ${GREY}${detail}${RESET}` : ''}`);
}

async function req(method, path, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  let data;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

async function test(label, fn, skipIf = false) {
  if (skipIf) { log('⊘', label, 'skipped'); skipped++; return; }
  try {
    await fn();
    log('✓', label);
    passed++;
  } catch (e) {
    log('✗', label, e.message);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'Assertion failed');
}

function section(name) {
  console.log(`\n${BOLD}  ${name}${RESET}`);
  console.log(`  ${'─'.repeat(44)}`);
}

// ── Tests ─────────────────────────────────────────────────────────
async function run() {
  console.log(`\n${BOLD}  Arca Backend Test Suite${RESET}`);
  console.log(`  ${GREY}Testing: ${BASE}${RESET}`);
  console.log(`  ${GREY}Started: ${new Date().toISOString()}${RESET}`);

  // ── Health ───────────────────────────────────────────────────────
  section('Health');

  await test('GET /health responds 200', async () => {
    const { status, data } = await req('GET', '/health');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  // ── Auth — Register ───────────────────────────────────────────────
  section('Auth — Register');

  await test('POST /api/register — missing fields returns 400', async () => {
    const { status } = await req('POST', '/api/register', {});
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('POST /api/register — short password returns 400', async () => {
    const { status } = await req('POST', '/api/register', { name: 'Test', email: TEST_EMAIL, password: 'abc' });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('POST /api/register — creates account returns 200 + token', async () => {
    const { status, data } = await req('POST', '/api/register', {
      name: 'Test User', email: TEST_EMAIL, password: TEST_PASS
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert(data.token, 'No token returned');
    assert(data.user?.email === TEST_EMAIL, 'Email mismatch');
    token  = data.token;
    userId = data.user.id;
  });

  await test('POST /api/register — duplicate email returns 409', async () => {
    const { status } = await req('POST', '/api/register', {
      name: 'Dup', email: TEST_EMAIL, password: TEST_PASS
    });
    assert(status === 409, `Expected 409, got ${status}`);
  });

  // ── Auth — Login ─────────────────────────────────────────────────
  section('Auth — Login');

  await test('POST /api/login — wrong password returns 401', async () => {
    const { status } = await req('POST', '/api/login', { email: TEST_EMAIL, password: 'wrongpassword' });
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test('POST /api/login — correct credentials returns token', async () => {
    const { status, data } = await req('POST', '/api/login', { email: TEST_EMAIL, password: TEST_PASS });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.token, 'No token returned');
    token = data.token; // refresh token
  });

  await test('GET /api/me — returns user profile', async () => {
    const { status, data } = await req('GET', '/api/me');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.email === TEST_EMAIL, 'Email mismatch');
  });

  await test('GET /api/me — no token returns 401', async () => {
    const savedToken = token;
    token = '';
    const { status } = await req('GET', '/api/me');
    token = savedToken;
    assert(status === 401, `Expected 401, got ${status}`);
  });

  // ── Magic Link ────────────────────────────────────────────────────
  section('Magic Link Auth');

  let magicDevLink = '';

  await test('POST /api/auth/magic — sends link (dev logs to console)', async () => {
    const { status, data } = await req('POST', '/api/auth/magic', { email: TEST_EMAIL2 });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert(data.ok === true, 'Expected ok:true');
    if (data.devLink) {
      magicDevLink = data.devLink;
      log(' ', `Dev link: ${GREY}${data.devLink.slice(0, 80)}…${RESET}`);
    }
  });

  await test('POST /api/auth/magic — invalid email returns 400', async () => {
    const { status } = await req('POST', '/api/auth/magic', { email: 'notanemail' });
    assert(status === 400, `Expected 400, got ${status}`);
  });

  await test('GET /api/auth/magic — invalid token returns 401', async () => {
    const { status } = await req('GET', '/api/auth/magic?token=badtoken123');
    assert(status === 401, `Expected 401, got ${status}`);
  });

  await test('GET /api/auth/magic — valid token returns JWT', async () => {
    if (!magicDevLink) throw new Error('No devLink available (NODE_ENV not development?)');
    const tokenParam = new URL(magicDevLink).searchParams.get('magic');
    const { status, data } = await req('GET', `/api/auth/magic?token=${tokenParam}`);
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert(data.token, 'No JWT returned');
    assert(data.user, 'No user returned');
  }, !magicDevLink && process.env.NODE_ENV === 'production');

  // ── Settings ──────────────────────────────────────────────────────
  section('Settings');

  await test('GET /api/settings — returns object', async () => {
    const { status, data } = await req('GET', '/api/settings');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(typeof data === 'object', 'Expected object');
  });

  await test('PUT /api/settings — saves and returns ok', async () => {
    const { status, data } = await req('PUT', '/api/settings', { theme: 'dark', name: 'Test User' });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  await test('GET /api/settings — reads back saved value', async () => {
    const { status, data } = await req('GET', '/api/settings');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.theme === 'dark', `Expected theme:dark, got ${data.theme}`);
  });

  // ── Files ─────────────────────────────────────────────────────────
  section('Files');

  await test('GET /api/files — returns empty array', async () => {
    const { status, data } = await req('GET', '/api/files');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), 'Expected array');
  });

  await test('POST /api/files — uploads a text file', async () => {
    // Use FormData for file upload
    const formData = new FormData();
    formData.append('files', new Blob(['Hello Arca'], { type: 'text/plain' }), 'test.txt');
    const res  = await fetch(`${BASE}/api/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    assert(res.status === 200, `Expected 200, got ${res.status}: ${JSON.stringify(data)}`);
    assert(Array.isArray(data) && data.length > 0, 'Expected array with items');
    fileId = data[0].id;
  });

  await test('GET /api/files — returns uploaded file', async () => {
    const { status, data } = await req('GET', '/api/files');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.some(f => f.id === fileId), 'Uploaded file not found');
  });

  await test('PATCH /api/files/:id — renames file', async () => {
    const { status, data } = await req('PATCH', `/api/files/${fileId}`, { name: 'renamed.txt' });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  await test('DELETE /api/files/:id — deletes file', async () => {
    const { status, data } = await req('DELETE', `/api/files/${fileId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  await test('DELETE /api/files/:id — 404 after delete', async () => {
    const { status } = await req('DELETE', `/api/files/${fileId}`);
    assert(status === 404, `Expected 404, got ${status}`);
  });

  // ── Journal ───────────────────────────────────────────────────────
  section('Journal');

  await test('GET /api/journal — returns array', async () => {
    const { status, data } = await req('GET', '/api/journal');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(Array.isArray(data), 'Expected array');
  });

  await test('POST /api/journal — creates entry', async () => {
    const { status, data } = await req('POST', '/api/journal', {
      title: 'Test Entry', body: 'Hello journal'
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert(data.id, 'No id returned');
    journalId = data.id;
  });

  await test('PUT /api/journal/:id — updates entry', async () => {
    const { status, data } = await req('PUT', `/api/journal/${journalId}`, {
      title: 'Updated Entry', body: 'Updated body'
    });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  await test('DELETE /api/journal/:id — deletes entry', async () => {
    const { status, data } = await req('DELETE', `/api/journal/${journalId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  // ── Legacy / Dead Man's Switch ────────────────────────────────────
  section('Legacy');

  await test('GET /api/legacy — returns switch + beneficiaries', async () => {
    const { status, data } = await req('GET', '/api/legacy');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.switch, 'No switch data');
    assert(Array.isArray(data.beneficiaries), 'No beneficiaries array');
  });

  await test('POST /api/legacy/checkin — records check-in', async () => {
    const { status, data } = await req('POST', '/api/legacy/checkin');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
    assert(data.checkedIn, 'No checkedIn timestamp');
  });

  await test('PUT /api/legacy/switch — updates frequency', async () => {
    const { status, data } = await req('PUT', '/api/legacy/switch', { freq: 30, grace: 7 });
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  await test('POST /api/legacy/beneficiaries — adds beneficiary', async () => {
    const { status, data } = await req('POST', '/api/legacy/beneficiaries', {
      name: 'Jane Test', email: 'jane@test.com', relation: 'Partner', access: 'full'
    });
    assert(status === 200, `Expected 200, got ${status}: ${JSON.stringify(data)}`);
    assert(data.id, 'No id returned');
    benId = data.id;
  });

  await test('DELETE /api/legacy/beneficiaries/:id — removes beneficiary', async () => {
    const { status, data } = await req('DELETE', `/api/legacy/beneficiaries/${benId}`);
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.ok === true, 'Expected ok:true');
  });

  // ── GDPR Export ────────────────────────────────────────────────────
  section('GDPR Export');

  await test('GET /api/export — returns complete user data', async () => {
    const { status, data } = await req('GET', '/api/export');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data.user, 'No user data');
    assert(data.user.email === TEST_EMAIL, 'Email mismatch');
    assert(Array.isArray(data.files), 'No files array');
    assert(Array.isArray(data.journal), 'No journal array');
    assert(Array.isArray(data.beneficiaries), 'No beneficiaries array');
  });

  // ── The bootstrap surface is not on this listener ────────────────
  //
  // These used to be the other way round: the same tests proved that the shared
  // key listed every account, suspended one, restored it, minted a session as
  // it and deleted it, over whatever address this file was pointed at. Seven of
  // those routes are gone and the four that remain are on a loopback listener
  // of their own, so what is worth proving here is that this listener does not
  // answer for any of it, key or no key.
  section('Bootstrap surface is not reachable here');

  const bootstrapGone = [
    ['POST', `/admin/api/accounts/${userId}/sso`, 'mint a session as any account'],
    ['PUT', `/admin/api/accounts/${userId}/password`, 'overwrite any account password'],
    ['DELETE', `/admin/api/accounts/${userId}`, 'delete an account'],
    ['POST', `/admin/api/accounts/${userId}/suspend`, 'suspend an account'],
    ['POST', `/admin/api/accounts/${userId}/unsuspend`, 'restore an account'],
    ['POST', '/admin/api/accounts', 'create an account'],
    ['POST', `/admin/api/accounts/${userId}/login-link`, 'mint a sign-in link'],
    ['POST', `/admin/api/accounts/${userId}/2fa/reset`, 'clear a second factor'],
    ['GET', '/admin/api/usage', 'read the usage feed'],
  ];

  for (const [method, route, what] of bootstrapGone) {
    await test(`${method} ${route} — the admin key cannot ${what} here`, async () => {
      const savedToken = token;
      token = '';
      const { status } = await req(method, route, method === 'GET' ? null : {}, { 'x-admin-key': ADMIN_KEY });
      token = savedToken;
      // 404 because the router is not mounted on this app at all. A 200 or a
      // 403 would both be news: the first is the bypass, the second means it is
      // mounted here and only the gate is stopping it.
      assert(status === 404, `Expected 404, got ${status}`);
    });
  }

  // The two readings that share the prefix are identity-gated and stay, so the
  // proof is that they refuse a key rather than that they are absent.
  for (const route of ['/admin/api/accounts', '/admin/api/audit?limit=1']) {
    await test(`GET ${route} — refuses the admin key, wants an identity`, async () => {
      const savedToken = token;
      token = '';
      const { status } = await req('GET', route, null, { 'x-admin-key': ADMIN_KEY });
      token = savedToken;
      assert(status === 401 || status === 403, `Expected 401 or 403, got ${status}`);
    });
  }

  await test('PATCH /api/platform/config — the admin key is no longer accepted', async () => {
    const savedToken = token;
    token = '';
    const { status } = await req('PATCH', '/api/platform/config', { label: 'should not apply' }, { 'x-admin-key': ADMIN_KEY });
    token = savedToken;
    assert(status === 403, `Expected 403, got ${status}`);
  });

  await test('PATCH /api/routing — the admin key alone is no longer accepted', async () => {
    const savedToken = token;
    token = '';
    const { status } = await req('PATCH', '/api/routing', { chat: [['ollama', 'llama3.2']] }, { 'x-admin-key': ADMIN_KEY });
    token = savedToken;
    // Refused unless it came from the machine itself. Run against localhost
    // this is allowed, which is the rule working rather than a failure.
    const local = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(BASE);
    assert(local ? status === 200 : status === 403, `Expected ${local ? 200 : 403}, got ${status}`);
  });

  // The account this run made is left on the box. Deleting it used to be the
  // last test, through a route that removed the row and the uploads directory
  // and left the sites, mail, databases and backups behind, which is why it is
  // gone rather than moved. Closing an account properly is its own item; until
  // it lands, a run against a real box leaves `TEST_EMAIL` behind on purpose
  // rather than half-deleting it.

  // ── Summary ───────────────────────────────────────────────────────
  const total = passed + failed + skipped;
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  ${GREEN}${passed} passed${RESET}  ${failed > 0 ? RED : GREY}${failed} failed${RESET}  ${GREY}${skipped} skipped${RESET}  of ${total} tests`);

  if (failed === 0) {
    console.log(`\n  ${GREEN}${BOLD}All tests passing. Backend is healthy.${RESET}\n`);
  } else {
    console.log(`\n  ${RED}${BOLD}${failed} test(s) failed. Check output above.${RESET}\n`);
    process.exit(1);
  }
}

run().catch(e => {
  console.error(`\n  ${RED}Fatal: ${e.message}${RESET}`);
  console.error(`  Is the server running at ${BASE}?`);
  console.error(`  Start it with: node server.js\n`);
  process.exit(1);
});
