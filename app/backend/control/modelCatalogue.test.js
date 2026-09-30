'use strict';

// The catalogue, discovery, and the rule that keeps them apart.
//
// Before this, three hard-coded arrays decided which models existed, and on
// 2026-09-25 they offered `gpt-4o` and `gemini-1.5-pro` — two generations out
// of date — and priced Claude Sonnet 5 at Claude Sonnet 4.6's rate. Nothing in
// the product could notice, because a hard-coded list has no way to be wrong.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createModelCatalogue } = require('./modelCatalogue.js');
const { createProviderModels } = require('./providerModels.js');
const { offerFor } = require('./modelOffer.js');

function scratch() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-'));
}
function writeOverride(dir, value) {
  fs.writeFileSync(path.join(dir, 'model-catalogue.json'), JSON.stringify(value));
}

// ── The shipped catalogue ──────────────────────────────────────────
test('the shipped catalogue loads, names its date, and has no complaints', () => {
  const c = createModelCatalogue();
  assert.match(c.asOf(), /^\d{4}-\d{2}-\d{2}$/, 'a catalogue has to say how old it is');
  assert.deepEqual(c.problems(), [], 'the shipped file must be valid on its own terms');
  for (const id of ['anthropic', 'openai', 'gemini', 'xai']) {
    assert.ok(c.modelsFor(id).length > 0, `${id} needs models`);
  }
});

test('prices match the providers own published rates, including the one that was wrong', () => {
  const c = createModelCatalogue();
  // The defect that started this: Sonnet 5 was priced at Sonnet 4.6's rate.
  assert.deepEqual(c.priceOf('anthropic', 'claude-sonnet-5'), { input: 2, output: 10 });
  assert.deepEqual(c.priceOf('anthropic', 'claude-opus-5'), { input: 5, output: 25 });
  assert.deepEqual(c.priceOf('anthropic', 'claude-opus-5-5'), { input: 4, output: 20 });
  assert.deepEqual(c.priceOf('anthropic', 'claude-fable-5-1'), { input: 10, output: 50 });
  assert.deepEqual(c.priceOf('anthropic', 'claude-haiku-4-5'), { input: 1, output: 5 });
});

test('the generations that were stale are gone and the current ones are present', () => {
  const c = createModelCatalogue();
  const ids = p => c.modelsFor(p).map(m => m.id);
  for (const dead of ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1-mini']) {
    assert.ok(!ids('openai').includes(dead), `${dead} is two generations old and must not ship`);
  }
  for (const dead of ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash']) {
    assert.ok(!ids('gemini').includes(dead), `${dead} is retired and must not ship`);
  }
  assert.ok(ids('anthropic').includes('claude-opus-5-5'), 'Opus 5.5 exists and was missing');
  assert.ok(ids('anthropic').includes('claude-fable-5-1'), 'Fable 5.1 exists and was missing');
  assert.ok(ids('xai').includes('grok-4.7'), 'xAI was absent from the panel entirely');
});

test('a missing price is null, never zero', () => {
  const dir = scratch();
  writeOverride(dir, { providers: { anthropic: { models: [{ id: 'priceless-1' }] } } });
  const c = createModelCatalogue({ dataDir: dir });
  assert.strictEqual(c.priceOf('anthropic', 'priceless-1'), null, 'unknown must not read as free');
});

// ── The operator override: updatable without a release ─────────────
test('an operator adds a model without a release, and it wins over the shipped entry', () => {
  const dir = scratch();
  writeOverride(dir, {
    as_of: '2027-01-01',
    providers: {
      anthropic: { models: [
        { id: 'claude-sonnet-5', display: 'Claude Sonnet 5', input_per_mtok: 1.5, output_per_mtok: 8 },
        { id: 'claude-next-9', display: 'Claude Next 9', input_per_mtok: 1, output_per_mtok: 2 },
      ] },
    },
  });
  const c = createModelCatalogue({ dataDir: dir });
  assert.strictEqual(c.asOf(), '2027-01-01', 'the override dates the catalogue');
  assert.deepEqual(c.priceOf('anthropic', 'claude-sonnet-5'), { input: 1.5, output: 8 }, 'a price change needs no release');
  assert.ok(c.model('anthropic', 'claude-next-9'), 'a new model needs no release');
  assert.ok(c.model('anthropic', 'claude-opus-5'), 'models the override did not mention survive');
});

test('an override can introduce a provider the shipped file has never heard of', () => {
  const dir = scratch();
  writeOverride(dir, { providers: { newcloud: { label: 'New Cloud', models: [{ id: 'nc-1', input_per_mtok: 1, output_per_mtok: 2 }] } } });
  const c = createModelCatalogue({ dataDir: dir });
  assert.ok(c.providerIds().includes('newcloud'));
  assert.strictEqual(c.model('newcloud', 'nc-1').display, 'nc-1', 'a display name defaults to the id');
});

test('a broken override never takes the panel down', () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'model-catalogue.json'), '{ this is not json');
  const c = createModelCatalogue({ dataDir: dir });
  assert.ok(c.modelsFor('anthropic').length > 0, 'the shipped catalogue still answers');
  assert.ok(c.problems().some(p => /not valid JSON/.test(p)), 'and the operator is told why theirs was ignored');
});

