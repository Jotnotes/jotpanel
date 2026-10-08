'use strict';

// A guest that had to regenerate one of its own secrets must never read as healthy.
//
// WHY THIS EXISTS. `jotpanel-firstboot.sh` repairs a `.env` that an unclean
// power-cut left empty or incomplete. The repair is deliberately
// non-destructive: it fills only what is absent and never replaces a value that
// survived, so it cannot lose anything that was not already lost. But it can
// discover that `JOTPANEL_ENCRYPT_SECRET` is gone, and that is unrecoverable -
// every field encrypted with the old one, provider keys and mail passwords
// included, cannot be read with the new one and nothing on the box can bring
// them back.
//
// The guest comes up anyway, and that is the right behaviour: refusing to boot
// would recover nothing, would make the guest harder to diagnose and would take
// it out of the fleet, while the damage has already happened. What must NOT
// happen is the box then reporting itself healthy. A repair that only the
// journal knows about is a repair nobody reads.
//
// So the marker `jotpanel-firstboot.sh` leaves is turned into a CONCERN, which
// is the panel's existing way of saying a box is not well: it reaches the
// guest's own `/admin/ops`, and `control/fleetSummary.js` projects both the
// verdict and the concern sentences into the row a pool host draws, so the
// hoster sees it on the fleet screen without opening the guest.
//
// It is read rather than remembered, every time the report is computed: the
// condition is true for as long as the file is there, and an operator who has
// dealt with it clears it by removing the file. That is said in the concern
// itself, because a permanent red light nobody can turn off is a red light
// people learn to ignore.

const path = require('path');

const MARKER = 'SECRETS_REPAIRED.txt';

// The name whose loss is not recoverable. The others are inconvenient:
// a new JWT_SECRET signs everybody out, a new ADMIN_KEY has to be re-pasted
// into whatever monitoring held it, and a regenerated JOTPANEL_DATA_DIR line
// points at the directory it always pointed at. Only this one means data that
// existed cannot be read again.
const UNRECOVERABLE = 'JOTPANEL_ENCRYPT_SECRET';

// Where the install lives, asked the same way the rest of the backend asks it:
// the job root if it is set, and otherwise the parent of the data directory,
// which is what both install.sh and jotpanel-firstboot.sh lay down.
function installRootFrom({ env = process.env, dataDir = null } = {}) {
  const root = env.JOTPANEL_JOB_ROOT ?? env.ARCA_JOB_ROOT;
  if (root) return root;
  return dataDir ? path.dirname(dataDir) : null;
}

// Returns the concerns to add, which is zero or one of them. Never throws: an
// ops report that cannot be computed is worse than one missing a line, and this
// runs inside the report every time it is asked for.
function secretsRepairedConcerns({ installRoot = null, fs = require('fs') } = {}) {
  if (!installRoot) return [];
  const file = path.join(installRoot, MARKER);
  let text = '';
  try {
    if (!fs.existsSync(file)) return [];
    text = String(fs.readFileSync(file, 'utf8') || '');
  } catch {
    // Unreadable is not the same as absent, and it is still not something to
    // fail a health report over. The file is 0644 for exactly this reason; if
    // it is not readable the operator has a different problem.
    return [];
  }
  if (!text.trim()) return [];

  // Every name the repair said it regenerated, across however many repairs the
  // file records. The format is jotpanel-firstboot.sh's own:
  //   missing and regenerated: NAME NAME
  const names = new Set();
  for (const line of text.split('\n')) {
    const match = /^missing and regenerated:(.*)$/.exec(line.trim());
    if (!match) continue;
    for (const name of match[1].trim().split(/\s+/)) if (name) names.add(name);
  }
  const listed = [...names];
  const when = (text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g) || []).pop() || null;
  const cleared = `Once it has been dealt with, remove ${file} to clear this.`;

  if (names.has(UNRECOVERABLE)) {
    return [{
      severity: 'critical',
      what: 'Encryption secret was regenerated',
      why: `This guest lost ${UNRECOVERABLE} to an unclean shutdown${when ? ` on ${when}` : ''} and first boot `
        + 'generated a new one so the panel could start. Anything stored encrypted before then, provider keys '
        + 'and mail passwords included, cannot be read with it, and the old secret is gone rather than mislaid. '
        + `Restore from a backup if those fields matter. ${cleared}`,
    }];
  }

  return [{
    severity: 'warn',
    what: 'Secrets were repaired at first boot',
    why: `An unclean shutdown${when ? ` on ${when}` : ''} left this guest's .env incomplete and first boot `
      + `regenerated ${listed.length ? listed.join(', ') : 'part of it'}. Nothing encrypted was lost, because `
      + `${UNRECOVERABLE} survived, but a new JWT_SECRET signs everybody out and a new ADMIN_KEY has to be `
      + `given to whatever monitoring held the old one. ${cleared}`,
  }];
}

module.exports = { secretsRepairedConcerns, installRootFrom, MARKER, UNRECOVERABLE };
