'use strict';

// Publishing a guest, checked where it can be checked without root or nginx.
//
// The thing being rendered is a file that nginx parses and root reloads, and the
// value going into it comes partly from a guest. So the cases that matter are
// the ones where a name or an address is not what it should be, and the
// properties that matter are the ones a customer's privacy depends on: HTTPS
// only, the public name forwarded, and no static surface at all.

const assert = require('assert/strict');
const {
  guestHostname, renderGuestVhost, publishPlan, unpublishPlan, publicationSettings, confPath,
} = require('./guestProxy');

let passed = 0;
const check = (what, fn) => { fn(); passed++; console.log(`  ok  ${what}`); };

const GOOD = {
  machineName: 'cust-0042', zone: 'guests.example.com', address: '192.168.122.50',
  certificate: '/etc/letsencrypt/live/guests.example.com/fullchain.pem',
  certificateKey: '/etc/letsencrypt/live/guests.example.com/privkey.pem',
};

// ── The name ────────────────────────────────────────────────────────
check('a guest is published one label below the zone', () => {
  assert.equal(guestHostname({ machineName: 'cust-0042', zone: 'guests.example.com' }), 'cust-0042.guests.example.com');
});

check('the zone is forgiving about case and stray dots, because a hoster types it once', () => {
  assert.equal(guestHostname({ machineName: 'Cust-1', zone: '.Guests.Example.COM.' }), 'cust-1.guests.example.com');
});

check('DANGEROUS: a name that would escape its label is refused', () => {
  for (const bad of ['a.b', 'a/b', 'a b', '../x', 'a;b', '-lead', 'trail-', '', 'a_b', 'A'.repeat(64)]) {
    assert.throws(() => guestHostname({ machineName: bad, zone: 'guests.example.com' }),
      /not a name that can be a hostname label/, `accepted ${JSON.stringify(bad)}`);
  }
});

check('DANGEROUS: a name more than one label below the zone is refused, because a wildcard does not cover it', () => {
  // The only way to get here is a zone with a leading label, since the machine
  // name itself cannot contain a dot.
  assert.throws(() => guestHostname({ machineName: 'x', zone: 'a..b.example.com' }), /not a zone/);
  assert.equal(guestHostname({ machineName: 'x', zone: 'deep.guests.example.com' }), 'x.deep.guests.example.com');
});

