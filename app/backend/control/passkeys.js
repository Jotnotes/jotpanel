'use strict';

const { panelSetting } = require('./panelSettings');

// Passkeys. WebAuthn registration and assertion, many credentials per account.
//
// ── Why this uses a library, written down because the repository's instinct is
// the other way ──────────────────────────────────────────────────────────────
//
// The rule against new dependencies is a *frontend* rule and it is kept: the
// browser half of this is `navigator.credentials`, which ships in the browser,
// and nothing was added to `app/frontend`. The backend is a different question.
// Verifying a WebAuthn response by hand means decoding CBOR, parsing a COSE key
// into something a crypto library will accept, unpacking authenticator data,
// checking flags, and verifying an ECDSA or RSA signature over a concatenation
// you have to build correctly. Every one of those is a place where a wrong
// answer still *looks* like a working login, because a broken verifier accepts
// the good case and the attacker's case alike. That is the worst shape a
// security bug can have: it passes its own happy-path test.
//
// So `@simplewebauthn/server` does the cryptography. It is the standard
// implementation, it is CommonJS-compatible through its `require` export, and
// its floor of Node 20 is met by the installer, which pins NodeSource 22.
//
// ── The relying party, and why an IP address cannot have passkeys ────────────
//
// A WebAuthn credential is bound to a relying party ID, which must be a
// registrable domain. It may not be an IP address, and the installer defaults
// `DOMAIN` to the machine's public IP when nobody passes `--domain`. So a
// default install genuinely cannot offer passkeys, and the honest thing is to
// say so on the sign-in screen rather than to draw a button that produces a
// browser error nobody can act on. `relyingParty()` returns null in that case
// and every route asks it first.
//
// The panel is also reachable at more than one origin: through nginx on the
// domain, and directly on the recovery port, which exists so the owner can
// reach the panel when nginx is the thing that is broken. Both are allowed
// origins for the same relying party ID, because they are the same host. The
// origin is still checked; it is checked against a list rather than against one
// string.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

// How long a challenge is worth answering. Long enough for somebody to find the
// key in their bag, short enough that a captured challenge is not useful later.
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

const b64url = buf => Buffer.from(buf).toString('base64url');

// A relying party ID has to be a registrable domain. Neither an IP address nor
// a name with a port is one, so both are refused here rather than at the
// browser, where the error is unactionable.
function isRegistrableDomain(host) {
  if (!host || typeof host !== 'string') return false;
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(':') || host.includes('/')) return false;
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host);
}

