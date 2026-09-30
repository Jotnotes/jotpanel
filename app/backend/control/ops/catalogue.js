'use strict';

const net = require('net');
const { PROVIDERS: INTEGRATION_PROVIDERS, CAPABILITIES: INTEGRATION_CAPABILITIES } = require('./integrationsBackend');

// Every change the panel can make to the server, declared in one place.
//
// This is the whole point of the exercise: a new capability is a new row here,
// not a new mechanism. Each row names the engine capability it needs, how to
// describe itself in the approval record, how dangerous it is, and how to clean
// its parameters. Propose, approve and execute are already built and are not
// re-implemented per feature.
//
// risk levels, matching the approval queue:
//   read-only    nothing changes
//   standard     a normal change
//   elevated     interrupts something that is running
//   destructive  data or access goes away, and the owner types the word

// A database or a login as the root side spells it. `text()`'s default set has
// no underscore, so the panel was refusing wp_blog while the machine underneath
// would have taken it. Letters, digits and underscore only, which is a SQL
// identifier and has no meaning to a shell.
// The floor the machine itself holds. Without it here the panel accepted a
// password, the owner approved it, and the mail server refused it afterwards,
// which is the one failure this design exists to prevent: an approval recorded
// for something that was never going to work.
function accountPassword(value, field = 'password') {
  const clean = String(required(value, field));
  if (clean.length < 10 || clean.length > 200 || /[\0\r\n]/.test(clean)) {
    throw new Error(`A ${field} must be 10 to 200 characters on one line`);
  }
  return clean;
}

const DB_IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

