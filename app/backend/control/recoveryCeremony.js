'use strict';

// Getting back in when every credential is gone.
//
// This is the ceremony the account recovery codes exist for. Until now a person
// could hold ten codes and there was nowhere to spend them, which is a safety
// net printed on paper and hung on nothing.
//
// ── Two keys, and neither one opens the door alone ───────────────────────────
//
// **The user's key** is an unused account recovery code. It proves the person
// held something from before they were locked out, which a stranger who has
// just learned an email address does not.
//
// **The hoster's key** is an approval from the organization that actually
// provides for that account, given by a human who looked. It proves somebody
// with a relationship to the customer agrees this request is real.
//
// A code alone is not enough, because paper gets photographed. An approval
// alone is not enough, because a hosting company's support desk is social
// engineering's favourite door. Both, and the request dies on its own if
// nobody finishes it.
//
// ── What the hoster may not do ───────────────────────────────────────────────
//
// The deleted `/admin/api/accounts/:id/password` route let whoever held a
// shared key set anybody's password. That is the thing this must not become.
// A hoster here **approves** and never **sets**: no route in this file accepts
// a credential from the approver, the approver never learns the recovery code,
// and what the user gets at the end is one short-lived ticket good for exactly
// one thing, enrolling a new passkey. It is not a session, so an approval is
// not a way into somebody's account for whoever approved it.
//
// ── Whose customer is it ─────────────────────────────────────────────────────
//
// The question "may this hoster approve this request" is not answered here. It
// is asked of `ownership.reaches`, the same function that answers it for every
// other operation, so a hosting company on another machine, or a reseller with
// no relationship to this account, gets the same no it gets everywhere else. A
// second implementation of that check written beside this one is exactly how
// products end up with two answers that disagree.

const crypto = require('crypto');

// Long enough for a person to telephone their host and for the host to look at
// it during a working day. Short enough that a forgotten request is not a
// standing invitation.
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
// The ticket handed over at the end. Minutes, because its only job is to carry
// somebody from "approved" to "passkey registered" in one sitting.
const TICKET_TTL_MS = 15 * 60 * 1000;

