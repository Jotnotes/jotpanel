#!/usr/bin/env node
'use strict';

const PROTOCOL_VERSION = '2024-11-05';
const WAITING = 'Waiting for approval in JotPanel. Nothing has changed yet.';
const ALLOWED_REQUESTS = new Set([
  'GET /api/panel/server/capabilities',
  'GET /api/panel/server/read/',
  'POST /api/panel/server/read/',
  'POST /api/panel/server/propose',
  'GET /api/control/actions',
]);

function cleanName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 96);
}

function safeSchema(value) {
  return value && typeof value === 'object' && value.type === 'object'
    ? value
    : { type: 'object', additionalProperties: true };
}

function scrub(value, secret) {
  if (!secret) return value;
  if (typeof value === 'string') return value.split(secret).join('[REDACTED]');
  if (Array.isArray(value)) return value.map(item => scrub(item, secret));
  if (value && typeof value === 'object') {
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[scrub(key, secret)] = scrub(item, secret);
    return copy;
  }
  return value;
}

function makeClient(env = process.env, fetchImpl = globalThis.fetch) {
  const key = String(env.JOTPANEL_API_KEY || '');
  let base;
  try {
    base = new URL(String(env.JOTPANEL_URL || ''));
  } catch {
    throw new Error('JOTPANEL_URL must be a valid HTTP or HTTPS URL.');
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('JOTPANEL_URL must be a valid HTTP or HTTPS URL.');
  }
  if (!key) throw new Error('JOTPANEL_API_KEY is required.');
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');

  async function request(method, path, body) {
    const route = `${method} ${path}`;
    const allowed = [...ALLOWED_REQUESTS].some(entry => entry.endsWith('/')
      ? route.startsWith(entry)
      : route === entry || route.startsWith(`${entry}?`));
    if (!allowed) throw new Error('The gateway is not allowed to call that JotPanel route.'); // DEFENCE_ROUTE_ALLOWLIST

    const target = new URL(`${basePath}${path}`, base.origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetchImpl(target, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw new Error(error?.name === 'AbortError' ? 'JotPanel did not answer in time.' : 'Could not reach JotPanel.');
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); }
      catch { throw new Error(`JotPanel returned an unreadable response (${response.status}).`); }
    }
    data = scrub(data, key); // DEFENCE_KEY_REDACTION
    if (!response.ok) {
      const message = typeof data?.error === 'string' ? data.error : `JotPanel refused the request (${response.status}).`;
      throw new Error(message);
    }
    return data;
  }

  return { request, key };
}

function operationRows(surface) {
  if (Array.isArray(surface?.operations)) return surface.operations;
  return (surface?.sections || []).flatMap(section => (section.operations || []).map(operation => ({
    ...operation,
    sectionTitle: section.title,
  })));
}

function toolsFromSurface(surface) {
  const tools = [];
  const used = new Set();
  const add = tool => {
    let name = tool.name;
    for (let suffix = 2; used.has(name); suffix += 1) name = `${tool.name}_${suffix}`;
    used.add(name);
    tools.push({ ...tool, name });
  };

  for (const read of surface?.reads || []) {
    if (read.available === false || !read.resource) continue;
    add({
      name: `read_${cleanName(read.resource)}`,
      description: read.description || `Read ${read.resource} from JotPanel. This does not change anything.`,
      inputSchema: safeSchema(read.inputSchema),
      _kind: 'read',
      _resource: String(read.resource),
      _method: read.method === 'POST' ? 'POST' : 'GET',
    });
  }

  for (const operation of operationRows(surface)) {
    if (operation.available === false || !operation.id) continue;
    add({
      name: `propose_${cleanName(operation.id)}`,
      description: operation.description || `Propose ${operation.id} in JotPanel. Nothing runs until a person approves it.`,
      inputSchema: safeSchema(operation.inputSchema),
      _kind: 'propose',
      _operation: String(operation.id),
    });
  }

  add({
    name: 'proposal_status',
    description: 'Check whether a JotPanel proposal is pending, approved, executed and read back, rejected, or failed. This cannot approve or execute it.',
    inputSchema: {
      type: 'object',
      properties: { proposal_id: { type: 'string', description: 'The proposal id returned by a propose tool.' } },
      required: ['proposal_id'],
      additionalProperties: false,
    },
    _kind: 'status',
  });
  return tools;
}

function publicTool(tool) {
  return { name: tool.name, description: tool.description, inputSchema: tool.inputSchema };
}

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

function toolError(message, key) {
  const safe = scrub(String(message || 'The request failed.'), key);
  return { isError: true, content: [{ type: 'text', text: safe }] };
}

