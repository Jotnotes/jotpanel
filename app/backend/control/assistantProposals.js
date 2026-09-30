'use strict';

// What the assistant is allowed to ask for, and nothing else.
//
// The assistant never executes. The most it can do is cause a PROPOSAL to
// exist, which a human then approves and executes on their own authenticated
// request. Three properties carry that:
//
//   1. The operation name is never taken from the model or from the user's
//      text. Free text is matched against the fixed builders below and the
//      key that comes out is looked up in this closed list, so an operation
//      that is not here cannot be reached however the request is worded.
//   2. Detection runs on the human's own last message only. It never reads
//      model output, a fetched page, a log line or a file, so text the
//      assistant merely READ can never become an action it proposed.
//   3. Inputs are whatever the catalogue row's own normalize() accepts, the
//      same validation a form submission goes through, and a credential is
//      generated here rather than parsed out of a conversation.
//
// Adding an operation to this file widens what the assistant can ask for, so
// it is a deliberate edit and destructive operations do not belong in it.
//
// Two rules the builders below all keep, because breaking either one puts a
// card on screen for something nobody asked for:
//
//   Nothing is inferred. A mailbox whose domain was guessed is a mailbox on
//   the wrong domain, and a zone split out of a hostname is the wrong zone on
//   a two-part suffix. Where the request does not carry the identifier in
//   full, the answer is null and the assistant replies in words instead.
//
//   A verb is required. Otherwise a question about backups reads as a request
//   for one, and the sentence "that mailbox is over its 500 MB quota" reads as
//   an instruction to set a quota of 500 MB.

const crypto = require('crypto');

// A verb, so a question about mailboxes is not read as a request for one.
const INTENT = /\b(create|add|make|set\s?up|setup|new|register|provision)\b/i;

// Undo words. Every builder here proposes something that comes INTO existence;
// the removals are deliberately absent from the list, so a sentence carrying
// one of these is not this request wearing a different hat.
const UNDO = /\b(stop|remove|delete|drop|clear|cancel|undo|revoke|disable|turn\s+off|switch\s+off|take\s+down|no\s+longer)\b/i;

// A question asks; it does not instruct. Without this "is there a backup of
// example.com" reads as an order to take one, because the sentence carries the
// noun and the name and that is all a keyword match ever looks at.
const QUESTION = /^\s*(?:is|are|was|were|do|does|did|has|have|had|what|which|who|whom|whose|when|where|why|how|should|shall|may|might|any)\b/i;

// Politeness wrapped around an instruction is still an instruction, so it is
// taken off before the question test rather than counted as one.
const POLITE = /^\s*(?:hi|hey|hello|ok|okay)?[,!.\s]*(?:please[,\s]+)?(?:(?:can|could|would|will)\s+you\s+)?(?:please[,\s]+)?/i;

