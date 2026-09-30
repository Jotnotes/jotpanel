'use strict';

// The scheduled half of backups. systemd runs this, one argument, the domain.
// It reads the schedule that was stored when the timer was set, so the timer
// carries no parameters and there is no command line to get wrong.
//
// It also writes a run journal, and that is the part worth explaining. A
// scheduled backup used to leave a single `<domain>.last.json` behind and
// nothing else: no durable record, so a backup that failed at 3am was invisible
// to the operator, and the question "what ran on this machine that no person
// approved" had no answer. The journal below is the evidence for that question.
//
// Two rules shape it, and neither may be relaxed by a later change.
//
// One: a scheduled run is NEVER recorded as approved. It carries
// `executionBasis: 'unattended_schedule'` and no approval field exists on it at
// all. Approval is a person's own authority, and a machine issuing one launders
// consent and voids the audit trail. The moment this product has a category of
// approval a machine can issue, the word stops meaning anything anywhere in it.
//
// Two: the journal is append-only and one file per run. It is never rewritten,
// so a later run cannot quietly change what an earlier one recorded, and the
// panel ingests each file exactly once by its own run id.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATE_DIR = (process.env.JOTPANEL_OPS_STATE_DIR ?? process.env.ARCA_OPS_STATE_DIR) || '/var/lib/jotpanel-ops';
const RUN_DIR = path.join(STATE_DIR, 'backup-runs');
const dom = String(process.argv[2] || '');
if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(dom)) { console.error('[backup-run] a domain is required'); process.exit(2); }
const domain = dom.toLowerCase();

const configFile = path.join(STATE_DIR, 'backup-schedules', `${domain}.json`);
if (!fs.existsSync(configFile)) { console.error('[backup-run] no schedule stored for', domain); process.exit(0); }

// A suspended account's timer is stopped, so this should not be reached while
// suspended. It is checked anyway, because "should not be reached" is how a
// suspension gets bypassed by whoever starts the unit by hand.
const suspended = fs.existsSync(path.join(STATE_DIR, 'backup-schedules', `${domain}.suspended`));

const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const jobs = require('./privilegedJobs');

const runId = `run_${crypto.randomBytes(10).toString('hex')}`;
const startedAt = new Date().toISOString();

function journal(entry) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });
    const file = path.join(RUN_DIR, `${runId}.json`);
    fs.writeFileSync(file, JSON.stringify({
      runId,
      domain,
      // The basis this ran on. There is deliberately no approval field here, not
      // even a null one, so nothing downstream can read an approval out of it.
      executionBasis: 'unattended_schedule',
      schedule: {
        when: config.when, parts: config.parts, databases: config.databases, keep: config.keep, setAt: config.set_at,
        // Asked for here, done by the panel. This side cannot read the
        // destination's credential and should not be able to, so all it does is
        // say that a copy was wanted. A run that wanted one and did not get one
        // is not healthy, and the panel is what decides that.
        offsite: config.offsite === true,
      },
      startedAt,
      ...entry,
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    // A journal that cannot be written must not take the backup down with it.
    console.error(`[backup-run] the run journal could not be written: ${error.message}`);
  }
}

if (suspended) {
  journal({ finishedAt: new Date().toISOString(), outcome: 'not_started', reason: 'the account is suspended' });
  console.error(`[backup-run] ${domain} is suspended, so nothing was backed up`);
  process.exit(0);
}

jobs.backupCreate({
  domain,
  parts: config.parts,
  databases: config.databases,
  engine: config.engine,
  keep: config.keep,
  runId,
  trigger: 'schedule',
}).then(result => {
  const finishedAt = new Date().toISOString();
  journal({ finishedAt, outcome: 'succeeded', offsiteRequested: config.offsite === true, backupId: result.id, archived: result.archived, verified: result.verified, pruned: result.pruned || [], runTruth: result.run_truth || null });
  fs.writeFileSync(path.join(path.dirname(configFile), `${domain}.last.json`),
    JSON.stringify({ at: finishedAt, runId, id: result.id, archived: result.archived, verified: result.verified }, null, 2));
  console.error(`[backup-run] ${domain}: ${result.archived} part(s) archived as ${result.id}`);
}).catch(error => {
  const finishedAt = new Date().toISOString();
  journal({ finishedAt, outcome: 'failed', error: error.message, failureCode: error.code || null, runTruth: error.backupRun || null });
  fs.writeFileSync(path.join(path.dirname(configFile), `${domain}.last.json`),
    JSON.stringify({ at: finishedAt, runId, failed: error.message }, null, 2));
  console.error(`[backup-run] ${domain} failed: ${error.message}`);
  process.exit(1);
});
