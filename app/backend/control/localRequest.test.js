'use strict';

// The bootstrap surface's second lock, tested the way it fails rather than the
// way it passes. Each of these is a request somebody could actually make: the
// installer's own curl, the same call arriving through nginx, and the same call
// arriving on the recovery port from the internet.

const assert = require('assert');
const { isLocalRequest, refusalReason } = require('./localRequest');

const request = (peer, headers = {}) => ({ socket: { remoteAddress: peer }, headers });

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`ok  ${name}`); };

check('the installer\'s own curl on 127.0.0.1 is local', () => {
  assert.strictEqual(isLocalRequest(request('127.0.0.1')), true);
});

check('IPv6 loopback is local, in both spellings', () => {
  assert.strictEqual(isLocalRequest(request('::1')), true);
  assert.strictEqual(isLocalRequest(request('::ffff:127.0.0.1')), true);
});

check('a request from off the machine is not local', () => {
  assert.strictEqual(isLocalRequest(request('82.165.188.141')), false);
  assert.match(refusalReason(request('82.165.188.141')), /not this machine/);
});

// nginx runs on this box, so what it proxies arrives from 127.0.0.1. The socket
// cannot tell it apart from the installer and the header is what can.
check('a request nginx proxied from the internet is refused even though the socket is loopback', () => {
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), false);
  assert.match(refusalReason(request('127.0.0.1', { 'x-forwarded-for': '203.0.113.7' })), /forwarded by a proxy/);
});

// The spoof that would work if the value were trusted rather than the presence.
check('a forged X-Forwarded-For claiming to be loopback is still refused', () => {
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.1' })), false);
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '127.0.0.1, 203.0.113.7' })), false);
});

check('the other ways a hop announces itself are refused too', () => {
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-real-ip': '203.0.113.7' })), false);
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { forwarded: 'for=203.0.113.7' })), false);
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-forwarded-proto': 'https' })), false);
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-forwarded-host': 'panel.example' })), false);
});

check('an empty header is not a hop', () => {
  assert.strictEqual(isLocalRequest(request('127.0.0.1', { 'x-forwarded-for': '' })), true);
});

check('a request with no socket at all is not local', () => {
  assert.strictEqual(isLocalRequest({ headers: {} }), false);
  assert.strictEqual(isLocalRequest({}), false);
});

console.log(`\n${passed} checks passed`);
