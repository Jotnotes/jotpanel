'use strict';

// Device trust: whether the thing asking is a machine this account has
// enrolled, and what a session on an unenrolled one is allowed to do.
//
// WHAT THIS IS FOR, and it is not the usual thing. The scenario Steve
// described is somebody signed in to their own Navigator on a computer they do
// not own — at a friend's house, a client's office, a library terminal. Two
// different risks live there and only one of them is this module's job:
//
//   - Uploading that machine's files INTO Navigator. The victim is the owner
//     of the computer. DECIDED 2026-10-04 that this is not a mechanism
//     problem: a general-purpose upload is what every FTP client has always
//     done, liability follows inducement rather than capability, and the
//     mitigation is an acceptable-use clause. See
//     docs/NAVIGATOR_DEVICE_TRUST_DESIGN.md.
//   - Draining the vault OUT of Navigator, from a session on a machine that
//     may be keylogged, shoulder-surfed or simply left signed in. The victim
//     is the account holder. THAT is what this defends, and it is the one with
//     commercial weight, because it is the question a hosting buyer asks.
//
// So the asymmetry here is deliberate and is Steve's call: download is the
// direction that empties the vault, so **download requires a step-up even on a
// trusted device**, and on a visiting device the policy can refuse it outright.
//
// WHAT PROVES A DEVICE. A roaming authenticator — a Yubikey — proves
// possession of a key and says nothing about which computer it is plugged
// into, so it can never answer "is this machine trusted" and is not used for
// that here. A PLATFORM credential (Touch ID, Windows Hello) cannot leave the
// machine it was made on, so presenting one is evidence about the machine.
// That distinction is the whole basis of this file; collapsing it would
// produce something that looks secure and is not.

// How a session was authenticated. Ordered weakest to strongest, because
// several decisions below are "at least this".
const METHOD = Object.freeze({
  password: 1,          // something you know, and nothing about the device
  password_2fa: 2,      // plus a code, still nothing about the device
  roaming_passkey: 3,   // really you, anywhere: a Yubikey or a phone
  platform_passkey: 4,  // really you, AND on this specific machine
});

const TIER = Object.freeze({ visiting: 'visiting', enrolled: 'enrolled' });

// What the policy can say about an action. `step_up` is not a refusal: it is
// "ask again, properly, right now", which is the thing a stolen session cannot
// satisfy because it has no authenticator.
const VERDICT = Object.freeze({ allow: 'allow', step_up: 'step_up', refuse: 'refuse' });

// The surfaces that hold the things worth stealing. Named rather than inferred
// from a path, because a rule that depends on a URL shape breaks silently the
// first time a route is renamed.
const SENSITIVE = Object.freeze([
  'files.download', 'files.download_bulk', 'account.export',
  'vault.id', 'vault.passwords', 'legacydesk', 'apikeys.read',
]);

const DEFAULTS = Object.freeze({
  // OFF BY DEFAULT, and this is not timidity. The step-up verdict is an
  // instruction to the client to confirm with an authenticator and retry, and
  // NOTHING IN EITHER FRONTEND UNDERSTANDS IT YET: no screen asks for a
  // passkey touch mid-download, and no sign-in path records how it
  // authenticated, so every session reads as `password` and therefore as
  // visiting. Enforcing in that state means every download answers 428 in
  // JotPanel as well as Navigator, which would break a shipped product to
  // half-ship an unshipped feature.
  //
  // Caught on 2026-10-04 by Steve asking whether this touches JotPanel. It did.
  //
  // So the engine ships, tested, and the enforcement waits for the client half.
  // Turn it on per install with JOTPANEL_DEVICE_TRUST=1 once a frontend can
  // satisfy a step-up; the policy below is what it will then apply.
  enforce: false,
  // Off by default on a new install. The hoster turns it on for a customer who
  // wants it; a default that silently permits is a default nobody revisits.
  uploadsFromVisiting: false,
  // Downloads: 'enrolled_only' | 'step_up' | 'anyone'. The middle one is the
  // shipped default because refusing outright strands somebody who genuinely
  // needs a file at a library, and allowing outright is what we are fixing.
  downloadsFromVisiting: 'step_up',
  // Even on an enrolled machine. Steve, 2026-10-04: download gets a step-up
  // too, not merely upload blocked.
  stepUpForSensitiveOnEnrolled: true,
  // A file request lets somebody with no account upload into a nominated
  // folder, which is an inbound hole by construction.
  fileRequestsEnabled: false,
  // How recently the step-up must have happened for it to still count.
  stepUpFreshnessMs: 5 * 60 * 1000,
});

