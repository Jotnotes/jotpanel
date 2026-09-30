'use strict';

// How well each model has done each kind of work for an account (Stage 7).
// Work a model got accepted counts for it; answers rejected by review, and
// answers the person corrected, count against it. Ordering only reorders the
// candidates routing already allowed: it never adds one the hard limits left
// out.

function createRoutingFit({ db, now = () => new Date() }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resident_routing_fit (
      account_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      model      TEXT NOT NULL,
      accepted   INTEGER NOT NULL DEFAULT 0,
      rejected   INTEGER NOT NULL DEFAULT 0,
      corrected  INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, role, model)
    );
  `);
  const columns = { accepted: 'accepted', rejected: 'rejected', corrected: 'corrected' };

  function record(accountId, role, model, outcome) {
    const column = columns[outcome];
    if (!column || !accountId || !role || !model) return;
    db.prepare(`INSERT INTO resident_routing_fit (account_id, role, model, ${column}, updated_at) VALUES (?,?,?,1,?)
      ON CONFLICT(account_id, role, model) DO UPDATE SET ${column}=${column}+1, updated_at=excluded.updated_at`)
      .run(String(accountId), String(role), String(model), now().toISOString());
  }

  // Positive is good. Two failures more than successes is enough to move a
  // model down for that kind of work.
  function score(row) {
    return row ? row.accepted - row.rejected - 2 * row.corrected : 0;
  }

  function order(accountId, role, candidates, keyOf = c => c) {
    const rows = new Map(db.prepare('SELECT * FROM resident_routing_fit WHERE account_id=? AND role=?').all(String(accountId), String(role)).map(r => [r.model, r]));
    return candidates
      .map((candidate, index) => ({ candidate, index, s: score(rows.get(keyOf(candidate))) }))
      .sort((a, b) => ((a.s <= -2) - (b.s <= -2)) || a.index - b.index)
      .map(item => item.candidate);
  }

  function report(accountId) {
    return db.prepare('SELECT role, model, accepted, rejected, corrected, updated_at FROM resident_routing_fit WHERE account_id=? ORDER BY role, model').all(String(accountId));
  }

  return { record, order, report, score };
}

module.exports = { createRoutingFit };