function createGateway({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  let client;
  let tools = null;

  function getClient() {
    if (!client) client = makeClient(env, fetchImpl);
    return client;
  }

  async function loadTools() {
    const panel = getClient();
    const surface = await panel.request('GET', '/api/panel/server/capabilities');
    tools = toolsFromSurface(surface);
    return tools;
  }

  async function callTool(name, args = {}) {
    const panel = getClient();
    if (!tools) await loadTools();
    const tool = tools.find(candidate => candidate.name === name);
    if (!tool) return toolError('Unknown or unavailable tool.', panel.key); // DEFENCE_CATALOGUE_ONLY

    try {
      if (tool._kind === 'read') {
        let path = `/api/panel/server/read/${encodeURIComponent(tool._resource)}`;
        if (tool._method === 'GET') {
          const query = new URLSearchParams();
          for (const [key, value] of Object.entries(args || {})) {
            if (value === undefined || value === null) continue;
            query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
          }
          if ([...query].length) path += `?${query}`;
          return textResult(scrub(await panel.request('GET', path), panel.key));
        }
        return textResult(scrub(await panel.request('POST', path, args || {}), panel.key));
      }

      if (tool._kind === 'propose') {
        const path = '/api/panel/server/propose'; // DEFENCE_FIXED_PROPOSE_PATH
        const response = await panel.request('POST', path, { operation: tool._operation, input: args || {} });
        const action = response?.action || response;
        return textResult(scrub({
          proposal_id: action?.id,
          what_will_happen: action?.summary || action?.label || tool._operation,
          status: action?.status || 'pending',
          message: WAITING,
        }, panel.key));
      }

      const id = String(args?.proposal_id || '');
      if (!id) return toolError('proposal_id is required.', panel.key);
      const response = await panel.request('GET', '/api/control/actions?limit=1000');
      const action = (response?.actions || []).find(item => item?.id === id);
      if (!action) return toolError('Proposal not found.', panel.key);
      const raw = String(action.status || 'pending');
      const status = raw === 'executing' ? 'approved' : raw === 'interrupted' ? 'failed' : raw;
      return textResult(scrub({
        proposal_id: id,
        status,
        ...(raw === 'executing' ? { detail: 'executing' } : {}),
        what_happened: action.summary || action.label || null,
        ...(status === 'executed' ? { read_back: action.executionResult || null } : {}),
        ...(status === 'rejected' ? { reason: action.rejectedReason || null } : {}),
        ...(status === 'failed' ? { error: action.error || action.interruptionReason || 'The operation failed.' } : {}),
      }, panel.key));
    } catch (error) {
      return toolError(error.message, panel.key);
    }
  }

  async function handle(message) {
    const id = Object.prototype.hasOwnProperty.call(message || {}, 'id') ? message.id : undefined;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid request.' } };
    }
    if (id === undefined) return null;
    try {
      if (message.method === 'initialize') return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: message.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'jotpanel-mcp', version: '1.0.0' },
        },
      };
      if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (message.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: (await loadTools()).map(publicTool) } };
      if (message.method === 'tools/call') return {
        jsonrpc: '2.0', id,
        result: await callTool(String(message.params?.name || ''), message.params?.arguments || {}),
      };
      return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found.' } };
    } catch (error) {
      const secret = client?.key || String(env.JOTPANEL_API_KEY || '');
      return { jsonrpc: '2.0', id, error: { code: -32000, message: scrub(error.message, secret) } };
    }
  }

  return { handle, callTool, loadTools, request: (...args) => getClient().request(...args) };
}

function runStdio(gateway = createGateway()) {
  let buffer = Buffer.alloc(0);

  const send = value => {
    if (value) process.stdout.write(`${JSON.stringify(value)}\n`);
  };

  const processLine = async line => {
    if (!line.trim()) return;
    try { send(await gateway.handle(JSON.parse(line))); }
    catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } }); }
  };

  const drain = async () => {
    while (buffer.length) {
      if (buffer.subarray(0, 15).toString().toLowerCase().startsWith('content-length:')) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const header = buffer.subarray(0, end).toString();
        const match = /^content-length:\s*(\d+)$/im.exec(header);
        if (!match) { buffer = Buffer.alloc(0); return; }
        const length = Number(match[1]);
        if (buffer.length < end + 4 + length) return;
        const body = buffer.subarray(end + 4, end + 4 + length).toString();
        buffer = buffer.subarray(end + 4 + length);
        await processLine(body);
        continue;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      const line = buffer.subarray(0, end).toString();
      buffer = buffer.subarray(end + 1);
      await processLine(line);
    }
  };

  let chain = Promise.resolve();
  process.stdin.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    chain = chain.then(drain);
  });
  process.stdin.on('end', () => { chain.then(drain); });
}

if (require.main === module) runStdio();

module.exports = { createGateway, runStdio, scrub, toolsFromSurface, ALLOWED_REQUESTS };
