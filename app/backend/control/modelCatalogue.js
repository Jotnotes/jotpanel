'use strict';

// What a model is, kept apart from what a customer may use.
//
// The model list used to be three hard-coded arrays — one in the panel's
// JavaScript, one in the backend's provider map, one in a pricing table — so a
// new model, a retired model or a price change meant a release, and the three
// drifted apart between releases. On 2026-09-25 the shipped panel offered
// `gpt-4o` and `gemini-1.5-pro` (two generations out of date), priced Claude
// Sonnet 5 at Sonnet 4.6's rate, and had no way to say any of it was stale.
//
// Three different questions were being answered by one list, and they have
// different answers and different owners:
//
//   catalogue  — what the provider documents: id, name, price, limits,
//                capabilities. Ours to maintain, updatable without a release.
//   available  — what THIS customer's key can actually reach, which only their
//                provider can answer, and which changes without telling us.
//   tested     — what this panel has actually called successfully. Ours to
//                observe, never to assume.
//
// This file owns the first. `providerModels.js` asks the second. The third is
// recorded when a call succeeds. Nothing offers a model on the strength of the
// catalogue alone, because a document is not a permission.

const fs = require('fs');
const path = require('path');

const SHIPPED = path.join(__dirname, 'modelCatalogue.json');
const OVERRIDE_NAME = 'model-catalogue.json';

const PRICE_FIELDS = ['input_per_mtok', 'output_per_mtok'];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// A malformed entry is dropped and named, never guessed at. A catalogue that
// silently repairs itself is a catalogue nobody can trust to be what it says.
function validateModel(providerId, model, complain) {
  const where = `${providerId}/${model && model.id ? model.id : '(no id)'}`;
  if (!model || typeof model.id !== 'string' || !model.id.trim()) {
    complain(`${where}: a model needs an id`);
    return null;
  }
  for (const field of PRICE_FIELDS) {
    const value = model[field];
    if (value != null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      complain(`${where}: ${field} must be a non-negative number, or absent`);
      return null;
    }
  }
  for (const field of ['context', 'max_output']) {
    const value = model[field];
    if (value != null && (!Number.isInteger(value) || value <= 0)) {
      complain(`${where}: ${field} must be a positive whole number, or absent`);
      return null;
    }
  }
  if (model.capabilities != null && !Array.isArray(model.capabilities)) {
    complain(`${where}: capabilities must be a list`);
    return null;
  }
  return {
    id: model.id.trim(),
    display: typeof model.display === 'string' && model.display.trim() ? model.display.trim() : model.id.trim(),
    input_per_mtok: model.input_per_mtok ?? null,
    output_per_mtok: model.output_per_mtok ?? null,
    context: model.context ?? null,
    max_output: model.max_output ?? null,
    capabilities: Array.isArray(model.capabilities) ? model.capabilities.slice() : [],
    notes: typeof model.notes === 'string' ? model.notes : null,
  };
}

// The override replaces a model outright rather than merging field by field:
// half of an old price and half of a new one is a number that was never true
// anywhere. A provider the override introduces is added whole.
function mergeProvider(base, extra) {
  const merged = { ...(base || {}), ...(extra || {}) };
  const byId = new Map((base?.models || []).map(m => [m.id, m]));
  // Entries with no usable id cannot be merged by id, but they are still
  // carried through so validation can name them. Dropping them here instead
  // would leave an operator staring at a file where one entry does nothing and
  // nothing anywhere says why.
  const unnamed = [];
  for (const model of extra?.models || []) {
    if (model && typeof model.id === 'string' && model.id.trim()) byId.set(model.id.trim(), model);
    else unnamed.push(model);
  }
  merged.models = [...byId.values(), ...unnamed];
  return merged;
}

function createModelCatalogue({ dataDir = null, shippedFile = SHIPPED, log = () => {} } = {}) {
  const problems = [];
  const complain = message => { problems.push(message); log(`[catalogue] ignored: ${message}`); };

  let shipped;
  try { shipped = readJson(shippedFile); }
  catch (error) { throw new Error(`the shipped model catalogue could not be read: ${error.message}`); }

  let override = null;
  const overridePath = dataDir ? path.join(dataDir, OVERRIDE_NAME) : null;
  if (overridePath && fs.existsSync(overridePath)) {
    // An operator's edit must never be able to take the panel down. A broken
    // override is reported and ignored; the shipped catalogue still answers.
    try { override = readJson(overridePath); }
    catch (error) { complain(`${OVERRIDE_NAME} is not valid JSON and was ignored: ${error.message}`); }
  }

  const providerIds = new Set([
    ...Object.keys(shipped.providers || {}),
    ...Object.keys(override?.providers || {}),
  ]);

  const providers = {};
  for (const id of providerIds) {
    const merged = mergeProvider(shipped.providers?.[id], override?.providers?.[id]);
    const seen = new Set();
    const models = [];
    for (const raw of merged.models || []) {
      const model = validateModel(id, raw, complain);
      if (!model) continue;
      if (seen.has(model.id)) { complain(`${id}/${model.id}: listed twice`); continue; }
      seen.add(model.id);
      models.push(model);
    }
    providers[id] = {
      id,
      label: merged.label || id,
      docs: merged.docs || null,
      pricing_docs: merged.pricing_docs || null,
      discovery: merged.discovery || null,
      models,
    };
  }

  const asOf = (override && override.as_of) || shipped.as_of || null;

  return {
    asOf: () => asOf,
    overriddenBy: () => (override ? overridePath : null),
    problems: () => problems.slice(),
    providerIds: () => Object.keys(providers),
    provider: id => providers[id] || null,
    modelsFor: id => (providers[id] ? providers[id].models.slice() : []),
    model: (providerId, modelId) =>
      (providers[providerId]?.models || []).find(m => m.id === modelId) || null,
    // Price per million tokens, or null where the provider does not publish one.
    // Null is returned as null and never as zero: a missing price shown as free
    // is the kind of wrong that costs somebody money.
    priceOf(providerId, modelId) {
      const model = this.model(providerId, modelId);
      if (!model) return null;
      if (model.input_per_mtok == null || model.output_per_mtok == null) return null;
      return { input: model.input_per_mtok, output: model.output_per_mtok };
    },
    discoveryFor: id => providers[id]?.discovery || null,
  };
}

module.exports = { createModelCatalogue, OVERRIDE_NAME };
