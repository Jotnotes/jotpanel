'use strict';

// Between the parser and the executor.
//
// The parser reads a cPanel archive and describes everything in it, which is
// far more than this panel can build in one pass. The executor builds sites,
// databases, mailboxes and forwarders and nothing else. Something has to decide
// which is which, and it has to be honest about the difference, because a
// migration that quietly drops the cron jobs and the SSL certificates is the
// reason people who have moved once will not move again.
//
// So the rule here is: **carry what can be built, and name what cannot.**
// Nothing is silently discarded. Every kind of thing the archive holds that the
// executor will not create comes out in `unsupported` with a sentence saying
// why, and the preview screen prints that list before anything runs.
//
// Pure, like the parser. No filesystem, no privilege, no network.

const { migrationPlan } = require('./catalogue');

// What the executor actually builds, and what it does not. Written down here
// rather than inferred, so adding a capability to the executor is a line in
// this table and not a hunt through the file.
const CARRIED = ['domains', 'databases', 'mailboxes', 'forwarders'];

// The parser hands back the privilege names it read out of the archive's own
// GRANT statements. The executor takes one of two words. Reducing a list to one
// of two words loses information in one of two directions, and the directions
// are not equally bad: a read-only user promoted to ALL is a privilege the
// owner never granted and will never see, while a full user reduced to read
// breaks the site loudly and is one click to correct. So a grant counts as read
// whenever every privilege in it only reads, and a grant nobody can read at all
// is announced rather than guessed at quietly.
const READ_ONLY_PRIVILEGES = new Set(['SELECT', 'SHOW VIEW', 'USAGE']);

function grantLevel(privileges) {
  // The contract says a string; the parser sends the list it actually found.
  // Both forms are handled, because the one that arrives is the parser's.
  if (typeof privileges === 'string') return privileges.toLowerCase() === 'read' ? 'read' : 'all';
  if (!Array.isArray(privileges) || !privileges.length) return 'all';
  return privileges.every(name => READ_ONLY_PRIVILEGES.has(String(name).trim().toUpperCase())) ? 'read' : 'all';
}

// cPanel keeps mailbox quotas in bytes and the parser divides, so a real
// mailbox arrives as 488.28125 MB. The executor takes whole megabytes and
// refuses anything else, which would have thrown out the entire plan over one
// mailbox. Rounded up, because a quota rounded down is smaller than the mailbox
// it is meant to hold.
function wholeMegabytes(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.ceil(number);
}

// One bad entry must not refuse the whole archive.
//
// This was watched happening: a single stray file in the archive's mysql
// directory became a database named `._oldcust_shop`, the plan validator quite
// correctly refused the name, and the entire migration refused with it. An
// archive from a machine nobody here controls will always contain something
// unexpected, and the answer to one unreadable entry is to name that entry, not
// to refuse the other four hundred.
//
// The check is the real validator rather than a second copy of its rules: each
// entry is put through `migrationPlan` on its own, and the ones that will not
// pass are moved into `unsupported` with the reason it gave. What comes out is
// a plan the gate is then guaranteed to accept, which is why the gate is left
// strict.
const SIFTED = ['domains', 'databases', 'mailboxes', 'forwarders'];

function describeEntry(key, entry) {
  if (key === 'domains') return `the site ${entry.domain}`;
  if (key === 'databases') return `the database ${entry.name}`;
  if (key === 'mailboxes') return `the mailbox ${entry.account}@${entry.domain}`;
  return `the forwarder ${entry.from} to ${entry.to}`;
}

function sift(plan) {
  const dropped = [];
  for (const key of SIFTED) {
    plan[key] = plan[key].filter(entry => {
      try { migrationPlan({ [key]: [entry] }); return true; }
      catch (error) {
        dropped.push({ what: describeEntry(key, entry), why: String(error.message).split('\n')[0] });
        return false;
      }
    });
  }
  if (dropped.length) plan.unsupported.push(...dropped);
  return plan;
}

// Where a thing sits inside the archive, as the archive names it. The parser
// describes everything by its stripped path because that is the right shape for
// reading; an unpacker needs the member name the archive really uses, wrapper
// included. Built here rather than in the parser because it is cPanel's own
// layout knowledge, which is exactly the part a DirectAdmin or Plesk mapper
// would replace while everything downstream stays the same.
function archivePrefixes(parsed) {
  const archive = parsed.archive && typeof parsed.archive === 'object' ? parsed.archive : {};
  const wrapper = archive.wrapper ? `${archive.wrapper}/` : '';
  const home = archive.homePrefix != null ? archive.homePrefix : `${wrapper}homedir/`;
  return {
    // A document root is recorded relative to the home directory, so the member
    // prefix is the home prefix and that root.
    files: documentRoot => (documentRoot ? `${home}${String(documentRoot).replace(/^\/+|\/+$/g, '')}/` : null),
    dump: dumpPath => (dumpPath ? `${wrapper}${dumpPath}` : null),
    mail: (domain, account) => `${home}mail/${domain}/${account}/`,
  };
}

