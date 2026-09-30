'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const GATEWAY = path.join(__dirname, '..', 'jotpanel-mcp.js');
const KEY = 'jotpanel_abcdef012345_0123456789abcdef0123456789abcdef0123456789abcdef';

async function fakePanel() {
  const requests = [];
  const actions = [{
    id: 'act_done', status: 'executed', label: 'Restart web service',
    summary: 'Restarted it and checked it afterwards.', executionResult: { verified: true, state: 'running' },
  }];
  const surface = {
    reads: [{
      resource: 'services', available: true,
      description: `Read services without changing them (${KEY})`,
      inputSchema: { type: 'object', properties: { unit: { type: 'string' } }, additionalProperties: false },
    }],
    sections: [{
      title: 'Services', operations: [{
        id: 'service.restart', available: true,
        description: 'Propose a service restart. Nothing runs until a person approves it in JotPanel.',
        inputSchema: { type: 'object', properties: { unit: { type: 'string' } }, required: ['unit'], additionalProperties: false },
      }],
    }],
  };

  const fetchImpl = async (target, options = {}) => {
    const url = new URL(target);
    let parsed = null;
    try { parsed = options.body ? JSON.parse(options.body) : null; } catch { parsed = options.body; }
    const authorization = options.headers?.Authorization;
    requests.push({ method: options.method, url: `${url.pathname}${url.search}`, authorization, body: parsed });
    const answer = (data, status = 200) => new Response(JSON.stringify(data), {
      status, headers: { 'Content-Type': 'application/json' },
    });

    if (authorization !== `Bearer ${KEY}`) {
      return answer({ error: `That API key is not valid: ${authorization || ''}` }, 401);
    }
    if (options.method === 'GET' && url.pathname === '/api/panel/server/capabilities') return answer(surface);
    if (options.method === 'GET' && url.pathname === '/api/panel/server/read/services') {
      return answer({ services: [{ unit: 'nginx', state: 'running' }], reflected_secret: KEY });
    }
    if (options.method === 'POST' && url.pathname === '/api/panel/server/propose') {
      const action = {
        id: 'act_pending', status: 'pending', label: 'Restart nginx',
        summary: 'Restart nginx and read its state back afterwards.',
      };
      actions.unshift(action);
      return answer({ ok: true, action });
    }
    if (options.method === 'GET' && url.pathname === '/api/control/actions') return answer({ durable: true, actions });
    if (options.method === 'POST' && /\/api\/control\/actions\/[^/]+\/(approve|execute|reject)$/.test(url.pathname)) {
      return answer({ ok: true, unsafe_test_route: true });
    }
    return answer({ error: `Forbidden test route: ${options.method} ${url.pathname}` }, 418);
  };
  return {
    url: 'http://jotpanel.test',
    requests,
    fetchImpl,
    surface,
    close: async () => {},
  };
}

function stdioClient(url, key = KEY, executable = GATEWAY) {
  const child = spawn(process.execPath, [executable], {
    env: { ...process.env, JOTPANEL_URL: url, JOTPANEL_API_KEY: key },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let transcript = '';
  let stderr = '';
  const waiting = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => {
    stdout += chunk;
    transcript += chunk;
    let end;
    while ((end = stdout.indexOf('\n')) !== -1) {
      const line = stdout.slice(0, end);
      stdout = stdout.slice(end + 1);
      if (!line) continue;
      const next = waiting.shift();
      if (next) next.resolve(JSON.parse(line));
    }
  });
  child.on('error', error => {
    for (const item of waiting.splice(0)) item.reject(error);
  });
  let id = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), 5000);
    waiting.push({
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params ? { params } : {}) })}\n`);
  });
  const close = async () => {
    child.stdin.end();
    await new Promise(resolve => child.once('close', resolve));
    return { stdout: transcript, stderr };
  };
  return { child, request, close, stderr: () => stderr };
}

async function expectMutationAssertion(run) {
  let caught;
  try { await run(); } catch (error) { caught = error; }
  assert.ok(caught instanceof assert.AssertionError, `break test should fail with AssertionError, got ${caught?.constructor?.name || 'nothing'}`);
}

async function main() {
  const panel = await fakePanel();
  try {
    const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-mcp-stdio-'));
    const harness = path.join(harnessDir, 'harness.js');
    fs.writeFileSync(harness, `'use strict';