test('rubbish entries are dropped and named rather than guessed at', () => {
  const dir = scratch();
  writeOverride(dir, { providers: { anthropic: { models: [
    { id: 'bad-price', input_per_mtok: 'free', output_per_mtok: 1 },
    { id: 'bad-context', context: -5 },
    { display: 'no id at all' },
  ] } } });
  const c = createModelCatalogue({ dataDir: dir });
  assert.strictEqual(c.model('anthropic', 'bad-price'), null);
  assert.strictEqual(c.model('anthropic', 'bad-context'), null);
  assert.strictEqual(c.problems().length, 3, 'each one is reported');
  assert.ok(c.modelsFor('anthropic').length > 0, 'the good entries are unaffected');
});

// ── Discovery: the customer's own key answers ──────────────────────
function fakeFetch(handler) { return async (url, opts) => handler(url, opts); }
const okJson = body => ({ ok: true, status: 200, json: async () => body });

test('each provider list shape is read correctly', async () => {
  const pm = createProviderModels({ fetchImpl: fakeFetch(async url => {
    if (url.startsWith('https://api.openai.com')) return okJson({ data: [{ id: 'gpt-6-sol' }, { id: 'gpt-6-luna' }] });
    if (url.startsWith('https://api.anthropic.com')) return okJson({ data: [{ id: 'claude-opus-5', max_input_tokens: 1000000, max_tokens: 128000, display_name: 'Claude Opus 5' }] });
    if (url.startsWith('https://generativelanguage')) return okJson({ models: [{ name: 'models/gemini-3.8-flash' }] });
    throw new Error('unexpected url');
  }) });

  const openai = await pm.discover({ style: 'openai', url: 'https://api.openai.com/v1/models' }, 'k');
  assert.deepEqual(openai.models, ['gpt-6-sol', 'gpt-6-luna']);

  const anthropic = await pm.discover({ style: 'anthropic', url: 'https://api.anthropic.com/v1/models' }, 'k');
  assert.deepEqual(anthropic.models, ['claude-opus-5']);
  assert.strictEqual(anthropic.detail.get('claude-opus-5').context, 1000000, 'the provider own limits are read');

  const gemini = await pm.discover({ style: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' }, 'k');
  assert.deepEqual(gemini.models, ['gemini-3.8-flash'], 'the models/ prefix is not part of the id');
});

test('the gemini key travels in the query string, and other providers in a header', async () => {
  let seenUrl = null; let seenHeaders = null;
  const pm = createProviderModels({ fetchImpl: fakeFetch(async (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return okJson({ models: [] }); }) });
  await pm.discover({ style: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' }, 'secret-key');
  assert.match(seenUrl, /key=secret-key/);
  const pm2 = createProviderModels({ fetchImpl: fakeFetch(async (url, opts) => { seenHeaders = opts.headers; return okJson({ data: [] }); }) });
  await pm2.discover({ style: 'anthropic', url: 'https://api.anthropic.com/v1/models' }, 'secret-key');
  assert.strictEqual(seenHeaders['x-api-key'], 'secret-key');
  assert.ok(seenHeaders['anthropic-version'], 'the version header is required by that API');
});

test('a refused key and an unreachable provider are different facts, and neither is an empty list', async () => {
  const refused = createProviderModels({ fetchImpl: fakeFetch(async () => ({ ok: false, status: 401, json: async () => ({}) })) });
  const a = await refused.discover({ style: 'openai', url: 'https://api.openai.com/v1/models' }, 'k');
  assert.strictEqual(a.ok, false);
  assert.match(a.reason, /refused this key/);

  const down = createProviderModels({ fetchImpl: fakeFetch(async () => { throw new Error('ECONNREFUSED'); }) });
  const b = await down.discover({ style: 'openai', url: 'https://api.openai.com/v1/models' }, 'k');
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /could not be reached/);
});

// ── The rule: documentation is not permission ──────────────────────
test('only models the customer key reports are offered', () => {
  const c = createModelCatalogue();
  const discovered = { ok: true, models: ['claude-opus-5'], detail: new Map() };
  const offer = offerFor({ catalogue: c, providerId: 'anthropic', discovered });
  const offered = offer.models.filter(m => m.offered).map(m => m.id);
  assert.deepEqual(offered, ['claude-opus-5'], 'the documented rest must not be offered');
  const fable = offer.models.find(m => m.id === 'claude-fable-5-1');
  assert.strictEqual(fable.offered, false, 'documented but not reachable on this key');
  assert.strictEqual(fable.documented, true, 'and still described, so the panel can say why');
});

test('a model the key reports but we have never documented is still offered', () => {
  const c = createModelCatalogue();
  const discovered = { ok: true, models: ['claude-unheard-of-7'], detail: new Map() };
  const offer = offerFor({ catalogue: c, providerId: 'anthropic', discovered });
  const found = offer.models.find(m => m.id === 'claude-unheard-of-7');
  assert.strictEqual(found.offered, true, 'the provider is the authority on what exists');
  assert.strictEqual(found.documented, false, 'and we admit we have no metadata for it');
  assert.strictEqual(found.input_per_mtok, null, 'rather than inventing a price');
});

test('a provider we could not ask describes rather than promises', () => {
  const c = createModelCatalogue();
  const offer = offerFor({ catalogue: c, providerId: 'anthropic', discovered: { ok: false, reason: 'the provider could not be reached: timeout' } });
  assert.strictEqual(offer.state, 'unconfirmed');
  assert.ok(offer.models.every(m => m.offered === false), 'nothing is promised on our word alone');
  assert.ok(offer.models.every(m => m.documented === true), 'but the customer still sees what exists');
  assert.match(offer.reason, /could not be reached/);
});

test('tested is its own fact, separate from documented and available', () => {
  const c = createModelCatalogue();
  const discovered = { ok: true, models: ['claude-opus-5', 'claude-sonnet-5'], detail: new Map() };
  const offer = offerFor({ catalogue: c, providerId: 'anthropic', discovered, tested: new Set(['claude-opus-5']) });
  const opus = offer.models.find(m => m.id === 'claude-opus-5');
  const sonnet = offer.models.find(m => m.id === 'claude-sonnet-5');
  assert.deepEqual([opus.documented, opus.available, opus.tested], [true, true, true]);
  assert.deepEqual([sonnet.documented, sonnet.available, sonnet.tested], [true, true, false],
    'reachable is not the same as proved, and the panel must not conflate them');
});

test('the provider own context window beats our written-down one', () => {
  const c = createModelCatalogue();
  const discovered = { ok: true, models: ['claude-haiku-4-5'], detail: new Map([['claude-haiku-4-5', { context: 400000, max_output: 99 }]]) };
  const offer = offerFor({ catalogue: c, providerId: 'anthropic', discovered });
  const haiku = offer.models.find(m => m.id === 'claude-haiku-4-5');
  assert.strictEqual(haiku.context, 400000, 'the live answer wins over the document');
});

// ── No second source of truth ──────────────────────────────────────
//
// The catalogue only helps if nothing else still carries its own list. These
// read the shipped source and fail if a hard-coded model array comes back, or
// if the routing defaults name a model the catalogue has never heard of —
// which is how the old defaults came to point at gpt-4o and gemini-2.0-flash
// for two generations without anything complaining.

const SRC = path.resolve(__dirname, '../..');

test('the panel carries no hard-coded model arrays any more', () => {
  const panel = fs.readFileSync(path.join(SRC, 'frontend/control-panel.jsx'), 'utf8');
  const providersBlock = panel.slice(panel.indexOf('export const PROVIDERS = ['));
  const firstList = providersBlock.slice(0, providersBlock.indexOf('];'));
  assert.ok(!/models:\s*\[/.test(firstList),
    'a models array in PROVIDERS is a list that cannot be updated without a release');
});

test('every routing default names a model the catalogue knows', () => {
  const c = createModelCatalogue();
  const gateway = require('./residentGateway.js');
  const known = new Set();
  for (const providerId of c.providerIds()) {
    for (const m of c.modelsFor(providerId)) known.add(`${providerId}/${m.id}`);
  }
  // Providers the catalogue does not cover yet are not this test's business.
  const covered = new Set(c.providerIds());
  const unknown = [];
  for (const [role, prefs] of Object.entries(gateway.ROLE_ROUTES)) {
    for (const [providerId, modelId] of prefs) {
      if (!covered.has(providerId)) continue;
      if (!known.has(`${providerId}/${modelId}`)) unknown.push(`${role}: ${providerId}/${modelId}`);
    }
  }
  assert.deepEqual(unknown, [], 'a routing preference for a model nobody documents is skipped in silence');
});

test('the retired ids are gone from the routing defaults too', () => {
  const gateway = require('./residentGateway.js');
  const flat = JSON.stringify(gateway.ROLE_ROUTES);
  for (const dead of ['gpt-4o', 'gemini-2.0-flash', 'gemini-1.5-pro', 'o1-mini']) {
    assert.ok(!flat.includes(`"${dead}"`), `${dead} is retired and must not be a default`);
  }
});

test('a model this panel has actually called is offered even when the listing omits it', () => {
  // Found live: Anthropic lists claude-haiku-4-5-20251001 while the alias
  // claude-haiku-4-5 is what answers, so the listing is not an exhaustive
  // index of what a key can call. Proof beats both the catalogue and the list.
  const c = createModelCatalogue();
  const discovered = { ok: true, models: ['claude-opus-5'], detail: new Map() };
  const offer = offerFor({ catalogue: c, providerId: 'anthropic', discovered, tested: new Set(['claude-haiku-4-5']) });
  const haiku = offer.models.find(m => m.id === 'claude-haiku-4-5');
  assert.strictEqual(haiku.tested, true);
  assert.strictEqual(haiku.available, false, 'the listing still did not name it, and we do not pretend otherwise');
  assert.strictEqual(haiku.offered, true, 'but a call that returned is proof enough to offer it');
});
