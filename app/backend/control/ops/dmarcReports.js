'use strict';

// DMARC aggregate reports, read and turned into sentences.
//
// This is the half the specialists actually charge for. Publishing the records
// is three DNS entries anybody can write; what nobody can do by hand is read
// the compressed XML that then arrives from Google, Microsoft, Yahoo and the
// rest, several a day, and work out which of their own senders is failing.
//
// The parsing here is deliberately small and pure. A report is a fixed, shallow
// shape and pulling in an XML library to read it would be a dependency carried
// for one file. Everything below takes a string and returns an object, so it
// tests without a network, a mailbox or a server.

// ── A very small XML reader, enough for this one document shape ───
function parseXml(xml) {
  const stack = [{ tag: '#root', children: [], text: '' }];
  const tagRe = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g;
  let last = 0, match;
  while ((match = tagRe.exec(xml))) {
    const text = xml.slice(last, match.index);
    if (text.trim()) stack[stack.length - 1].text += text;
    last = tagRe.lastIndex;
    if (match[5] != null) { stack[stack.length - 1].text += match[5]; continue; }
    if (!match[2]) continue;
    if (match[1] === '/') { if (stack.length > 1) stack.pop(); continue; }
    const node = { tag: match[2], children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (match[4] !== '/') stack.push(node);
  }
  return stack[0].children[0] || null;
}

function child(node, tag) { return node && node.children.find(c => c.tag === tag); }
function value(node, tag) { const c = child(node, tag); return c ? decode(c.text.trim()) : null; }
function decode(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// ── One report ────────────────────────────────────────────────────
function parseAggregateReport(xml) {
  const root = parseXml(xml);
  if (!root || root.tag !== 'feedback') throw new Error('That is not a DMARC aggregate report');
  const meta = child(root, 'report_metadata');
  const policy = child(root, 'policy_published');
  const range = meta ? child(meta, 'date_range') : null;
  const records = root.children.filter(c => c.tag === 'record').map(rec => {
    const row = child(rec, 'row');
    const evaluated = row ? child(row, 'policy_evaluated') : null;
    const identifiers = child(rec, 'identifiers');
    const auth = child(rec, 'auth_results');
    const dkimNodes = auth ? auth.children.filter(c => c.tag === 'dkim') : [];
    const spfNodes = auth ? auth.children.filter(c => c.tag === 'spf') : [];
    return {
      source_ip: row ? value(row, 'source_ip') : null,
      count: Number((row ? value(row, 'count') : 0) || 0),
      disposition: evaluated ? value(evaluated, 'disposition') : null,
      dkim: evaluated ? value(evaluated, 'dkim') : null,
      spf: evaluated ? value(evaluated, 'spf') : null,
      header_from: identifiers ? value(identifiers, 'header_from') : null,
      dkim_domains: dkimNodes.map(n => ({ domain: value(n, 'domain'), selector: value(n, 'selector'), result: value(n, 'result') })),
      spf_domains: spfNodes.map(n => ({ domain: value(n, 'domain'), result: value(n, 'result') })),
    };
  });
  return {
    reporter: meta ? value(meta, 'org_name') : null,
    report_id: meta ? value(meta, 'report_id') : null,
    from: range ? Number(value(range, 'begin')) : null,
    to: range ? Number(value(range, 'end')) : null,
    domain: policy ? value(policy, 'domain') : null,
    published_policy: policy ? value(policy, 'p') : null,
    records,
  };
}

// ── Many reports, turned into something a person can act on ───────
//
// The useful question is never "how many messages passed". It is "which of the
// things sending as me is failing, and is that thing mine". So the summary is
// grouped by sender, not by day, and the sentence for each says what to do.
function summarise(reports, options = {}) {
  const bySource = new Map();
  let total = 0, passed = 0, quarantined = 0, rejected = 0;
  let from = null, to = null;
  const reporters = new Set();

  for (const report of reports) {
    if (report.reporter) reporters.add(report.reporter);
    if (report.from && (!from || report.from < from)) from = report.from;
    if (report.to && (!to || report.to > to)) to = report.to;
    for (const record of report.records) {
      const key = record.source_ip || 'unknown';
      const entry = bySource.get(key) || {
        source_ip: key, count: 0, aligned: 0, failing: 0,
        dkim_pass: 0, spf_pass: 0, dispositions: {}, domains: new Set(),
      };
      const n = record.count || 0;
      entry.count += n;
      total += n;
      const dkimOk = record.dkim === 'pass';
      const spfOk = record.spf === 'pass';
      if (dkimOk) entry.dkim_pass += n;
      if (spfOk) entry.spf_pass += n;
      if (dkimOk || spfOk) { entry.aligned += n; passed += n; } else entry.failing += n;
      const d = record.disposition || 'none';
      entry.dispositions[d] = (entry.dispositions[d] || 0) + n;
      if (d === 'quarantine') quarantined += n;
      if (d === 'reject') rejected += n;
      for (const item of record.dkim_domains) if (item.domain) entry.domains.add(item.domain);
      for (const item of record.spf_domains) if (item.domain) entry.domains.add(item.domain);
      bySource.set(key, entry);
    }
  }

  const known = new Set((options.knownSenders || []).map(s => String(s)));
  const sources = [...bySource.values()]
    .map(entry => {
      const rate = entry.count ? entry.aligned / entry.count : 0;
      const mine = known.has(entry.source_ip);
      let sentence;
      if (rate === 1) sentence = `${entry.source_ip} sent ${entry.count} and every one of them passed.`;
      else if (rate === 0) sentence = mine
        ? `${entry.source_ip} is one of yours and every one of its ${entry.count} messages failed, so something it sends is not covered by your SPF record or is not being signed.`
        : `${entry.source_ip} sent ${entry.count} claiming to be you and none of them passed. Either it is a sender you forgot about, or somebody is forging your domain.`;
      else sentence = `${entry.source_ip} sent ${entry.count} and ${entry.failing} of them failed, which usually means one route out of that sender is not covered.`;
      return {
        ...entry,
        domains: [...entry.domains],
        pass_rate: Math.round(rate * 100),
        known: mine,
        sentence,
      };
    })
    .sort((a, b) => b.count - a.count);

  const rate = total ? Math.round((passed / total) * 100) : null;
  const failingSources = sources.filter(s => s.pass_rate < 100);
  const advice = [];
  if (!total) advice.push('No reports have arrived yet. They usually start within a day of publishing the record, and they only arrive at all if the record asks for them.');
  else if (rate === 100) advice.push(`Everything that sent as this domain passed. If it stays this way for a couple of weeks, moving the policy from none to quarantine is safe.`);
  else advice.push(`${rate}% of the mail claiming to be this domain passed. Do not tighten the policy while anything of yours is still failing, because tightening it is what starts throwing that mail away.`);
  if (rejected) advice.push(`${rejected} message${rejected > 1 ? 's were' : ' was'} rejected outright because of your policy. If any of that was yours, it never arrived.`);
  if (quarantined) advice.push(`${quarantined} message${quarantined > 1 ? 's went' : ' went'} to spam because of your policy.`);

  return {
    total, passed, failing: total - passed, quarantined, rejected,
    pass_rate: rate,
    from: from ? new Date(from * 1000).toISOString() : null,
    to: to ? new Date(to * 1000).toISOString() : null,
    reporters: [...reporters],
    sources,
    failing_sources: failingSources.length,
    advice,
    summary: total
      ? `${total} message${total > 1 ? 's' : ''} claimed to be this domain, ${rate}% passed, from ${sources.length} sender${sources.length > 1 ? 's' : ''}.`
      : 'No DMARC reports have been read yet.',
  };
}

// ── Getting the XML out of the mail it arrives in ─────────────────
//
// Reports come as an attachment, gzipped or zipped, on an ordinary email.
// Both formats are read here rather than shelled out to gunzip and unzip,
// partly because unzip is not installed on a minimal box and mostly because a
// backup of somebody's mail is not somewhere to be spawning processes per
// message. A DMARC zip holds one file with no tricks in it, so the twenty
// lines below are the whole reader.
const zlib = require('zlib');

function unzipSingle(buffer) {
  // Local file header: PK\x03\x04, then the compression method at offset 8,
  // the sizes at 18 and 22, and the two name and extra lengths at 26 and 28.
  if (buffer.length < 30 || buffer.readUInt32LE(0) !== 0x04034b50) throw new Error('not a zip');
  const method = buffer.readUInt16LE(8);
  const compressed = buffer.readUInt32LE(18);
  const nameLen = buffer.readUInt16LE(26);
  const extraLen = buffer.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  const body = compressed ? buffer.slice(start, start + compressed) : buffer.slice(start);
  if (method === 0) return body;
  if (method === 8) return zlib.inflateRawSync(body);
  throw new Error(`unsupported zip compression method ${method}`);
}

// One raw message in, the report XML it carries out, or null.
function extractReportXml(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('binary') : String(raw);
  const parts = text.split(/\r?\n--/);
  const candidates = parts.length > 1 ? parts : [text];
  for (const part of candidates) {
    const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(part);
    const name = (part.match(/(?:filename|name)="?([^";\r\n]+)"?/i) || [])[1] || '';
    const split = part.split(/\r?\n\r?\n/);
    if (split.length < 2) continue;
    const body = split.slice(1).join('\n\n');
    let bytes;
    try { bytes = isBase64 ? Buffer.from(body.replace(/[^A-Za-z0-9+/=]/g, ''), 'base64') : Buffer.from(body, 'binary'); }
    catch { continue; }
    if (!bytes.length) continue;
    try {
      if (bytes[0] === 0x1f && bytes[1] === 0x8b) return zlib.gunzipSync(bytes).toString('utf8');
      if (bytes.readUInt32LE(0) === 0x04034b50) return unzipSingle(bytes).toString('utf8');
      const asText = bytes.toString('utf8');
      if (/<feedback[\s>]/.test(asText)) return asText;
      if (/\.xml$/i.test(name) && asText.includes('<')) return asText;
    } catch { /* an attachment that will not open is not the whole mailbox */ }
  }
  return null;
}

module.exports = { parseAggregateReport, summarise, parseXml, extractReportXml, unzipSingle };
