'use strict';

// Chat-to-provisioning bridge for the demo. Reuses the free-text intent
// mapping and pulls the inputs an action needs out of the visitor's own
// words, filling the gaps with demo-safe defaults (a generated password,
// the visitor's own IP) so the mock adapter can always stage a real
// proposal. Returns null whenever the message is not clearly actionable —
// a missed detection costs nothing, a broken proposal breaks the show.

const crypto = require('crypto');
const { mapIntent } = require('./intentMap');
const { ACTIONS } = require('./actions');

// base64url of 12 bytes = 16 chars, comfortably past the 10-char floor.
function genPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// "for mark", "called shop", "named backups" → the name the visitor used.
function extractName(text) {
  const m = text.match(/\b(?:for|called|named)\s+([a-z][a-z0-9._-]{0,30})\b/i);
  if (!m) return null;
  const stop = new Set(['me', 'my', 'the', 'a', 'an', 'this', 'that', 'him', 'her', 'them', 'us', 'you']);
  return stop.has(m[1].toLowerCase()) ? null : m[1].toLowerCase();
}

function buildDemoInput(actionKey, text, opts = {}) {
  switch (actionKey) {
    case ACTIONS.CREATE_EMAIL_ACCOUNT: {
      // An explicit address wins; otherwise the name they mentioned on the
      // account's own domain, else a friendly default. The builder requires
      // a domain, so the account's primary domain is the fallback.
      const explicit = text.match(/\b([a-z0-9][a-z0-9._-]*)@([a-z0-9.-]+\.[a-z]{2,})\b/i);
      const domain = explicit ? explicit[2].toLowerCase() : opts.primaryDomain;
      if (!domain) return null;
      return {
        localPart: explicit ? explicit[1].toLowerCase() : (extractName(text) || 'hello'),
        domain,
        password: genPassword(),
      };
    }
    case ACTIONS.CREATE_FTP_ACCOUNT: {
      const ipInText = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
      const ip = ipInText ? ipInText[1] : (opts.clientIp || '').replace(/^::ffff:/, '');
      if (!ip) return null;
      return {
        username: extractName(text) || 'deploy',
        password: genPassword(),
        allowedIp: ip,
      };
    }
    case ACTIONS.FETCH_ACCOUNT_STATS:
      return {};
    case ACTIONS.ADD_DNS_RECORD: {
      // Only stage a record when the message actually carries one; guessing
      // a type, name and value would put a wrong card on screen.
      const type = (text.match(/\b(a|aaaa|cname|txt|mx)\s+record\b/i) || [])[1];
      const name = (text.match(/\b(?:for|on|at)\s+([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*)\b/i) || [])[1];
      const value = (text.match(/\b(?:to|pointing\s+(?:at|to)|value)\s+([a-z0-9:._-]+)\b/i) || [])[1];
      if (!type || !name || !value) return null;
      const upper = type.toUpperCase();
      return { type: upper, name, ...(upper === 'MX' ? { exchange: value } : { value }) };
    }
    default:
      return null;
  }
}

// detectDemoAction(text, { clientIp }) → { actionKey, input } | null
function detectDemoAction(text, opts = {}) {
  const t = (text || '').toString().trim();
  if (!t) return null;
  let actionKey;
  try { actionKey = mapIntent(t); } catch { return null; }
  const input = buildDemoInput(actionKey, t, opts);
  return input ? { actionKey, input } : null;
}

module.exports = { detectDemoAction };