function createDeviceTrust({ db, now = () => new Date(), policy: overrides = {} } = {}) {
  const policy = { ...DEFAULTS, ...overrides };

  if (db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id             TEXT PRIMARY KEY,
        user_id        TEXT NOT NULL,
        credential_id  TEXT NOT NULL UNIQUE,
        label          TEXT,
        enrolled_at    TEXT NOT NULL,
        last_seen_at   TEXT,
        revoked_at     TEXT
      )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_trusted_devices_user ON trusted_devices(user_id)');
  }

  // ── Reading a session ─────────────────────────────────────────────
  //
  // From claims the token carries, never from anything the request asserts
  // about itself. A header saying "I am a trusted device" is a header an
  // attacker writes.
  function tierOf(session = {}) {
    const method = METHOD[session.amr] || 0;
    if (method < METHOD.platform_passkey) return TIER.visiting;
    if (!session.deviceId) return TIER.visiting;
    if (db && !isEnrolled(session.userId, session.deviceId)) return TIER.visiting;
    return TIER.enrolled;
  }

  function isEnrolled(userId, credentialId) {
    if (!db) return true;
    const row = db.prepare(
      'SELECT 1 FROM trusted_devices WHERE user_id=? AND credential_id=? AND revoked_at IS NULL'
    ).get(String(userId || ''), String(credentialId || ''));
    return !!row;
  }

  function enroll({ userId, credentialId, label = null }) {
    if (!db) throw new Error('enrolling a device needs the database');
    if (!userId || !credentialId) throw new Error('a trusted device needs an account and a credential');
    const id = `dev_${Buffer.from(String(credentialId)).toString('hex').slice(0, 16)}`;
    db.prepare(`INSERT OR REPLACE INTO trusted_devices (id,user_id,credential_id,label,enrolled_at,revoked_at)
                VALUES (?,?,?,?,?,NULL)`)
      .run(id, String(userId), String(credentialId), label, now().toISOString());
    return { id, userId, credentialId, label };
  }

  function revoke({ userId, credentialId }) {
    if (!db) throw new Error('revoking a device needs the database');
    const result = db.prepare(
      'UPDATE trusted_devices SET revoked_at=? WHERE user_id=? AND credential_id=? AND revoked_at IS NULL'
    ).run(now().toISOString(), String(userId), String(credentialId));
    return result.changes > 0;
  }

  function list(userId) {
    if (!db) return [];
    return db.prepare(
      'SELECT id,credential_id,label,enrolled_at,last_seen_at FROM trusted_devices WHERE user_id=? AND revoked_at IS NULL ORDER BY enrolled_at DESC'
    ).all(String(userId));
  }

  // ── The decision ──────────────────────────────────────────────────
  //
  // Returns a verdict and, always, a reason in plain words: a refusal a person
  // cannot act on is a support ticket.
  function check(action, session = {}) {
    const tier = tierOf(session);
    // Reported rather than silently permissive: a caller asking what the policy
    // says should be able to tell "allowed" from "not being enforced here".
    if (!policy.enforce) {
      return verdict(VERDICT.allow, tier,
        'Device-trust policy is not enforced on this install (JOTPANEL_DEVICE_TRUST is off).');
    }
    const sensitive = SENSITIVE.includes(action);
    const fresh = hasFreshStepUp(session);

    if (action === 'files.upload' && tier === TIER.visiting) {
      return policy.uploadsFromVisiting
        ? verdict(VERDICT.allow, tier, 'This install allows uploads from a device you have not enrolled.')
        : verdict(VERDICT.refuse, tier,
          'Uploads are only allowed from a device you have enrolled. Use your phone, or enroll this computer from Settings if it is yours.');
    }

    if (action === 'filerequest.create' && !policy.fileRequestsEnabled) {
      return verdict(VERDICT.refuse, tier,
        'File requests are switched off on this server. Somebody with no account could otherwise upload into it.');
    }

    if (sensitive && tier === TIER.visiting) {
      if (policy.downloadsFromVisiting === 'enrolled_only') {
        return verdict(VERDICT.refuse, tier,
          'This can only be reached from a device you have enrolled.');
      }
      if (policy.downloadsFromVisiting === 'anyone') {
        return verdict(VERDICT.allow, tier, 'This install allows it from any device.');
      }
      return fresh
        ? verdict(VERDICT.allow, tier, 'Confirmed just now.')
        : verdict(VERDICT.step_up, tier,
          'Confirm with your passkey or security key before this leaves the server.');
    }

    // The asymmetry Steve asked for: even an enrolled machine confirms before
    // the vault empties, because enrolment says the machine is yours and says
    // nothing about who is sitting at it right now.
    if (sensitive && policy.stepUpForSensitiveOnEnrolled && !fresh) {
      return verdict(VERDICT.step_up, tier, 'Confirm with your passkey or security key before this leaves the server.');
    }

    return verdict(VERDICT.allow, tier, 'Allowed.');
  }

  // A step-up is only worth anything while it is recent. A claim with no time
  // on it is treated as no step-up at all rather than as an old one, because
  // the missing case is the one an attacker controls.
  function hasFreshStepUp(session = {}) {
    if (!session.stepUpAt) return false;
    const at = new Date(session.stepUpAt).getTime();
    if (!Number.isFinite(at)) return false;
    return (now().getTime() - at) <= policy.stepUpFreshnessMs;
  }

  function verdict(decision, tier, reason) { return { decision, tier, reason, allowed: decision === VERDICT.allow }; }

  return { check, tierOf, enroll, revoke, list, isEnrolled, hasFreshStepUp, policy, METHOD, TIER, VERDICT, SENSITIVE };
}

module.exports = { createDeviceTrust, METHOD, TIER, VERDICT, SENSITIVE, DEFAULTS };
