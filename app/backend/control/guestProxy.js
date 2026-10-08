'use strict';

// How a customer reaches a guest that lives on a private network.
//
// THE BLOCKER THIS EXISTS FOR, traced 2026-10-05 while building activation. A
// guest is created with `--network network=default`, which is libvirt's NAT on
// 192.168.122.0/24. There is no forward, no bridge and no routable address, so
// the ONLY machine that can reach a guest is the pool host that made it. A
// customer could be handed a perfect activation code and have nowhere to type
// it. Activation was proved over real HTTP and was unreachable in real life.
//
// Two things were missing, and one answer gives both:
//
//   1. a path from the internet to a guest;
//   2. a real DOMAIN NAME for the guest, because `control/passkeys.js` refuses
//      an IP in terms - "Passkeys are bound to a domain" - so the product's
//      intended durable customer credential was unavailable on every guest.
//
// ── The shape, and what it reuses ─────────────────────────────────
//
// The pool host already terminates TLS and already writes nginx server blocks
// for sites, with `server_name`, certificate paths and redirects. A guest gets
// the same treatment: one vhost per guest at `<machine>.<zone>`, TLS from the
// hoster's WILDCARD certificate, proxying to the guest's private address.
//
// The guest is then told its public origin, which it already knows how to use:
// `JOTPANEL_PUBLIC_ORIGIN` has always won over the derived domain for link
// generation, and `WEBAUTHN_RP_ID` has always won over `DOMAIN` for passkeys. So
// nothing in the panel needed inventing; it needed telling.
//
// ── WHAT THIS WIDENS, said plainly ───────────────────────────────
//
// TLS is terminated on the pool host, so the pool host sees a customer's traffic
// in clear. That is a real widening and it was Steve's decision on 2026-10-05
// with the alternatives costed: per-guest certificates need a DNS record and an
// ACME round trip per guest, which reintroduces the provisioning-time dependency
// on a third party that the image design removed, and hit Let's Encrypt rate
// limits at fleet scale; SNI pass-through keeps the pool host out of the
// plaintext but then the guest needs a publicly trusted certificate of its own,
// which carries the same per-guest DNS and ACME cost.
//
// The boundary is not newly crossed: the pool host already holds every guest's
// `fleet.report` key, reads every guest's summary including who is on it, and
// can read any guest's disk. A hoster who runs the hypervisor could always see
// everything on it. What changes is that traffic in flight is now also visible
// there, and that belongs in the hosting company's own privacy statement.
//
// ── What this file is, and is not ────────────────────────────────
//
// Pure. It computes a hostname and renders configuration text, and writes
// nothing: `machine.publish` in control/ops/machineJobs.js does the writing,
// behind the privileged socket, like every other change to this host's nginx.
// Keeping the rendering here means it can be tested without root, without nginx
// and without a hypervisor, which is most of what there is to get wrong.

const path = require('path');

// A label in a hostname, and nothing that could escape one. Machine names are
// already constrained by `MACHINE_NAME` in machineJobs.js, but this renders
// text into a configuration file that nginx parses and root reloads, so it is
// checked again here rather than trusted across a layer.
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// A zone the hoster owns. Dots allowed, nothing else beyond a hostname.
const ZONE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
// Only a literal IPv4 is accepted as a proxy target. A hostname here would mean
// nginx resolving a name at request time, through whatever DNS the pool host
// has, to reach a machine on a private network: the wrong mechanism, and one a
// guest could influence by announcing a name instead of an address.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

const CONF_DIR = '/etc/nginx/sites-available';
const ENABLED_DIR = '/etc/nginx/sites-enabled';
const PREFIX = 'jotpanel-guest-';

// Overridable the same way MACHINE_ROOT is, and for the same reason: what this
// produces is a real file in a real directory, so the only honest test of it
// writes one. Read per call rather than at require time, so a test does not
// have to drop the module cache to move them.
const confDir = (env = process.env) => env.JOTPANEL_OPS_NGINX_AVAILABLE || CONF_DIR;
const enabledDir = (env = process.env) => env.JOTPANEL_OPS_NGINX_ENABLED || ENABLED_DIR;

// A zone has to be a REGISTRABLE DOMAIN, and an address is not one. Digits are
// legal hostname labels, so `192.168.0.1` matches the shape of a zone perfectly
// and publishing under it would produce `cust-1.192.168.0.1`: a name no wildcard
// certificate covers and, worse, one no passkey can be bound to, which is the
// exact defect this file exists to fix. Found by its own test on 2026-10-05.
// The last label carries the test, because a real suffix never ends in digits.
function isRegistrableZone(zone) {
  if (!ZONE.test(zone)) return false;
  if (IPV4.test(zone)) return false;
  const last = zone.split('.').pop();
  return /^[a-z][a-z0-9-]*$/.test(last);
}

