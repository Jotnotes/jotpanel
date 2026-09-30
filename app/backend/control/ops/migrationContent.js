'use strict';

// Putting the contents of somebody else's archive where they belong.
//
// Pure and panel-neutral: nothing here knows what cPanel is. A plan names a
// member prefix, these take what is under it and hand back what was written,
// and a DirectAdmin or Plesk mapper reuses every line of it by naming different
// prefixes. Kept apart from the privileged job so the rules about which names
// are allowed to become paths can be tested without a machine to run them on.

const fs = require('fs');
const path = require('path');

// Local rather than borrowed from the privileged job, so this module needs
// nothing from a machine. Same behaviour: make the folder if it is missing,
// leave it alone if it is there.
function ensureDir(target, mode = 0o755) {
  fs.mkdirSync(target, { recursive: true, mode });
}

// Everything under a prefix, with the prefix taken off. Directory entries and
// anything that would climb out are dropped rather than repaired.
function membersUnder(entries, prefix) {
  const root = String(prefix || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!root) return [];
  const out = [];
  for (const [name, data] of entries) {
    const clean = String(name).replace(/\\/g, '/');
    if (clean !== root && !clean.startsWith(`${root}/`)) continue;
    const relative = clean === root ? path.posix.basename(clean) : clean.slice(root.length + 1);
    if (!relative || relative.endsWith('/')) continue;
    if (relative.split('/').some(part => !part || part === '.' || part === '..')) continue;
    out.push({ relative, data });
  }
  return out;
}

// Write a set of members under a directory, refusing anything that resolves
// outside it. The names came out of somebody else's archive, so the check is
// per file and after resolution rather than a pattern test on the way in.
function writeMembers(root, members, mode = 0o644) {
  const realRoot = path.resolve(root);
  let written = 0;
  let bytes = 0;
  for (const member of members) {
    const target = path.resolve(realRoot, member.relative);
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) continue;
    ensureDir(path.dirname(target), 0o750);
    fs.writeFileSync(target, member.data, { mode });
    written += 1;
    bytes += member.data.length;
  }
  return { written, bytes };
}

// What is actually on disk underneath, counted rather than assumed. This is the
// read-back for a file placement: the number written and the number found have
// to agree, and if they do not the step is a failure and says both numbers.
function countFiles(root) {
  let total = 0;
  const walk = dir => {
    let listing = [];
    try { listing = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of listing) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path.join(dir, entry.name));
      else if (entry.isFile()) total += 1;
    }
  };
  walk(root);
  return total;
}

module.exports = { membersUnder, writeMembers, countFiles };