const OPERATIONS = [
  // ── Install a missing stack ─────────────────────────────────────
  // These are fixed named jobs. The caller chooses one of the declared
  // stacks; it never supplies package names or a command.
  ...[
    ['database', 'MariaDB', 'databases'],
    ['postgres', 'PostgreSQL', 'databases'],
    ['web', 'nginx', 'sites'],
    ['certificates', 'certbot', 'sites'],
    ['mail', 'Postfix and Dovecot', 'mail'],
    ['webmail', 'Roundcube', 'mail'],
    ['dns', 'BIND', 'dns'],
    ['dkim', 'OpenDKIM', 'mail'],
    ['antispam', 'rspamd spam filtering', 'mail'],
    ['fail2ban', 'fail2ban', 'security'],
    ['php', 'PHP', 'sites'],
  ].map(([stack, label, group]) => ({
    id: `stack.install.${stack}`, capability: 'stack.install', group,
    risk: 'elevated',
    scope: { kind: 'server' },
    label: () => `Install ${label} on this server`,
    summary: () => `Install the fixed ${label} package set, start it, and run its permission probe afterwards.`,
    normalize: () => ({ stack }),
  })),

  // Echo's ears and voice, as a proposal. Off until it is asked for: it is a
  // third of a gigabyte of models on somebody else's machine, and a panel that
  // downloaded that unasked would be doing exactly what this product refuses to
  // do. Declining costs nothing and it can be asked for again from the same
  // place later.
  {
    id: 'stack.install.voice', capability: 'stack.install', group: 'services',
    risk: 'elevated',
    scope: { kind: 'server' },
    label: () => 'Let Echo listen and speak on this server',
    summary: () => 'Install speech to text and text to speech on this machine, about 350 MB of models, and start the service. Speech is turned into text here and is never sent to another company. Nothing else about the panel changes, and it can be removed afterwards.',
    normalize: () => ({ stack: 'voice' }),
  },

  // ── 1. Services ─────────────────────────────────────────────────
  {
    id: 'service.start', capability: 'service.control', group: 'services',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Start ${p.unit}`,
    summary: p => `Ask the service manager to start ${p.unit} and confirm it is running afterwards.`,
    normalize: p => ({ unit: unit(p.unit), verb: 'start' }),
  },
  {
    id: 'service.stop', capability: 'service.control', group: 'services',
    scope: { kind: 'server' },
    risk: 'elevated', confirm: 'STOP',
    label: p => `Stop ${p.unit}`,
    summary: p => `Stop ${p.unit}. Anything it serves goes down until it is started again.`,
    normalize: p => ({ unit: unit(p.unit), verb: 'stop' }),
  },
  {
    id: 'service.restart', capability: 'service.control', group: 'services',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Restart ${p.unit}`,
    summary: p => `Restart ${p.unit}. Requests in flight are dropped; the panel confirms it came back up.`,
    normalize: p => ({ unit: unit(p.unit), verb: 'restart' }),
  },
  {
    id: 'service.reload', capability: 'service.control', group: 'services',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Reload ${p.unit}`,
    summary: p => `Reload the configuration of ${p.unit} without dropping what it is serving.`,
    normalize: p => ({ unit: unit(p.unit), verb: 'reload' }),
  },
  {
    id: 'process.kill', capability: 'process.kill', group: 'services',
    scope: { kind: 'server' },
    risk: 'destructive', confirm: 'KILL',
    label: p => `Stop process ${p.pid}`,
    summary: p => `Send ${p.signal || 'TERM'} to process ${p.pid}. Unsaved work in that process is lost.`,
    normalize: p => ({ pid: integer(p.pid, 'process id'), signal: oneOf(p.signal || 'TERM', ['TERM', 'KILL', 'HUP', 'INT'], 'signal') }),
  },
  {
    id: 'system.reboot', capability: 'system.reboot', group: 'services',
    scope: { kind: 'server' },
    risk: 'destructive', confirm: 'REBOOT',
    label: () => 'Restart the machine',
    summary: () => 'Restart the whole server. Every site, mailbox and database on it is offline until it comes back.',
    normalize: () => ({}),
  },

  // ── 2. Databases ────────────────────────────────────────────────
  {
    id: 'database.create', capability: 'database.create', group: 'databases',
    scope: { kind: 'database', param: 'name' },
    risk: 'standard',
    label: p => `Create database ${p.name}`,
    summary: p => `Create an empty ${p.engine || 'database'} called ${p.name}.`,
    normalize: p => ({ name: text(p.name, 'database name', 48, DB_IDENT), engine: engine(p.engine) }),
    entitlements: [{ metric: 'databases_count', delta: 1 }],
  },
  {
    id: 'database.drop', capability: 'database.drop', group: 'databases',
    scope: { kind: 'database', param: 'name' },
    risk: 'destructive', confirm: 'DROP',
    label: p => `Delete database ${p.name}`,
    summary: p => `Delete ${p.name} and everything in it. There is no undo and no copy is taken first.`,
    normalize: p => ({ name: text(p.name, 'database name', 48, DB_IDENT), engine: engine(p.engine) }),
  },
  {
    id: 'database.user.create', capability: 'database.user.create', group: 'databases',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Create database user ${p.username}`,
    summary: p => `Create the login ${p.username}. It can reach nothing until it is granted a database.`,
    normalize: p => ({ username: text(p.username, 'database user', 48, DB_IDENT), password: dbPassword(p.password), engine: engine(p.engine) }),
    generates: ['password'],
  },
  {
    id: 'database.user.drop', capability: 'database.user.drop', group: 'databases',
    scope: { kind: 'server' },
    risk: 'destructive', confirm: 'DROP',
    label: p => `Delete database user ${p.username}`,
    summary: p => `Delete the login ${p.username}. Anything signing in as it stops working immediately.`,
    normalize: p => ({ username: text(p.username, 'database user', 48, DB_IDENT), engine: engine(p.engine) }),
  },
  {
    id: 'database.grant', capability: 'database.grant', group: 'databases',
    scope: { kind: 'database', param: 'name' },
    risk: 'standard',
    label: p => `Grant ${p.username} on ${p.name}`,
    summary: p => `Give ${p.username} ${p.privileges === 'read' ? 'read-only' : 'full'} access to ${p.name}.`,
    normalize: p => ({ name: text(p.name, 'database name', 48, DB_IDENT), username: text(p.username, 'database user', 48, DB_IDENT), privileges: oneOf(p.privileges || 'all', ['all', 'read'], 'privileges'), engine: engine(p.engine) }),
  },
  {
    id: 'database.password', capability: 'database.password', group: 'databases',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Change the password for ${p.username}`,
    summary: p => `Set a new password for the database login ${p.username}. Anything using the old one stops working.`,
    normalize: p => ({ username: text(p.username, 'database user', 48, DB_IDENT), password: dbPassword(p.password), engine: engine(p.engine) }),
    generates: ['password'],
  },
  {
    id: 'database.import', capability: 'database.import', group: 'databases',
    scope: { kind: 'database', param: 'name' },
    risk: 'destructive', confirm: 'IMPORT',
    label: p => `Import a dump into ${p.name}`,
    summary: p => `Run an uploaded SQL file against ${p.name}. It can overwrite or drop what is already there.`,
    normalize: p => ({ name: text(p.name, 'database name', 48, DB_IDENT), engine: engine(p.engine), uploadId: required(p.uploadId, 'uploaded file') }),
    entitlements: [{ metric: 'managed_storage_bytes', delta: 0 }],
  },

  // ── 3. Mail administration ──────────────────────────────────────
  {
    id: 'mail.mailbox.create', capability: 'mail.mailbox.create', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Create mailbox ${p.account}@${p.domain}`,
    // The size is optional and its default is no limit at all, which the card
    // used to leave unsaid: a person approving a mailbox could not tell whether
    // one had been chosen for them. An unstated default is not a default a
    // person agreed to, so it is written out.
    summary: p => `Create a mailbox on this server for ${p.account}@${p.domain}${p.quotaMb ? `, limited to ${p.quotaMb} MB` : ', with no size limit'}.`,
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), password: accountPassword(p.password, 'mailbox password'), quotaMb: p.quotaMb ? integer(p.quotaMb, 'mailbox size') : null }),
    generates: ['password'],
    entitlements: [{ metric: 'mailboxes_count', delta: 1 }],
  },
  {
    id: 'mail.mailbox.delete', capability: 'mail.mailbox.delete', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'destructive', confirm: 'DELETE',
    label: p => `Delete mailbox ${p.account}@${p.domain}`,
    summary: p => `Delete ${p.account}@${p.domain} and the mail stored in it. Nothing is copied out first.`,
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64) }),
  },
  {
    id: 'mail.mailbox.password', capability: 'mail.mailbox.password', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Change the password for ${p.account}@${p.domain}`,
    summary: p => `Set a new mailbox password. Mail programs signed in with the old one stop collecting mail.`,
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), password: accountPassword(p.password, 'mailbox password') }),
    generates: ['password'],
  },
  {
    id: 'mail.mailbox.quota', capability: 'mail.mailbox.quota', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Set the size of ${p.account}@${p.domain}`,
    summary: p => `Change the mailbox limit to ${p.quotaMb ? `${p.quotaMb} MB` : 'unlimited'}.`,
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), quotaMb: p.quotaMb ? integer(p.quotaMb, 'mailbox size') : null }),
  },
  {
    id: 'mail.forwarder.set', capability: 'mail.forwarder.set', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Forward ${p.account}@${p.domain} to ${p.forward}`,
    summary: p => `Copy mail arriving for ${p.account}@${p.domain} on to ${p.forward}.`,
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), forward: email(p.forward) }),
  },
  {
    id: 'mail.forwarder.delete', capability: 'mail.forwarder.delete', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Stop forwarding ${p.account}@${p.domain} to ${p.forward}`,
    summary: p => `Remove the forward to ${p.forward}. The mailbox itself is untouched.`,
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), forward: email(p.forward) }),
  },
  {
    id: 'mail.autoreply.set', capability: 'mail.autoreply.set', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Switch on the automatic reply for ${p.account}@${p.domain}`,
    summary: () => 'Everyone who writes to this mailbox receives the message once.',
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), message: required(p.message, 'message') }),
  },
  {
    id: 'mail.autoreply.clear', capability: 'mail.autoreply.clear', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Switch off the automatic reply for ${p.account}@${p.domain}`,
    summary: () => 'Stop sending the automatic reply. The message is discarded.',
    normalize: p => ({ domain: domain(p.domain), account: text(p.account, 'mailbox name', 64) }),
  },
  {
    id: 'mail.catchall.set', capability: 'mail.catchall.set', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => (p.forward ? `Send unknown mail for ${p.domain} to ${p.forward}` : `Stop catching unknown mail for ${p.domain}`),
    summary: p => (p.forward
      ? `Mail to any address at ${p.domain} that has no mailbox goes to ${p.forward}. This collects spam as well as mistyped addresses.`
      : `Unknown addresses at ${p.domain} are refused again rather than collected.`),
    normalize: p => ({ domain: domain(p.domain), forward: p.forward ? email(p.forward) : null }),
  },
  {
    id: 'mail.antispam.set', capability: 'mail.antispam.set', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `${p.enabled ? 'Switch on' : 'Switch off'} spam filtering for ${p.domain}`,
    summary: p => (p.enabled ? `Filter incoming mail for ${p.domain}.` : `Stop filtering ${p.domain}. Every message is delivered, including spam.`),
    normalize: p => ({ domain: domain(p.domain), enabled: p.enabled !== false && p.enabled !== 'false' }),
  },
  {
    id: 'mail.dkim.enable', capability: 'mail.dkim.enable', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Create a signing key for ${p.domain}`,
    summary: p => `Generate a DKIM key for ${p.domain} so receiving servers can check the mail really came from you. The DNS record to publish is shown afterwards.`,
    normalize: p => ({ domain: domain(p.domain) }),
  },
  {
    id: 'mail.queue.retry', capability: 'mail.queue.action', group: 'mail',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => (p.id === 'ALL' ? 'Try the whole mail queue again' : `Try queued message ${p.id} again`),
    summary: () => 'Ask the mail server to attempt delivery now instead of waiting for its next run.',
    normalize: p => ({ verb: 'retry', id: queueId(p.id) }),
  },
  {
    id: 'mail.queue.delete', capability: 'mail.queue.action', group: 'mail',
    scope: { kind: 'server' },
    risk: 'destructive', confirm: 'DELETE',
    label: p => (p.id === 'ALL' ? 'Delete every queued message' : `Delete queued message ${p.id}`),
    summary: () => 'Remove the message from the queue. It is never delivered and the sender is not told.',
    normalize: p => ({ verb: 'delete', id: queueId(p.id) }),
  },

  // ── 4. Websites ─────────────────────────────────────────────────
  {
    id: 'site.create', capability: 'site.create', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Add ${p.domain} to this server`,
    summary: p => `Create the web configuration and document root for ${p.domain}. A subdomain is added the same way.`,
    normalize: p => ({ domain: domain(p.domain), ip: p.ip || '', documentRoot: p.documentRoot ? relativeRoot(p.documentRoot) : 'public' }),
    entitlements: [{ metric: 'sites_count', delta: 1 }],
  },
  {
    id: 'site.delete', capability: 'site.delete', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'destructive', confirm: 'DELETE',
    label: p => `Remove ${p.domain} from this server`,
    summary: p => `Delete the web configuration for ${p.domain}, the files under its document root, and the database belonging to any application this panel installed there. Nothing is copied first.`,
    normalize: p => ({ domain: domain(p.domain) }),
  },
  {
    id: 'site.document-root', capability: 'site.document-root', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Set the document root for ${p.domain}`,
    summary: p => `Serve ${p.domain} from the managed folder ${p.documentRoot}. The nginx configuration is tested and reloaded.`,
    normalize: p => ({ domain: domain(p.domain), documentRoot: relativeRoot(p.documentRoot) }),
  },
  {
    id: 'site.redirect', capability: 'site.redirect', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => (p.target ? `Redirect ${p.domain}` : `Remove the redirect from ${p.domain}`),
    summary: p => (p.target ? `Send requests for ${p.domain} to ${p.target}, then test and reload nginx.` : `Serve ${p.domain} from its document root again.`),
    normalize: p => ({ domain: domain(p.domain), target: p.target ? httpUrl(p.target) : null }),
  },
  {
    id: 'site.reload', capability: 'site.reload', group: 'sites',
    scope: { kind: 'server' },
    risk: 'standard',
    label: () => 'Test and reload nginx',
    summary: () => 'Run nginx configuration validation, reload it, and confirm the service remains active.',
    normalize: () => ({}),
  },
  {
    // Why this is an operation and not something the panel does quietly on
    // startup: it rewrites a site's web-server configuration and reloads nginx.
    // Both are things a person should have agreed to, and a box that repaired
    // itself at boot would be a box that discarded a hand-edited vhost while
    // nobody was watching.
    id: 'site.statistics.enable', capability: 'site.statistics.enable', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => (p.domain ? `Start counting traffic for ${p.domain}` : 'Start counting traffic for every site'),
    summary: p => `Add the traffic log to ${p.domain ? p.domain : 'each site that does not have one'}, then test and reload nginx. `
      + 'A site whose configuration has been edited outside the panel is left alone and named, because rewriting it would discard those edits.',
    normalize: p => ({ domain: p.domain ? domain(p.domain) : '' }),
  },
  {
    id: 'certificate.issue', capability: 'certificate.issue', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Issue a certificate for ${p.domain}`,
    summary: p => `Ask certbot to issue ${p.staging ? 'a staging' : 'a live'} certificate for ${p.domain} through its managed web root, then read it back.`,
    normalize: p => ({ domain: domain(p.domain), email: p.email ? email(p.email) : null, staging: p.staging === true || p.staging === 'true', forceHttps: p.forceHttps === true || p.forceHttps === 'true' }),
  },
  {
    id: 'certificate.renew', capability: 'certificate.renew', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `${p.dryRun ? 'Test renewal for' : 'Renew'} ${p.domain}`,
    summary: p => `${p.dryRun ? 'Run certbot renewal against its staging service' : 'Force certbot to renew the certificate'}, and verify the result.`,
    normalize: p => ({ domain: domain(p.domain), dryRun: p.dryRun === true || p.dryRun === 'true' }),
  },
  {
    id: 'certificate.https', capability: 'certificate.https', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `${p.enabled ? 'Force HTTPS for' : 'Stop forcing HTTPS for'} ${p.domain}`,
    summary: p => `${p.enabled ? 'Redirect HTTP requests to HTTPS' : 'Allow HTTP requests without redirecting them'}, then test and reload nginx.`,
    normalize: p => ({ domain: domain(p.domain), enabled: p.enabled === true || p.enabled === 'true' }),
  },
  {
    id: 'sftp.enable', capability: 'sftp.enable', group: 'files',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated',
    label: p => `Turn on SFTP for ${p.domain}`,
    summary: p => `Let ${p.domain} be reached over SFTP on port 22, confined to its own folder with no shell and no forwarding.`,
    normalize: p => ({ domain: domain(p.domain), password: dbSafePassword(p.password) }),
    generates: ['password'],
  },
  {
    id: 'sftp.disable', capability: 'sftp.disable', group: 'files',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Turn off SFTP for ${p.domain}`,
    summary: p => `Remove SFTP access and lock the password, so anyone holding it can no longer sign in.`,
    normalize: p => ({ domain: domain(p.domain) }),
  },
  {
    id: 'site.files.write', capability: 'site.files.write', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Save ${p.path} on ${p.domain}`,
    summary: p => `Write ${p.path} inside ${p.domain}'s document root, owned by that site rather than by the panel.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path), content: String(p.content == null ? '' : p.content) }),
    // Storage is a gate rather than a reservation: nothing can say in advance
    // how many bytes this is about to cost, so what is checked is whether the
    // account is already using everything its package allows.
    entitlements: [{ metric: 'managed_storage_bytes', delta: 0 }],
  },
  {
    id: 'site.files.upload', capability: 'site.files.place', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Upload ${p.path} to ${p.domain}`,
    summary: p => `Place the uploaded file at ${p.path} inside ${p.domain}, owned by that site.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path), staged: stagingRef(p.staged) }),
    // Storage is a gate rather than a reservation: nothing can say in advance
    // how many bytes this is about to cost, so what is checked is whether the
    // account is already using everything its package allows.
    entitlements: [{ metric: 'managed_storage_bytes', delta: 0 }],
  },
  {
    id: 'site.files.archive', capability: 'site.files.archive', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Archive ${p.path} on ${p.domain}`,
    summary: p => `Pack ${p.path} into ${p.target}. Nothing is removed.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path), target: relativePath(p.target) }),
    entitlements: [{ metric: 'managed_storage_bytes', delta: 0 }],
  },
  {
    id: 'site.files.extract', capability: 'site.files.extract', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated',
    label: p => `Extract ${p.path} on ${p.domain}`,
    summary: p => `Unpack ${p.path} into ${p.target || 'the document root'}. Files already there are kept rather than overwritten.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path), target: p.target ? relativePath(p.target) : '' }),
    entitlements: [{ metric: 'managed_storage_bytes', delta: 0 }],
  },
  {
    id: 'site.files.folder', capability: 'site.files.folder', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Create ${p.path} on ${p.domain}`,
    summary: p => `Make the folder ${p.path} inside ${p.domain}'s document root.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path) }),
  },
  {
    id: 'site.files.delete', capability: 'site.files.delete', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'destructive', confirm: 'DELETE',
    label: p => `Delete ${p.path} from ${p.domain}`,
    summary: p => `Remove ${p.path}. A folder goes with everything inside it and there is no undo.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path) }),
  },
  {
    id: 'site.files.rename', capability: 'site.files.rename', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Rename ${p.path} to ${p.target} on ${p.domain}`,
    summary: p => `Move ${p.path} to ${p.target} inside the same site.`,
    normalize: p => ({ domain: domain(p.domain), path: relativePath(p.path), target: relativePath(p.target) }),
  },
  {
    id: 'application.install', capability: 'application.install', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated',
    label: p => `Install ${p.application} on ${p.domain}`,
    // What it does, rather than what an earlier draft of this line said it did.
    // It promised that any files already there would stay, and the operation in
    // fact refuses outright when the document root is not empty, naming what is
    // in the way. The refusal is the better behaviour, so the card was brought
    // to it rather than the other way round: an operator who reads "your files
    // stay" and gets a refusal has been told the wrong thing twice, once by the
    // card and once by the error.
    summary: p => `Download ${p.application} from its own vendor, place it in ${p.domain}'s document root, and check the site answers afterwards. The document root has to be empty: if anything is already there this refuses rather than installing over it.`,
    normalize: p => ({
      application: oneOf(String(p.application || '').toLowerCase(), ['wordpress', 'phpmyadmin'], 'application'),
      domain: domain(p.domain),
    }),
    entitlements: [{ metric: 'managed_storage_bytes', delta: 0 }],
  },
  {
    id: 'site.php.set', capability: 'site.php.set', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated',
    label: p => `Put ${p.domain} on ${p.template}`,
    summary: p => `Change the PHP version serving ${p.domain}. Code written for the old version can stop working.`,
    normalize: p => ({ domain: domain(p.domain), template: text(p.template, 'PHP template', 64, /^[A-Za-z0-9._-]+$/) }),
  },
  {
    id: 'site.alias.add', capability: 'site.alias.set', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Park ${p.alias} on ${p.domain}`,
    summary: p => `${p.alias} serves the same website as ${p.domain}.`,
    normalize: p => ({ domain: domain(p.domain), alias: domain(p.alias), remove: false }),
  },
  {
    id: 'site.alias.remove', capability: 'site.alias.set', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Unpark ${p.alias} from ${p.domain}`,
    summary: p => `${p.alias} stops serving ${p.domain}'s website.`,
    normalize: p => ({ domain: domain(p.domain), alias: domain(p.alias), remove: true }),
  },
  {
    id: 'site.protect.set', capability: 'site.protect.set', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Password-protect ${p.path || '/'} on ${p.domain}`,
    summary: p => `Visitors to ${p.path || '/'} must sign in as ${p.user}.`,
    normalize: p => ({ domain: domain(p.domain), user: text(p.user, 'username', 64), password: accountPassword(p.password, 'directory password'), path: p.path ? text(p.path, 'path', 200, /^\/[\w\-./]*$/) : '/' }),
    generates: ['password'],
  },
  {
    id: 'site.protect.clear', capability: 'site.protect.clear', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Remove ${p.user} from the protected directory on ${p.domain}`,
    summary: p => `${p.user} can no longer sign in. If it was the only login the directory becomes public.`,
    normalize: p => ({ domain: domain(p.domain), user: text(p.user, 'username', 64), path: p.path ? text(p.path, 'path', 200, /^\/[\w\-./]*$/) : '/' }),
  },

  // ── 5. Files and upload accounts ────────────────────────────────
  {
    id: 'file.permissions', capability: 'file.permissions', group: 'files',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Set ${p.target} to ${p.mode}`,
    summary: p => `Change permissions on ${p.target} to ${p.mode}${p.recursive ? ', and everything inside it' : ''}.`,
    normalize: p => ({ target: required(p.target, 'file or folder'), mode: text(p.mode, 'permissions', 4, /^[0-7]{3,4}$/), recursive: p.recursive === true || p.recursive === 'true' }),
  },
  {
    id: 'file.archive', capability: 'file.archive', group: 'files',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Create ${p.archive}`,
    summary: p => `Pack the selection into ${p.archive}. An existing file of that name is never overwritten.`,
    normalize: p => ({ sources: list(p.sources, 'files to archive'), archive: required(p.archive, 'archive name') }),
  },
  {
    id: 'file.extract', capability: 'file.extract', group: 'files',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Extract ${p.archive}`,
    summary: p => `Unpack ${p.archive} into ${p.into || 'the folder it is in'}. Files of the same name are replaced.`,
    normalize: p => ({ archive: required(p.archive, 'archive'), into: p.into || '' }),
  },

  // ── Integrations ────────────────────────────────────────────────
  // Connecting a vendor is a write like any other, so it is proposed, approved,
  // executed and read back. The capability rows below name what someone wants
  // done and never who does it; the Integration Manager resolves that.
  {
    id: 'integration.connect', capability: 'integration.connect', group: 'integrations',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Connect ${p.provider} for ${p.capability}`,
    summary: p => `Use ${p.provider} for ${p.capability} across ${p.scope === 'platform' ? 'this whole deployment' : `this ${p.scope}`}. The key is stored encrypted and is never shown again.`,
    // Checked here rather than at execution, or a connection nobody could ever
    // make was staged, shown, approved, and only then refused.
    normalize: p => ({
      provider: providerFor(p.provider, p.capability),
      capability: text(p.capability, 'capability', 64, /^[a-z][a-z0-9.]*$/),
      scope: oneOf(p.scope || 'platform', ['platform', 'reseller', 'account'], 'scope'),
      scopeId: p.scopeId ? text(p.scopeId, 'scope', 64) : null,
      credential: p.credential == null ? null : String(p.credential),
    }),
  },
  {
    id: 'integration.disconnect', capability: 'integration.disconnect', group: 'integrations',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Disconnect ${p.id}`,
    summary: () => 'Remove the connection and its stored key. Whatever it was serving falls back to the next provider, or to nothing.',
    normalize: p => ({ id: text(p.id, 'connection', 64) }),
  },
  {
    // Testing a destination writes to it, so it is a write: proposed, approved,
    // recorded. It opens an outbound connection to a host somebody configured,
    // and that belongs in the durable record rather than behind a button that
    // leaves no trace.
    id: 'integration.test', capability: 'integration.test', group: 'integrations',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Test the connection ${p.id}`,
    summary: () => 'Write a small test object to that destination, read it back, compare it, and remove it. Nothing else is sent and nothing already there is touched.',
    normalize: p => ({ id: text(p.id, 'connection', 64) }),
  },
  {
    id: 'mail.security.set', capability: 'capability.mail.security.set', group: 'integrations',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `${p.enabled ? 'Switch on' : 'Switch off'} mail security for ${p.domain}`,
    summary: p => `${p.enabled ? 'Filter incoming mail for' : 'Stop filtering'} ${p.domain}, using whichever provider serves mail security here.`,
    normalize: p => ({ domain: domain(p.domain), enabled: p.enabled !== false && p.enabled !== 'false' }),
  },
  {
    id: 'dns.hosting.zone.create', capability: 'capability.dns.hosting.zone.create', group: 'integrations',
    scope: { kind: 'zone', param: 'zone' },
    risk: 'standard',
    label: p => `Host DNS for ${p.zone}`,
    summary: p => `Hold the zone for ${p.zone}, wherever DNS hosting is served from here.`,
    normalize: p => ({ zone: domain(p.zone), ip: p.ip ? text(p.ip, 'address', 45, /^[0-9.]+$/) : null }),
  },
  {
    id: 'certificate.issuance.issue', capability: 'capability.certificate.issuance.issue', group: 'integrations',
    scope: { kind: 'site', param: 'domain' },
    risk: 'standard',
    label: p => `Get a certificate for ${p.domain}`,
    summary: p => `Issue the certificate for ${p.domain}, from whichever issuer is configured here.`,
    normalize: p => ({ domain: domain(p.domain), email: p.email ? email(p.email) : null, staging: p.staging === true || p.staging === 'true', forceHttps: p.forceHttps === true || p.forceHttps === 'true' }),
  },
  {
    id: 'email.transactional.send', capability: 'capability.email.transactional.send', group: 'integrations',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Send mail to ${p.to}`,
    summary: p => `Send "${p.subject}" to ${p.to} through whichever mail provider is connected here.`,
    normalize: p => ({
      to: email(p.to), from: p.from ? email(p.from) : null,
      subject: text(p.subject, 'subject', 200, /^[^\r\n]+$/),
      text: p.text == null ? '' : String(p.text).slice(0, 20000),
    }),
  },
  {
    id: 'backup.offsite.store', capability: 'capability.backup.offsite.store', group: 'integrations',
    scope: { kind: 'backup', param: 'domain' },
    risk: 'standard',
    label: p => `Store a backup of ${p.domain} offsite`,
    summary: p => `Take a backup of ${p.domain} and put it wherever offsite storage is configured here.`,
    normalize: p => ({
      domain: domain(p.domain),
      parts: Array.isArray(p.parts) && p.parts.length ? p.parts.map(part => oneOf(part, ['files', 'databases', 'mail'], 'backup part')) : ['files', 'mail'],
      keep: p.keep ? integer(p.keep, 'how many to keep') : 7,
      // Sending one that already exists rather than making another. A
      // scheduled run archives on the root side minutes before the panel gets
      // to it, and making a second archive to have something to upload would
      // waste the disk and send a copy of something nobody verified.
      backupId: p.backupId ? text(p.backupId, 'backup', 80, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/) : null,
    }),
  },
  {
    // Bringing a backup back from the destination, which is the half that made
    // the word offsite mean something. It is not itself destructive: it puts a
    // verified copy into this machine's own backup store and touches no live
    // data, and restoring from it afterwards is the same approved and confirmed
    // operation it has always been. Split in two on purpose, so somebody
    // recovering can see what arrived before they write it over anything.
    id: 'backup.offsite.retrieve', capability: 'capability.backup.offsite.retrieve', group: 'integrations',
    scope: { kind: 'backup', param: 'domain' },
    risk: 'standard',
    label: p => `Bring the ${p.domain} backup ${p.id} back from offsite storage`,
    summary: p => `Download backup ${p.id} of ${p.domain} from wherever offsite storage is configured here, check it, and put it with this machine's own backups so it can be restored. Nothing on the live site is touched by this, and a backup of that name already here is left alone rather than written over.`,
    normalize: p => ({
      domain: domain(p.domain),
      id: text(p.id, 'backup', 80, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    }),
  },

  // ── 6. DNS ──────────────────────────────────────────────────────
  {
    id: 'dns.zone.create', capability: 'dns.zone.create', group: 'dns',
    scope: { kind: 'zone', param: 'zone' },
    risk: 'standard',
    label: p => `Create the DNS zone for ${p.zone}`,
    summary: p => `Start holding the zone for ${p.zone} on this server${p.ip ? `, pointing the domain, www and mail at ${p.ip}` : ''}. Nothing changes for visitors until the domain's name servers point here.`,
    normalize: p => ({ zone: domain(p.zone), ip: p.ip ? text(p.ip, 'address', 45, /^[0-9.]+$/) : null }),
  },
  {
    // Destructive and confirmed, like site.delete, because a zone is the last
    // thing standing between a domain and nothing: taking it away stops this
    // server answering for the name at all. Added on 2026-08-30 after the
    // independent audit found, unprompted and on three separate machines, that
    // the panel could give this server a zone and had no way to take one back.
    id: 'dns.zone.delete', capability: 'dns.zone.delete', group: 'dns',
    scope: { kind: 'zone', param: 'zone' },
    risk: 'destructive', confirm: 'DELETE',
    label: p => `Remove the DNS zone for ${p.zone}`,
    summary: p => `Stop holding the zone for ${p.zone} on this server and delete its zone file. This server will no longer answer for ${p.zone} or anything under it, and the records in it are not copied anywhere first.`,
    normalize: p => ({ zone: domain(p.zone) }),
  },
  {
    id: 'dns.record.create', capability: 'dns.record.create', group: 'dns',
    scope: { kind: 'zone', param: 'zone' },
    risk: 'standard',
    label: p => `Add ${p.type} ${p.label || '@'} to ${p.zone}`,
    summary: p => `Add a ${p.type} record pointing ${p.label || '@'}.${p.zone} at ${p.value}.`,
    normalize: p => ({
      zone: domain(p.zone),
      label: p.label ? text(p.label, 'name', 63, /^[A-Za-z0-9_*][A-Za-z0-9._-]*$|^@$/) : '@',
      type: oneOf(String(p.type || '').toUpperCase(), ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'], 'record type'),
      value: required(p.value, 'value'),
      preference: p.preference == null || p.preference === '' ? 10 : integer(p.preference, 'preference'),
      ttl: p.ttl ? integer(p.ttl, 'ttl') : null,
    }),
  },
  {
    id: 'dns.record.delete', capability: 'dns.record.delete', group: 'dns',
    scope: { kind: 'zone', param: 'zone' },
    risk: 'destructive', confirm: 'DELETE',
    label: p => `Delete ${p.type} ${p.label || '@'} from ${p.zone}`,
    summary: p => `Remove the ${p.type} record for ${p.label || '@'}.${p.zone}${p.value ? ` pointing at ${p.value}` : ''}. Mail or a website may stop resolving.`,
    // A record is named by what it is, not by a row number. The zone file has
    // no ids in it and the reader does not invent any, so asking for one meant
    // the panel sent a parameter nothing downstream reads and the delete
    // quietly matched nothing. `name` is what the zone read calls it.
    normalize: p => ({
      zone: domain(p.zone),
      label: (p.label || p.name) ? text(String(p.label || p.name), 'name', 63, /^[A-Za-z0-9_*][A-Za-z0-9._-]*$|^@$/) : '@',
      type: oneOf(String(p.type || '').toUpperCase(), ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'], 'record type'),
      value: p.value == null || p.value === '' ? null : String(p.value),
    }),
  },

  // ── 7. Firewall, updates, keys, console ─────────────────────────
  {
    id: 'firewall.allow', capability: 'firewall.rule', group: 'security',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Allow ${p.port}/${p.protocol || 'tcp'}${p.address ? ` from ${p.address}` : ''}`,
    summary: p => `Open port ${p.port} to ${p.address || 'the whole internet'}.`,
    normalize: p => ({ verb: 'allow', port: integer(p.port, 'port'), protocol: oneOf(p.protocol || 'tcp', ['tcp', 'udp'], 'protocol'), address: p.address || '' }),
  },
  {
    id: 'firewall.deny', capability: 'firewall.rule', group: 'security',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Block ${p.address || `${p.port}/${p.protocol || 'tcp'}`}`,
    summary: p => `Refuse traffic from ${p.address || 'anywhere'}${p.port ? ` to port ${p.port}` : ''}. Blocking your own address locks you out.`,
    normalize: p => ({ verb: 'deny', port: p.port ? integer(p.port, 'port') : null, protocol: oneOf(p.protocol || 'tcp', ['tcp', 'udp'], 'protocol'), address: p.address || '' }),
  },
  {
    id: 'firewall.remove', capability: 'firewall.rule', group: 'security',
    scope: { kind: 'server' },
    risk: 'elevated', confirm: 'REMOVE',
    label: p => `Remove firewall rule ${p.index}`,
    summary: () => 'Delete the rule. Whatever it was allowing or blocking returns to the default.',
    normalize: p => ({ verb: 'delete', index: integer(p.index, 'rule number') }),
  },
  {
    id: 'fail2ban.unban', capability: 'fail2ban.unban', group: 'security',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Unban ${p.ip} from ${p.jail}`,
    summary: p => `Remove ${p.ip} from the ${p.jail} jail, then read the active bans back to confirm it is gone.`,
    normalize: p => ({ ip: ipAddress(p.ip), jail: text(p.jail, 'jail', 64, /^[A-Za-z0-9_.-]+$/) }),
  },
  // ── Backups ─────────────────────────────────────────────────────
  {
    id: 'backup.create', capability: 'backup.create', group: 'backups',
    scope: { kind: 'backup', param: 'domain' },
    risk: 'standard',
    label: p => `Back up ${p.domain}`,
    summary: p => `Archive ${(p.parts && p.parts.length ? p.parts : ['files', 'mail']).join(' and ')} for ${p.domain} as gzipped tar, keeping the last ${p.keep || 7}. Anything older than that is deleted.`,
    normalize: p => ({
      domain: domain(p.domain),
      parts: Array.isArray(p.parts) && p.parts.length ? p.parts.map(part => oneOf(part, ['files', 'databases', 'mail'], 'backup part')) : ['files', 'mail'],
      databases: Array.isArray(p.databases) ? p.databases.map(name => text(name, 'database name', 64)) : [],
      engine: engine(p.engine) || null,
      keep: p.keep ? integer(p.keep, 'how many to keep') : 7,
    }),
    entitlements: [{ metric: 'backups_count', delta: 1 }, { metric: 'managed_storage_bytes', delta: 0 }],
  },
  {
    id: 'backup.schedule.set', capability: 'backup.schedule.set', group: 'backups',
    scope: { kind: 'backup', param: 'domain' },
    risk: 'standard',
    label: p => `Back up ${p.domain} ${p.when || 'daily'}`,
    summary: p => `Run the backup ${p.when || 'daily'} from now on, keeping the last ${p.keep || 7}. It survives a reboot and catches up if the machine was off when it was due.`
      + (p.offsite ? ' Each run is also copied to the offsite destination configured here, and a run whose copy does not arrive is not reported as healthy.' : ''),
    normalize: p => ({
      domain: domain(p.domain),
      when: oneOf(p.when || 'daily', ['hourly', 'daily', 'weekly', 'monthly'], 'how often'),
      parts: Array.isArray(p.parts) && p.parts.length ? p.parts.map(part => oneOf(part, ['files', 'databases', 'mail'], 'backup part')) : ['files', 'mail'],
      databases: Array.isArray(p.databases) ? p.databases.map(name => text(name, 'database name', 64)) : [],
      engine: engine(p.engine) || null,
      keep: p.keep ? integer(p.keep, 'how many to keep') : 7,
      // Whether each scheduled run is also copied off this machine. A flag and
      // not a destination: which destination is resolved from what the operator
      // configured, exactly as `backup.offsite.store` already does, so nothing
      // in a schedule names a host and a second destination system is not
      // invented alongside the first. Absent means local only, which is what
      // every schedule that already exists means.
      offsite: !!p.offsite,
    }),
  },
  {
    id: 'backup.schedule.clear', capability: 'backup.schedule.clear', group: 'backups',
    scope: { kind: 'backup', param: 'domain' },
    risk: 'standard',
    label: p => `Stop backing up ${p.domain} automatically`,
    summary: () => 'Remove the schedule. The backups already taken are left alone.',
    normalize: p => ({ domain: domain(p.domain) }),
  },
  {
    id: 'backup.restore', capability: 'backup.restore', group: 'backups',
    scope: { kind: 'backup', param: 'domain' },
    risk: 'destructive', confirm: 'RESTORE',
    label: p => (p.path ? `Restore ${p.path} from ${p.id}` : `Restore ${p.part === 'databases' ? (p.database ? `the database ${p.database}` : 'the databases') : p.part || 'files'} for ${p.domain} from ${p.id}`),
    summary: p => (p.part === 'databases'
      ? `Put the database back from this backup, creating it first if it is no longer on this server, and write the contents over whatever is in it now.`
      : p.mode === 'copy'
        ? `Unpack alongside the live copy so nothing in use is touched, and you compare the two yourself.`
        : `Write the backup over what is there now. Anything changed since ${p.id} is gone, and there is no copy of it.`),
    normalize: p => ({
      domain: domain(p.domain),
      id: text(p.id, 'backup', 64),
      // A database can be restored here now rather than being sent off to the
      // import path four manual steps away.
      part: oneOf(p.part || 'files', ['files', 'mail', 'databases'], 'backup part'),
      // Which database, when the backup holds more than one. Absent means all of
      // them, which is what a whole-account recovery wants.
      database: p.database ? text(p.database, 'database name', 64) : null,
      engine: engine(p.engine) || null,
      // No leading slash, no null byte, and no climbing. The job refuses a
      // climbing path too, but it refused it at execute, which meant a proposal
      // that could never work still got a card and still cost somebody an
      // approval before it failed. Refusing here keeps the rule this file works
      // to: nothing reaches the queue that cannot run.
      path: p.path ? text(p.path, 'path', 512, /^(?!.*(^|\/)\.\.(\/|$))[^/][^\0]*$/) : null,
      mode: oneOf(p.mode || 'in-place', ['in-place', 'copy'], 'restore mode'),
    }),
  },
  {
    id: 'mailauth.setup', capability: 'mailauth.setup', group: 'mail',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Set up mail authentication for ${p.domain}`,
    summary: p => `Generate a signing key for ${p.domain}, point this server's mail at it, and publish SPF, DKIM and DMARC. The policy starts at ${p.policy || 'none'}, which collects evidence and asks receivers to do nothing yet, and it should stay there until the reports show everything of yours passing.`,
    normalize: p => ({
      domain: domain(p.domain),
      policy: oneOf(p.policy || 'none', ['none', 'quarantine', 'reject'], 'policy'),
      reportTo: p.reportTo ? text(p.reportTo, 'reporting address', 254) : null,
      selector: p.selector ? text(p.selector, 'selector', 32, /^[a-z0-9]+$/) : 'jotpanel',
    }),
  },
  {
    id: 'panel.domain.set', capability: 'panel.domain.set', group: 'services',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Give this panel the name ${p.domain}`,
    summary: p => `Point the panel at ${p.domain}, fetch a real certificate for it and serve on it. The name has to be pointed at this machine already, and the panel restarts, so anybody signed in is signed out for a moment.`,
    normalize: p => ({ domain: domain(p.domain), email: required(p.email, 'contact address'), staging: p.staging === true }),
  },
  {
    id: 'firewall.guard.arm', capability: 'firewall.guard.arm', group: 'security',
    scope: { kind: 'server' },
    risk: 'standard',
    label: p => `Guard the firewall for ${p.minutes || 5} minutes`,
    summary: p => `Copy the current rules aside and have the machine put them back in ${p.minutes || 5} minutes unless you confirm you are still connected. Do this before a rule that could cut you off.`,
    normalize: p => ({ minutes: p.minutes ? integer(p.minutes, 'minutes') : 5 }),
  },
  {
    id: 'firewall.guard.confirm', capability: 'firewall.guard.confirm', group: 'security',
    scope: { kind: 'server' },
    risk: 'standard',
    label: () => 'Keep the firewall change',
    summary: () => 'You are still connected, so cancel the pending undo and keep the rules as they are now.',
    normalize: p => ({ guardId: required(p.guardId, 'guard') }),
  },
  {
    id: 'packages.apply', capability: 'packages.apply', group: 'security',
    scope: { kind: 'server' },
    risk: 'elevated', confirm: 'UPDATE',
    label: p => (p.securityOnly === false ? 'Install every waiting update' : 'Install the waiting security updates'),
    summary: () => 'Services can restart while this runs, and some updates ask for a reboot afterwards.',
    normalize: p => ({ securityOnly: p.securityOnly !== false && p.securityOnly !== 'false' }),
  },
  {
    id: 'sshkey.add', capability: 'sshkey.add', group: 'security',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: () => 'Authorise a new SSH key',
    summary: () => 'Whoever holds the matching private key can sign in to this server over SSH.',
    normalize: p => ({ key: sshPublicKey(p.key) }),
  },
  {
    id: 'sshkey.remove', capability: 'sshkey.remove', group: 'security',
    scope: { kind: 'server' },
    risk: 'destructive', confirm: 'REVOKE',
    label: p => `Revoke SSH key ${p.line}`,
    summary: () => 'That key can no longer sign in. Revoking your own key locks you out of the shell.',
    normalize: p => ({ line: required(p.line, 'key') }),
  },
  {
    id: 'console.run', capability: 'console.run', group: 'security',
    scope: { kind: 'server' },
    risk: 'destructive', confirm: 'RUN',
    label: p => `Run: ${String(p.command || '').slice(0, 80)}`,
    summary: () => 'One command, as the panel service owner, with a sixty second limit. Whatever it does is not reversible from here.',
    normalize: p => ({ command: required(p.command, 'command') }),
  },

  // ── 8. Runtimes beyond PHP ──────────────────────────────────────
  // The site stops being served from its files and starts being served by a
  // program. The panel never receives the command: it receives which of a fixed
  // set of languages, and which file inside the site to start. The character set
  // is narrow on purpose, because that name becomes a word in a systemd unit.
  {
    id: 'runtime.set', capability: 'runtime.set', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated',
    label: p => `Serve ${p.domain} with ${p.runtime}`,
    summary: p => `Run ${p.entry} as a ${p.runtime} application owned by ${p.domain}'s own user, and point the web server at it instead of at the files. Whatever is serving ${p.domain} now stops.`,
    normalize: p => ({
      domain: domain(p.domain),
      runtime: oneOf(p.runtime, ['node', 'python', 'ruby', 'java', 'perl', 'dotnet', 'binary'], 'runtime'),
      entry: text(p.entry, 'starting file', 200, /^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
    }),
  },
  {
    id: 'runtime.clear', capability: 'runtime.clear', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated', confirm: 'STOP',
    label: p => `Stop the application on ${p.domain}`,
    summary: p => `Stop the program serving ${p.domain} and go back to serving its own files. Anything the program was answering stops answering.`,
    normalize: p => ({ domain: domain(p.domain) }),
  },
  {
    id: 'runtime.restart', capability: 'runtime.restart', group: 'sites',
    scope: { kind: 'site', param: 'domain' },
    risk: 'elevated',
    label: p => `Restart the application on ${p.domain}`,
    summary: p => `Restart the program serving ${p.domain}. Requests in flight are dropped; the panel waits for it to answer again before recording this as done.`,
    normalize: p => ({ domain: domain(p.domain) }),
  },
  {
    id: 'runtime.install', capability: 'runtime.install', group: 'sites',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Install ${p.runtime} on this server`,
    summary: p => `Install the fixed package set for ${p.runtime} and ask the interpreter to run afterwards. No site starts using it until you point one at it.`,
    normalize: p => ({ runtime: oneOf(p.runtime, ['node', 'python', 'ruby', 'java', 'perl', 'dotnet'], 'runtime') }),
  },

  // ── 9. Moving in from another server ────────────────────────────
  // A plan arrives from a parser that read somebody else's archive, so it is
  // the least trusted input this file handles. Nothing is passed through: the
  // plan is rebuilt here field by field, and anything the executor does not
  // read is dropped rather than carried along.
  {
    id: 'migrate.apply', capability: 'migrate.apply', group: 'migration',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Build ${describePlan(p.plan)} from the imported account${p.targetOrgId ? ` for ${p.targetOrgId}` : ''}`,
    summary: p => `Create ${describePlan(p.plan)}${p.targetOrgId ? ` and hand them to ${p.targetOrgId}` : ''} alongside what is already here. Nothing is switched over: DNS is untouched and the old server keeps serving until you point the name here yourself.`,
    normalize: p => ({ plan: migrationPlan(p.plan), targetOrgId: p.targetOrgId ? text(p.targetOrgId, 'account', 64) : null }),
    // Whose account this is being moved in for. Only the name of the parameter
    // lives here; who is allowed to say it is decided by the ownership service
    // against the signed identity, never off the request.
    targetOrg: 'targetOrgId',
    // A function rather than a fixed list, because this is the one operation
    // whose size is not known until the plan is read. It was the only creating
    // operation in the product that no package applied to, which made an import
    // the way around every limit: an account allowed five sites could bring in
    // fifty, and the meter would only notice afterwards, if anything ever asked.
    entitlements: p => [
      { metric: 'sites_count', delta: (p.plan.domains || []).length },
      { metric: 'databases_count', delta: (p.plan.databases || []).length },
      { metric: 'mailboxes_count', delta: (p.plan.mailboxes || []).length },
    ].filter(effect => effect.delta > 0),
  },
  {
    id: 'migrate.imap.pull', capability: 'migrate.imap.pull', group: 'migration',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'standard',
    label: p => `Copy ${p.username} from ${p.host} into ${p.account}@${p.domain}`,
    summary: p => `Read the mailbox at ${p.host} over IMAP and write it into ${p.account}@${p.domain}. Nothing is written to ${p.host}, and this refuses if there is already mail on this side.`,
    normalize: p => ({ ...imapSource(p), domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), replace: false }),
  },
  {
    id: 'migrate.imap.replace', capability: 'migrate.imap.pull', group: 'migration',
    scope: { kind: 'mailbox', param: 'domain' },
    risk: 'destructive', confirm: 'REPLACE',
    label: p => `Mirror ${p.username} from ${p.host} over ${p.account}@${p.domain}`,
    summary: p => `Make ${p.account}@${p.domain} an exact copy of the mailbox at ${p.host}. Anything on this side that is not on ${p.host} is removed, which is why this is the deliberate version. What is in the mailbox now is moved aside first and kept, and if the copy fails it is put straight back.`,
    normalize: p => ({ ...imapSource(p), domain: domain(p.domain), account: text(p.account, 'mailbox name', 64), replace: true }),
  },

  // ── 10. Reseller administration ─────────────────────────────────
  //
  // These change nothing on the machine. They change what an account is
  // allowed to have, which is why they are here rather than in a direct route:
  // "who raised this customer's limit, when, and who approved it" is a question
  // a hosting company gets asked six months later by somebody holding an
  // invoice, and the durable record is the only honest answer to it.
  //
  // The scope kind is `organization`, and the rule ownership.js applies to it
  // is that a provider may administer the accounts beneath it and never its
  // own: an account raising its own ceiling is not an override, it is the
  // absence of one.
  {
    id: 'entitlements.package.create', capability: 'entitlements.package.create', group: 'reseller',
    // A package belongs to whoever made it and is offered to their own
    // customers, so this acts on the caller's organization and never on the
    // machine. It was server-scoped, which reserved it to the box operator and
    // left a reseller with nothing to sell.
    scope: { kind: 'own' },
    risk: 'standard',
    label: p => `Create the ${p.name} package`,
    summary: p => `Define a package called ${p.name} with ${p.limits.length} limits on it. Nobody is put on it by this, and a package cannot be edited once it exists, so changing what it offers means making another one.`,
    normalize: p => ({
      name: text(p.name, 'package name', 64, /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/),
      description: oneLine(p.description),
      limits: packageLimits(p.limits),
    }),
  },
  {
    id: 'entitlements.package.assign', capability: 'entitlements.package.assign', group: 'reseller',
    scope: { kind: 'organization', param: 'targetOrgId' },
    risk: 'standard',
    label: p => `Put ${p.targetOrgId} on a package`,
    summary: p => `Move this account onto the package you chose. What they already have is left alone; what they may add from now on is what the package says. If it would hand out more than this account holds, it is refused with the numbers.`,
    normalize: p => ({ targetOrgId: orgId(p.targetOrgId), packageId: text(p.packageId, 'package', 48, /^pkg_[a-f0-9]+$/) }),
  },
  {
    id: 'entitlements.package.archive', capability: 'entitlements.package.archive', group: 'reseller',
    // Same reason as create. The handler already refuses a package owned by a
    // different organization, so the ownership answer is unchanged; what
    // changes is that a reseller can retire its own.
    scope: { kind: 'own' },
    risk: 'standard',
    label: p => `Stop offering package ${p.packageId}`,
    summary: () => 'Retire this package so it cannot be given to anyone new. Everybody already on it stays exactly as they are.',
    normalize: p => ({ packageId: text(p.packageId, 'package', 48, /^pkg_[a-f0-9]+$/) }),
  },
  {
    id: 'entitlements.account_limit.override', capability: 'entitlements.account_limit.override', group: 'reseller',
    scope: { kind: 'organization', param: 'targetOrgId' },
    risk: 'standard',
    label: p => `Set ${p.targetOrgId}'s ${p.metric} to ${p.unlimited ? 'unlimited' : p.maximum}`,
    summary: p => `Change one limit on this one account without making a new package for it. It reads as an override from then on, with your name and your reason on it, until somebody clears it.${p.unlimited ? ' Unlimited only holds while whoever provides for this account is unlimited too.' : ''}`,
    normalize: p => ({
      targetOrgId: orgId(p.targetOrgId),
      metric: metricKey(p.metric),
      unlimited: !!p.unlimited,
      maximum: p.unlimited ? null : integer(p.maximum, 'the new limit'),
      reserved: p.reserved == null || p.reserved === '' ? null : integer(p.reserved, 'reserved amount'),
      downstreamPolicy: p.downstreamPolicy ? oneOf(p.downstreamPolicy, ['strict', 'usage_based'], 'allocation policy') : null,
      reason: oneLine(p.reason),
    }),
  },
  {
    id: 'entitlements.account_limit.override.clear', capability: 'entitlements.account_limit.override.clear', group: 'reseller',
    scope: { kind: 'organization', param: 'targetOrgId' },
    risk: 'standard',
    label: p => `Put ${p.targetOrgId}'s ${p.metric} back to its package value`,
    summary: p => `Remove the override on ${p.metric} so this account goes back to whatever its package says. If the package allows less than the override did, this reduces what they may add.`,
    normalize: p => ({ targetOrgId: orgId(p.targetOrgId), metric: metricKey(p.metric) }),
  },
  {
    id: 'entitlements.organization.link', capability: 'entitlements.organization.link', group: 'reseller',
    scope: { kind: 'organization', param: 'targetOrgId' },
    risk: 'standard',
    label: p => `Take on ${p.targetOrgId} as a customer`,
    summary: () => 'Put this account underneath yours, so what it uses counts against what you hold and you can put it on one of your packages. An account can only sit under one provider at a time.',
    normalize: p => ({ targetOrgId: orgId(p.targetOrgId) }),
  },
  // ── Accounts, which is what a provider actually sells ────────────
  //
  // These are the operations that make the reseller role real. Everything else
  // in the entitlements group decides what an account may have; these decide
  // that the account exists at all, and whether it is running.
  //
  // They are on the ordinary catalogue path for the same reason the limits are:
  // taking somebody's hosting off the air is exactly the change a hosting
  // company gets asked about six months later, and an audit line is a note
  // where the record is evidence.
  {
    id: 'account.create', capability: 'account.create', group: 'reseller',
    scope: { kind: 'own' },
    risk: 'standard',
    label: p => `Take on ${p.email} as a customer`,
    summary: p => `Create ${p.email} as an account of its own beneath yours, with its own organization, and put it on the ${p.packageId ? 'package you chose' : 'no package until you assign one'}. What it uses counts against what you hold.`,
    normalize: p => ({
      email: email(p.email),
      name: oneLine(p.name, 100),
      password: text(p.password, 'password', 200, /^.{12,}$/),
      packageId: p.packageId ? text(p.packageId, 'package', 48, /^pkg_[a-f0-9]+$/) : null,
    }),
    // The password is generated rather than typed in the common case, and it is
    // the one thing here worth showing once and never again.
    generates: ['password'],
    deliver: ['password'],
  },
  {
    id: 'account.suspend', capability: 'account.suspend', group: 'reseller',
    scope: { kind: 'organization', param: 'targetOrgId', selfRefusal: 'An account cannot suspend itself' },
    risk: 'elevated',
    label: p => `Suspend ${p.targetOrgId}`,
    // Says plainly that it does not cascade, because a hoster suspending a
    // reseller for non-payment would otherwise assume the reseller's own
    // customers went off with them, and find out later that they did not.
    summary: () => 'Stop this account. Its websites answer 503, its mail is refused at the door, its file access is closed and its backups stop running. Nothing is deleted and putting it back is one action. Accounts underneath this one keep running and have to be stopped separately.',
    normalize: p => ({ targetOrgId: orgId(p.targetOrgId), reason: oneLine(p.reason) }),
  },
  {
    id: 'account.unsuspend', capability: 'account.unsuspend', group: 'reseller',
    scope: { kind: 'organization', param: 'targetOrgId', selfRefusal: 'An account cannot unsuspend itself' },
    risk: 'standard',
    label: p => `Put ${p.targetOrgId} back`,
    summary: () => 'Start this account again: websites, mail, file access and backups all come back on.',
    normalize: p => ({ targetOrgId: orgId(p.targetOrgId), reason: oneLine(p.reason) }),
  },
  {
    // Server-scoped on purpose, so only the account that runs the box makes
    // resellers. The hierarchy is admin, reseller, customer and it is three
    // deep: letting a reseller mint resellers is a different product and a
    // different set of questions about who is liable for whom.
    id: 'account.role.set', capability: 'account.role.set', group: 'reseller',
    scope: { kind: 'server' },
    risk: 'elevated',
    label: p => `Make ${p.identityId} ${p.role === 'reseller' ? 'a reseller' : 'an ordinary customer'}`,
    summary: p => p.role === 'reseller'
      ? 'This account may take on customers of its own, put them on its packages and run their hosting, inside whatever limits it holds. It gains nothing over the machine itself.'
      : 'This account goes back to being an ordinary customer. Anyone already beneath it stays where they are and keeps working; what changes is that this account can no longer administer them.',
    normalize: p => ({
      identityId: text(p.identityId, 'account', 64, /^[A-Za-z0-9_-]{4,64}$/),
      role: oneOf(String(p.role || '').trim(), ['reseller', 'end_user'], 'role'),
    }),
  },
];

const BY_ID = new Map(OPERATIONS.map(op => [op.id, op]));

function getOperation(id) {
  const op = BY_ID.get(String(id || ''));
  if (!op) throw new Error(`Unknown server operation: ${id}`);
  return op;
}

// ── Read resources, the other half of the surface ──────────────────
// A read never needs approval, so it needs no proposal: it maps straight onto a
// capability and is refused the same honest way when the capability is absent.
const READS = {
  'statistics-coverage': 'site.statistics.status',
  'system-metrics': 'system.metrics',
  'system-metrics-history': 'system.metrics.history',
  services: 'service.list',
  service: 'service.status',
  processes: 'process.list',
  logs: 'log.sources',
  'log-tail': 'log.tail',
  'log-search': 'log.search',
  journal: 'log.journal',
  databases: 'database.list',
  'database-tables': 'database.tables',
  'mail-domains': 'mail.domains',
  mailboxes: 'mail.mailbox.list',
  webmail: 'webmail.status',
  'mail-queue': 'mail.queue.list',
  dkim: 'mail.dkim.show',
  'server-sites': 'site.list',
  certificates: 'certificate.list',
  'php-templates': 'site.php.versions',
  'php': 'php.versions',
  'applications': 'application.list',
  'sftp': 'sftp.status',
  'site-files': 'site.files.list',
  'site-file-stage': 'site.files.stage',
  'staging-reserve': 'staging.reserve',
  'staging-discard': 'staging.discard',
  'site-file': 'site.files.read',
  'protected-directories': 'site.protect.list',
  files: 'file.list',
  'disk-usage': 'disk.usage',
  'dns-zones': 'dns.zones',
  'dns-records': 'dns.records',
  'dns-zone-records': 'dns.zone.records',
  'integrations': 'integration.list',
  'mail-auth': 'mailauth.check',
  'dmarc-reports': 'dmarc.reports.read',
  'backup-health': 'backup.health.list',
  backups: 'backup.list',
  'backup-schedules': 'backup.schedule.status',
  'backup-offsite': 'capability.backup.offsite.list',
  'backup-incidents': 'backup.incidents.list',
  'backup-contents': 'backup.contents',
  'backup-file-versions': 'backup.file.versions',
  'backup-file-preview': 'backup.file.preview',
  firewall: 'firewall.list',
  'fail2ban-bans': 'fail2ban.list',
  'firewall-guards': 'firewall.guard.status',
  packages: 'packages.status',
  'ssh-keys': 'sshkey.list',
  // Both of these carry more than a query string will hold, and one of them
  // carries somebody's mail password, which has no business in a URL. They are
  // read over POST, which is what the read route accepts for exactly this.
  'migrate-preview': 'migrate.preview',
  'migrate-imap-inspect': 'migrate.imap.inspect',
  runtimes: 'runtime.list',
  'site-runtime': 'runtime.status',
};

// ── Who each reading's answer belongs to ───────────────────────────
// A read needs no approval, which was quietly read as needing no permission:
// every reading above was answered for whoever asked, so an ordinary customer
// signing in got the whole machine's websites, backups, processes, firewall and
// logs. Each reading now declares whose answer it is, beside the capability it
// maps to, and `serverOps.read` puts that declaration through the same
// ownership service `propose` already uses.
//
// Five shapes, and no reading may be missing one — consistency.test.js refuses
// a READS row without a scope, which is what stops the ninety-seventh reading
// from being added without one:
//
//   { kind: 'server' }            the machine's own state. The operator's.
//   { kind: 'site', param: 'x' }  one named resource, keyed by a parameter.
//   { narrow }                    a list, cut down to what the caller owns.
//   { kind: 'own' }               the engine already answers for the caller alone.
//   { kind: 'open' }              nothing in the answer belongs to an account.
//
// `narrow` receives the engine's answer and a predicate, and returns the answer
// an ordinary account should see. It never runs for the operator.
// The domain a queued message was sent from. Postfix prints the envelope
// sender, which is an address and occasionally the empty one a bounce is sent
// with. An unparseable sender returns the empty string on purpose: it then
// matches no claimed domain, so a line this file cannot read the owner of goes
// to the operator alone rather than to whoever happens to be asking.
function mailDomainOf(sender) {
  const at = String(sender == null ? '' : sender).trim().toLowerCase().lastIndexOf('@');
  return at === -1 ? '' : String(sender).trim().toLowerCase().slice(at + 1).replace(/[>\s]+$/, '');
}

const READ_SCOPES = {
  // Which sites are being counted and which are not. A list of sites, so it is
  // cut down to the ones the caller owns rather than answering for the box: a
  // reseller's customer asking whether their own traffic is counted must not
  // learn what else is on the machine.
  'statistics-coverage': {
    narrow: (data, owns) => {
      const sites = (data.sites || []).filter(site => owns('site', site.domain));
      return {
        ...data, sites,
        counted: sites.filter(s => s.counted).length,
        waiting: sites.filter(s => !s.counted && s.safe).length,
        blocked: sites.filter(s => !s.counted && !s.safe).length,
      };
    },
  },
  // The machine. Its load, its services, its processes, its logs, its firewall,
  // its packages, its keys, its mail queue and the providers it is wired to.
  // None of it is one account's, all of it describes the box, so all of it is
  // reserved to the account that runs the box.
  'system-metrics': { kind: 'server' },
  'system-metrics-history': { kind: 'server' },
  services: { kind: 'server' },
  service: { kind: 'server' },
  processes: { kind: 'server' },
  logs: { kind: 'server' },
  'log-tail': { kind: 'server' },
  'log-search': { kind: 'server' },
  journal: { kind: 'server' },
  'disk-usage': { kind: 'server' },
  firewall: { kind: 'server' },
  'fail2ban-bans': { kind: 'server' },
  'firewall-guards': { kind: 'server' },
  packages: { kind: 'server' },
  'ssh-keys': { kind: 'server' },
  integrations: { kind: 'server' },
  'backup-health': { kind: 'server' },
  webmail: { kind: 'server' },
  // Moving in reads somebody else's server, which is a thing only the account
  // that runs this one has any business pointing at it.
  'migrate-preview': { kind: 'server' },
  'migrate-imap-inspect': { kind: 'server' },

  // One named resource, keyed by the parameter that names it. The same
  // question `propose` asks about a write, asked about the read instead: a
  // resource another organization has claimed is refused, and an unclaimed one
  // is allowed, exactly as it is on the way in.
  'site-files': { kind: 'site', param: 'domain' },
  'site-file': { kind: 'site', param: 'domain' },
  'site-file-stage': { kind: 'site', param: 'domain' },
  'protected-directories': { kind: 'site', param: 'domain' },
  sftp: { kind: 'site', param: 'domain' },
  'site-runtime': { kind: 'site', param: 'domain' },
  'php-templates': { kind: 'site', param: 'domain' },
  'database-tables': { kind: 'database', param: 'name' },
  mailboxes: { kind: 'mailbox', param: 'domain' },
  dkim: { kind: 'mailbox', param: 'domain' },
  'dmarc-reports': { kind: 'mailbox', param: 'domain' },
  'dns-zone-records': { kind: 'zone', param: 'zone' },
  'backup-contents': { kind: 'backup', param: 'domain' },
  'backup-file-versions': { kind: 'backup', param: 'domain' },
  'backup-file-preview': { kind: 'backup', param: 'domain' },

  // Lists. Narrowed rather than refused, because "here is what you have" is a
  // better answer to a customer than an error, and because these are the
  // screens a customer is meant to use.
  'server-sites': {
    narrow: (data, owns) => ({ ...data, sites: (data.sites || []).filter(site => owns('site', site.domain)) }),
  },
  certificates: {
    narrow: (data, owns) => ({
      ...data,
      certificates: (data.certificates || []).filter(entry => owns('site', entry.domain)),
      sites: (data.sites || []).filter(site => owns('site', site.domain)),
    }),
  },
  // Database users are server-scoped in the write catalogue — a user is not
  // claimed for anybody — so an ordinary account is shown none of them rather
  // than a list it has no way to tell apart.
  databases: {
    narrow: (data, owns) => {
      const mine = rows => (rows || []).filter(row => owns('database', row.name));
      return {
        ...data,
        engines: (data.engines || []).map(entry => ({ ...entry, databases: mine(entry.databases), users: [] })),
        databases: mine(data.databases),
        users: [],
      };
    },
  },
  'mail-domains': {
    narrow: (data, owns) => ({ ...data, domains: (data.domains || []).filter(entry => owns('mailbox', entry.domain)) }),
  },
  // The queue is the machine's, but a message sitting in it is somebody's. It
  // carries the address it was sent from, and the person who wrote it is the
  // one who needs to know why it has not moved — which is the whole reason the
  // mail client can answer a question Roundcube cannot. So this was the
  // machine's own state and is now a list: the operator reads the whole queue,
  // and everybody else reads the messages sent from a mail domain they own.
  // A message from a domain nobody has claimed reaches nobody but the
  // operator, because `owns` excludes the unclaimed rather than sharing it out.
  // `count` is recomputed from what survived the filter. Leaving the whole
  // machine's count over a narrowed list is the kind of number this codebase
  // treats as a lie.
  'mail-queue': {
    narrow: (data, owns) => {
      const messages = (data.messages || []).filter(entry => owns('mailbox', mailDomainOf(entry.sender)));
      return { ...data, messages, count: messages.length };
    },
  },
  'dns-zones': {
    narrow: (data, owns) => ({ ...data, zones: (data.zones || []).filter(entry => owns('zone', entry.zone)) }),
  },
  // `backups` takes an optional domain: named, it is keyed like the readings
  // above; unnamed, the engine answers for the whole backup root, so it is
  // narrowed too. `backup-schedules` ignores the domain it is given and always
  // answers for the box, which is why it is a list and not a keyed reading.
  backups: {
    kind: 'backup', param: 'domain',
    narrow: (data, owns) => ({ ...data, backups: (data.backups || []).filter(entry => owns('backup', entry.domain)) }),
  },
  'backup-schedules': {
    narrow: (data, owns) => ({ ...data, schedules: (data.schedules || []).filter(entry => owns('backup', entry.domain)) }),
  },
  // What is actually sitting at the offsite destination. Narrowed the same way
  // the local list is: somebody sees the backups of domains they own and no
  // others, and the destination itself is described without its credential
  // because `describe()` has never returned one.
  // Whose backups are broken. The whole box, so it belongs to whoever runs it.
  'backup-incidents': { kind: 'server' },
  'backup-offsite': {
    kind: 'backup', param: 'domain',
    narrow: (data, owns) => ({ ...data, backups: (data.backups || []).filter(entry => owns('backup', entry.domain)) }),
  },

  // Already the caller's own. The file area is rooted at the account's own
  // upload directory by the engine, and a staging reference is minted per call
  // and unguessable, so there is no ownership question left to ask.
  files: { kind: 'own' },
  'staging-reserve': { kind: 'own' },
  'staging-discard': { kind: 'own' },

  // Nothing in the answer belongs to an account. The first three are what this
  // machine has installed, which a customer needs in order to choose what their
  // own site runs. The last two are read out of the public DNS, which anybody
  // may ask for without this panel's help.
  php: { kind: 'open' },
  runtimes: { kind: 'open' },
  applications: { kind: 'open' },
  'dns-records': { kind: 'open' },
  'mail-auth': { kind: 'open' },
};

// ── Validation helpers ─────────────────────────────────────────────
// A path inside a site. No absolute paths, no climbing, no null bytes. The
// privileged side resolves it against the site root and refuses anything that
// lands outside, so this is the first of two gates rather than the only one.
// The same character set the database passwords use, which was chosen so a
// password cannot be misread by anything it passes through. chpasswd takes it
// on standard input rather than in an argument, so nothing lands in a process
// list either.
function dbSafePassword(value) {
  const clean = String(required(value, 'password'));
  if (clean.length < 12) throw new Error('An SFTP password must be at least 12 characters');
  if (clean.length > 128) throw new Error('That password is too long');
  if (!/^[A-Za-z0-9._~!@#%^*+=-]+$/.test(clean)) throw new Error('That password contains a character this panel will not pass through');
  return clean;
}

// A staging reference is generated by the privileged side and handed back, so
// the only thing checked here is that it has not been tampered with on the way.
function stagingRef(value) {
  const clean = String(required(value, 'upload reference'));
  if (!/^stage_[a-f0-9]{32}$/.test(clean)) throw new Error('That is not a valid upload reference');
  return clean;
}

function relativePath(value, field = 'path') {
  const clean = String(required(value, field)).replace(/^\/+/, '').replace(/\\/g, '/');
  if (clean.includes('\0')) throw new Error(`${field} is not a valid path`);
  if (clean.length > 1024) throw new Error(`${field} is too long`);
  if (clean.split('/').some(part => part === '..')) throw new Error(`${field} may not climb out of the site`);
  if (!/^[^\0]+$/.test(clean)) throw new Error(`${field} is not a valid path`);
  return clean;
}

function required(value, field) {
  const text_ = typeof value === 'string' ? value.trim() : value;
  if (text_ === undefined || text_ === null || text_ === '') throw new Error(`${field} is required`);
  return text_;
}

// Free text somebody typed, kept as one line. Control characters go, because a
// description carrying a newline or an escape lands in a label the approver
// reads and in the record afterwards.
function oneLine(value, max = 400) {
  if (value == null) return null;
  return String(value).replace(/[\0-\x1f\x7f]/g, ' ').slice(0, max).trim() || null;
}

// An organization id as this product mints them. Checked for shape here so a
// caller cannot send something that only looks like one; whether it exists, and
// whether the caller may touch it, is ownership.js's answer, not this one.
function orgId(value) {
  const clean = String(required(value, 'account')).trim();
  if (!/^org_[a-f0-9]{8,32}$/.test(clean)) throw new Error(`${value} is not an account on this server`);
  return clean;
}

// A metric name, from the fixed list the entitlements service seeds. Kept here
// as a literal rather than read from the database, because a catalogue that
// accepted whatever happened to be in a table would let a typo through as a
// limit on something that does not exist.
const METRIC_KEYS = ['sites_count', 'databases_count', 'mailboxes_count', 'managed_storage_bytes', 'backups_count', 'ai_cost_microunits_month'];
function metricKey(value) {
  return oneOf(String(required(value, 'limit')).trim(), METRIC_KEYS, 'limit');
}

// The limits a package carries. Every metric has to be named: a package that
// silently meant "unlimited for anything you forgot" is how somebody sells a
// plan they did not intend to sell.
function packageLimits(value) {
  const rows = Array.isArray(value) ? value : [];
  if (!rows.length) throw new Error('A package needs a limit for every metric');
  const seen = new Set();
  const limits = rows.map(row => {
    const metric = metricKey(row && row.metric);
    if (seen.has(metric)) throw new Error(`${metric} is listed twice`);
    seen.add(metric);
    const unlimited = !!(row && row.unlimited);
    return { metric, unlimited, value: unlimited ? null : integer(row.value, `the ${metric} limit`) };
  });
  const missing = METRIC_KEYS.filter(key => !seen.has(key));
  if (missing.length) throw new Error(`This package says nothing about ${missing.join(', ')}`);
  return limits;
}

function text(value, field, max, pattern = /^[A-Za-z0-9][A-Za-z0-9._@-]*$/) {
  const clean = String(required(value, field));
  if (clean.length > max) throw new Error(`${field} must be ${max} characters or fewer`);
  if (!pattern.test(clean)) throw new Error(`${clean} is not a valid ${field}`);
  return clean;
}

function integer(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${field} must be a whole number`);
  return number;
}

function oneOf(value, allowed, field) {
  const clean = String(value || '').trim();
  if (!allowed.includes(clean)) throw new Error(`${field} must be one of ${allowed.join(', ')}`);
  return clean;
}

// The provider has to exist, the capability has to exist, and the one has to do
// the other. All three are known statically, so all three are refused here.
function providerFor(value, capability) {
  const id = text(value, 'provider', 64, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const provider = INTEGRATION_PROVIDERS.find(entry => entry.id === id);
  if (!provider) throw new Error(`${id} is not a provider this panel knows`);
  const wanted = String(capability || '');
  if (!INTEGRATION_CAPABILITIES[wanted]) throw new Error(`${wanted || 'that'} is not a capability this panel has`);
  if (!provider.capabilities.includes(wanted)) throw new Error(`${provider.name} does not do ${wanted}`);
  if (provider.kind === 'local') throw new Error(`${provider.name} is this machine, so there is no account to connect`);
  return id;
}

function domain(value) {
  const clean = String(required(value, 'domain')).toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(clean)) throw new Error(`${value} is not a domain name`);
  return clean;
}

function email(value) {
  const clean = String(required(value, 'address')).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(clean)) throw new Error(`${value} is not an email address`);
  return clean;
}

function ipAddress(value) {
  const clean = String(required(value, 'address')).trim();
  if (!net.isIP(clean)) throw new Error(`${value} is not an IP address`);
  return clean;
}

function engine(value) {
  if (!value) return undefined;
  return oneOf(String(value).toLowerCase(), ['mysql', 'postgres', 'hestia'], 'database engine');
}

function queueId(value) {
  const clean = String(required(value, 'queue id')).toUpperCase();
  if (clean !== 'ALL' && !/^[A-F0-9]{6,20}$/.test(clean)) throw new Error('A queue id looks like 3F2A1B0C, or use ALL');
  return clean;
}

// Checked here rather than at execution, so a malformed key or a password the
// database will refuse never becomes an approved action waiting to fail.
function sshPublicKey(value) {
  const key = String(required(value, 'public key')).trim().replace(/\s+/g, ' ');
  if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com)\s+[A-Za-z0-9+/=]{32,}(\s+\S.*)?$/.test(key)) {
    throw new Error('That does not look like a public key line (it should start with ssh-ed25519, ssh-rsa or ecdsa-…)');
  }
  return key;
}

function dbPassword(value) {
  const password = String(required(value, 'password'));
  if (!/^[A-Za-z0-9!#%*+\-=?@^_~.]{10,128}$/.test(password)) {
    throw new Error('A database password must be 10–128 characters using letters, digits and ! # % * + - = ? @ ^ _ ~ . only');
  }
  return password;
}

function unit(value) {
  const clean = String(required(value, 'service name'));
  if (!/^[A-Za-z0-9@._:\\-]{1,128}$/.test(clean)) throw new Error(`${value} is not a valid service name`);
  return clean;
}

function list(value, field) {
  const entries = (Array.isArray(value) ? value : String(value || '').split(',')).map(v => String(v).trim()).filter(Boolean);
  if (!entries.length) throw new Error(`${field} is required`);
  if (entries.length > 200) throw new Error(`${field} is limited to 200 entries at a time`);
  return entries;
}

function relativeRoot(value) {
  const clean = String(required(value, 'document root')).trim().replace(/^\/+/, '');
  if (!clean || clean.length > 160 || clean.split('/').some(part => !part || part === '.' || part === '..' || !/^[A-Za-z0-9._-]+$/.test(part))) {
    throw new Error('document root must be a relative folder path using letters, digits, dots, dashes and underscores');
  }
  return clean;
}

function httpUrl(value) {
  const clean = String(required(value, 'redirect URL')).trim();
  if (!/^https?:\/\/[a-z0-9][a-z0-9.-]*(?::\d{1,5})?(?:[/?#][^\s]*)?$/i.test(clean) || /[$\\]/.test(clean)) {
    throw new Error('redirect URL must be a complete HTTP or HTTPS address');
  }
  return clean;
}


// ── The imported plan, rebuilt rather than accepted ─────────────────
// This is the only input in this file that was written by a machine somewhere
// else. A parser read an archive from a server nobody here controls and turned
// it into an object; every field below is copied out by name into a fresh one,
// so anything the executor does not read cannot arrive, and every list has an
// end. The privileged jobs validate each name again when they use it, which is
// where the real gate is, and this is the first of the two.
const PLAN_LIMITS = { domains: 500, databases: 500, mailboxes: 5000, forwarders: 5000, files: 5000, statistics: 5000, warnings: 500, unsupported: 500 };

function migrationPlan(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('a migration plan is required');
  const rows = (key, build) => {
    const source = Array.isArray(value[key]) ? value[key] : [];
    if (source.length > PLAN_LIMITS[key]) throw new Error(`this plan lists ${source.length} ${key}, which is more than one migration will carry`);
    return source.map(build).filter(Boolean);
  };
  const line = (input, max = 200) => (input == null ? null : String(input).replace(/[\0-\x1f\x7f]/g, ' ').slice(0, max).trim() || null);
  // A member name inside somebody else's archive, which is the least trusted
  // string in the least trusted input this file handles. It is never a path on
  // this machine and it is never allowed to become one: no absolute form, no
  // drive letter, no climbing, no control characters, and nothing that is only
  // safe until an unpacker interprets it. A name that does not survive this is
  // dropped rather than repaired, because a repaired path is a guess about
  // where somebody's files should go.
  const member = input => {
    if (input == null) return null;
    const value = String(input).replace(/\\/g, '/');
    if (!value || value.includes('\0') || value.startsWith('/') || /^[a-z]:\//i.test(value)) return null;
    if (value.split('/').includes('..')) return null;
    if (/[\0-\x1f\x7f]/.test(value)) return null;
    return value.slice(0, 400);
  };
  return {
    account: line(typeof value.account === 'object' && value.account ? value.account.user || value.account.name : value.account, 100),
    source: line(value.source, 60),
    // The staged archive this plan was read out of, if it is still here. The id
    // is a token, never a path: the panel turns it into one at execution time
    // from its own directory, so nothing a plan says can point the executor at
    // a file of its choosing.
    archiveId: /^mig_[a-f0-9]{16}$/.test(String(value.archiveId || '')) ? String(value.archiveId) : null,
    domains: rows('domains', entry => (entry && entry.domain ? {
      domain: domain(entry.domain),
      documentRoot: entry.documentRoot ? relativeRoot(entry.documentRoot) : 'public',
      // Where this site's files sit inside the archive. Null means the plan
      // knows of no files for it, which is different from an empty site and is
      // reported as such rather than passed off as a finished migration.
      filesPrefix: member(entry.filesPrefix),
    } : null)),
    databases: rows('databases', entry => (entry && entry.name ? {
      name: text(entry.name, 'database name', 48),
      users: (Array.isArray(entry.users) ? entry.users : []).slice(0, 50)
        .filter(user => user && user.username)
        .map(user => ({ username: text(user.username, 'database user', 48), privileges: user.privileges === 'read' ? 'read' : 'all' })),
      // The dump inside the archive. A database created without it is an empty
      // database with the right name, which is the failure people find last.
      dumpPath: member(entry.dumpPath),
    } : null)),
    mailboxes: rows('mailboxes', entry => (entry && entry.domain && entry.account ? {
      domain: domain(entry.domain),
      account: text(entry.account, 'mailbox name', 64),
      address: `${String(entry.account).toLowerCase()}@${domain(entry.domain)}`,
      quotaMb: entry.quotaMb == null || entry.quotaMb === '' ? 0 : integer(entry.quotaMb, 'mailbox size'),
      // The stored mail itself. Without it a migrated mailbox is an address
      // that works and an inbox that is empty.
      mailPrefix: member(entry.mailPrefix),
    } : null)),
    forwarders: rows('forwarders', entry => (entry && entry.from && entry.to ? { from: email(entry.from), to: email(entry.to) } : null)),
    // Files and statistics are counted in the preview and carried for the
    // record. Neither is read as a path here, because neither job opens one.
    files: rows('files', entry => line(entry && entry.path ? entry.path : entry, 400)),
    statistics: rows('statistics', entry => line(entry && entry.domain ? entry.domain : entry, 253)),
    warnings: rows('warnings', entry => line(entry, 400)),
    // The parser names what it could not carry as a thing and a reason. Both
    // are kept, joined into one line, because "12 cron jobs" without the reason
    // is a complaint and with it is an answer.
    unsupported: rows('unsupported', entry => (entry && typeof entry === 'object'
      ? line(`${entry.what}${entry.why ? `: ${entry.why}` : ''}`, 400)
      : line(entry, 400))),
  };
}

function describePlan(plan) {
  const counts = [
    [(plan && plan.domains || []).length, 'website'],
    [(plan && plan.databases || []).length, 'database'],
    [(plan && plan.mailboxes || []).length, 'mailbox', 'mailboxes'],
  ].filter(([count]) => count > 0)
    .map(([count, one, many]) => `${count} ${count === 1 ? one : many || `${one}s`}`);
  return counts.length ? counts.join(', ') : 'nothing this machine can build';
}

// The server somebody is leaving. The password is checked for shape here and
// protected in the record by the same rule that covers every other password.
function imapSource(p) {
  const security = oneOf(p.security || 'tls', ['tls', 'starttls', 'plain'], 'connection security');
  const host = String(required(p.host, 'mail server')).trim().toLowerCase();
  if (host.length > 253 || !/^[a-z0-9][a-z0-9.:_-]*$/.test(host)) throw new Error(`${p.host} is not a mail server name or address`);
  const port = p.port == null || p.port === '' ? (security === 'tls' ? 993 : 143) : integer(p.port, 'port');
  if (port < 1 || port > 65535) throw new Error('The mail server port must be between 1 and 65535');
  const username = String(required(p.username, 'mailbox login'));
  const password = String(required(p.password, 'mailbox password'));
  if (username.length > 255 || /[\r\n\0]/.test(username)) throw new Error('The mailbox login must be one line');
  if (password.length > 255 || /[\r\n\0]/.test(password)) throw new Error('The mailbox password must be one line');
  return { host, port, security, username, password, allowUntrusted: p.allowUntrusted === true || p.allowUntrusted === 'true' };
}

module.exports = { OPERATIONS, READS, READ_SCOPES, getOperation, migrationPlan };
