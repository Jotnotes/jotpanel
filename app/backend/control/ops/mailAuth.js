'use strict';

// SPF, DKIM and DMARC, read from the public resolver and explained.
//
// Publishing these three records is not hard and nobody should be charged
// forty dollars a month for it. What is hard is knowing which of them is
// quietly wrong, because every failure here is silent: the mail still leaves,
// it just stops being believed. So this file is the diagnosis rather than the
// setup, and it is written to say what is wrong in a sentence a person can act
// on rather than to render a record back at them.
//
// The parsing is pure and takes a resolver, so it tests without a network.

const COMMON_SELECTORS = [
  'default', 'mail', 'dkim', 'jotpanel', 'arca', 'k1', 's1', 's2', 'selector1', 'selector2',
  'google', 'mandrill', 'zoho', 'sendgrid', 'mailjet', 'protonmail', 'fm1',
];

function normalizeDomain(input) {
  const name = String(input || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(name)) throw new Error(`${input || 'that'} is not a domain name`);
  return name;
}

function joinTxt(answer) {
  return Array.isArray(answer) ? answer.join('') : String(answer);
}

// ── SPF ───────────────────────────────────────────────────────────
// The two failures that actually happen: more than one SPF record, which makes
// every checker give up rather than pick one, and more than ten DNS lookups,
// which is a hard limit in the specification and turns a valid record into a
// permanent error.
const SPF_LOOKUP_MECHANISMS = ['include', 'a', 'mx', 'ptr', 'exists', 'redirect'];

function parseSpf(record) {
  const terms = record.trim().split(/\s+/).slice(1);
  const out = { all: null, lookups: [], syntax: [] };
  for (const term of terms) {
    const all = term.match(/^([-~?+]?)all$/i);
    if (all) { out.all = all[1] || '+'; continue; }
    const mech = term.match(/^([-~?+]?)([a-z]+)([:=](.*))?$/i);
    if (!mech) { out.syntax.push(term); continue; }
    const name = mech[2].toLowerCase();
    if (SPF_LOOKUP_MECHANISMS.includes(name)) out.lookups.push({ mechanism: name, value: mech[4] || null });
  }
  return out;
}

async function countSpfLookups(domain, resolver, seen = new Set(), depth = 0) {
  // The ten-lookup limit counts every mechanism that causes a query, following
  // includes all the way down. Counting only the top level, which is the easy
  // version, misses the case that actually breaks: a provider whose own record
  // is six lookups deep.
  if (depth > 10 || seen.has(domain)) return 0;
  seen.add(domain);
  let records;
  try { records = await resolver(domain, 'TXT'); } catch { return 0; }
  const spf = (records || []).map(joinTxt).find(t => /^v=spf1\b/i.test(t));
  if (!spf) return 0;
  let count = 0;
  for (const lookup of parseSpf(spf).lookups) {
    count += 1;
    if ((lookup.mechanism === 'include' || lookup.mechanism === 'redirect') && lookup.value) {
      count += await countSpfLookups(lookup.value.toLowerCase(), resolver, seen, depth + 1);
    }
  }
  return count;
}

// ── DMARC ─────────────────────────────────────────────────────────
function parseDmarc(record) {
  const tags = {};
  for (const part of record.split(';')) {
    const [key, ...rest] = part.split('=');
    if (!key || !rest.length) continue;
    tags[key.trim().toLowerCase()] = rest.join('=').trim();
  }
  return tags;
}

function mailtoDomains(value) {
  return String(value || '').split(',')
    .map(entry => (entry.trim().match(/^mailto:[^@]+@([^!\s]+)/i) || [])[1])
    .filter(Boolean)
    .map(d => d.toLowerCase().replace(/\.$/, ''));
}

// The p tag holds a whole DER public key structure, not the modulus, so its
// length in bytes is the key size plus a header of about 38 bytes. Measuring
// the base64 and calling the answer the key size is how a 1024-bit key gets
// reported as 1280, which is a number that exists nowhere and makes the rest
// of the report look invented. Take the header off and snap to a real size.
const DKIM_SIZES = [512, 1024, 2048, 3072, 4096];
function dkimKeyBits(p) {
  const b64 = String(p || '').replace(/\s/g, '');
  if (!b64) return 0;
  const bytes = Math.floor((b64.length * 3) / 4);
  const bits = (bytes - 38) * 8;
  if (bits <= 0) return 0;
  return DKIM_SIZES.reduce((best, size) => Math.abs(size - bits) < Math.abs(best - bits) ? size : best, DKIM_SIZES[0]);
}

