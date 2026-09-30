'use strict';

// Echo files proposals against the same closed catalogue the MCP gateway uses.
//
// Until now the assistant could only act on thirteen hand-written phrasings out
// of a hundred and ten operations, so almost every request came back as
// directions to a screen. This is not a second action system: the model picks an
// operation id and its parameters, and `serverOps.propose` — the one the gateway
// and the panel's own buttons call — validates the operation, the parameters,
// the capability and the person's permission all over again. Nothing here
// executes anything.
//
// The trust boundary this moves is recorded in ~/docs/VACP_PROPOSAL_PIPELINE.md.
// The short version: a proposal is inert, an outside AI connected over MCP has
// always been allowed to file one, and the person still approves in Activity
// with the exact strings in front of them.

// The operation list handed to the model is generated from the catalogue, never
// kept by hand, because a hand-kept list drifts and then the assistant offers
// operations the panel does not have.
const PARAM = /\bp\.([a-zA-Z_][A-Za-z0-9_]*)/g;

// A secret is never asked of the model and never asked of the person through the
// model. Where the operation can make its own, the panel makes it and shows it
// once; where it cannot, the operation is not offered to the assistant at all.
// `key` is deliberately not here: an SSH public key is not a secret and only the
// person has it. Matching is on the whole parameter name, so `apiKeyLabel` or
// `tokenName` is not swept up by accident.
const SECRET = /^(password|passphrase|secret|token|api_?key|private_?key)$/i;

function isSecret(name) { return SECRET.test(name); }

function paramsOf(operation) {
  const source = String(operation.normalize || '');
  const generated = new Set(Array.isArray(operation.generates) ? operation.generates : []);
  const withheld = new Set();
  const seen = new Map();
  let match;
  while ((match = PARAM.exec(source))) {
    const name = match[1];
    if (generated.has(name) || seen.has(name)) continue;
    // A secret the operation cannot generate is recorded, not listed: it is what
    // makes the operation unofferable rather than something to ask for.
    if (isSecret(name)) { withheld.add(name); continue; }
    // The catalogue writes an optional parameter as a guard: `p.quotaMb ? … : null`.
    // Anything it reads unguarded is required, and omitting it throws in normalize.
    const optional = new RegExp(`\\bp\\.${name}\\s*(\\?|\\|\\||\\?\\?)`).test(source);
    seen.set(name, optional);
  }
  return {
    required: [...seen].filter(([, optional]) => !optional).map(([name]) => name),
    optional: [...seen].filter(([, optional]) => optional).map(([name]) => name),
    generated: [...generated],
    // Secrets the box generates for this operation; the server asks for them by
    // name when it files the proposal, so the model never handles one.
    generate: [...generated].filter(isSecret),
    // Secrets with nowhere to come from. An operation with any of these cannot
    // be offered to the assistant.
    withheld: [...withheld],
  };
}

function describeOperations(operations) {
  return operations.map(operation => ({
    id: operation.id,
    summary: typeof operation.summary === 'function' ? null : operation.summary || null,
    ...paramsOf(operation),
  }));
}

// One line per operation, short enough that a hundred of them do not swamp the
// request. Server-generated parameters are not listed: asking a person for a
// password the box is about to invent is how the mailbox form went wrong.
function offerable(operation) { return operation.withheld.length === 0; }

function catalogueForPrompt(operations, allowed) {
  const permitted = allowed ? new Set(allowed) : null;
  return describeOperations(operations)
    .filter(offerable)
    .filter(operation => !permitted || permitted.has(operation.id))
    .map(operation => {
      const parts = [operation.id];
      if (operation.required.length) parts.push(`needs: ${operation.required.join(', ')}`);
      if (operation.optional.length) parts.push(`optional: ${operation.optional.join(', ')}`);
      return `- ${parts.join(' | ')}`;
    })
    .join('\n');
}

// The model answers with one fenced block and nothing else that acts. Every
// provider can produce a fenced block, which is why this is not built on one
// vendor's tool-calling: the panel routes to anthropic, openai, ollama and the
// rest, and the assistant has to behave the same on all of them.
const BLOCK = /```jotpanel-proposal\s*([\s\S]*?)```/i;

function extractProposal(reply) {
  const text = String(reply == null ? '' : reply);
  const found = text.match(BLOCK);
  if (!found) return { proposal: null, text, malformed: false };
  const cleaned = text.replace(BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
  let parsed = null;
  try { parsed = JSON.parse(found[1].trim()); } catch { parsed = null; }
  const operation = parsed && typeof parsed.operation === 'string' ? parsed.operation : null;
  if (!operation) return { proposal: null, text: cleaned, malformed: true };
  const input = parsed.input && typeof parsed.input === 'object' && !Array.isArray(parsed.input) ? parsed.input : {};
  return { proposal: { operation, input }, text: cleaned, malformed: false };
}

// A refusal is never silent. The person asked for something and must be told it
// was not filed, in a sentence, with the reason the server gave.
function refusalLine(reason) {
  const detail = String(reason || '').trim();
  return detail ? `I could not put that in Activity: ${detail}` : 'I could not put that in Activity.';
}

function promptRules(catalogue) {
  return [
    'When the person asks you to change something on this server, do not explain the screens. Answer with one fenced block and nothing else:',
    '```jotpanel-proposal',
    '{"operation": "mail.mailbox.create", "input": {"domain": "example.com", "account": "sales"}}',
    '```',
    'The panel turns that block into a proposal the person approves in Activity. It runs nothing by itself.',
    'Use only an operation id from this list, exactly as written. Never invent one, and never invent a parameter name:',
    catalogue,
    'If a parameter the operation needs is missing from what they told you, do not guess it and do not send a block. Ask one short question for that one thing.',
    'Leave out an optional parameter you were not given. The panel fills it with its own default and shows it on the proposal.',
    'Never put a password or any other secret in the block. The panel generates those itself.',
    'If they asked a question rather than for a change — how something works, where a screen is — answer it in plain words with no block.',
  ].join('\n');
}

module.exports = { paramsOf, describeOperations, catalogueForPrompt, offerable, isSecret, extractProposal, refusalLine, promptRules };
