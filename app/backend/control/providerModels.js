'use strict';

// What this customer's key can actually reach.
//
// The catalogue says what a model is. It cannot say what any particular account
// is allowed to call: that depends on the customer's plan, their region, their
// provider's rollout, and it changes without anybody telling us. Only the
// provider can answer it, so we ask them, with the customer's own key.
//
// This is why the panel does not need Steve's keys to stay current, and why a
// model being in the catalogue is never on its own a reason to offer it.

const ANTHROPIC_VERSION = '2023-06-01';
const TIMEOUT_MS = 12000;

// Each provider publishes its own list in its own shape. Three shapes cover the
// four providers; a new one is a case here rather than a change anywhere else.
const STYLES = {
  openai: {
    headers: key => ({ Authorization: `Bearer ${key}` }),
    parse: body => (Array.isArray(body?.data) ? body.data.map(m => m && m.id).filter(Boolean) : []),
  },
  anthropic: {
    headers: key => ({ 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }),
    // The Anthropic list carries the context window and output cap, so where it
    // does, the live answer is better than our written-down one.
    parse: body => (Array.isArray(body?.data) ? body.data.map(m => m && m.id).filter(Boolean) : []),
    detail: body => new Map((body?.data || [])
      .filter(m => m && m.id)
      .map(m => [m.id, { context: m.max_input_tokens ?? null, max_output: m.max_tokens ?? null, display: m.display_name || null }])),
  },
  gemini: {
    // Google takes the key on the query string and prefixes every name with
    // "models/", which is not the string anyone calls the model by.
    url: (url, key) => `${url}?key=${encodeURIComponent(key)}&pageSize=200`,
    headers: () => ({}),
    parse: body => (Array.isArray(body?.models) ? body.models
      .map(m => m && typeof m.name === 'string' ? m.name.replace(/^models\//, '') : null)
      .filter(Boolean) : []),
  },
};

function createProviderModels({ fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  // Returns { ok, models, detail, reason }. A failure is always a reason, never
  // an empty list: "your provider did not answer" and "your key can reach
  // nothing" look identical to a caller that only gets an array back, and the
  // first must not silently empty somebody's model picker.
  async function discover(discovery, apiKey) {
    if (!discovery || !discovery.style || !discovery.url) {
      return { ok: false, models: [], detail: new Map(), reason: 'this provider publishes no model list' };
    }
    const style = STYLES[discovery.style];
    if (!style) return { ok: false, models: [], detail: new Map(), reason: `no way to read a ${discovery.style} model list` };
    if (!apiKey) return { ok: false, models: [], detail: new Map(), reason: 'no key for this provider' };

    const url = style.url ? style.url(discovery.url, apiKey) : discovery.url;
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...style.headers(apiKey) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { ok: false, models: [], detail: new Map(), reason: `the provider could not be reached: ${error.message}` };
    }
    if (!response.ok) {
      // 401 and 403 are the key being wrong or unentitled, which is worth
      // saying plainly rather than reporting as an outage.
      const reason = response.status === 401 || response.status === 403
        ? 'the provider refused this key'
        : `the provider answered ${response.status}`;
      return { ok: false, models: [], detail: new Map(), reason };
    }
    let body;
    try { body = await response.json(); }
    catch { return { ok: false, models: [], detail: new Map(), reason: 'the provider sent something that is not JSON' }; }

    const models = style.parse(body);
    const detail = style.detail ? style.detail(body) : new Map();
    return { ok: true, models, detail, reason: null };
  }

  return { discover, styles: Object.keys(STYLES) };
}

module.exports = { createProviderModels, STYLES };
