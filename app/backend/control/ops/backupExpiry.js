'use strict';
const fs = require('fs');
const path = require('path');
const { panelSetting } = require('../panelSettings');

/**
 * Backups expire on a bounded schedule. Deleting from backups happens here
 * and nowhere else: an erased record stays in every backup that predates the
 * erasure until that backup reaches the maximum age and is destroyed. The
 * maximum is one of three figures, set by the host, so the promise can name
 * it. Anything else is refused rather than rounded.
 *
 * Layout is the backup engine's own: root/<domain>/<id>/manifest.json, with
 * created_at in the manifest. A backup without a readable date is never
 * destroyed by age, because "probably old" is not a reason to delete a
 * recovery point; it is reported instead.
 */
const ALLOWED = [30, 60, 90];
const DAY = 86400000;

function maxAgeDays(env = process.env) {
  const raw = panelSetting("BACKUP_MAX_AGE_DAYS", undefined, env);
  if (raw == null || String(raw).trim() === '') return 90;
  const days = Number(raw);
  if (!ALLOWED.includes(days)) throw new Error(`JOTPANEL_BACKUP_MAX_AGE_DAYS must be 30, 60 or 90, not ${JSON.stringify(raw)}`);
  return days;
}

function domains(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
}

/** Every backup under one domain, dated from its manifest, or undated when the manifest cannot say. */
function backups(root, domain, now) {
  const where = path.join(root, domain);
  if (!fs.existsSync(where)) return [];
  return fs.readdirSync(where, { withFileTypes: true })
    .filter(e => e.isDirectory() && /^\d{4}-/.test(e.name))
    .map(e => {
      let createdAt = null;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(where, e.name, 'manifest.json'), 'utf8'));
        const at = new Date(manifest.created_at);
        if (!Number.isNaN(at.getTime())) createdAt = at;
      } catch { /* undated: reported, never destroyed by age */ }
      return { id: e.name, domain, where, createdAt, ageDays: createdAt ? (now() - createdAt) / DAY : null };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Destroy every backup older than the maximum and leave evidence of each. */
function expireBackups({ root, domain = null, now = () => new Date(), env = process.env, event = () => {} }) {
  const max = maxAgeDays(env);
  const expired = [];
  for (const dom of domain ? [domain] : domains(root)) {
    for (const b of backups(root, dom, now)) {
      if (b.ageDays == null || b.ageDays <= max) continue;
      fs.rmSync(path.join(b.where, b.id), { recursive: true, force: true });
      const detail = { backup: b.id, age_days: Math.floor(b.ageDays), max_age_days: max, where: b.where };
      event('backup_expired', dom, detail);
      expired.push({ domain: dom, ...detail });
    }
  }
  return { maxAgeDays: max, expired };
}

/** What the schedule is and whether every surviving backup is inside it. */
function backupPolicy({ root, now = () => new Date(), env = process.env }) {
  const max = maxAgeDays(env);
  let oldest = null, undated = 0;
  for (const dom of domains(root)) {
    for (const b of backups(root, dom, now)) {
      if (b.ageDays == null) { undated++; continue; }
      if (oldest == null || b.ageDays > oldest) oldest = b.ageDays;
    }
  }
  return {
    maxAgeDays: max,
    oldestSurvivingBackupAgeDays: oldest == null ? null : Math.floor(oldest),
    undatedBackups: undated,
    withinMaximum: undated === 0 && (oldest == null || oldest <= max),
  };
}

module.exports = { backupPolicy, expireBackups, maxAgeDays, ALLOWED };