function guestHostname({ machineName, zone }) {
  const label = String(machineName == null ? '' : machineName).trim().toLowerCase();
  const suffix = String(zone == null ? '' : zone).trim().toLowerCase().replace(/^\.+|\.+$/g, '');
  if (!LABEL.test(label)) throw new Error(`${machineName} is not a name that can be a hostname label`);
  if (!isRegistrableZone(suffix)) throw new Error(`${zone} is not a zone this can publish a guest under`);
  const host = `${label}.${suffix}`;
  // A wildcard certificate covers exactly one level. `a.b.guests.example.com`
  // under a `*.guests.example.com` certificate would be served with a
  // certificate no browser accepts, which is a broken machine rather than a
  // configuration preference, so it is refused here.
  if (host.split('.').length !== suffix.split('.').length + 1) {
    throw new Error(`${host} is more than one label below ${suffix}, which a wildcard certificate does not cover`);
  }
  return host;
}

function confPath(hostname, env) { return path.join(confDir(env), `${PREFIX}${hostname}.conf`); }
function enabledPath(hostname, env) { return path.join(enabledDir(env), `${PREFIX}${hostname}.conf`); }

// The vhost. One guest, one name, one private address.
function renderGuestVhost({ hostname, address, certificate, certificateKey }) {
  if (!isRegistrableZone(String(hostname || ''))) throw new Error(`${hostname} is not a hostname this can serve`);
  if (!IPV4.test(String(address || ''))) throw new Error(`${address} is not a private address this can proxy to`);
  for (const [label, value] of [['certificate', certificate], ['key', certificateKey]]) {
    if (!/^\/[\w./-]+$/.test(String(value || ''))) throw new Error(`${label} path ${value} is not a plain absolute path`);
  }
  return `# Managed by jotpanel-ops. One customer guest, reached through this pool host.
# Written by control/guestProxy.js; edit the guest's publication, not this file.
server {
  listen 80;
  listen [::]:80;
  server_name ${hostname};
  # Everything goes to HTTPS. The customer's session cookie and their activation
  # code both travel on this hostname, so there is no plain-HTTP surface at all
  # beyond the redirect itself.
  return 301 https://${hostname}$request_uri;
}
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${hostname};
  ssl_certificate ${certificate};
  ssl_certificate_key ${certificateKey};

  # A customer's machine, not a website: no document root, no index, no PHP, and
  # no static serving. Everything is the guest's own panel.
  client_max_body_size 512m;

  location / {
    proxy_pass https://${address};
    # The PUBLIC name, so the guest generates links, cookies and passkey
    # challenges for the address the customer actually used rather than for the
    # private one it answers on.
    proxy_set_header Host ${hostname};
    proxy_set_header X-Forwarded-Host ${hostname};
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

    # VERIFICATION IS OFF ON THIS HOP, DELIBERATELY, and this is the one line
    # here worth arguing about. The guest answers on a certificate it made
    # itself, whose subject is its private address, so verifying by name cannot
    # succeed and verifying by trust store would mean writing a per-guest CA
    # bundle on this host. The hop is this host reaching a NAT address on itself,
    # over a network no other machine is on, and the pool host is the only thing
    # that can reach it at all. The collector's own polling is the part that
    # pins the guest's certificate, and it still does.
    proxy_ssl_verify off;
    proxy_ssl_server_name on;

    # Echo and the assistant stream, so a long answer is not cut at the proxy.
    proxy_buffering off;
    proxy_read_timeout 3900s;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
`;
}

// What publishing one guest means, as data: the caller writes it, and the job
// that does the writing is the only thing that needs root.
function publishPlan({ machineName, zone, address, certificate, certificateKey, env }) {
  const hostname = guestHostname({ machineName, zone });
  return {
    hostname,
    origin: `https://${hostname}`,
    conf: confPath(hostname, env),
    enabled: enabledPath(hostname, env),
    text: renderGuestVhost({ hostname, address, certificate, certificateKey }),
  };
}

function unpublishPlan({ machineName, zone, env }) {
  const hostname = guestHostname({ machineName, zone });
  return { hostname, conf: confPath(hostname, env), enabled: enabledPath(hostname, env) };
}

// Whether this pool host is set up to publish guests at all. A hoster who has
// not pointed a wildcard at this machine and dropped a certificate on it should
// get a clear "not configured" rather than a vhost nginx will refuse.
function publicationSettings(env = process.env) {
  const zone = (env.JOTPANEL_GUEST_ZONE ?? env.ARCA_GUEST_ZONE ?? '').trim().toLowerCase();
  const certificate = (env.JOTPANEL_GUEST_WILDCARD_CERT ?? '').trim();
  const certificateKey = (env.JOTPANEL_GUEST_WILDCARD_KEY ?? '').trim();
  const missing = [];
  if (!zone) missing.push('JOTPANEL_GUEST_ZONE');
  if (!certificate) missing.push('JOTPANEL_GUEST_WILDCARD_CERT');
  if (!certificateKey) missing.push('JOTPANEL_GUEST_WILDCARD_KEY');
  return {
    configured: missing.length === 0 && isRegistrableZone(zone),
    zone, certificate, certificateKey,
    reason: missing.length
      ? `this pool host does not publish guests: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`
      : (isRegistrableZone(zone) ? null : `JOTPANEL_GUEST_ZONE "${zone}" is not a zone a guest can be published under`),
  };
}

module.exports = {
  guestHostname, isRegistrableZone, renderGuestVhost, publishPlan, unpublishPlan, publicationSettings,
  confPath, enabledPath, CONF_DIR, ENABLED_DIR, PREFIX,
};