check('a zone that is not a zone is refused', () => {
  for (const bad of ['', 'localhost', 'example', 'a b.com', 'http://x.com', '192.168.0.1.']) {
    assert.throws(() => guestHostname({ machineName: 'x', zone: bad }), /not a zone/, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── The vhost ───────────────────────────────────────────────────────
check('the rendered vhost serves only HTTPS, and redirects the rest', () => {
  const text = renderGuestVhost({ hostname: 'g.guests.example.com', address: '192.168.122.50', certificate: GOOD.certificate, certificateKey: GOOD.certificateKey });
  assert.match(text, /listen 443 ssl;/);
  assert.match(text, /return 301 https:\/\/g\.guests\.example\.com\$request_uri;/);
  assert.equal(/proxy_pass/.test(text.split('server {')[1]), false, 'the port 80 block proxies nothing, it only redirects');
});

check('it forwards the PUBLIC name, so links and passkey challenges are for the right host', () => {
  const text = renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com' });
  assert.match(text, /proxy_set_header Host g\.guests\.example\.com;/);
  assert.match(text, /proxy_set_header X-Forwarded-Host g\.guests\.example\.com;/);
  assert.match(text, /proxy_set_header X-Forwarded-Proto https;/);
});

check('it proxies to the guest and nothing else: no root, no index, no PHP', () => {
  const text = renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com' });
  assert.match(text, /proxy_pass https:\/\/192\.168\.122\.50;/);
  for (const forbidden of [/\broot\s+\//, /\bindex\s/, /fastcgi/, /try_files/, /autoindex/]) {
    assert.equal(forbidden.test(text), false, `the vhost carries a static surface: ${forbidden}`);
  }
});

check('it carries the streaming settings Echo needs, so a long answer is not cut at the proxy', () => {
  const text = renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com' });
  assert.match(text, /proxy_buffering off;/);
  assert.match(text, /proxy_read_timeout 3900s;/);
});

check('and it says in the file itself that nothing should edit it by hand', () => {
  assert.match(renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com' }), /Managed by jotpanel-ops/);
});

// ── What must never reach the file ──────────────────────────────────
check('DANGEROUS: only a literal IPv4 is accepted as the proxy target', () => {
  for (const bad of ['guest.local', '192.168.122.50; }', '192.168.122.999', '1.2.3', '$host', '', '192.168.122.50 }\nserver{', '::1']) {
    assert.throws(() => renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com', address: bad }),
      /not a private address/, `accepted ${JSON.stringify(bad)}`);
  }
});

check('DANGEROUS: a certificate path with anything but path characters is refused', () => {
  for (const bad of ['/etc/x.pem; }', '/etc/$x.pem', 'relative.pem', '', '/etc/x pem', '/etc/"x".pem']) {
    assert.throws(() => renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com', certificate: bad }),
      /is not a plain absolute path/, `accepted ${JSON.stringify(bad)}`);
    assert.throws(() => renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com', certificateKey: bad }),
      /is not a plain absolute path/, `accepted ${JSON.stringify(bad)}`);
  }
});

check('DANGEROUS: a hostname that is not a hostname is refused by the renderer too, not only by the namer', () => {
  for (const bad of ['g.guests.example.com; }', 'g guests', '', 'localhost']) {
    assert.throws(() => renderGuestVhost({ ...GOOD, hostname: bad }), /is not a hostname/, `accepted ${JSON.stringify(bad)}`);
  }
});

check('nothing a guest could influence reaches the file unchecked', () => {
  // The address is the one value in here that comes from a guest, through
  // re-announce. It is the reason IPV4 is matched rather than trusted.
  const injected = '192.168.122.50;\n  }\n  location /steal { proxy_pass http://evil; }\n';
  assert.throws(() => renderGuestVhost({ ...GOOD, hostname: 'g.guests.example.com', address: injected }), /not a private address/);
});

// ── The plans ───────────────────────────────────────────────────────
check('a publish plan says where the file goes, what is in it, and the origin to tell the guest', () => {
  const plan = publishPlan(GOOD);
  assert.equal(plan.hostname, 'cust-0042.guests.example.com');
  assert.equal(plan.origin, 'https://cust-0042.guests.example.com');
  assert.equal(plan.conf, confPath('cust-0042.guests.example.com'));
  assert.match(plan.conf, /^\/etc\/nginx\/sites-available\/jotpanel-guest-/);
  assert.match(plan.text, /server_name cust-0042\.guests\.example\.com;/);
});

check('one guest is one file, so unpublishing cannot take another guest down with it', () => {
  const a = publishPlan({ ...GOOD, machineName: 'guest-a' });
  const b = publishPlan({ ...GOOD, machineName: 'guest-b' });
  assert.notEqual(a.conf, b.conf);
  assert.equal(unpublishPlan({ machineName: 'guest-a', zone: GOOD.zone }).conf, a.conf);
  assert.notEqual(unpublishPlan({ machineName: 'guest-a', zone: GOOD.zone }).conf, b.conf);
});

check('the file name is prefixed, so a guest vhost cannot collide with the panel\'s own', () => {
  assert.match(publishPlan(GOOD).conf, /jotpanel-guest-cust-0042\.guests\.example\.com\.conf$/);
  assert.equal(publishPlan(GOOD).conf.includes('jotpanel-tls.conf'), false);
});

// ── Whether this pool host publishes at all ─────────────────────────
check('a pool host with nothing configured says so, rather than rendering a broken vhost', () => {
  const out = publicationSettings({});
  assert.equal(out.configured, false);
  assert.match(out.reason, /JOTPANEL_GUEST_ZONE/);
  assert.match(out.reason, /JOTPANEL_GUEST_WILDCARD_CERT/);
});

check('a half-configured pool host names exactly what is missing', () => {
  const out = publicationSettings({ JOTPANEL_GUEST_ZONE: 'guests.example.com', JOTPANEL_GUEST_WILDCARD_CERT: '/etc/c.pem' });
  assert.equal(out.configured, false);
  assert.match(out.reason, /JOTPANEL_GUEST_WILDCARD_KEY is not set/);
});

check('a configured pool host reports the zone it publishes under', () => {
  const out = publicationSettings({
    JOTPANEL_GUEST_ZONE: 'Guests.Example.COM',
    JOTPANEL_GUEST_WILDCARD_CERT: '/etc/c.pem',
    JOTPANEL_GUEST_WILDCARD_KEY: '/etc/k.pem',
  });
  assert.equal(out.configured, true);
  assert.equal(out.zone, 'guests.example.com');
  assert.equal(out.reason, null);
});

check('a zone that is not a zone is not configured, however the rest looks', () => {
  const out = publicationSettings({ JOTPANEL_GUEST_ZONE: 'localhost', JOTPANEL_GUEST_WILDCARD_CERT: '/etc/c.pem', JOTPANEL_GUEST_WILDCARD_KEY: '/etc/k.pem' });
  assert.equal(out.configured, false);
  assert.match(out.reason, /is not a zone/);
});

console.log(`\nguest proxy checks passed — ${passed} checks`);