const ADDRESS = /\b([a-z0-9][a-z0-9._-]{0,63})@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\b/i;
const ADDRESS_G = /\b[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b/gi;

// Last labels that are file extensions rather than top-level domains, so
// "index.html" and "dump.sql" are never read as a site somebody wants added.
const FILE_SUFFIX = new Set(['html', 'htm', 'php', 'js', 'jsx', 'ts', 'tsx', 'json', 'txt', 'md', 'css',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'zip', 'gz', 'tgz', 'tar', 'bz2', 'sql', 'conf',
  'cfg', 'log', 'yml', 'yaml', 'sh', 'py', 'rb', 'pl', 'ini', 'env', 'pdf', 'csv', 'xml', 'bak', 'old', 'tmp']);

// base64url of 12 bytes, comfortably past the catalogue's floor and inside the
// character set a database password is allowed to use.
function generatedPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

// Exactly one domain name written out in full, or nothing. Two candidates is
// nothing on purpose: "point example.com at old.example.net" names two things
// and picking one of them is the guess this file does not make.
function bareDomain(text) {
  const stripped = String(text).replace(ADDRESS_G, ' ');
  const finder = /\b((?:[a-z0-9][a-z0-9-]*\.)+[a-z][a-z0-9-]{1,23})\b/gi;
  let match; let found = null;
  while ((match = finder.exec(stripped))) {
    const name = match[1].toLowerCase();
    if (FILE_SUFFIX.has(name.slice(name.lastIndexOf('.') + 1))) continue;
    if (found && found !== name) return null;
    found = name;
  }
  return found;
}

// MariaDB or PostgreSQL when the person said which, and undefined when they
// did not, which leaves the catalogue on the box's own default.
function statedEngine(text) {
  if (/\bpostgres(ql)?\b/i.test(text)) return 'postgres';
  if (/\b(mysql|mariadb)\b/i.test(text)) return 'mysql';
  return undefined;
}

const NAME_STOPWORDS = new Set(['called', 'named', 'for', 'on', 'in', 'with', 'to', 'that', 'the', 'a', 'an', 'and', 'user', 'login', 'account', 'database', 'db']);

// The name somebody gave a thing, taken from "called x" or "named x" first
// because that is unambiguous, and from "<noun> x" only as a fallback.
// The dot is in the character class because a name may carry one, and a
// sentence ends in one too. Without the trim, "create a database called
// invoices." asked for a database named "invoices." and the catalogue refused
// it as an invalid identifier, so writing an ordinary sentence was the thing
// that broke it. Found on a live box, 2026-09-09.
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function statedName(text, noun) {
  const explicit = String(text).match(/\b(?:called|named)\s+["'`]?([A-Za-z][A-Za-z0-9._-]{0,47})["'`]?/);
  if (explicit) return explicit[1].replace(TRAILING_PUNCTUATION, '') || null;
  const after = String(text).match(new RegExp(`\\b(?:${noun})\\s+["'\`]?([A-Za-z][A-Za-z0-9._-]{0,47})["'\`]?`, 'i'));
  if (after && !NAME_STOPWORDS.has(after[1].toLowerCase())) return after[1].replace(TRAILING_PUNCTUATION, '') || null;
  return null;
}

// ── The builders ─────────────────────────────────────────────────
// Each takes the human's own words and returns catalogue input or null. Null
// is the normal answer and it costs nothing: a missed detection leaves an
// ordinary reply, a wrong one puts a card on screen nobody asked for.

// name@domain.tld written out in full. Nothing is inferred: a mailbox the
// assistant guessed the domain for is a mailbox on the wrong domain.
function mailboxCreate(text) {
  if (!INTENT.test(text)) return null;
  if (!/\b(mailbox|mail\s?box|email\s+(account|address))\b/i.test(text)) return null;
  const m = text.match(ADDRESS);
  if (!m) return null;
  const input = { domain: m[2].toLowerCase(), account: m[1].toLowerCase(), password: generatedPassword() };
  const quota = text.match(/\b(\d{1,6})\s?(mb|megabytes?)\b/i);
  if (quota) input.quotaMb = parseInt(quota[1], 10);
  return { input, deliver: ['password'] };
}

// Both addresses stated, and in the order the sentence puts them, so the
// forward never runs backwards and empties the wrong mailbox onto the right one.
function forwarderSet(text) {
  if (!/\bforward(?:s|ed|ing|er|ers)?\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const pair = text.match(/([a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]*\.[a-z]{2,})\s*(?:mail\s+)?(?:to|onto|on\s+to|->|→)\s+([a-z0-9][a-z0-9._-]{0,63}@[a-z0-9][a-z0-9.-]*\.[a-z]{2,})/i);
  if (!pair) return null;
  const [account, domain] = pair[1].toLowerCase().split('@');
  return { input: { domain, account, forward: pair[2].toLowerCase() } };
}

// The message has to be quoted or introduced, never assembled out of the rest
// of the sentence, because whatever comes out of here is what every person
// writing to that mailbox reads.
function autoreplySet(text) {
  if (!/\b(out\s+of\s+(?:the\s+)?office|auto[\s-]?reply|auto[\s-]?responder|vacation\s+(?:message|reply|responder)|away\s+message|holiday\s+message)\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const who = text.match(ADDRESS);
  if (!who) return null;
  const quoted = text.match(/["“”'`]([^"“”'`]{3,500})["“”'`]/);
  const introduced = text.match(/\b(?:saying|that\s+says|which\s+says|reading|message[:,]?)\s+(.{3,500})$/i);
  const message = (quoted ? quoted[1] : introduced ? introduced[1] : '').trim();
  if (!message) return null;
  return { input: { domain: who[2].toLowerCase(), account: who[1].toLowerCase(), message } };
}

// A size and a set-verb, both. "It is over its 500 MB quota" is a complaint.
function mailboxQuota(text) {
  if (!/\b(quota|size|limit|storage|space)\b/i.test(text)) return null;
  if (!/\b(set|change|raise|increase|lower|reduce|resize|make|give|bump|limit|cap)\b/i.test(text)) return null;
  const who = text.match(ADDRESS);
  if (!who) return null;
  const size = text.match(/\b(\d{1,6})\s?(mb|gb|megabytes?|gigabytes?)\b/i);
  if (!size) return null;
  const value = parseInt(size[1], 10);
  return { input: { domain: who[2].toLowerCase(), account: who[1].toLowerCase(), quotaMb: /^g/i.test(size[2]) ? value * 1024 : value } };
}

// SPF, DKIM and DMARC in one, which is what somebody asking about mail
// authentication means. DKIM on its own is the narrower row below.
function mailauthSetup(text) {
  if (!/\b(spf|dmarc|mail\s+authentication|email\s+authentication|mail\s+auth)\b/i.test(text)) return null;
  if (!INTENT.test(text) && !/\b(fix|sort|configure|enable|publish|turn\s+on|authenticate)\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const name = bareDomain(text);
  if (!name) return null;
  return { input: { domain: name } };
}

// DKIM and nothing else named, so the proposal is the key rather than the
// whole of mail authentication. Proposing more than was asked for is how a
// person learns not to trust the card.
function dkimEnable(text) {
  if (!/\bdkim\b|\bsigning\s+key\b/i.test(text)) return null;
  if (!INTENT.test(text) && !/\b(enable|turn\s+on|generate|sign)\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const name = bareDomain(text);
  if (!name) return null;
  return { input: { domain: name } };
}

function siteCreate(text) {
  if (!INTENT.test(text)) return null;
  if (!/\b(site|website|web\s?site|subdomain|domain)\b/i.test(text) && !/\bto\s+this\s+server\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  if (ADDRESS.test(text)) return null;
  if (/\b(zone|dns|certificate|ssl|tls|https|backup|database|mailbox|dkim|spf|dmarc)\b/i.test(text)) return null;
  const name = bareDomain(text);
  if (!name) return null;
  return { input: { domain: name } };
}

// The zone, never a record inside it. A record needs the zone split out of a
// hostname and that split is a guess on every two-part suffix.
function dnsZoneCreate(text) {
  if (!INTENT.test(text)) return null;
  if (!/\b(dns|zone|name\s?servers?)\b/i.test(text)) return null;
  if (/\brecords?\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const zone = bareDomain(text);
  if (!zone) return null;
  const address = text.match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return { input: { zone, ip: address ? address[1] : null } };
}

function certificateIssue(text) {
  if (!/\b(ssl|tls|https|certificate|cert)\b/i.test(text)) return null;
  if (!/\b(issue|get|obtain|install|set\s?up|setup|add|create|enable|secure|put)\b/i.test(text)) return null;
  if (/\b(renew|renewal|expire|expiring)\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const name = bareDomain(text);
  if (!name) return null;
  return { input: { domain: name } };
}

// A repeating backup. Checked before the one-off, because "back up example.com
// every night" is a schedule and running it once would quietly do the wrong job.
function backupSchedule(text) {
  if (!/\bback\s?ups?\b|\bbackup\b/i.test(text)) return null;
  if (UNDO.test(text) || /\brestore\b/i.test(text)) return null;
  const when = text.match(/\b(hourly|every\s+hour|daily|every\s+day|nightly|every\s+night|weekly|every\s+week|monthly|every\s+month)\b/i);
  if (!when) return null;
  const name = bareDomain(text);
  if (!name) return null;
  const word = when[1].toLowerCase();
  const period = /hour/.test(word) ? 'hourly' : /week/.test(word) ? 'weekly' : /month/.test(word) ? 'monthly' : 'daily';
  return { input: { domain: name, when: period } };
}

function backupCreate(text) {
  if (!/\bback\s?ups?\b|\bbackup\b/i.test(text)) return null;
  if (!/\b(back\s?up|backup|take|make|create|run|start)\b/i.test(text)) return null;
  if (UNDO.test(text) || /\brestore\b/i.test(text)) return null;
  const name = bareDomain(text);
  if (!name) return null;
  return { input: { domain: name } };
}

// Checked before the database itself, because "a database user" carries the
// word database and the narrower reading is the right one.
function databaseUserCreate(text) {
  if (!INTENT.test(text)) return null;
  if (!/\b(?:database|db|mysql|mariadb|postgres(?:ql)?)\s+(?:user|login|account)\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  const username = statedName(text, 'user|login|account');
  if (!username) return null;
  return { input: { username, password: generatedPassword(), engine: statedEngine(text) }, deliver: ['password'] };
}

function databaseCreate(text) {
  if (!INTENT.test(text)) return null;
  if (!/\b(database|db|mysql|mariadb|postgres(?:ql)?)\b/i.test(text)) return null;
  if (UNDO.test(text)) return null;
  if (/\b(user|login|import|dump|grant|restore|table)\b/i.test(text)) return null;
  const name = statedName(text, 'database|db');
  if (!name) return null;
  return { input: { name, engine: statedEngine(text) } };
}

// The closed list. Key is a catalogue operation id, value builds its input.
// Order is significance, not preference: the narrower reading of a sentence is
// checked before the wider one, and the first builder that answers wins.
const OPERATIONS = Object.freeze({
  'mail.forwarder.set': forwarderSet,
  'mail.autoreply.set': autoreplySet,
  'mail.mailbox.create': mailboxCreate,
  'mail.mailbox.quota': mailboxQuota,
  'mailauth.setup': mailauthSetup,
  'mail.dkim.enable': dkimEnable,
  'certificate.issue': certificateIssue,
  'dns.zone.create': dnsZoneCreate,
  'backup.schedule.set': backupSchedule,
  'backup.create': backupCreate,
  'database.user.create': databaseUserCreate,
  'database.create': databaseCreate,
  'site.create': siteCreate,
});

// The human's own words in, a proposal request or null out.
// Speech has no "@" key and no full stop. Whisper writes "info at site1.example.com",
// and "sales at example dot com" when the domain is spelled out, so a spoken
// request matched nothing and came back as directions to a screen. This rewrites
// only what is unambiguously an address — a word, "at", then something already
// shaped like a domain — and leaves every other "at" alone. It runs on the
// person's own words, the only text this detector is ever allowed to read.
function spokenAddresses(text) {
  return text
    .replace(/\b([a-z0-9][a-z0-9._-]*)\s+at\s+((?:[a-z0-9-]+\s+dot\s+)+[a-z]{2,})/gi,
      (m, user, host) => `${user}@${host.replace(/\s+dot\s+/gi, '.')}`)
    .replace(/\b([a-z0-9][a-z0-9._-]*)\s+at\s+([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi, '$1@$2');
}

function detect(text) {
  if (typeof text !== 'string' || text.length > 2000) return null;
  const asked = spokenAddresses(text).replace(POLITE, '');
  if (QUESTION.test(asked)) return null;
  for (const operation of Object.keys(OPERATIONS)) {
    const hit = OPERATIONS[operation](asked);
    if (hit) return { operation, input: hit.input, deliver: hit.deliver || null };
  }
  return null;
}

module.exports = { detect, spokenAddresses, OPERATIONS: Object.keys(OPERATIONS) };
