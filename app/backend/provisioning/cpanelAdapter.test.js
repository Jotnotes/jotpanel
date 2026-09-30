'use strict';

const assert = require('assert/strict');
const { createCpanelAdapter, cpanelAdapterFromEnv, unwrapApiResult } = require('./cpanelAdapter');
const { createProvisioningService, ACTIONS } = require('./index');

const account = {
  accountId: 'acct_123',
  cpanelUser: 'higashi',
  primaryDomain: 'higashi.example',
  domains: ['higashi.example'],
  allowedDnsZones: ['higashi.example'],
};

// A fake WHM transport: records requests and replies with canned JSON.
function fakeTransport(responder) {
  const calls = [];
  const transport = async (opts) => {
    calls.push(opts);
    const reply = responder(opts, calls.length - 1);
    return { statusCode: reply.statusCode || 200, body: JSON.stringify(reply.json) };
  };
  return { transport, calls };
}

function uapiOk(data) {
  // WHM proxies UAPI, nesting the real result under result.data.result.
  return { result: { data: { result: { status: 1, errors: null, data } } } };
}
function uapiErr(errors) {
  return { result: { data: { result: { status: 0, errors, data: null } } } };
}

async function run() {
  await testConfigGating();
  await testAuthHeaderAndUrl();
  await testEmailSuccessUnwraps();
  await testUapiErrorThrows();
  await testWhmAuthDenialThrows();
  await testStatsFansOutToCompanions();
  await testFtpAllowlistNotEnforcedIsFlagged();
  await testEndToEndThroughService();
  console.log('cpanel adapter tests passed');
}

async function testConfigGating() {
  assert.equal(cpanelAdapterFromEnv({}), null, 'no config → null (mock fallback)');
  assert.equal(cpanelAdapterFromEnv({ CPANEL_WHM_HOST: 'h' }), null, 'host without token → null');
  const a = cpanelAdapterFromEnv({ CPANEL_WHM_HOST: 'whm.host', CPANEL_WHM_API_TOKEN: 'tok' });
  assert.ok(a && a.name === 'cpanel-whm' && a.host === 'whm.host');
  assert.throws(() => createCpanelAdapter({ host: 'h' }), /API token/);
  assert.throws(() => createCpanelAdapter({ apiToken: 't' }), /host/);
}

async function testAuthHeaderAndUrl() {
  const { transport, calls } = fakeTransport(() => ({ json: uapiOk({ ok: 1 }) }));
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'secret', whmUser: 'reseller', transport });
  await adapter.callUapi({ user: 'higashi', module: 'Email', func: 'add_pop', params: { email: 'a', quota: 100 } });
  const req = calls[0];
  assert.equal(req.headers.Authorization, 'whm reseller:secret');
  assert.equal(req.port, 2087);
  assert.match(req.path, /^\/json-api\/cpanel\?/);
  assert.match(req.path, /cpanel_jsonapi_apiversion=3/);
  assert.match(req.path, /cpanel_jsonapi_user=higashi/);
  assert.match(req.path, /cpanel_jsonapi_module=Email/);
  assert.match(req.path, /cpanel_jsonapi_func=add_pop/);
  assert.match(req.path, /quota=100/);
}

async function testEmailSuccessUnwraps() {
  const { transport } = fakeTransport(() => ({ json: uapiOk({ email: 'hi@higashi.example' }) }));
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'tok', transport });
  const out = await adapter.execute(
    { api: 'cpanel-uapi', module: 'Email', function: 'add_pop', user: 'higashi', params: { email: 'hi', domain: 'higashi.example', password: 'x'.repeat(12), quota: 1024 } },
    account
  );
  assert.equal(out.ok, true);
  assert.equal(out.adapter, 'cpanel-whm');
  assert.deepEqual(out.data, { email: 'hi@higashi.example' });
  assert.equal(out.warnings, undefined);
}

async function testUapiErrorThrows() {
  const { transport } = fakeTransport(() => ({ json: uapiErr(['That mailbox already exists.']) }));
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'tok', transport });
  await assert.rejects(
    () => adapter.execute({ api: 'cpanel-uapi', module: 'Email', function: 'add_pop', user: 'higashi', params: {} }, account),
    /already exists/
  );
}

async function testWhmAuthDenialThrows() {
  const { transport } = fakeTransport(() => ({ json: { metadata: { result: 0, reason: 'Access denied' } } }));
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'badtoken', transport });
  await assert.rejects(
    () => adapter.execute({ api: 'cpanel-uapi', module: 'ZoneEdit', function: 'add_zone_record', user: 'higashi', params: {} }, account),
    /WHM denied: Access denied/
  );
}

async function testStatsFansOutToCompanions() {
  const { transport, calls } = fakeTransport((opts) => {
    if (/StatsBar/.test(opts.path)) return { json: uapiOk([{ disk: '6144' }]) };
    return { json: uapiOk({ bw: 42 }) };
  });
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'tok', transport });
  const out = await adapter.execute(
    {
      api: 'cpanel-uapi', module: 'StatsBar', function: 'get_stats', user: 'higashi', params: { display: 'diskusage' },
      companionCalls: [{ api: 'cpanel-uapi', module: 'Bandwidth', function: 'query', user: 'higashi', params: { grouping: 'domain' } }],
    },
    account
  );
  assert.equal(calls.length, 2, 'primary + one companion call');
  assert.deepEqual(out.data.statsbar, [{ disk: '6144' }]);
  assert.deepEqual(out.data.bandwidth, { bw: 42 });
  assert.equal(out.data.visitors.source, 'higashi');
}

async function testFtpAllowlistNotEnforcedIsFlagged() {
  const { transport } = fakeTransport(() => ({ json: uapiOk({ user: 'deploy' }) }));
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'tok', transport });
  const out = await adapter.execute(
    {
      api: 'cpanel-uapi', module: 'Ftp', function: 'add_ftp', user: 'higashi',
      params: { user: 'deploy', domain: 'higashi.example', pass: 'x'.repeat(12), homedir: 'public_html/x' },
      enforcement: { type: 'source-ip-allowlist', allowedIp: '203.0.113.7' },
    },
    account
  );
  assert.equal(out.ok, true, 'FTP account itself was created');
  assert.equal(out.enforcement.applied, false, 'allowlist honestly reported as NOT applied');
  assert.equal(out.enforcement.allowedIp, '203.0.113.7');
  assert.ok(out.warnings && /NOT enforced/.test(out.warnings[0]));
}

// The service builds and scopes the call; the real adapter executes it. Proves the
// adapter is a drop-in for the mock across the propose → approve → execute flow.
async function testEndToEndThroughService() {
  const { transport, calls } = fakeTransport(() => ({ json: uapiOk({ record: 'added' }) }));
  const adapter = createCpanelAdapter({ host: 'whm.host', apiToken: 'tok', transport });
  const service = createProvisioningService({ adapter });

  const action = await service.propose({
    intent: 'add dns record',
    account,
    input: { zone: 'higashi.example', type: 'A', name: 'app', value: '198.51.100.42', ttl: 600 },
  });
  await service.approveAction(action.id, { approvedBy: 'steve' });
  const executed = await service.executeApproved(action.id, { account });

  assert.equal(executed.status, 'executed');
  assert.equal(executed.executionResult.adapter, 'cpanel-whm');
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /cpanel_jsonapi_module=ZoneEdit/);
  assert.match(calls[0].path, /name=app\.higashi\.example/);
  assert.equal(ACTIONS.ADD_DNS_RECORD, action.actionKey);
}

run().catch((error) => { console.error(error); process.exit(1); });
