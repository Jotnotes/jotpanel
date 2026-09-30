'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { checkMailAuth, parseSpf, parseDmarc, countSpfLookups, mailtoDomains } = require('./mailAuth');

// A resolver built from a plain map, so every one of these runs offline.
function fakeResolver(zone) {
  return async (name, type) => {
    const key = `${name.toLowerCase()}|${(type || 'TXT').toUpperCase()}`;
    if (!(key in zone)) { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; }
    return zone[key];
  };
}
const findings = r => r.findings.map(f => f.sentence).join(' ');

test('two SPF records is reported as failing, not as a preference', async () => {
  const r = await checkMailAuth({ domain: 'x.com' }, { resolveTxt: fakeResolver({
    'x.com|TXT': [['v=spf1 include:one.net -all'], ['v=spf1 include:two.net -all']],
  }) });
  assert.match(findings(r), /2 SPF records/);
  assert.equal(r.verdict, 'unprotected');
});

test('the ten lookup limit counts through includes, not only the top level', async () => {
  const zone = {
    'a.com|TXT': [['v=spf1 include:b.com include:c.com -all']],
    'b.com|TXT': [['v=spf1 a mx include:d.com -all']],
    'c.com|TXT': [['v=spf1 a a a a -all']],
    'd.com|TXT': [['v=spf1 a a a a a -all']],
  };
  // 2 includes + b(a,mx,include=3) + d(5) + c(4) = 14
  const count = await countSpfLookups('a.com', fakeResolver(zone));
  assert.ok(count > 10, `expected over ten, got ${count}`);
  const r = await checkMailAuth({ domain: 'a.com' }, { resolveTxt: fakeResolver(zone) });
  assert.match(findings(r), /hard limit/);
});

test('+all is called out as worse than nothing', async () => {
  const r = await checkMailAuth({ domain: 'x.com' }, { resolveTxt: fakeResolver({ 'x.com|TXT': [['v=spf1 +all']] }) });
  assert.match(findings(r), /anybody at all may send/);
});

test('a DMARC record with no rua is a problem, because it teaches nothing', async () => {
  const r = await checkMailAuth({ domain: 'x.com' }, { resolveTxt: fakeResolver({
    'x.com|TXT': [['v=spf1 -all']],
    '_dmarc.x.com|TXT': [['v=DMARC1; p=none']],
  }) });
  assert.match(findings(r), /nobody is telling you who is sending/);
});

test('reports sent to another domain need that domain to permit it', async () => {
  const zone = {
    'x.com|TXT': [['v=spf1 -all']],
    '_dmarc.x.com|TXT': [['v=DMARC1; p=none; rua=mailto:reports@analyzer.io']],
  };
  const r = await checkMailAuth({ domain: 'x.com' }, { resolveTxt: fakeResolver(zone) });
  assert.match(findings(r), /has not published the record that permits it/);

  zone['x.com._report._dmarc.analyzer.io|TXT'] = [['v=DMARC1']];
  const ok = await checkMailAuth({ domain: 'x.com' }, { resolveTxt: fakeResolver(zone) });
  assert.doesNotMatch(findings(ok), /has not published/);
});

test('reject with nothing behind it is the worst case and is named as such', async () => {
  const r = await checkMailAuth({ domain: 'x.com' }, { resolveTxt: fakeResolver({
    '_dmarc.x.com|TXT': [['v=DMARC1; p=reject; rua=mailto:me@x.com']],
  }) });
  assert.match(findings(r), /throw away its own mail/);
  assert.equal(r.verdict, 'breaking mail');
});

test('a revoked DKIM key is not mistaken for a present one', async () => {
  const r = await checkMailAuth({ domain: 'x.com', selectors: ['arca'] }, { resolveTxt: fakeResolver({
    'arca._domainkey.x.com|TXT': [['v=DKIM1; k=rsa; p=']],
  }) });
  assert.match(findings(r), /published but empty/);
});

test('a selector we could not guess is a warning, a selector we issued is a fault', async () => {
  const empty = { resolveTxt: fakeResolver({ 'x.com|TXT': [['v=spf1 -all']] }) };
  const guessed = await checkMailAuth({ domain: 'x.com' }, empty);
  assert.match(findings(guessed), /we did not find one rather than that none exists/);
  assert.equal(guessed.findings.find(f => f.part === 'dkim').level, 'warning');
  assert.doesNotMatch(guessed.summary, /all in place/, 'the summary must not claim a key we never found');

  const ours = await checkMailAuth({ domain: 'x.com', selectors: ['arca'] }, empty);
  assert.equal(ours.findings.find(f => f.part === 'dkim').level, 'problem');
  assert.match(findings(ours), /this server signs with/);
});

test('a healthy domain says so and lists nothing', async () => {
  const p = 'A'.repeat(392);
  const r = await checkMailAuth({ domain: 'x.com', selectors: ['arca'] }, { resolveTxt: fakeResolver({
    'x.com|TXT': [['v=spf1 mx -all']],
    'arca._domainkey.x.com|TXT': [[`v=DKIM1; k=rsa; p=${p}`]],
    '_dmarc.x.com|TXT': [['v=DMARC1; p=none; rua=mailto:dmarc@x.com']],
  }) });
  assert.equal(r.findings.filter(f => f.level === 'problem').length, 0);
  assert.match(r.summary, /all in place/);
});

test('the small parsers do what they say', () => {
  assert.equal(parseSpf('v=spf1 include:a.com -all').all, '-');
  assert.equal(parseDmarc('v=DMARC1; p=quarantine; pct=50').pct, '50');
  assert.deepEqual(mailtoDomains('mailto:a@one.com,mailto:b@two.com!10m'), ['one.com', 'two.com']);
});

test('a DKIM key size is a real key size, not the length of its wrapper', () => {
  const { dkimKeyBits } = require('./mailAuth');
  // A DER-wrapped RSA public key is the modulus plus about 38 bytes of header,
  // so measuring the base64 and stopping there reports sizes nobody has ever
  // generated. These are the real base64 lengths.
  assert.equal(dkimKeyBits('A'.repeat(216)), 1024);
  assert.equal(dkimKeyBits('A'.repeat(392)), 2048);
  assert.equal(dkimKeyBits('A'.repeat(736)), 4096);
  assert.equal(dkimKeyBits(''), 0);
});