function createRecoveryCeremony({ db, ownership, accountRecovery, now = () => new Date(), audit = () => {} }) {
  for (const [name, value] of Object.entries({ db, ownership, accountRecovery })) {
    if (!value) throw new Error(`the recovery ceremony requires ${name}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_recovery_requests (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL,
      org_id         TEXT,
      state          TEXT NOT NULL,
      code_proved_at TEXT,
      approved_at    TEXT,
      approved_by    TEXT,
      approver_org   TEXT,
      consumed_at    TEXT,
      ticket_hash    TEXT,
      ticket_expires TEXT,
      created_at     TEXT NOT NULL,
      expires_at     TEXT NOT NULL,
      created_ip     TEXT
    );
    CREATE INDEX IF NOT EXISTS account_recovery_requests_user ON account_recovery_requests (user_id, state);
  `);

  const id = prefix => `${prefix}_${crypto.randomBytes(10).toString('hex')}`;
  const expired = row => new Date(row.expires_at) < now();

  // Opening a request proves nothing on its own, so it deliberately gives
  // nothing away: the answer is the same whether or not the address is here.
  // The request only becomes real once a recovery code is spent on it.
  function open({ email, code, ip = null }) {
    const user = db.prepare('SELECT id, email FROM users WHERE email=?').get(String(email || '').trim().toLowerCase());
    if (!user) return { ok: true, opaque: true };

    // The user's key, spent now rather than at the end. A code that does not
    // match must not open a request, or the queue becomes a way to make a
    // hoster's support desk look at an account somebody merely named.
    const spent = accountRecovery.consume(user.id, code);
    if (!spent.ok) {
      audit(user.id, 'recovery_request_refused', null, spent.reason);
      return { ok: true, opaque: true };
    }

    const membership = (() => { try { return ownership.getMembership(user.id); } catch { return null; } })();
    const at = now();
    const requestId = id('rcv');
    db.prepare(`INSERT INTO account_recovery_requests
      (id,user_id,org_id,state,code_proved_at,created_at,expires_at,created_ip)
      VALUES (?,?,?,'awaiting_hoster',?,?,?,?)`)
      .run(requestId, user.id, membership ? membership.orgId : null, at.toISOString(), at.toISOString(),
        new Date(at.getTime() + REQUEST_TTL_MS).toISOString(), ip);
    audit(user.id, 'recovery_requested', null, `${requestId}: recovery code accepted, ${spent.codes_left} left, awaiting the hosting company`);
    return { ok: true, opaque: true, requestId, state: 'awaiting_hoster' };
  }

  // What a hoster sees. Narrowed to the accounts that hoster actually provides
  // for, by the ownership engine rather than by a filter written here.
  function pending(approverIdentityId) {
    const rows = db.prepare(`SELECT * FROM account_recovery_requests WHERE state='awaiting_hoster' ORDER BY created_at`).all();
    return rows.filter(row => !expired(row) && canApprove(approverIdentityId, row.user_id).ok).map(row => ({
      id: row.id,
      email: db.prepare('SELECT email FROM users WHERE id=?').get(row.user_id)?.email || null,
      created_at: row.created_at,
      expires_at: row.expires_at,
      recovery_code_proved: !!row.code_proved_at,
    }));
  }

  // The one question, asked of the one place that answers it everywhere else.
  function canApprove(approverIdentityId, targetUserId) {
    try {
      const approver = ownership.getMembership(approverIdentityId);
      const target = ownership.getMembership(targetUserId);
      if (!approver || !target) return { ok: false, reason: 'That account has no organization' };
      if (approver.orgId === target.orgId) return { ok: false, reason: 'An account cannot approve its own recovery' };
      // `withinReach` is the function every other operation asks, and it is
      // the whole authority check: your own organization, anything beneath you
      // if you provide for it, anything on the box if you run the box. Note the
      // signature takes a membership and a target organization; `reaches` is
      // the resource-shaped question and calling that here would have compared
      // an organization id to a resource key and quietly answered no.
      if (!ownership.withinReach(approver, target.orgId)) {
        return { ok: false, reason: 'That is not an account this organization provides for' };
      }
      return { ok: true, approverOrgId: approver.orgId };
    } catch (error) {
      return { ok: false, reason: error.message };
    }
  }

  // Approving hands back nothing the approver can use. The ticket is generated
  // here, hashed here, and returned for delivery to the *user*; the approver's
  // own answer says only that it was approved.
  function approve({ requestId, approverIdentityId }) {
    const row = db.prepare('SELECT * FROM account_recovery_requests WHERE id=?').get(requestId);
    if (!row) return { ok: false, reason: 'No such recovery request' };
    if (row.state !== 'awaiting_hoster') return { ok: false, reason: `That request is ${row.state}` };
    if (expired(row)) {
      db.prepare("UPDATE account_recovery_requests SET state='expired' WHERE id=?").run(requestId);
      return { ok: false, reason: 'That request has expired' };
    }
    const may = canApprove(approverIdentityId, row.user_id);
    if (!may.ok) {
      audit(approverIdentityId, 'recovery_approval_refused', null, `${requestId}: ${may.reason}`);
      return { ok: false, reason: may.reason };
    }

    const ticket = `arcv_${crypto.randomBytes(24).toString('hex')}`;
    const at = now();
    const changed = db.prepare(`UPDATE account_recovery_requests
        SET state='approved', approved_at=?, approved_by=?, approver_org=?, ticket_hash=?, ticket_expires=?
        WHERE id=? AND state='awaiting_hoster'`)
      .run(at.toISOString(), approverIdentityId, may.approverOrgId,
        crypto.createHash('sha256').update(ticket).digest('hex'),
        new Date(at.getTime() + TICKET_TTL_MS).toISOString(), requestId);
    // The UPDATE is the claim. Two approvers racing produce one change and one
    // refusal rather than two tickets for one request.
    if (changed.changes !== 1) return { ok: false, reason: 'That request was already handled' };

    audit(row.user_id, 'recovery_approved', null, `${requestId} approved by ${may.approverOrgId}`);
    return { ok: true, ticket, expires_at: new Date(at.getTime() + TICKET_TTL_MS).toISOString() };
  }

  // Spending the ticket. Returns the identity it belongs to and burns it, so
  // the caller may let that person enrol exactly one new credential. It
  // deliberately does not create a session: the ticket is not a way in, it is
  // permission to make a way in.
  function redeem({ ticket }) {
    const hash = crypto.createHash('sha256').update(String(ticket || '')).digest('hex');
    const row = db.prepare("SELECT * FROM account_recovery_requests WHERE ticket_hash=? AND state='approved'").get(hash);
    if (!row) return { ok: false, reason: 'That recovery ticket is not valid' };
    if (!row.ticket_expires || new Date(row.ticket_expires) < now()) {
      db.prepare("UPDATE account_recovery_requests SET state='expired' WHERE id=?").run(row.id);
      audit(row.user_id, 'recovery_ticket_expired', null, row.id);
      return { ok: false, reason: 'That recovery ticket has expired' };
    }
    const burnt = db.prepare("UPDATE account_recovery_requests SET state='consumed', consumed_at=? WHERE id=? AND state='approved'")
      .run(now().toISOString(), row.id);
    if (burnt.changes !== 1) return { ok: false, reason: 'That recovery ticket has already been used' };
    audit(row.user_id, 'recovery_ticket_redeemed', null, row.id);
    return { ok: true, userId: row.user_id, requestId: row.id };
  }

  function statusOf(requestId) {
    const row = db.prepare('SELECT id,state,created_at,expires_at,approved_at,consumed_at FROM account_recovery_requests WHERE id=?').get(requestId);
    if (!row) return null;
    if (row.state === 'awaiting_hoster' && expired(row)) return { ...row, state: 'expired' };
    return row;
  }

  function sweep() {
    db.prepare("UPDATE account_recovery_requests SET state='expired' WHERE state='awaiting_hoster' AND expires_at < ?").run(now().toISOString());
  }

  return { open, pending, approve, redeem, statusOf, canApprove, sweep, REQUEST_TTL_MS, TICKET_TTL_MS };
}

module.exports = { createRecoveryCeremony };
