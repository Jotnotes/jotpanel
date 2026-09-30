'use strict';

// Certificate writes are unusually easy to overstate: certbot can exit zero
// while nginx still serves the old certificate. These tests hold the safe
// surface around that root-side check in place: validated inputs, a closed
// named-job contract, and no capability unless the privileged probe passes.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getOperation } = require('./catalogue');
const { createNativeStackBackend } = require('./nativeStackBackend');
const { executeNamedJob, SPECS } = require('./privilegedJobs');

function certificateClient(available) {
  const calls = [];
  return {
    calls,
    probe: async () => ({ ok: true }),
    run: async (job, params = {}) => {
      calls.push({ job, params });
      if (job === 'stack.probe') {
        return {
          stack: params.stack,
          available: params.stack === 'certificates' ? available : false,
          reason: params.stack === 'certificates' && !available ? 'certbot cannot read its certificate store' : 'not installed',
        };
      }
      return { verified: true };
    },
  };
}

test('certificate inputs are normalized before an action can be proposed', () => {
  const issue = getOperation('certificate.issue');
  assert.deepEqual(issue.normalize({
    domain: 'WWW.Example.COM.',
    email: 'owner@example.com',
    staging: 'true',
    forceHttps: 'true',
  }), {
    domain: 'www.example.com',
    email: 'owner@example.com',
    staging: true,
    forceHttps: true,
  });
  assert.throws(() => issue.normalize({ domain: 'example.com; certbot renew' }), /domain name/);
  assert.throws(() => issue.normalize({ domain: 'example.com', email: 'not-an-address' }), /email address/);

  const renew = getOperation('certificate.renew');
  assert.deepEqual(renew.normalize({ domain: 'Example.com', dryRun: 'true' }), {
    domain: 'example.com',
    dryRun: true,
  });

  const https = getOperation('certificate.https');
  assert.deepEqual(https.normalize({ domain: 'Example.com', enabled: 'true' }), {
    domain: 'example.com',
    enabled: true,
  });
  assert.throws(() => https.normalize({ domain: 'example.com && nginx -s stop', enabled: true }), /domain name/);
});

test('certificate capabilities stay absent until the privileged probe passes', async () => {
  const client = certificateClient(false);
  const report = await createNativeStackBackend({ client }).capabilities();
  for (const id of ['certificate.list', 'certificate.issue', 'certificate.renew', 'certificate.https']) {
    assert.equal(report.capabilities.has(id), false, `${id} must not be offered without a passing probe`);
    assert.match(report.missing.get(id), /certbot cannot read its certificate store/);
  }
});

test('certificate capabilities use only fixed named jobs and fixed parameters', async () => {
  const client = certificateClient(true);
  const { capabilities } = await createNativeStackBackend({ client }).capabilities();

  await capabilities.get('certificate.list').run({ ignored: 'not forwarded' });
  await capabilities.get('certificate.issue').run({
    domain: 'example.com', email: 'owner@example.com', staging: true, forceHttps: true,
    command: 'certbot certonly',
  });
  await capabilities.get('certificate.renew').run({ domain: 'example.com', dryRun: false, command: 'certbot renew' });
  await capabilities.get('certificate.https').run({ domain: 'example.com', enabled: true, command: 'nginx -s reload' });

  assert.deepEqual(client.calls.slice(-4), [
    { job: 'certificate.list', params: {} },
    { job: 'certificate.issue', params: { domain: 'example.com', email: 'owner@example.com', staging: true, forceHttps: true } },
    { job: 'certificate.renew', params: { domain: 'example.com', dryRun: false } },
    { job: 'certificate.https', params: { domain: 'example.com', enabled: true } },
  ]);
});

test('the root-side certificate jobs reject command-shaped extra fields', async () => {
  assert.deepEqual(SPECS['certificate.issue'][0], ['domain', 'email', 'staging', 'forceHttps']);
  assert.deepEqual(SPECS['certificate.renew'][0], ['domain', 'dryRun']);
  assert.deepEqual(SPECS['certificate.https'][0], ['domain', 'enabled']);
  await assert.rejects(
    () => executeNamedJob('certificate.issue', { domain: 'example.com', command: 'certbot certonly example.com' }),
    /does not accept: command/,
  );
  await assert.rejects(
    () => executeNamedJob('certificate.renew', { domain: 'example.com', argv: ['--force-renewal'] }),
    /does not accept: argv/,
  );
});

test('every certificate write reads back the certificate nginx is serving', () => {
  for (const job of ['certificate.issue', 'certificate.renew', 'certificate.https']) {
    assert.match(
      String(SPECS[job][1]),
      /await verifyServedCertificate\(name\)/,
      `${job} must compare nginx's live certificate with the stored certificate before reporting success`,
    );
  }
  assert.match(String(SPECS['certificate.https'][1]), /await httpSiteRequest\(name\)/,
    'the HTTPS switch must read the live HTTP redirect back');
});

test('an owner-triggered renewal does not inherit certbot\'s fleet delay', () => {
  const handler = String(SPECS['certificate.renew'][1]);
  assert.match(handler, /--no-random-sleep-on-renew/);
});