const surface = JSON.parse(process.env.JOTPANEL_TEST_SURFACE);
globalThis.fetch = async (_url, options = {}) => {
  const auth = options.headers && options.headers.Authorization;
  const data = auth === 'Bearer ${KEY}' ? surface : { error: 'That API key is not valid: ' + auth };
  return new Response(JSON.stringify(data), { status: auth === 'Bearer ${KEY}' ? 200 : 401, headers: { 'Content-Type': 'application/json' } });
};
require(${JSON.stringify(GATEWAY)}).runStdio();
`);
    const oldSurface = process.env.JOTPANEL_TEST_SURFACE;
    process.env.JOTPANEL_TEST_SURFACE = JSON.stringify(panel.surface);
    const client = stdioClient(panel.url, KEY, harness);
    const initialized = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(initialized.result.serverInfo.name, 'jotpanel-mcp');
    assert.deepEqual(initialized.result.capabilities, { tools: { listChanged: false } });

    const listed = await client.request('tools/list');
    const names = listed.result.tools.map(tool => tool.name);
    assert.deepEqual(names, ['read_services', 'propose_service_restart', 'proposal_status']);
    assert.deepEqual(listed.result.tools[1].inputSchema.required, ['unit']);
    assert.match(listed.result.tools[1].description, /Nothing runs until a person approves/);

    const { createGateway } = require(GATEWAY);
    const gateway = createGateway({
      env: { JOTPANEL_URL: panel.url, JOTPANEL_API_KEY: KEY },
      fetchImpl: panel.fetchImpl,
    });
    await gateway.handle({ jsonrpc: '2.0', id: 10, method: 'tools/list' });
    const read = await gateway.handle({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'read_services', arguments: { unit: 'nginx' } } });
    assert.equal(read.result.structuredContent.services[0].state, 'running');
    assert.equal(read.result.structuredContent.reflected_secret, '[REDACTED]');

    const beforeProposal = panel.requests.length;
    const proposed = await gateway.handle({ jsonrpc: '2.0', id: 12, method: 'tools/call', params: {
      name: 'propose_service_restart', arguments: { unit: 'nginx', path: '/api/control/actions/act_pending/approve' },
    } });
    assert.equal(proposed.result.structuredContent.proposal_id, 'act_pending');
    assert.equal(proposed.result.structuredContent.message, 'Waiting for approval in JotPanel. Nothing has changed yet.');
    assert.deepEqual(panel.requests.slice(beforeProposal).map(request => `${request.method} ${request.url}`), ['POST /api/panel/server/propose']);

    const status = await gateway.handle({ jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'proposal_status', arguments: { proposal_id: 'act_done' } } });
    assert.equal(status.result.structuredContent.status, 'executed');
    assert.deepEqual(status.result.structuredContent.read_back, { verified: true, state: 'running' });

    for (const name of ['approve', 'execute', 'reject', 'approve_proposal', 'propose_execute']) {
      const count = panel.requests.length;
      const refused = await gateway.handle({ jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name, arguments: { proposal_id: 'act_pending', path: `/api/control/actions/act_pending/${name}` } } });
      assert.equal(refused.result.isError, true);
      assert.equal(panel.requests.length, count, `${name} must not make an HTTP request`);
    }
    assert.equal(panel.requests.some(request => /\/(approve|execute|reject)(?:\?|$)/.test(request.url)), false);

    const output = await client.close();
    const serializedResponses = JSON.stringify({ initialized, listed, read, proposed, status });
    assert.equal(serializedResponses.includes(KEY), false);
    assert.equal(output.stdout.includes(KEY), false);
    assert.equal(output.stderr.includes(KEY), false);

    const badGateway = createGateway({
      env: { JOTPANEL_URL: panel.url, JOTPANEL_API_KEY: 'bad-key-that-must-not-leak' },
      fetchImpl: panel.fetchImpl,
    });
    const badList = await badGateway.handle({ jsonrpc: '2.0', id: 20, method: 'tools/list' });
    assert.equal(badList.error.code, -32000);
    assert.match(badList.error.message, /not valid/i);
    assert.equal(JSON.stringify(badList).includes('bad-key-that-must-not-leak'), false);

    // Break tests: run temporary source copies with a named defence removed and
    // prove the matching invariant assertion trips. This makes the security
    // tests demonstrate that they can catch the regressions they claim to.
    const source = fs.readFileSync(GATEWAY, 'utf8');
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jotpanel-mcp-break-'));
    try {
      const noRouteGuard = path.join(temp, 'no-route-guard.js');
      fs.writeFileSync(noRouteGuard, source.replace(
        "if (!allowed) throw new Error('The gateway is not allowed to call that JotPanel route.'); // DEFENCE_ROUTE_ALLOWLIST",
        "if (false && !allowed) throw new Error('removed'); // defence removed",
      ));
      await expectMutationAssertion(async () => {
        delete require.cache[noRouteGuard];
        const mutant = require(noRouteGuard).createGateway({ env: { JOTPANEL_URL: panel.url, JOTPANEL_API_KEY: KEY }, fetchImpl: panel.fetchImpl });
        const count = panel.requests.length;
        await mutant.request('POST', '/api/control/actions/act_pending/approve', {});
        assert.equal(panel.requests.length, count, 'approve route must never be requested');
      });

      const noRedaction = path.join(temp, 'no-redaction.js');
      fs.writeFileSync(noRedaction, source.replace(
        'data = scrub(data, key); // DEFENCE_KEY_REDACTION',
        'data = data; // defence removed',
      ));
      await expectMutationAssertion(async () => {
        delete require.cache[noRedaction];
        const mutant = require(noRedaction).createGateway({ env: { JOTPANEL_URL: panel.url, JOTPANEL_API_KEY: KEY }, fetchImpl: panel.fetchImpl });
        const response = await mutant.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        assert.equal(JSON.stringify(response).includes(KEY), false, 'the key must not appear in a response');
      });

      const noCatalogueGuard = path.join(temp, 'no-catalogue-guard.js');
      fs.writeFileSync(noCatalogueGuard, source.replace(
        "if (!tool) return toolError('Unknown or unavailable tool.', panel.key); // DEFENCE_CATALOGUE_ONLY",
        '// catalogue defence removed',
      ));
      await expectMutationAssertion(async () => {
        delete require.cache[noCatalogueGuard];
        const mutant = require(noCatalogueGuard).createGateway({ env: { JOTPANEL_URL: panel.url, JOTPANEL_API_KEY: KEY }, fetchImpl: panel.fetchImpl });
        await mutant.loadTools();
        const response = await mutant.handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'approve', arguments: {} } });
        assert.equal(response.result.content[0].text, 'Unknown or unavailable tool.');
      });

      const agentChosenPath = path.join(temp, 'agent-chosen-path.js');
      fs.writeFileSync(agentChosenPath, source.replace(
        "const path = '/api/panel/server/propose'; // DEFENCE_FIXED_PROPOSE_PATH",
        "const path = String(args.path || '/api/panel/server/propose'); // defence removed",
      ));
      await expectMutationAssertion(async () => {
        delete require.cache[agentChosenPath];
        const mutant = require(agentChosenPath).createGateway({ env: { JOTPANEL_URL: panel.url, JOTPANEL_API_KEY: KEY }, fetchImpl: panel.fetchImpl });
        await mutant.loadTools();
        const response = await mutant.handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
          name: 'propose_service_restart', arguments: { unit: 'nginx', path: '/api/control/actions/act_pending/approve' },
        } });
        assert.ok(response.result.structuredContent, 'a proposal response must carry structured content');
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
      fs.rmSync(harnessDir, { recursive: true, force: true });
      if (oldSurface === undefined) delete process.env.JOTPANEL_TEST_SURFACE;
      else process.env.JOTPANEL_TEST_SURFACE = oldSurface;
    }

    console.log('jotpanel MCP gateway tests passed');
  } finally {
    await panel.close();
  }
}

main().catch(error => {
  process.stderr.write(`${error.stack || `${error.name}: ${error.message}`}\n`);
  process.exitCode = 1;
});