function createPasskeyService({ db, now = () => new Date(), env = process.env }) {
  if (!db) throw new Error('the passkey service requires a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS webauthn_credentials (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL,
      credential_id   TEXT NOT NULL UNIQUE,
      public_key      BLOB NOT NULL,
      counter         INTEGER NOT NULL DEFAULT 0,
      transports      TEXT,
      device_type     TEXT,
      backed_up       INTEGER DEFAULT 0,
      name            TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      last_used_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS webauthn_credentials_user ON webauthn_credentials (user_id);

    CREATE TABLE IF NOT EXISTS webauthn_challenges (
      challenge   TEXT PRIMARY KEY,
      user_id     TEXT,
      kind        TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      expires_at  TEXT NOT NULL,
      used_at     TEXT
    );
  `);

  // The credential id is unique across the whole table rather than per account.
  // An authenticator will not mint the same credential for two accounts, so a
  // collision means somebody is replaying one account's credential at another,
  // and the database refusing it is one more place that has to be got past.

  function relyingParty() {
    const host = String(panelSetting("WEBAUTHN_RP_ID", undefined, env) || env.DOMAIN || '').trim().toLowerCase();
    if (!isRegistrableDomain(host)) return null;
    const origins = new Set();
    if (panelSetting("PUBLIC_ORIGIN", undefined, env)) origins.add(String(panelSetting("PUBLIC_ORIGIN", undefined, env)).replace(/\/$/, ''));
    origins.add(`https://${host}`);
    // The recovery port serves the same panel on the same host, and somebody
    // repairing a broken nginx is exactly the person who should still be able
    // to sign in.
    const panelPort = parseInt(panelSetting("PANEL_PORT", undefined, env) || '7443', 10);
    if (Number.isInteger(panelPort) && panelPort > 0) origins.add(`https://${host}:${panelPort}`);
    if (host === 'localhost') {
      origins.add('http://localhost:5173');
      origins.add(`http://localhost:${env.PORT || 9999}`);
    }
    return { rpID: host, rpName: panelSetting("WEBAUTHN_RP_NAME", undefined, env) || 'JotPanel', origins: [...origins] };
  }

  function available() { return relyingParty() !== null; }

  function whyUnavailable() {
    const host = String(panelSetting("WEBAUTHN_RP_ID", undefined, env) || env.DOMAIN || '').trim();
    if (!host) return 'This server has no domain name, and a passkey has to be bound to one.';
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
      return `This panel answers on ${host}, an address rather than a name. Passkeys are bound to a domain, so give the panel a domain first and they become available.`;
    }
    return `"${host}" is not a domain a passkey can be bound to.`;
  }

  function listFor(userId) {
    return db.prepare(`SELECT id, name, created_at, last_used_at, device_type, backed_up, transports
                       FROM webauthn_credentials WHERE user_id=? ORDER BY created_at`).all(userId)
      .map(row => ({ ...row, backed_up: !!row.backed_up, transports: row.transports ? JSON.parse(row.transports) : [] }));
  }

  function countFor(userId) {
    return db.prepare('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id=?').get(userId).n;
  }

  // Challenges are rows rather than session state, because the panel is one
  // process today and should not need rewriting the day it is two. They are
  // burnt on use and swept on expiry.
  function rememberChallenge(challenge, userId, kind) {
    const at = now();
    db.prepare('INSERT OR REPLACE INTO webauthn_challenges (challenge,user_id,kind,created_at,expires_at,used_at) VALUES (?,?,?,?,?,NULL)')
      .run(challenge, userId || null, kind, at.toISOString(), new Date(at.getTime() + CHALLENGE_TTL_MS).toISOString());
  }

  // Consumed exactly once. The UPDATE is the claim: two callers racing the same
  // challenge produce one row change and one refusal, rather than both reading
  // "unused" and both proceeding.
  function consumeChallenge(challenge, kind) {
    const row = db.prepare('SELECT * FROM webauthn_challenges WHERE challenge=? AND kind=?').get(challenge, kind);
    if (!row) return { ok: false, reason: 'That sign-in attempt is not one this server started' };
    if (row.used_at) return { ok: false, reason: 'That sign-in attempt has already been used' };
    if (new Date(row.expires_at) < now()) return { ok: false, reason: 'That sign-in attempt took too long, start again' };
    const burnt = db.prepare('UPDATE webauthn_challenges SET used_at=? WHERE challenge=? AND used_at IS NULL').run(now().toISOString(), challenge);
    if (burnt.changes !== 1) return { ok: false, reason: 'That sign-in attempt has already been used' };
    return { ok: true, row };
  }

  function sweepChallenges() {
    db.prepare("DELETE FROM webauthn_challenges WHERE expires_at < ?").run(new Date(now().getTime() - 24 * 3600 * 1000).toISOString());
  }

  // ── Registration ──────────────────────────────────────────────────
  async function registrationOptions({ userId, userName }) {
    const rp = relyingParty();
    if (!rp) throw new Error(whyUnavailable());
    const existing = db.prepare('SELECT credential_id, transports FROM webauthn_credentials WHERE user_id=?').all(userId);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName,
      userDisplayName: userName,
      // The account's own id, so an authenticator that already holds a
      // credential for this account replaces it rather than silently keeping
      // two that both claim to be the same person.
      userID: Buffer.from(userId, 'utf8'),
      attestationType: 'none',
      // What is already enrolled, so the authenticator declines to make a
      // second credential for itself rather than making one this server would
      // then have to reject.
      excludeCredentials: existing.map(row => ({
        id: row.credential_id,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred',
        // Deliberately unset. Restricting to platform authenticators is what
        // shuts a hardware key out, and a security key on a keyring is one of
        // the things this is for.
      },
    });
    rememberChallenge(options.challenge, userId, 'registration');
    return options;
  }

  async function verifyRegistration({ userId, response, name }) {
    const rp = relyingParty();
    if (!rp) throw new Error(whyUnavailable());
    const expected = response?.response?.clientDataJSON
      ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge
      : null;
    if (!expected) throw new Error('That registration response is not readable');
    const claim = consumeChallenge(expected, 'registration');
    if (!claim.ok) throw new Error(claim.reason);
    if (claim.row.user_id !== userId) throw new Error('That registration was started by a different account');

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      requireUserVerification: false,
    });
    if (!verification.verified || !verification.registrationInfo) throw new Error('That passkey could not be verified');

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
    const credentialId = credential.id;
    const already = db.prepare('SELECT user_id FROM webauthn_credentials WHERE credential_id=?').get(credentialId);
    if (already) {
      throw new Error(already.user_id === userId
        ? 'That passkey is already registered on this account'
        : 'That passkey is already registered');
    }

    const id = `pk_${crypto.randomBytes(8).toString('hex')}`;
    const label = String(name || '').trim().slice(0, 60) || `Passkey ${countFor(userId) + 1}`;
    db.prepare(`INSERT INTO webauthn_credentials
        (id,user_id,credential_id,public_key,counter,transports,device_type,backed_up,name,created_at,last_used_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`)
      .run(id, userId, credentialId, Buffer.from(credential.publicKey), credential.counter || 0,
        JSON.stringify(credential.transports || []), credentialDeviceType || null,
        credentialBackedUp ? 1 : 0, label, now().toISOString());
    return { id, name: label, credential_id: credentialId };
  }

  // ── Assertion ─────────────────────────────────────────────────────
  //
  // Deliberately does not take an email. A sign-in that asks who you are before
  // it asks for the passkey tells anybody who asks whether an address has an
  // account here, and a discoverable credential does not need the question: the
  // authenticator says which credential it used and this looks the account up
  // from that.
  async function authenticationOptions() {
    const rp = relyingParty();
    if (!rp) throw new Error(whyUnavailable());
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
    rememberChallenge(options.challenge, null, 'authentication');
    return options;
  }

  async function verifyAuthentication({ response }) {
    const rp = relyingParty();
    if (!rp) throw new Error(whyUnavailable());
    const expected = response?.response?.clientDataJSON
      ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8')).challenge
      : null;
    if (!expected) throw new Error('That sign-in response is not readable');
    const claim = consumeChallenge(expected, 'authentication');
    if (!claim.ok) throw new Error(claim.reason);

    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE credential_id=?').get(response.id);
    if (!row) throw new Error('That passkey is not registered here');

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: expected,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpID,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        counter: row.counter,
        transports: row.transports ? JSON.parse(row.transports) : undefined,
      },
      requireUserVerification: false,
    });
    if (!verification.verified) throw new Error('That passkey did not verify');

    // The signature counter, where the authenticator keeps one. A counter that
    // did not move on an authenticator that counts is the signature of a cloned
    // credential, and the library reports it; passkeys synced across a vendor's
    // devices legitimately stay at zero, so zero is not treated as suspicious.
    const next = verification.authenticationInfo.newCounter;
    if (row.counter > 0 && next <= row.counter) throw new Error('That passkey looks like a copy of one this server has seen');
    db.prepare('UPDATE webauthn_credentials SET counter=?, last_used_at=? WHERE id=?')
      .run(next, now().toISOString(), row.id);

    return { userId: row.user_id, credentialId: row.id, name: row.name };
  }

  // ── Management ────────────────────────────────────────────────────
  //
  // Removing a credential must not be a way to lock yourself out. The caller
  // says whether the account has another way in; this refuses when removing
  // the last passkey would leave nothing, and the caller is what knows about
  // passwords, because that is not this file's business.
  function remove({ userId, id, accountHasOtherLogin }) {
    const row = db.prepare('SELECT * FROM webauthn_credentials WHERE id=? AND user_id=?').get(id, userId);
    if (!row) return { ok: false, reason: 'No such passkey on this account' };
    if (countFor(userId) === 1 && !accountHasOtherLogin) {
      return { ok: false, reason: 'That is the only way into this account. Add another passkey, or set a password, before removing it.' };
    }
    db.prepare('DELETE FROM webauthn_credentials WHERE id=? AND user_id=?').run(id, userId);
    return { ok: true, name: row.name };
  }

  function rename({ userId, id, name }) {
    const label = String(name || '').trim().slice(0, 60);
    if (!label) return { ok: false, reason: 'A passkey needs a name' };
    const changed = db.prepare('UPDATE webauthn_credentials SET name=? WHERE id=? AND user_id=?').run(label, id, userId);
    return changed.changes === 1 ? { ok: true, name: label } : { ok: false, reason: 'No such passkey on this account' };
  }

  return {
    available, whyUnavailable, relyingParty, isRegistrableDomain,
    listFor, countFor, registrationOptions, verifyRegistration,
    authenticationOptions, verifyAuthentication, remove, rename,
    sweepChallenges, consumeChallenge, CHALLENGE_TTL_MS,
  };
}

module.exports = { createPasskeyService, isRegistrableDomain };
