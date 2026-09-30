'use strict';

const assert = require('assert');
const { test } = require('node:test');
const { parseAggregateReport, summarise } = require('./dmarcReports');

const REPORT = `<?xml version="1.0" encoding="UTF-8" ?>
<feedback>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <report_id>1234567890</report_id>
    <date_range><begin>1787184000</begin><end>1787270400</end></date_range>
  </report_metadata>
  <policy_published>
    <domain>example.com</domain><adkim>r</adkim><aspf>r</aspf><p>none</p><sp>none</sp><pct>100</pct>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.10</source_ip><count>42</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results>
      <dkim><domain>example.com</domain><selector>arca</selector><result>pass</result></dkim>
      <spf><domain>example.com</domain><result>pass</result></spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>198.51.100.7</source_ip><count>9</count>
      <policy_evaluated><disposition>quarantine</disposition><dkim>fail</dkim><spf>fail</spf></policy_evaluated>
    </row>
    <identifiers><header_from>example.com</header_from></identifiers>
    <auth_results><spf><domain>elsewhere.net</domain><result>fail</result></spf></auth_results>
  </record>
</feedback>`;

test('a real report shape is read', () => {
  const r = parseAggregateReport(REPORT);
  assert.equal(r.reporter, 'google.com');
  assert.equal(r.domain, 'example.com');
  assert.equal(r.published_policy, 'none');
  assert.equal(r.records.length, 2);
  assert.equal(r.records[0].source_ip, '203.0.113.10');
  assert.equal(r.records[0].count, 42);
  assert.equal(r.records[1].disposition, 'quarantine');
  assert.equal(r.records[0].dkim_domains[0].selector, 'arca');
});

test('anything that is not a report is refused rather than half read', () => {
  assert.throws(() => parseAggregateReport('<html><body>hello</body></html>'), /not a DMARC aggregate report/);
});

test('the summary groups by sender, because that is the question people have', () => {
  const s = summarise([parseAggregateReport(REPORT)]);
  assert.equal(s.total, 51);
  assert.equal(s.passed, 42);
  assert.equal(s.pass_rate, 82);
  assert.equal(s.quarantined, 9);
  assert.equal(s.sources.length, 2);
  assert.equal(s.sources[0].source_ip, '203.0.113.10');
  assert.equal(s.failing_sources, 1);
});

test('a stranger sending as you reads differently from one of your own', () => {
  const stranger = summarise([parseAggregateReport(REPORT)]);
  assert.match(stranger.sources[1].sentence, /somebody is forging your domain/);
  const mine = summarise([parseAggregateReport(REPORT)], { knownSenders: ['198.51.100.7'] });
  assert.match(mine.sources[1].sentence, /one of yours/);
});

test('the advice never suggests tightening while something is failing', () => {
  const s = summarise([parseAggregateReport(REPORT)]);
  assert.match(s.advice.join(' '), /Do not tighten/);
  assert.doesNotMatch(s.advice.join(' '), /safe/);
});

test('a clean fortnight is what invites the next step', () => {
  const clean = REPORT.replace(/<disposition>quarantine<\/disposition><dkim>fail<\/dkim><spf>fail<\/spf>/, '<disposition>none</disposition><dkim>pass</dkim><spf>pass</spf>');
  const s = summarise([parseAggregateReport(clean)]);
  assert.equal(s.pass_rate, 100);
  assert.match(s.advice.join(' '), /moving the policy from none to quarantine is safe/);
});

test('nothing read is said plainly rather than shown as zero percent', () => {
  const s = summarise([]);
  assert.equal(s.total, 0);
  assert.equal(s.pass_rate, null);
  assert.match(s.advice.join(' '), /No reports have arrived yet/);
});
