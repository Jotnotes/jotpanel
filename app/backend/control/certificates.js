'use strict';

const tls = require('tls');
const net = require('net');

async function certificateHealth(domain, { timeoutMs = 4500, now = () => new Date() } = {}) {
  const host = normalizeHost(domain);
  if (!host) return { status: 'not_configured', verified: false, reason: 'No domain is configured for this site.' };
  try {
    const cert = await new Promise((resolve, reject) => {
      const socket = tls.connect({ host, port: 443, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
        const peer = socket.getPeerCertificate();
        const authorized = socket.authorized;
        const authorizationError = socket.authorizationError || null;
        socket.end();
        resolve({ peer, authorized, authorizationError });
      });
      socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('TLS connection timed out')); });
      socket.once('error', reject);
    });
    if (!cert.peer || !cert.peer.valid_to) throw new Error('The server did not present a certificate');
    const expiresAt = new Date(cert.peer.valid_to);
    const daysRemaining = Math.floor((expiresAt.getTime() - now().getTime()) / 86400000);
    const status = daysRemaining < 0 ? 'expired'
      : !cert.authorized ? 'invalid'
        : daysRemaining < 7 ? 'critical'
          : daysRemaining < 21 ? 'warning' : 'healthy';
    return {
      status,
      verified: cert.authorized && daysRemaining >= 0,
      daysRemaining,
      expiresAt: expiresAt.toISOString(),
      issuer: cert.peer.issuer?.O || cert.peer.issuer?.CN || null,
      subject: cert.peer.subject?.CN || host,
      reason: cert.authorized
        ? (daysRemaining >= 0 ? `Certificate verified; ${daysRemaining} day(s) remaining.` : `Certificate expired ${Math.abs(daysRemaining)} day(s) ago.`)
        : `The live certificate could not be verified: ${cert.authorizationError || 'unknown verification error'}.`,
      checkedAt: now().toISOString(),
    };
  } catch (error) {
    return { status: 'unreachable', verified: false, reason: error.message, checkedAt: now().toISOString() };
  }
}

async function siteCertificateHealth(sites, options = {}) {
  return Promise.all((sites || []).map(async site => ({ ...site, certificate: await certificateHealth(site.domain, options) })));
}

function normalizeHost(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname || null;
  } catch { return null; }
}

module.exports = { certificateHealth, siteCertificateHealth, normalizeHost };
