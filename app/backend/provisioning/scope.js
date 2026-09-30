'use strict';

function normalizeAccountContext(context = {}) {
  const accountId = requiredString(context.accountId, 'accountId');
  const cpanelUser = requiredString(context.cpanelUser, 'cpanelUser');
  const primaryDomain = normalizeDomain(requiredString(context.primaryDomain, 'primaryDomain'));
  const domains = new Set([primaryDomain, ...(context.domains || []).map(normalizeDomain)]);
  const allowedDnsZones = new Set([primaryDomain, ...(context.allowedDnsZones || []).map(normalizeDomain)]);

  return {
    accountId,
    cpanelUser,
    primaryDomain,
    domains,
    allowedDnsZones,
    homeDirectory: context.homeDirectory || `/home/${cpanelUser}`,
    allowedIpCidrs: context.allowedIpCidrs || [],
  };
}

function assertOwnedDomain(context, domain, fieldName = 'domain') {
  const normalized = normalizeDomain(requiredString(domain, fieldName));
  if (!context.domains.has(normalized)) {
    throw new Error(`Domain ${normalized} is outside account scope`);
  }
  return normalized;
}

function assertOwnedDnsZone(context, zone) {
  const normalized = normalizeDomain(requiredString(zone, 'zone'));
  if (!context.allowedDnsZones.has(normalized)) {
    throw new Error(`DNS zone ${normalized} is outside account scope`);
  }
  return normalized;
}

function assertSafeRelativePath(pathValue) {
  const value = requiredString(pathValue, 'homeDirectory').replace(/^\/+/, '');
  if (value.includes('..') || value.startsWith('~')) {
    throw new Error('FTP home directory must stay inside the cPanel account home');
  }
  return value;
}

function normalizeDomain(domain) {
  const normalized = String(domain).trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(normalized)) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  return normalized;
}

function requiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function assertLocalPart(value, fieldName = 'localPart') {
  const localPart = requiredString(value, fieldName).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(localPart)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return localPart;
}

function assertUsername(value, fieldName = 'username') {
  const username = requiredString(value, fieldName).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(username)) {
    throw new Error(`Invalid ${fieldName}`);
  }
  return username;
}

function assertPassword(value) {
  const password = requiredString(value, 'password');
  if (password.length < 10) {
    throw new Error('password must be at least 10 characters');
  }
  return password;
}

function assertIpAddress(value) {
  const ip = requiredString(value, 'allowedIp');
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) && ip.split('.').every((part) => Number(part) <= 255);
  const ipv6 = /^[0-9a-f:]+$/i.test(ip) && ip.includes(':');
  if (!ipv4 && !ipv6) throw new Error(`Invalid IP address: ${ip}`);
  return ip;
}

function assertQuotaMb(value, fallback = 0) {
  const quota = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isInteger(quota) || quota < 0) {
    throw new Error('quotaMb must be a non-negative integer');
  }
  return quota;
}

module.exports = {
  normalizeAccountContext,
  assertOwnedDomain,
  assertOwnedDnsZone,
  assertSafeRelativePath,
  normalizeDomain,
  requiredString,
  assertLocalPart,
  assertUsername,
  assertPassword,
  assertIpAddress,
  assertQuotaMb,
};