// ── The check ─────────────────────────────────────────────────────
async function checkMailAuth(input, deps) {
  const domain = normalizeDomain(input.domain);
  const resolver = deps.resolveTxt;
  // The selectors the caller knows about, which are the ones this machine
  // actually signs with when the mail client asks. Normalized rather than
  // spread as given: one selector arrives from a query string as a string
  // rather than an array, and spreading a string spreads its letters, so
  // asking about `arca` would have looked up a, r, c and a.
  const asked = [].concat(input.selectors || [])
    .flatMap(value => String(value).split(','))
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
  const selectors = [...new Set([...asked, ...COMMON_SELECTORS])];
  const findings = [];
  const say = (part, level, sentence, detail) => findings.push({ part, level, sentence, ...(detail ? { detail } : {}) });

  // SPF
  let spfRecords = [];
  try { spfRecords = (await resolver(domain, 'TXT') || []).map(joinTxt).filter(t => /^v=spf1\b/i.test(t)); } catch {}
  const spf = { present: spfRecords.length > 0, records: spfRecords, lookups: null, all: null };
  if (!spf.present) {
    say('spf', 'problem', `${domain} has no SPF record, so nothing tells receiving servers which machines may send as it.`);
  } else if (spfRecords.length > 1) {
    say('spf', 'problem', `${domain} has ${spfRecords.length} SPF records. The specification allows one, and checkers treat several as an error rather than picking a winner, so SPF is failing for everything you send.`);
  } else {
    const parsed = parseSpf(spfRecords[0]);
    spf.all = parsed.all;
    spf.lookups = await countSpfLookups(domain, resolver);
    if (spf.lookups > 10) {
      say('spf', 'problem', `The SPF record needs ${spf.lookups} DNS lookups and ten is the hard limit, so it fails permanently no matter which server checks it.`, 'Following every include, not only the ones written here.');
    } else if (spf.lookups > 8) {
      say('spf', 'warning', `The SPF record is at ${spf.lookups} of the ten permitted DNS lookups, so adding one more sender will break it.`);
    }
    if (parsed.all === '+') say('spf', 'problem', 'The SPF record ends in +all, which tells the world that anybody at all may send as this domain. It is worse than having no record.');
    if (parsed.all === null) say('spf', 'warning', 'The SPF record has no all mechanism at the end, so a receiver has nothing to do with mail from anywhere else.');
    if (parsed.syntax.length) say('spf', 'warning', `The SPF record contains ${parsed.syntax.length} term(s) that are not valid SPF.`, parsed.syntax.join(' '));
  }

  // DKIM
  const keys = [];
  for (const selector of selectors) {
    let answers = [];
    try { answers = await resolver(`${selector}._domainkey.${domain}`, 'TXT') || []; } catch { continue; }
    const record = answers.map(joinTxt).find(t => /(^|;)\s*(v=DKIM1|k=|p=)/i.test(t));
    if (!record) continue;
    const p = (record.match(/(?:^|;)\s*p=([^;]*)/i) || [])[1] || '';
    keys.push({ selector, revoked: p.trim() === '', approximateBits: dkimKeyBits(p) });
  }
  const dkim = { present: keys.length > 0, keys };
  if (!dkim.present) {
    // DNS cannot be asked which selectors exist, only whether a given one
    // does, so finding nothing is not proof that nothing is there. Reporting
    // it as a definite fault sends people hunting for a problem they may not
    // have, which is exactly the kind of noise that makes a report useless.
    // A selector this panel issued is different: that one should be there.
    const ours = asked;
    if (ours.length) {
      say('dkim', 'problem', `The DKIM key this server signs with, on selector ${ours.join(' or ')}, is not published for ${domain}, so every message it signs fails the check.`);
    } else {
      say('dkim', 'warning', `No DKIM key turned up for ${domain} on the selectors worth trying. Selectors cannot be listed from DNS, only guessed at, so this means we did not find one rather than that none exists. Whoever sends your mail knows which selector they use.`, `Tried: ${selectors.join(', ')}`);
    }
  } else {
    for (const key of keys) {
      if (key.revoked) say('dkim', 'problem', `The DKIM key on selector ${key.selector} is published but empty, which is how a key is revoked. Mail signed with it will fail.`);
      else if (key.approximateBits && key.approximateBits < 1536) say('dkim', 'warning', `The DKIM key on selector ${key.selector} looks like ${key.approximateBits} bits. Providers are moving to treat anything under 2048 as weak.`);
    }
  }

  // DMARC
  let dmarcRecords = [];
  try { dmarcRecords = (await resolver(`_dmarc.${domain}`, 'TXT') || []).map(joinTxt).filter(t => /^v=DMARC1\b/i.test(t)); } catch {}
  const dmarc = { present: dmarcRecords.length > 0, record: dmarcRecords[0] || null, policy: null, reporting: false };
  if (!dmarc.present) {
    say('dmarc', 'problem', `${domain} has no DMARC record, so a receiver that finds forged mail claiming to be you has no instruction from you about what to do with it.`);
  } else if (dmarcRecords.length > 1) {
    say('dmarc', 'problem', `${domain} has ${dmarcRecords.length} DMARC records and receivers ignore the lot when there is more than one.`);
  } else {
    const tags = parseDmarc(dmarcRecords[0]);
    dmarc.policy = (tags.p || '').toLowerCase() || null;
    dmarc.subdomainPolicy = (tags.sp || '').toLowerCase() || null;
    dmarc.percent = tags.pct ? parseInt(tags.pct, 10) : 100;
    dmarc.reporting = !!tags.rua;
    if (!dmarc.policy) say('dmarc', 'problem', 'The DMARC record has no p tag, which makes it invalid and it will be ignored.');
    if (!tags.rua) {
      say('dmarc', 'problem', 'The DMARC record asks for no reports, so nobody is telling you who is sending as your domain. This is the most common reason a DMARC rollout stalls: it looks done and it is teaching you nothing.');
    } else {
      // The gotcha the specialists charge for. Sending reports to a different
      // domain requires that domain to publish its own permission, and without
      // it the reports are simply never sent. Nothing anywhere says so.
      for (const target of mailtoDomains(tags.rua)) {
        if (target === domain || target.endsWith(`.${domain}`)) continue;
        let ok = false;
        try {
          const auth = (await resolver(`${domain}._report._dmarc.${target}`, 'TXT') || []).map(joinTxt);
          ok = auth.some(t => /^v=DMARC1/i.test(t));
        } catch { ok = false; }
        if (!ok) say('dmarc', 'problem', `Reports are addressed to ${target}, which is a different domain, and ${target} has not published the record that permits it. Receivers will silently send nothing.`, `${domain}._report._dmarc.${target} is missing`);
      }
    }
    if (dmarc.policy === 'none' && dmarc.reporting) say('dmarc', 'note', 'The policy is none, which is the right place to start. It collects evidence and asks receivers to do nothing yet.');
    if (dmarc.percent < 100 && dmarc.policy !== 'none') say('dmarc', 'note', `The policy applies to ${dmarc.percent}% of mail, so the rest is unprotected.`);
    if (dmarc.policy === 'reject' && !spf.present && !dkim.present) say('dmarc', 'problem', 'The policy is reject while neither SPF nor DKIM is in place, so this domain is instructing the world to throw away its own mail.');
  }

  // Who the world is told to ask about this domain. It belongs in this answer
  // because the commonest confusion in the whole subject is a record that has
  // been written correctly into a zone nobody is asked about, which is the same
  // as not having written it.
  let nameservers = [];
  try { nameservers = (await deps.resolveTxt(domain, 'NS') || []).map(n => String(n).toLowerCase().replace(/\.$/, '')); } catch {}

  const problems = findings.filter(f => f.level === 'problem');
  const verdict = !problems.length
    ? (dmarc.policy === 'reject' ? 'protected' : 'working')
    : (dmarc.policy === 'reject' ? 'breaking mail' : 'unprotected');

  // Say what was actually established. Counting only problems and then
  // announcing that all three are in place claims a DKIM key we never found,
  // which is the report telling a small lie on its very first line.
  const confirmed = [spf.present && 'SPF', dkim.present && 'DKIM', dmarc.present && 'DMARC'].filter(Boolean);
  const missing = [!spf.present && 'SPF', !dkim.present && 'DKIM', !dmarc.present && 'DMARC'].filter(Boolean);
  const clean = confirmed.length === 3
    ? `SPF, DKIM and DMARC are all in place for ${domain}.`
    : `${confirmed.join(' and ') || 'Nothing'} in place for ${domain}, and ${missing.join(' and ')} did not turn up.`;

  return {
    domain,
    verdict,
    summary: problems.length
      ? `${problems.length} thing${problems.length > 1 ? 's are' : ' is'} wrong with mail authentication for ${domain}.`
      : clean,
    spf, dkim, dmarc, findings, nameservers,
    checked_at: new Date().toISOString(),
    source: 'public resolver',
    verified: true,
  };
}

module.exports = { checkMailAuth, dkimKeyBits, parseSpf, parseDmarc, countSpfLookups, mailtoDomains, normalizeDomain, COMMON_SELECTORS };
