'use strict';

// One place that decides what counts as a secret.
//
// There were three copies of this rule and they had drifted: the proposal
// redactor, the panel's action redactor and the execution-result stripper each
// matched a slightly different set of parameter names. That is not a tidiness
// problem. `credential` was in none of them, which is the name the Integration
// Manager gives the field holding an SMTP URL with the password inside it, so
// connecting any provider wrote its secret into the permanent record. A rule
// kept in three places is a rule that will be wrong in at least one of them.

// Parameter names that carry secret material, or that are worth hiding from a
// summary somebody reads. Deliberately broad: this is matched against the names
// of operation parameters, which are a small and known set, and the cost of
// hiding one thing too many there is that a card says [protected] where it did
// not need to.
const SECRET_PARAM = /(password|passphrase|secret|credential|token|api.?key|private.?key|archivePath|protected|key|sql)/i;

// Names that trip the rule above and are not secrets. The rule is deliberately
// broad and stays that way: `key` on its own has to keep matching, because it
// is what an SSH key, a licence key and a signing key are all called. But it
// also matches `actionKey`, which is the identifier of the operation being
// performed, `mail.mailbox.delete` and the like, and blanking that told every
// reader of the panel that the name of the thing they were approving was a
// secret. An exemption for the identifier is the narrow fix; loosening `key`
// would be the wide one, and would let a real key through.
//
// Only exact names belong here, and only names that are identifiers of an
// operation rather than material used by one.
const NOT_SECRET_PARAM = /^(actionKey)$/;

// The narrower rule, for what an operation returned. Deliberately NOT the one
// above: a result legitimately carries object keys, file paths and archive
// names under fields called `key` and `path`, and blanking those would throw
// away the part of the record that says what actually happened. A result should
// not contain a secret in the first place; this is the backstop for when one
// does.
const SECRET_RESULT = /(password|passphrase|secret|credential|token)/i;

// What replaces a value that is hidden from a reader but still held.
const HIDDEN = '[protected]';
// What replaces a value that has been permanently removed from the record. The
// two are different words on purpose: one means you are not being shown it, the
// other means it is not there any more.
const SCRUBBED = '[scrubbed]';

// Whether a field name carries secret material. One question, asked by the
// redactor and by the check that a body came out clean, so the two can never
// disagree about what an exemption means.
function isSecretName(name, pattern = SECRET_PARAM) {
  return pattern.test(name) && !NOT_SECRET_PARAM.test(name);
}

// Walks an arbitrary structure and replaces the values under matching names.
// Returns a copy; the input is never modified, because these run against the
// durable record and a redactor with a side effect is its own kind of bug.
function redact(value, { pattern = SECRET_PARAM, replacement = HIDDEN } = {}) {
  const walk = node => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const copy = {};
    for (const [name, held] of Object.entries(node)) {
      if (isSecretName(name, pattern) && held != null && held !== '') copy[name] = replacement;
      else copy[name] = walk(held);
    }
    return copy;
  };
  return walk(value);
}

// True when anything under here would be replaced. Used by the backfill to
// count what is still holding a secret without decrypting twice, and by the
// tests to assert a body came out clean.
function holdsSecret(value, pattern = SECRET_PARAM) {
  let found = false;
  const walk = node => {
    if (found) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [name, held] of Object.entries(node)) {
      if (found) return;
      if (isSecretName(name, pattern) && held != null && held !== '' && held !== HIDDEN && held !== SCRUBBED) { found = true; return; }
      walk(held);
    }
  };
  walk(value);
  return found;
}

module.exports = { SECRET_PARAM, SECRET_RESULT, NOT_SECRET_PARAM, HIDDEN, SCRUBBED, isSecretName, redact, holdsSecret };