function planFromCpanel(parsed, { archiveId = null } = {}) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The archive parser returned nothing this panel can read');
  const list = key => (Array.isArray(parsed[key]) ? parsed[key] : []);
  // The parser cannot see entry types in a Map of paths to buffers, so it warns
  // that its caller has to reject links leaving the tree. This panel is that
  // caller and it already does: readTar admits regular files only and puts every
  // name through safeArchivePath, so no link ever reaches the parser. The
  // warning is answered rather than repeated, because a preview that raises an
  // unhandled risk on every archive teaches people to skip the warnings.
  const warnings = list('warnings').map(String).map(warning => (/symlink/i.test(warning)
    ? 'Links inside the archive were dropped before it was read. Only ordinary files were considered, and every path was checked for climbing out of the tree.'
    : warning));
  const unsupported = list('unsupported').map(entry => (entry && typeof entry === 'object' ? entry : { what: String(entry), why: 'the parser could not carry it' }));

  // Parked domains are the same website under another name. Creating a second
  // site for one gives it its own empty document root, which looks like a
  // working migration and serves nothing, so they are named rather than built.
  const sites = list('domains').filter(entry => entry && entry.domain && entry.kind !== 'parked');
  const parked = list('domains').filter(entry => entry && entry.domain && entry.kind === 'parked');
  if (parked.length) {
    unsupported.push({
      what: `${parked.length} parked domain(s): ${parked.map(entry => entry.domain).join(', ')}`,
      why: 'a parked domain is another name for a site that already exists. Add it as an alias to that site after the migration rather than as a site of its own',
    });
  }

  const databases = list('databases').filter(entry => entry && entry.name);
  // Named out loud. These users get full access because the archive did not say
  // what they had, which is a guess, and a guess about who can write to a
  // database is the kind that has to be visible to the person approving it.
  const guessed = databases.flatMap(entry => (Array.isArray(entry.users) ? entry.users : [])
    .filter(user => user && user.username && !Array.isArray(user.privileges) && typeof user.privileges !== 'string')
    .map(user => user.username));
  if (guessed.length) {
    warnings.push(`The archive did not record what ${guessed.join(', ')} were allowed to do, so they are granted full access to their database. Narrow them under Databases if they only ever read.`);
  }
  const withDumps = databases.filter(entry => entry.dumpPath);
  if (withDumps.length && archiveId) {
    warnings.push(`${withDumps.length} database(s) carry a dump in the archive and it is imported in the same pass. Each one is counted afterwards and a database that did not take its dump is listed as a failure rather than left looking finished.`);
  } else if (withDumps.length) {
    // Said as a warning rather than left to be discovered. An empty database
    // with the right name and the right user is not a migrated database, and
    // somebody who thinks it is will point a live site at it.
    warnings.push(`${withDumps.length} database(s) are created empty. The archive carries their dumps and they have to be imported afterwards, under Databases, one at a time.`);
  }

  for (const [key, what, why] of [
    ['dns', 'DNS zone records', 'the zone is not copied, because the name still points at the old server until you move it deliberately. Add the records under DNS when you are ready to cut over'],
    ['cron', 'scheduled jobs', 'a cron line is a command, and this panel does not create one from an archive it was handed'],
    ['ftpAccounts', 'FTP accounts', 'they carry no reusable password, so they are recreated by hand under Files and upload accounts'],
    ['certificates', 'SSL certificates and keys', 'the new server issues its own certificate once the name points at it, which is both easier and safer than carrying a private key between machines'],
    ['autoresponders', 'automatic replies', 'they are not created by this pass. Set them under Mailboxes afterwards'],
    ['rawLogs', 'archived raw access logs', 'they are not carried. The monthly statistics below are'],
  ]) {
    const count = list(key).length;
    if (count) unsupported.push({ what: `${count} ${what}`, why });
  }

  const statistics = list('statistics').filter(entry => entry && entry.domain);
  if (statistics.length) {
    // The part every migration drops and the one a person notices, so it is
    // counted in the preview whether or not this pass imports it.
    warnings.push(`${statistics.length} month(s) of web statistics were found in the archive across ${new Set(statistics.map(entry => entry.domain)).size} domain(s).`);
  }

  const files = list('files').filter(entry => entry && entry.relativePath);
  if (files.length) {
    warnings.push(`${files.length} website file(s) are listed in the archive. This pass creates the sites and their document roots; the files are placed by the restore under Backups and restore.`);
  }

  const where = archivePrefixes(parsed);
  // Said out loud when the archive is not going to be there. A plan read from
  // an upload that was thrown away builds the same sites and databases and puts
  // nothing in them, and the difference between those two outcomes is the whole
  // migration.
  if (!archiveId) {
    warnings.push('This plan was read without keeping the archive, so it can create the sites, databases and mailboxes but cannot fill them. Read the archive again from the migration screen to bring the content across in the same pass.');
  }

  return sift({
    source: 'cpanel',
    archiveId,
    account: parsed.account && parsed.account.user ? String(parsed.account.user) : null,
    domains: sites.map(entry => ({
      domain: entry.domain,
      documentRoot: entry.documentRoot || 'public',
      filesPrefix: where.files(entry.documentRoot),
    })),
    databases: databases.map(entry => ({
      name: entry.name,
      users: (Array.isArray(entry.users) ? entry.users : []).filter(user => user && user.username)
        .map(user => ({ username: user.username, privileges: grantLevel(user.privileges) })),
      dumpPath: where.dump(entry.dumpPath),
    })),
    mailboxes: list('mailboxes').filter(entry => entry && entry.domain && entry.account)
      .map(entry => ({
        domain: entry.domain, account: entry.account, quotaMb: wholeMegabytes(entry.quotaMb),
        mailPrefix: where.mail(entry.domain, entry.account),
      })),
    forwarders: list('forwarders').filter(entry => entry && entry.from && entry.to)
      .map(entry => ({ from: entry.from, to: entry.to })),
    files: files.map(entry => entry.relativePath),
    statistics: statistics.map(entry => entry.domain),
    warnings,
    unsupported,
  });
}

module.exports = { planFromCpanel, grantLevel, wholeMegabytes, CARRIED };
