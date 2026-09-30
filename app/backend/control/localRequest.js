'use strict';

// Whether a request genuinely came from this machine.
//
// This exists because possession of a secret is not the same as being local,
// and the panel had been treating them as the same thing. The bootstrap surface
// is gated on `ADMIN_KEY`, a single static string written into the box's `.env`
// at install time, and a static string travels: it is in the installer's
// output, in the environment of anything that reads that file, and in whatever
// copies it once somebody wires a billing system up to it. A credential that
// cannot say who is using it should not be able to reach anything from off the
// machine.
//
// Two questions, and both have to answer yes.
//
// **Did the socket come from loopback.** This is the one that matters, and it
// is asked of the kernel rather than of a header. The panel serves the same
// express app on a recovery port bound to every interface, so a check that
// trusted `X-Forwarded-For` alone would have been answered by whoever was
// asking.
//
// **Did anything forward it.** nginx sits on the same box, so a request it
// proxies arrives from 127.0.0.1 and the socket alone cannot tell it from the
// installer's own curl. Every nginx configuration this product writes sets
// `X-Forwarded-For` and `X-Real-IP`, so their presence is the difference. It is
// deliberately not a trust decision about the contents of those headers: the
// value is never read, only whether a hop announced itself at all. A caller
// that adds the header to a genuinely local request refuses itself, which is
// the safe direction to be wrong in.
//
// Neither check is the whole defence. The bootstrap routes live on their own
// listener bound to 127.0.0.1 and are not mounted on the app the internet can
// reach, so this function is the second lock rather than the first.

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// A hop's own announcement that it forwarded this. `Forwarded` is the RFC 7239
// spelling; the other two are what nginx, HAProxy and every CDN actually send.
const FORWARDED_HEADERS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'x-forwarded-host', 'x-forwarded-proto'];

function isLocalRequest(req) {
  const headers = (req && req.headers) || {};
  for (const name of FORWARDED_HEADERS) {
    if (headers[name] !== undefined && headers[name] !== null && headers[name] !== '') return false;
  }
  const peer = (req && req.socket && req.socket.remoteAddress) || '';
  return LOOPBACK.has(peer);
}

// Why a request was refused, in words that go into the audit record. Kept
// beside the check so the record cannot drift from the rule.
function refusalReason(req) {
  const headers = (req && req.headers) || {};
  const hop = FORWARDED_HEADERS.find(name => headers[name] !== undefined && headers[name] !== null && headers[name] !== '');
  if (hop) return `forwarded by a proxy (${hop})`;
  const peer = (req && req.socket && req.socket.remoteAddress) || 'an unknown address';
  return `arrived from ${peer}, which is not this machine`;
}

module.exports = { isLocalRequest, refusalReason, LOOPBACK, FORWARDED_HEADERS };
