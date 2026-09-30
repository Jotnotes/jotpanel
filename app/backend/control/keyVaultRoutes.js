'use strict';

// The three routes that put a person's own provider key into the vault, list
// it and take it out. They live here rather than inline in server.js so each
// defence can be switched off in a test and seen to fail.
//
// What holds:
// - Nothing here returns a key. Saving answers with a fingerprint, listing
//   reads fingerprints and labels only.
// - Writes (save and remove) share one budget per person, counted whether the
//   request succeeded or not, so a script cannot rotate keys without limit.
// - Every write is audited, the refusals included, and no audit line carries
//   any characters of the key.

const rateLimit = require('express-rate-limit');

const KEY_WRITE_WINDOW_MS = 15 * 60 * 1000;
const KEY_WRITE_MAX = 20;

function mountKeyVaultRoutes(app, {
  auth, providerKeys, audit, scrubSecrets, keyableProvider, hostAllowsByok, identityKey,
  windowMs = KEY_WRITE_WINDOW_MS, max = KEY_WRITE_MAX,
}) {
  const writeLimiter = rateLimit({
    windowMs, max,
    keyGenerator: req => `vault:${req.user ? `user:${req.user.id}` : identityKey(req)}`,
    handler: (req, res) => {
      audit(req.user && req.user.id, 'provider_key_refused', req, `rate limited: ${req.method}`);
      res.status(429).json({ error: req.t('Too many key changes. Wait 15 minutes and try again.') });
    },
    standardHeaders: true, legacyHeaders: false,
  });

  const ownKeyScope = req => ({ kind: 'identity', id: req.user.id });
  const refuse = (req, res, status, why, message) => {
    audit(req.user.id, 'provider_key_refused', req, scrubSecrets(`${String(req.params.provider).slice(0, 40)}: ${why}`));
    return res.status(status).json({ error: req.t(message) });
  };

  app.get('/api/ai/keys', auth, (req, res) => {
    res.json({ keys: providerKeys.list(ownKeyScope(req)).map(k => ({ provider: k.provider_id, fingerprint: k.fingerprint, label: k.label, createdAt: k.created_at, lastUsedAt: k.last_used_at })) });
  });

  app.put('/api/ai/keys/:provider', auth, writeLimiter, (req, res) => {
    const providerId = keyableProvider(req.params.provider);
    if (!providerId) return refuse(req, res, 400, 'no such provider', 'That provider does not take a key.');
    if (!hostAllowsByok()) return refuse(req, res, 403, 'host does not allow own keys', 'Your hosting company does not allow your own API keys on this panel.');
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    if (key.length < 8 || key.length > 500 || /\s/.test(key)) return refuse(req, res, 400, 'not a key', 'That does not look like an API key.');
    const requestedLabel = req.body && Object.prototype.hasOwnProperty.call(req.body, 'label') ? req.body.label : 'added in Settings';
    if (typeof requestedLabel !== 'string' || !requestedLabel.trim() || requestedLabel.trim().length > 80) {
      return refuse(req, res, 400, 'bad label', 'A key label must be between 1 and 80 characters.');
    }
    try {
      const saved = providerKeys.put(ownKeyScope(req), providerId, key, { label: requestedLabel, by: req.user.id });
      audit(req.user.id, 'provider_key_saved', req, scrubSecrets(`${providerId} ${saved.label} ${saved.fingerprint}${saved.rotated ? ' (replaced)' : ''}`));
      res.json({ provider: providerId, label: saved.label, fingerprint: saved.fingerprint, rotated: saved.rotated });
    } catch (error) {
      const limit = error.code === 'KEY_LIMIT';
      return refuse(req, res, limit ? 409 : 400, limit ? 'key limit' : 'store refused', error.message);
    }
  });

  app.delete('/api/ai/keys/:provider', auth, writeLimiter, (req, res) => {
    const providerId = keyableProvider(req.params.provider);
    if (!providerId) return refuse(req, res, 400, 'no such provider', 'That provider does not take a key.');
    const label = req.query.label == null ? req.body?.label : req.query.label;
    if (label != null && (typeof label !== 'string' || !label.trim() || label.trim().length > 80)) {
      return refuse(req, res, 400, 'bad label', 'A key label must be between 1 and 80 characters.');
    }
    const { revoked } = providerKeys.revoke(ownKeyScope(req), providerId, req.user.id, { label });
    audit(req.user.id, revoked ? 'provider_key_removed' : 'provider_key_remove_nothing', req, scrubSecrets(`${providerId}${label ? ` ${label.trim()}` : ''}`));
    res.json({ provider: providerId, ...(label ? { label: label.trim() } : {}), removed: revoked });
  });
}

module.exports = { mountKeyVaultRoutes, KEY_WRITE_WINDOW_MS, KEY_WRITE_MAX };
