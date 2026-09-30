'use strict';

const assert = require('assert/strict');
const {
  createHestiaAdapter,
  hestiaAdapterFromEnv,
  parseHestiaBody,
  hostLabel,
} = require('./hestiaAdapter');
const { createProvisioningService, ACTIONS } = require('./index');

const account = {
  accountId: 'acct_123',
  cpanelUser: 'higashi',
  primaryDomain: 'higashi.example',
  domains: ['higashi.example'],
  allowedDnsZones: ['higashi.example'],
};

// A fake Hestia transport: records requests and replies with a canned body.
function fakeTransport(responder) {
  const calls = [];
  const transport = async (opts) => {
    calls.push({ ...opts, form: new URLSearchParams(opts.body) });
    const reply = responder(opts, calls.length - 1);
    return { statusCode: reply.statusCode || 200, body: reply.body };
  };
  return { transport, calls };
}

const USER_JSON = JSON.stringify({
  higashi: { DISK_QUOTA: '10240', U_DISK: '512', BANDWIDTH: '102400', U_BANDWIDTH: '2048' },
});

async function run() {
  // ── Body parsing ────────────────────────────────────────────────
  assert.deepEqual(parseHestiaBody('', 'v-list-user'), { ok: true, data: null });
  assert.deepEqual(parseHestiaBody('0', 'v-list-user'), { ok: true, data: null });
  assert.equal(parseHestiaBody('3', 'v-add-mail-account').ok, false);
  assert.match(parseHestiaBody('3', 'v-add-mail-account').error, /already exists \(exit 3\)/);
  assert.match(parseHestiaBody('9', 'v-add-dns-record').error, /insufficient privileges/);
  assert.deepEqual(parseHestiaBody(USER_JSON, 'v-list-user').data.higashi.U_DISK, '512');
  assert.equal(parseHestiaBody('{bad json', 'v-list-user').ok, false);

  // ── DNS host label derivation ───────────────────────────────────
  assert.equal(hostLabel('app.higashi.example', 'higashi.example'), 'app');
  assert.equal(hostLabel('higashi.example', 'higashi.example'), '@');
  assert.equal(hostLabel('a.b.higashi.example', 'higashi.example'), 'a.b');

  // ── Read path: stats, and the companion call is deduped ─────────
  {
    const { transport, calls } = fakeTransport(() => ({ body: USER_JSON }));
    const adapter = createHestiaAdapter({ host: 'panel.host', accessKey: 'ak', secretKey: 'sk', transport });
    const service = createProvisioningService({ adapter });

    const action = await service.propose({ intent: 'fetch account stats', account, input: {} });
    await service.approveAction(action.id, { approvedBy: 'steve' });
    const executed = await service.executeApproved(action.id, { account });

    assert.equal(executed.status, 'executed');
    assert.equal(executed.executionResult.adapter, 'hestia');
    assert.equal(ACTIONS.FETCH_ACCOUNT_STATS, action.actionKey);

    // StatsBar and Bandwidth both map to v-list-user, so only one request goes out.
    assert.equal(calls.length, 1);
    assert.equal(calls[0].form.get('cmd'), 'v-list-user');
    assert.equal(calls[0].form.get('arg1'), 'higashi');
    assert.equal(calls[0].form.get('arg2'), 'json');
    assert.equal(calls[0].form.get('access_key'), 'ak');
    assert.equal(calls[0].port, 8083);
    assert.equal(calls[0].path, '/api/');

    // Unverified signatures must announce themselves rather than pass silently.
    assert.match(executed.executionResult.warnings.join(' '), /unverified/);
  }

  // ── Writes are refused unless explicitly opened ─────────────────
  {
    const { transport, calls } = fakeTransport(() => ({ body: '0' }));
    const adapter = createHestiaAdapter({ host: 'panel.host', apiHash: 'h', transport });
    const service = createProvisioningService({ adapter });

    const action = await service.propose({
      intent: 'add dns record',
      account,
      input: { zone: 'higashi.example', type: 'A', name: 'app', value: '198.51.100.42', ttl: 600 },
    });
    await service.approveAction(action.id, { approvedBy: 'steve' });

    await assert.rejects(
      () => service.executeApproved(action.id, { account }),
      /read-only/
    );
    assert.equal(calls.length, 0, 'a refused write must not touch the network');
  }

  // ── Write path with allowWrites: positional order is the contract ──
  {
    const { transport, calls } = fakeTransport(() => ({ body: '0' }));
    const adapter = createHestiaAdapter({
      host: 'panel.host',
      apiHash: 'h',
      allowWrites: true,
      transport,
    });
    const service = createProvisioningService({ adapter });

    const action = await service.propose({
      intent: 'add dns record',
      account,
      input: { zone: 'higashi.example', type: 'A', name: 'app', value: '198.51.100.42', ttl: 600 },
    });
    await service.approveAction(action.id, { approvedBy: 'steve' });
    const executed = await service.executeApproved(action.id, { account });

    assert.equal(executed.status, 'executed');
    assert.equal(calls.length, 1);
    const f = calls[0].form;
    assert.equal(f.get('cmd'), 'v-add-dns-record');
    assert.equal(f.get('arg1'), 'higashi');
    assert.equal(f.get('arg2'), 'higashi.example');
    assert.equal(f.get('arg3'), 'app', 'Hestia takes the host label, not the FQDN');
    assert.equal(f.get('arg4'), 'A');
    assert.equal(f.get('arg5'), '198.51.100.42');
    assert.equal(f.get('arg8'), '600');
    assert.equal(f.get('hash'), 'h');
  }

  // ── Email write maps quota 0 to unlimited ───────────────────────
  {
    const { transport, calls } = fakeTransport(() => ({ body: '0' }));
    const adapter = createHestiaAdapter({ host: 'panel.host', apiHash: 'h', allowWrites: true, transport });

    await adapter.execute(
      {
        api: 'cpanel-uapi',
        module: 'Email',
        function: 'add_pop',
        params: { email: 'hello', domain: 'higashi.example', password: 'Sw0rdfish!x', quota: 0 },
      },
      { accountId: 'acct_123', cpanelUser: 'higashi' }
    );

    const f = calls[0].form;
    assert.equal(f.get('cmd'), 'v-add-mail-account');
    assert.equal(f.get('arg3'), 'hello');
    assert.equal(f.get('arg5'), 'unlimited');
  }

  // ── Host errors surface, they do not get swallowed ──────────────
  {
    const { transport } = fakeTransport(() => ({ statusCode: 401, body: 'denied' }));
    const adapter = createHestiaAdapter({ host: 'panel.host', apiHash: 'h', transport });
    await assert.rejects(
      () => adapter.execute(
        { module: 'StatsBar', function: 'get_stats', params: {} },
        { accountId: 'a', cpanelUser: 'higashi' }
      ),
      /HTTP 401/
    );
  }

  // ── Unmapped calls fail loudly rather than guessing ─────────────
  {
    const { transport } = fakeTransport(() => ({ body: '0' }));
    const adapter = createHestiaAdapter({ host: 'panel.host', apiHash: 'h', transport });
    await assert.rejects(
      () => adapter.execute(
        { module: 'Nowhere', function: 'nothing', params: {} },
        { accountId: 'a', cpanelUser: 'higashi' }
      ),
      /no mapping for Nowhere::nothing/
    );
  }

  // ── Env wiring: unconfigured returns null so the mock stays ─────
  assert.equal(hestiaAdapterFromEnv({}), null);
  assert.equal(hestiaAdapterFromEnv({ HESTIA_HOST: 'panel.host' }), null, 'host alone is not enough');
  {
    const adapter = hestiaAdapterFromEnv({
      HESTIA_HOST: 'panel.host',
      HESTIA_ACCESS_KEY: 'ak',
      HESTIA_SECRET_KEY: 'sk',
    });
    assert.equal(adapter.name, 'hestia');
    assert.equal(adapter.allowWrites, false, 'writes stay closed unless HESTIA_ALLOW_WRITES=1');
  }
  {
    const adapter = hestiaAdapterFromEnv({
      HESTIA_HOST: 'panel.host',
      HESTIA_API_HASH: 'h',
      HESTIA_ALLOW_WRITES: '1',
    });
    assert.equal(adapter.allowWrites, true);
  }

  console.log('hestia adapter tests passed');
}

run().catch((error) => { console.error(error); process.exit(1); });
