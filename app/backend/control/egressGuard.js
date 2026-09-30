'use strict';

// ── What leaves the box (Stage 4) ────────────────────────────────
//
// Settled decision 1: only the sanitised work brief and the project context it
// needs leave the customer side. A specialist (design, coding, research,
// reasoning, mechanical) gets a brief written from the ledger and the current
// request, never the transcript. A plain conversation, or a model the person
// chose by hand, gets the recent conversation. Either way secrets are removed
// by value before anything is sent, and the last check refuses a payload that
// still holds one.

const SECRET_VALUES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bgsk_[A-Za-z0-9]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
const LABELLED_SECRET = /\b(password|passwd|pwd|passphrase|secret|token|api[ _-]?key(?: provided)?)(\s*(?:is|[:=])\s*)(\S{6,})/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{2,4}[\s.-]\d{2,4}[\s.-]\d{2,4}\b/g;

const SPECIALIST_ROLES = new Set(['design', 'reasoning', 'coding', 'research', 'mechanical']);
const KEEP_MESSAGES = 12;

function scrubSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const pattern of SECRET_VALUES) out = out.replace(pattern, '[secret removed]');
  return out.replace(LABELLED_SECRET, (_, label, joiner) => `${label}${joiner}[secret removed]`);
}

function scrubContacts(text) {
  return String(text == null ? '' : text).replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

function holdsSecret(text) {
  const value = String(text == null ? '' : text);
  return SECRET_VALUES.some(pattern => { pattern.lastIndex = 0; return pattern.test(value); })
    || new RegExp(LABELLED_SECRET.source, 'i').test(value.replace(/\[secret removed\]/g, ''));
}

function contentOf(message) {
  return typeof (message && message.content) === 'string' ? message.content : '';
}

// The brief for a specialist, from the ledger's slice of the project and the
// person's current request. Returns the messages to send and the named fields
// they were built from, which is what the dispatch record keeps hashes of.
function prepareOutbound({ role, explicit = false, system = '', messages = [], project = null }) {
  if (explicit || !SPECIALIST_ROLES.has(role)) {
    const conversation = messages.slice(-KEEP_MESSAGES).map(message => ({ ...message, content: scrubSecrets(contentOf(message)) }));
    return { kind: 'conversation', messages: conversation, fields: { system, conversation } };
  }
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  const lastIndex = messages.lastIndexOf(lastUser);
  const previous = [...messages.slice(0, lastIndex)].reverse().find(message => message.role === 'assistant');
  const line = item => scrubContacts(scrubSecrets([item.title, item.text].filter(Boolean).join(': ')));
  const fields = {
    system,
    project: project ? scrubContacts(scrubSecrets(project.name || '')) : '',
    rules: project ? [...project.rules.decisions, ...project.rules.constraints].map(line) : [],
    requirements: project ? project.requirements.map(line) : [],
    previous: previous ? scrubContacts(scrubSecrets(contentOf(previous))).slice(0, 1500) : '',
    request: scrubSecrets(contentOf(lastUser)),
  };
  const brief = [
    fields.project && `Project: ${fields.project}`,
    fields.rules.length && `Rules that must hold:\n${fields.rules.map(rule => `- ${rule}`).join('\n')}`,
    fields.requirements.length && `Open requirements:\n${fields.requirements.map(item => `- ${item}`).join('\n')}`,
    fields.previous && `Your previous reply, for reference:\n${fields.previous}`,
    `The request:\n${fields.request}`,
  ].filter(Boolean).join('\n\n');
  return { kind: 'brief', messages: [{ role: 'user', content: brief }], fields };
}

// The last look before sending. Nothing that still holds a secret goes out.
function assertClean(messages) {
  for (const message of messages) {
    if (holdsSecret(contentOf(message))) {
      const error = new Error('A secret was still in the message, so nothing was sent');
      error.code = 'EGRESS_SECRET';
      throw error;
    }
  }
  return messages;
}

// What the panel sends the hosted engine: the fields the engine reads, and
// nothing else from the browser's request (which carries the person's keys).
function hostedBody(body = {}, { messages, context } = {}) {
  return {
    mode: body.mode || null,
    messages: messages || body.messages || [],
    stream: !!body.stream,
    maxTokens: body.maxTokens || null,
    ...(context ? { context } : {}),
  };
}

module.exports = { prepareOutbound, assertClean, hostedBody, scrubSecrets, scrubContacts, holdsSecret };
