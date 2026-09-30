'use strict';

// Spending a one-time sign-in link. A link proves the mailbox, the same way a
// password proves knowledge, so on an account with a second factor it is half
// the answer: what comes back is the same short-lived challenge the password
// path returns, never a session.
function createMagicSignIn({ db, magicHash, jwt, JWT_SECRET, twoFactor, audit }) {
  return (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: req.t('Token required') });
    const row = db.prepare('SELECT * FROM magic_tokens WHERE token=?').get(magicHash(token));
    if (!row)     return res.status(401).json({ error: req.t('Invalid link') });
    if (row.used) return res.status(401).json({ error: req.t('Link already used') });
    if (new Date(row.expires_at) < new Date()) return res.status(401).json({ error: req.t('Link expired') });

    const user = db.prepare('SELECT * FROM users WHERE email=?').get(row.email);
    if (!user) return res.status(404).json({ error: req.t('Account not found') });
    if (user.suspended) return res.status(403).json({ error: req.t('Account suspended') });
    db.prepare('UPDATE magic_tokens SET used=1 WHERE token=?').run(magicHash(token));

    if (twoFactor.isEnabled(user.id)) {
      const challenge = jwt.sign({ id: user.id, purpose: 'two_factor' }, JWT_SECRET, { expiresIn: '5m' });
      audit(user.id, 'magic_verified_awaiting_code', req);
      return res.json({ two_factor_required: true, challenge });
    }

    const jwtToken = jwt.sign({ id: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
    audit(user.id, 'magic_verified', req);
    res.json({ token: jwtToken, user: { id: user.id, name: user.name, email: user.email, plan: user.plan } });
  };
}

module.exports = { createMagicSignIn };
