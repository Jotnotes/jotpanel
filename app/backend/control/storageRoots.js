'use strict';

// Where a customer's private files live, and where the files they publish live,
// and the fact that those are two different places on the disk.
//
// They were one place. Both `POST /api/files` and `POST /api/pub/files` used
// the same multer storage, so a private document and a page meant for the
// internet landed side by side in `uploads/<user id>/`, and the only thing that
// decided which was which was the table the row went into. Nothing about a file
// on disk said whether it was private. The web route did read only `pub_files`,
// so private files were not in fact reachable, but that is a property of one SQL
// query rather than of the layout, and one query is a thin place to keep a
// promise about somebody's private files.
//
// So the layout answers it now:
//
//   uploads/<user id>/private/     never served, by any route, ever
//   uploads/<user id>/published/   what the panel serves at /sites/:userId/...
//
// and `servedPathFor` is the gate the serving route asks. It resolves the path
// off the row and refuses anything that is not inside that user's published
// directory, so a bad row, a row from before this split, a `..` that survived
// somewhere, or a future bug that reads the wrong table cannot produce a
// private file. The check is on the resolved real path rather than on the
// string, because `published/../private/x` is a perfectly ordinary-looking
// string.
//
// nginx is not part of this. It serves `/srv/jotpanel-sites/<domain>/public` and
// nothing else, and the uploads tree is not under any document root; the panel
// process is what serves published files. That is worth knowing when reading
// this file: the boundary here is the boundary, there is no web server rule
// underneath it doing the same job.

const path = require('path');
const fs = require('fs');

const PRIVATE = 'private';
const PUBLISHED = 'published';

function rootsFor(uploadsDir, userId) {
  const base = path.resolve(uploadsDir, String(userId));
  return {
    base,
    private: path.join(base, PRIVATE),
    published: path.join(base, PUBLISHED),
  };
}

function ensureRoot(uploadsDir, userId, which) {
  const roots = rootsFor(uploadsDir, userId);
  const dir = which === PUBLISHED ? roots.published : roots.private;
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  return dir;
}

// Is `candidate` inside `root`, asked of the resolved paths rather than of the
// strings. `startsWith` on its own says yes to `/a/published-other` for the root
// `/a/published`, which is how this kind of check is usually got wrong, so the
// separator is part of the comparison.
function isInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot) return false;
  return resolved.startsWith(resolvedRoot + path.sep);
}

// The one question the serving route asks. Returns the absolute path to send,
// or null, and null means send a 404 rather than an explanation: a caller
// probing for private files should not learn the difference between "no such
// file" and "that one is private".
function servedPathFor(uploadsDir, userId, diskPath) {
  if (!diskPath || typeof diskPath !== 'string') return null;
  const { published } = rootsFor(uploadsDir, userId);
  if (!isInside(published, diskPath)) return null;
  const resolved = path.resolve(diskPath);
  try {
    // Both sides get their symlinks resolved, and the root's are resolved too.
    // Following only the file's was a real bug rather than a test artefact: on
    // any box where the uploads directory is reached through a link, and macOS
    // is one because /var is a link to /private/var, the file resolves to a
    // path the unresolved root is not a prefix of and every published file
    // 404s. The link that matters is still caught, because a link inside the
    // published directory pointing into the private one resolves outside the
    // resolved root just the same.
    const realRoot = fs.realpathSync(published);
    const real = fs.realpathSync(resolved);
    if (!isInside(realRoot, real)) return null;
    if (!fs.statSync(real).isFile()) return null;
    return real;
  } catch {
    return null;
  }
}

// Whether a private file is about to be put where the internet can read it.
// Not a refusal: moving a file into your own website is a thing people do on
// purpose all day. It is the fact that the panel has to say out loud first,
// because the difference between the two directories is invisible once the file
// is sitting in a list.
function crossesIntoPublic(uploadsDir, userId, fromPath, toPath) {
  const roots = rootsFor(uploadsDir, userId);
  return isInside(roots.private, fromPath) && isInside(roots.published, toPath);
}

// Boxes that carry files from before the split have them directly under
// `uploads/<user id>/`. Each row is moved into the directory its own table
// implies and the row is updated in the same transaction, so a move that
// happens without the row following it cannot leave a file the panel has lost
// track of. Anything already in the right place is left alone, which is what
// makes this safe to run at every start.
function planRelocation({ uploadsDir, rows }) {
  const plan = [];
  for (const row of rows) {
    if (!row || !row.disk_path) continue;
    const which = row.published ? PUBLISHED : PRIVATE;
    const roots = rootsFor(uploadsDir, row.user_id);
    const target = which === PUBLISHED ? roots.published : roots.private;
    if (isInside(target, row.disk_path)) continue;
    // Only files the panel put there itself, directly under the account's own
    // directory. Anything else is somebody's own arrangement and is left alone
    // rather than moved by a migration that cannot know what it is.
    if (path.dirname(path.resolve(row.disk_path)) !== roots.base) continue;
    plan.push({
      id: row.id,
      table: row.published ? 'pub_files' : 'files',
      from: path.resolve(row.disk_path),
      to: path.join(target, path.basename(row.disk_path)),
    });
  }
  return plan;
}

module.exports = { rootsFor, ensureRoot, isInside, servedPathFor, crossesIntoPublic, planRelocation, PRIVATE, PUBLISHED };
