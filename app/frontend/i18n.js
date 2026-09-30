// Language, for a panel that is sold in more than one country.
//
// The key is the English sentence itself. That is a deliberate trade: it means
// no key invention, no key churn when wording changes, and — the part that
// matters on a panel with a thousand strings — anything not yet translated
// falls back to readable English instead of showing `panel.mail.compose.title`
// to a customer. The cost is that changing the English makes a string new
// again, which is the right way round: reworded copy should be re-translated.
//
// Which language wins, in order:
//
//   1. What this person chose. Their choice, on their machine, beats everything.
//   2. What the host set for the machine. A hoster in Brazil ships Portuguese.
//   3. What the browser asks for, which is usually right and costs nothing.
//   4. English.
//
// Two settings rather than one, because they answer different questions. The
// host's is "what language is this business in"; the person's is "what language
// am I". A panel with only the first cannot serve an English-speaking customer
// of a Brazilian host, and adding that later means touching every screen twice.

import fr from './locales/fr.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import de from './locales/de.json';
import nl from './locales/nl.json';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'fr', name: 'Français' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'de', name: 'Deutsch' },
  { code: 'nl', name: 'Nederlands' },
];

const DICTIONARIES = { en: {}, fr, es, pt, de, nl };

const STORAGE_KEY = 'jotpanel_language';
const LEGACY_STORAGE_KEY = 'arca_language';

function fromBrowser() {
  const asked = (typeof navigator !== 'undefined' && navigator.languages) || [];
  for (const tag of asked) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (DICTIONARIES[code]) return code;
  }
  return '';
}

function stored() {
  try { return localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY) || ''; } catch { return ''; }
}

// The host's default is written into the page by the server. Read once, and
// never allowed to override a person who has chosen.
function hostDefault() {
  if (typeof document === 'undefined') return '';
  const declared = document.documentElement.getAttribute('data-jotpanel-language') || document.documentElement.getAttribute('data-arca-language') || '';
  return DICTIONARIES[declared] ? declared : '';
}

let active = '';

export function currentLanguage() {
  if (active) return active;
  active = [stored(), hostDefault(), fromBrowser(), 'en'].find(code => code && DICTIONARIES[code]) || 'en';
  return active;
}

export function setLanguage(code) {
  if (!DICTIONARIES[code]) return currentLanguage();
  active = code;
  try { localStorage.setItem(STORAGE_KEY, code); } catch { /* a private window still gets the language, just not next time */ }
  if (typeof document !== 'undefined') document.documentElement.setAttribute('lang', code);
  return active;
}

// t("Mark unread") — and t("{n} messages", { n: 4 }) when a number belongs in
// the middle. Placeholders are named rather than positional because word order
// is exactly what changes between languages, and a translator moving {n} to the
// front of a sentence must not have to move anything else.
// The header every request to the panel carries, so the server answers in the
// language the person chose here rather than guessing from their browser.
export const LANGUAGE_HEADER = 'X-JotPanel-Language';
export function languageHeaders() { return { [LANGUAGE_HEADER]: currentLanguage() }; }

export function t(english, values) {
  const dictionary = DICTIONARIES[currentLanguage()] || {};
  let text = dictionary[english] || english;
  if (values) {
    for (const [name, value] of Object.entries(values)) {
      text = text.split(`{${name}}`).join(String(value));
    }
  }
  return text;
}
