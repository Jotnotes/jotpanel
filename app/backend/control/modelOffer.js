'use strict';

// What the panel offers a customer, and why.
//
// Three facts, three owners, deliberately not merged into one list until the
// last moment:
//
//   catalogue  — ours: what the provider documents.
//   available  — theirs: what their key reached, last time we asked.
//   tested     — observed: what this panel has actually called successfully.
//
// The rule this file exists to hold: **a model is offered only when the
// customer's own key reports it.** The catalogue can describe a model that the
// account cannot touch, and the provider can expose one we have never heard of.
// Offering on the strength of our document would put models in the picker that
// return 404 on first use, which is the failure the old hard-coded list had.
//
// A provider we could not ask is not the same as a provider with nothing. When
// discovery fails the catalogue is offered, flagged `unconfirmed`, because
// leaving somebody with an empty picker over a network blip is worse than
// showing them what the documentation says while telling them we could not
// check.

function offerFor({ catalogue, providerId, discovered = null, tested = new Set() }) {
  const provider = catalogue.provider(providerId);
  if (!provider) return { provider: null, models: [], state: 'unknown-provider' };

  const described = new Map(provider.models.map(m => [m.id, m]));

  // Never asked, or asked and refused: describe, do not promise.
  if (!discovered || discovered.ok !== true) {
    return {
      provider: { id: provider.id, label: provider.label, docs: provider.docs },
      state: discovered ? 'unconfirmed' : 'not-checked',
      reason: discovered ? discovered.reason : null,
      models: provider.models.map(m => ({
        ...m, available: false, documented: true, tested: tested.has(m.id), offered: false,
      })),
    };
  }

  const live = new Set(discovered.models || []);
  const detail = discovered.detail instanceof Map ? discovered.detail : new Map();
  const models = [];

  for (const id of live) {
    const doc = described.get(id) || null;
    const extra = detail.get(id) || {};
    models.push({
      id,
      display: extra.display || doc?.display || id,
      // The provider's own numbers win where it gives them; ours fill the gaps.
      context: extra.context ?? doc?.context ?? null,
      max_output: extra.max_output ?? doc?.max_output ?? null,
      input_per_mtok: doc?.input_per_mtok ?? null,
      output_per_mtok: doc?.output_per_mtok ?? null,
      capabilities: doc?.capabilities ?? [],
      notes: doc?.notes ?? null,
      // A model the key reaches that we have never documented is still usable,
      // and is shown as such rather than hidden: the provider is the authority
      // on what exists, and our catalogue is allowed to be behind.
      documented: !!doc,
      available: true,
      tested: tested.has(id),
      offered: true,
    });
  }

  // Documented models the key did NOT report. Kept in the answer so the panel
  // can say "your plan does not include this" rather than quietly losing it.
  //
  // With one exception, found on a live box on 2026-09-25: a model this panel
  // has actually called is offered whether or not the list names it. Anthropic
  // lists `claude-haiku-4-5-20251001` while `claude-haiku-4-5` is the alias
  // that answers, so the list is not an exhaustive index of what a key can
  // call. A successful call is stronger evidence than an entry in a catalogue
  // and stronger than an entry in a listing, and refusing to offer a model we
  // have demonstrably used would be the panel disbelieving its own proof.
  for (const [id, doc] of described) {
    if (live.has(id)) continue;
    const proved = tested.has(id);
    models.push({ ...doc, documented: true, available: false, tested: proved, offered: proved });
  }

  models.sort((a, b) => (Number(b.offered) - Number(a.offered)) || a.id.localeCompare(b.id));
  return {
    provider: { id: provider.id, label: provider.label, docs: provider.docs },
    state: 'confirmed',
    reason: null,
    models,
  };
}

module.exports = { offerFor };
