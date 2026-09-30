'use strict';

// Privileged half of the panel. It listens only on a Unix socket and delegates
// to a closed catalogue of named jobs. The web application never runs as root.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { executeNamedJob } = require('./control/ops/privilegedJobs');

if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
  throw new Error('jotpanel-ops must run as root');
}

const SOCKET = (process.env.JOTPANEL_OPS_SOCKET ?? process.env.ARCA_OPS_SOCKET) || '/run/jotpanel-ops/ops.sock';
const REQUEST_LIMIT = 270 * 1024 * 1024;

function socketGroupId() {
  const wanted = (process.env.JOTPANEL_OPS_GROUP ?? process.env.ARCA_OPS_GROUP) || 'jotpanel-ops';
  const row = fs.readFileSync('/etc/group', 'utf8').split('\n').find(line => line.split(':')[0] === wanted);
  const gid = row && Number(row.split(':')[2]);
  if (!Number.isInteger(gid)) throw new Error(`Operations socket group ${wanted} does not exist`);
  return gid;
}

try { fs.unlinkSync(SOCKET); } catch (error) { if (error.code !== 'ENOENT') throw error; }
fs.mkdirSync(path.dirname(SOCKET), { recursive: true, mode: 0o750 });
fs.chownSync(path.dirname(SOCKET), 0, socketGroupId());

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST' || req.url !== '/v1/jobs') {
    res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'Not found' }));
  }
  const chunks = []; let bytes = 0; let ended = false;
  req.on('data', chunk => {
    bytes += chunk.length;
    if (bytes > REQUEST_LIMIT) {
      ended = true; res.statusCode = 413; res.end(JSON.stringify({ ok: false, error: 'Job request is too large' })); req.destroy(); return;
    }
    chunks.push(chunk);
  });
  req.on('end', async () => {
    if (ended) return;
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const topLevel = Object.keys(body).filter(key => !['job', 'params'].includes(key));
      if (topLevel.length || typeof body.job !== 'string' || !body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
        throw new Error('The operations service accepts only a named job and a parameter object');
      }
      const result = await executeNamedJob(body.job, body.params);
      res.statusCode = 200; res.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      res.statusCode = error.code === 'UNKNOWN_JOB' ? 404 : 400;
      // A failed backup carries the evidence collected before refusal. This is
      // a closed, backup-only shape rather than arbitrary Error properties,
      // which keeps diagnostic internals from becoming part of the socket API.
      res.end(JSON.stringify({ ok: false, error: error.message, code: error.code || null,
        ...(error.backupRun ? { backupRun: error.backupRun } : {}) }));
    }
  });
  req.on('error', () => {});
});

server.listen(SOCKET, () => {
  fs.chownSync(SOCKET, 0, socketGroupId());
  fs.chmodSync(SOCKET, 0o660);
  console.log(`[jotpanel-ops] privileged named-job service listening on ${SOCKET}`);
});

function stop() { server.close(() => { try { fs.unlinkSync(SOCKET); } catch {} process.exit(0); }); }
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
