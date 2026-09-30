'use strict';

// What language the server answers in.
//
// The panel's own words were translated first, and its error messages were not,
// which left the half a person reads when something has gone wrong in English —
// the worst half to leave, because that is the moment they most need to
// understand it.
//
// Which language, in order:
//
//   1. The language the person chose in the panel, sent with the request. Their
//      explicit choice beats everything, exactly as it does in the interface.
//   2. What their browser asks for. Usually right and costs nothing.
//   3. The host's default for this machine.
//   4. English.
//
// The dictionaries are the front end's. The key is the English sentence in both
// places, so a phrase that appears on a screen and in a message is translated
// once, and a server message that happens to match interface wording is already
// done. Nothing is duplicated and nothing can drift apart.

const fs = require('fs');
const path = require('path');

const LOCALES = path.join(__dirname, '..', '..', 'frontend', 'locales');
const HEADER = 'x-jotpanel-language';
const LEGACY_HEADER = 'x-arca-language';

const dictionaries = new Map();

function dictionaryFor(code) {
  if (dictionaries.has(code)) return dictionaries.get(code);
  let loaded = {};
  try {
    const file = path.join(LOCALES, `${code}.json`);
    // The name is checked against a pattern rather than trusted, because it
    // arrives in a header. Without this, a language of "../../etc/passwd" is a
    // file read.
    if (/^[a-z]{2}$/.test(code) && fs.existsSync(file)) loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { loaded = {}; }
  dictionaries.set(code, loaded);
  return loaded;
}

function available(code) {
  return /^[a-z]{2}$/.test(code) && fs.existsSync(path.join(LOCALES, `${code}.json`));
}

function fromAcceptLanguage(header) {
  // "fr-CA,fr;q=0.9,en;q=0.8" — taken in the order offered, first one we have.
  for (const part of String(header || '').split(',')) {
    const code = part.trim().split(';')[0].slice(0, 2).toLowerCase();
    if (available(code)) return code;
  }
  return '';
}

function languageOf(req, hostDefault = '') {
  const chosen = String(req?.headers?.[HEADER] || req?.headers?.[LEGACY_HEADER] || '').slice(0, 2).toLowerCase();
  if (available(chosen)) return chosen;
  const asked = fromAcceptLanguage(req?.headers?.['accept-language']);
  if (asked) return asked;
  if (available(hostDefault)) return hostDefault;
  return 'en';
}

// t(req, "Something went wrong: {why}", { why }) — the same shape the interface
// uses, so a string can be moved between them without being rewritten.
function translate(req, english, values, hostDefault = '') {
  const dictionary = dictionaryFor(languageOf(req, hostDefault));
  let text = dictionary[english] || english;
  if (values) for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(String(value));
  return text;
}

// Reloadable, because the dictionaries are files on disk that a host may edit
// and the alternative is restarting the panel to change a word.
function forget() { dictionaries.clear(); }

module.exports = { translate, languageOf, available, forget, HEADER };
