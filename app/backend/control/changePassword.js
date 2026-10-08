'use strict';

// A signed-in person replacing their own password.
//
// The route this replaces was `PUT /accounts/:id/password`, and it was removed
// because it "overwrote any account's password with no authority check, no
// length floor and no record". All three of those are structural here rather
// than remembered:
//
//   - No account identifier is accepted from the request at all. Not in a path,
//     not in a body. The account is `req.user.id`, which only `auth` can set,
//     so there is no input through which a caller could name somebody else's
//     account. That is why this is mounted at /api/me/password: a route with an
//     id in it invites exactly the bug that got the old one deleted.
//   - The current password is proved in the same request, with the same compare
//     the sign-in path uses, so a session somebody walked up to is not on its
//     own enough to change the credential it was issued against.
//   - The floor is the product's floor, twelve characters, the same one
//     `account.create` applies in control/activation.js and the installer
//     applies to the first owner. `/api/register` still says eight; that is the
//     public sign-up path, closed on a real install, and it is the outlier
//     rather than the rule.
//   - Both outcomes are recorded. Never the password, never the hash, never a
//     length: the record says that the account's password was replaced, and the
//     audit row already carries who and from where.
//
// Everything else is deliberately left alone. Account recovery, the recovery
// ceremony, passkeys and the owner bootstrap route are not touched by this, and
// nothing here reads or writes their tables.

// The same padding sign-in uses, so an account row with an unreadable hash
// costs the same work as a real one instead of answering faster.
const INVALID_HASH = '$2a$12$invalidhashpadding000000000000000000000000000000000000000';

// The floor the rest of the product enforces. Named rather than inline so a
// test can assert against the same constant the route applies.
const MIN_LENGTH = 12;

function createChangePassword({ db, bcrypt, jwt, JWT_SECRET, twoFactor, audit }) {
  if (!db || !bcrypt || !jwt || !JWT_SECRET || !twoFactor || !audit) {
    throw new Error('changePassword needs a database, bcrypt, jwt, a secret, twoFactor and audit');
  }

  return async function changePassword(req, res) {
    const t = req.t || (s => s);

    // `auth` is what puts an identity on the request and it refuses before
    // this is reached, so this cannot happen through the mounted route. It is
    // here because the alternative to answering is not answering: an async
    // handler that throws rejects its promise, Express never hears about it
    // and the request hangs with no reply at all. The identity is taken from
    // here and from nowhere else — there is deliberately no fallback to
    // anything in the body, which is the whole reason the old route died.
    if (!req.user?.id) {
      return res.status(401).json({ error: t('No token') });
    }

    // A machine credential is not a person, and rotating the password of the
    // human who issued the key is not something the key should be able to do.
    // `auth`'s own allowlist already refuses a key on this path because the
    // path is not in it; this is kept as well because the two fail differently
    // — that survives somebody adding a pattern to the allowlist.
    if (req.apiKey) {
      audit(req.user.id, 'password_change_refused', req, 'an API key cannot change an account password');
      return res.status(403).json({ error: t('An API key cannot change an account password.') });
    }

    const current = String(req.body?.current_password ?? '');
    const next = String(req.body?.new_password ?? '');

    if (!current || !next) {
      return res.status(400).json({ error: t('Your current password and the new one are both required.') });
    }
    if (next.length < MIN_LENGTH) {
      // Checked before the compare so a caller who typed a short new password
      // is told that, rather than being told their current one is wrong.
      return res.status(400).json({ error: t('Choose a password of at least 12 characters.') });
    }
    if (next === current) {
      return res.status(400).json({ error: t('That is the password you already have.') });
    }

    const user = db.prepare('SELECT id,name,email,plan,password FROM users WHERE id=?').get(req.user.id);

    // Awaited rather than sync, for the reason written at /api/login: bcryptjs
    // is pure JavaScript and `compareSync` at cost 12 holds the event loop for
    // the whole hash, so a panel doing this work answers nobody for a second.
    // Wrapped, because a hash the library cannot read is not a successful
    // proof, and an async handler that rejects answers nothing at all.
    let proved = false;
    try { proved = (await bcrypt.compare(current, user?.password || INVALID_HASH)) && !!user; } catch { proved = false; }
    if (!proved) {
      audit(req.user.id, 'password_change_failed', req, 'current password wrong');
      return res.status(401).json({ error: t('That password is not right') });
    }

    // If the account has a second factor, it is asked for here, exactly as
    // turning the second factor off asks for it. The reasoning is the one
    // already written at /api/2fa/disable: somebody sitting at a session that
    // was left open knows neither the password nor the code, and a credential
    // change should need both halves of the sign-in it is replacing. A recovery
    // code is accepted in place of a live code, because that is what every
    // other proof in control/twoFactor.js accepts and it is the only thing a
    // person who has lost the phone has left.
    if (twoFactor.isEnabled(user.id)) {
      const supplied = String(req.body?.code ?? '').trim();
      const byCode = /^\d{6}$/.test(supplied.replace(/\s/g, ''))
        ? twoFactor.checkCode(user.id, supplied)
        : twoFactor.useRecoveryCode(user.id, supplied);
      if (!byCode.ok) {
        audit(user.id, 'password_change_failed', req, byCode.reason);
        return res.status(401).json({ error: byCode.reason });
      }
    }

    // The same mechanism and the same cost as every other password write on
    // this box: bcrypt at 12, as public registration, the owner bootstrap route
    // and `account.create` all do. Reduced cost here would make this the
    // cheapest hash on the machine and therefore the one worth attacking.
    const hash = bcrypt.hashSync(next, 12);
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, user.id);

    // What is deliberately NOT done, said out loud because a reader will look
    // for it:
    //
    //   - The second factor is left enrolled. Changing a password is not
    //     evidence about the phone, and clearing the factor here would mean a
    //     password change quietly lowered the account's protection — the exact
    //     shape of the hole /api/2fa/disable exists to keep closed.
    //   - Passkeys are left alone, for the same reason. They are a separate
    //     credential and the password has no authority over them.
    //   - Other sessions are NOT invalidated, because on this box they cannot
    //     be. A panel session is a stateless 30-day JWT with no server-side
    //     record and no version on the account, so there is nothing to revoke
    //     against; the same sentence is already written about API keys at
    //     server.js. Adding a revocation generation would change the
    //     authentication middleware itself and the recovery surfaces that share
    //     it, which is a decision bigger than this route. So this is honest
    //     about it rather than pretending: the person's own session is replaced
    //     below, and the event is in the audit log where a stolen-session
    //     question can be asked of it. See the report accompanying this change.
    //   - API keys are left valid. They are the account's machine credentials,
    //     issued and revoked one at a time at /api/api-keys, and a password
    //     change is not a revocation of them.
    audit(user.id, 'password_changed', req);

    // A fresh session for the caller, so the one they are holding is replaced
    // by one minted after the change rather than one minted before it. Same
    // claims and same lifetime as the one /api/login issues; a token is not a
    // new authority, it is the one they already have.
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name, email: user.email, plan: user.plan },
      note: t('Your password is changed. Sessions already signed in elsewhere stay signed in until they expire.'),
    });
  };
}

module.exports = { createChangePassword, MIN_LENGTH };
