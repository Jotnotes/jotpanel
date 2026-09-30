'use strict';

// Direct, panel-owned server stacks. The web process only translates engine
// capabilities into named privileged jobs; it never receives an executable or
// command string from a request and never has root itself.

const { createPrivilegedClient } = require('./privilegedClient');

function createNativeStackBackend({ client = createPrivilegedClient() } = {}) {
  let lastState = null;

  async function capabilities() {
    const caps = new Map(); const missing = new Map();
    const add = (id, kind, job, adapt = value => value, params = value => value) => caps.set(id, {
      id, kind, backend: 'native-stacks',
      run: (input = {}) => client.run(job, params(input)).then(adapt),
    });
    const skipMany = (ids, reason) => ids.forEach(id => missing.set(id, reason));

    const service = await client.probe();
    if (!service.ok) {
      const reason = `the privileged named-job service is unavailable: ${service.reason}`;
      skipMany(ALL_CAPABILITIES, reason);
      lastState = { privileged: service, stacks: {} };
      return { capabilities: caps, missing, state: lastState };
    }

    add('stack.install', 'write', 'stack.install');
    add('stack.probe', 'read', 'stack.probe');

    const probes = {};
    for (const stack of ['database', 'postgres', 'web', 'certificates', 'mail', 'webmail', 'fail2ban', 'php', 'antispam']) {
      try { probes[stack] = await client.run('stack.probe', { stack }); }
      catch (error) { probes[stack] = { stack, available: false, reason: error.message }; }
    }

    // Either engine is enough for the Databases screen to exist. A machine with
    // only PostgreSQL used to be told it had no database server at all.
    if (probes.database.available || probes.postgres.available) {
      add('database.list', 'read', 'database.list');
      add('database.tables', 'read', 'database.tables', value => value, p => ({ name: p.name, engine: p.engine }));
      add('database.create', 'write', 'database.create', value => value, p => ({ name: p.name, engine: p.engine }));
      add('database.drop', 'write', 'database.drop', value => value, p => ({ name: p.name, engine: p.engine }));
      add('database.user.create', 'write', 'database.user.create', value => value, p => ({ username: p.username, password: p.password, engine: p.engine }));
      add('database.user.drop', 'write', 'database.user.drop', value => value, p => ({ username: p.username, engine: p.engine }));
      add('database.grant', 'write', 'database.grant', value => value, p => ({ name: p.name, username: p.username, privileges: p.privileges, engine: p.engine }));
      add('database.password', 'write', 'database.password', value => value, p => ({ username: p.username, password: p.password, engine: p.engine }));
      add('database.dump', 'read', 'database.dump', value => value, p => ({ name: p.name, engine: p.engine }));
      add('database.import', 'write', 'database.import', value => value, p => ({ name: p.name, sql: p.sql, engine: p.engine }));
    } else skipMany(DATABASE_CAPS, `neither database server is runnable with panel privilege. MariaDB: ${probes.database.reason || 'install it first'}. PostgreSQL: ${probes.postgres.reason || 'install it first'}.`);

    if (probes.web.available) {
      add('site.list', 'read', 'site.list');
      // Which sites are being counted, and bringing the ones that are not into
      // counting. Both belong with the web server, because both are questions
      // about its configuration.
      add('site.statistics.status', 'read', 'site.statistics.status');
      add('site.statistics.enable', 'write', 'site.statistics.enable', value => value, p => ({ domain: p.domain }));
      add('site.create', 'write', 'site.create', value => value, p => ({ domain: p.domain, documentRoot: p.documentRoot }));
      add('site.delete', 'write', 'site.delete', value => value, p => ({ domain: p.domain }));
      add('site.document-root', 'write', 'site.document-root', value => value, p => ({ domain: p.domain, documentRoot: p.documentRoot }));
      add('site.redirect', 'write', 'site.redirect', value => value, p => ({ domain: p.domain, target: p.target }));
      add('site.alias.set', 'write', 'site.alias', value => value, p => ({ domain: p.domain, alias: p.alias, remove: p.remove }));
      add('site.reload', 'write', 'site.reload');
      add('site.protect.list', 'read', 'site.protect.list', v => v, p => ({ domain: p.domain }));
      add('site.protect.set', 'write', 'site.protect.set', v => v, p => ({ domain: p.domain, path: p.path, user: p.user, password: p.password }));
      add('site.protect.clear', 'write', 'site.protect.clear', v => v, p => ({ domain: p.domain, path: p.path, user: p.user }));
      // A site's own files, through the daemon, because the panel user cannot
      // read a site tree and anything it wrote would belong to the wrong user.
      add('sftp.status', 'read', 'sftp.status', v => v, p => ({ domain: p.domain }));
      add('sftp.enable', 'write', 'sftp.enable');
      add('sftp.disable', 'write', 'sftp.disable');
      add('site.files.list', 'read', 'site.files.list', v => v, p => ({ domain: p.domain, dir: p.dir || '' }));
      add('site.files.read', 'read', 'site.files.read', v => v, p => ({ domain: p.domain, path: p.path }));
      add('site.files.write', 'write', 'site.files.write');
      add('site.files.folder', 'write', 'site.files.folder');
      add('site.files.delete', 'write', 'site.files.delete');
      add('site.files.rename', 'write', 'site.files.rename');
      add('site.files.place', 'write', 'site.files.place');
      add('site.files.stage', 'read', 'site.files.stage', v => v, p => ({ domain: p.domain, path: p.path }));
      add('site.files.archive', 'write', 'site.files.archive');
      add('site.files.extract', 'write', 'site.files.extract');
      add('staging.reserve', 'read', 'staging.reserve', v => v, () => ({}));
      add('staging.discard', 'read', 'staging.discard', v => v, p => ({ staged: p.staged }));
      // Runtimes beyond PHP. They are a process behind this reverse proxy, so
      // they belong to the web stack rather than to a stack of their own, and
      // which languages this machine can actually run is answered by
      // runtime.list asking each interpreter to run rather than looking on disk.
      add('runtime.list', 'read', 'runtime.list');
      add('runtime.status', 'read', 'runtime.status', v => v, p => ({ domain: p.domain }));
      add('runtime.set', 'write', 'runtime.set', v => v, p => ({ domain: p.domain, runtime: p.runtime, entry: p.entry }));
      add('runtime.clear', 'write', 'runtime.clear', v => v, p => ({ domain: p.domain }));
      add('runtime.restart', 'write', 'runtime.restart', v => v, p => ({ domain: p.domain }));
      add('runtime.install', 'write', 'runtime.install', v => v, p => ({ runtime: p.runtime }));
    } else skipMany(SITE_CAPS, `nginx is not runnable with panel privilege: ${probes.web.reason || 'install it first'}`);

    if (probes.certificates.available) {
      add('certificate.list', 'read', 'certificate.list', value => value, () => ({}));
      add('certificate.issue', 'write', 'certificate.issue', value => value, p => ({ domain: p.domain, email: p.email, staging: p.staging, forceHttps: p.forceHttps }));
      add('certificate.renew', 'write', 'certificate.renew', value => value, p => ({ domain: p.domain, dryRun: p.dryRun }));
      add('certificate.https', 'write', 'certificate.https', value => value, p => ({ domain: p.domain, enabled: p.enabled }));
    } else skipMany(CERTIFICATE_CAPS, `certbot is not runnable with panel privilege: ${probes.certificates.reason || 'install it first'}`);

    if (probes.php.available) {
      add('php.versions', 'read', 'php.versions');
      add('application.list', 'read', 'application.list');
      add('application.install', 'write', 'application.install', value => value,
        p => ({ application: p.application, domain: p.domain }));
      add('site.php.set', 'write', 'site.php.set', v => v, p => ({ domain: p.domain, template: p.template }));
      add('site.php.versions', 'read', 'php.versions', value => ({
        // The sites screen asks for templates; on a native box a template is
        // simply a PHP version with a pool behind it.
        templates: (value.versions || []).map(entry => ({
          name: `PHP ${entry.version}`, template: entry.version,
          running: entry.running, socket: entry.socket, default: entry.version === value.default,
        })),
        default: value.default,
      }));
    } else skipMany(PHP_CAPS, `PHP is not runnable with panel privilege: ${probes.php.reason || 'install it first'}`);

    if (probes.mail.available) {
      add('mail.domains', 'read', 'mail.list', value => ({
        domains: (value.domains || []).map(entry => ({ domain: entry.domain, accounts: entry.mailboxes, antispam: entry.antispam !== false, dkim: false, catchall: (value.catchalls || []).find(item => item.domain === entry.domain)?.forward || null })),
      }));
      add('mail.mailbox.list', 'read', 'mail.list', (value, domain) => value, p => p);
      // Mailbox list needs its requested-domain filter and the field names the
      // existing operator table already uses.
      caps.set('mail.mailbox.list', {
        id: 'mail.mailbox.list', kind: 'read', backend: 'native-stacks',
        run: async p => {
          const value = await client.run('mail.list', {});
          return { mailboxes: (value.mailboxes || []).filter(item => !p.domain || item.domain === p.domain).map(item => ({ ...item, used_bytes: item.size_bytes, forwarders: item.forwards || [] })) };
        },
      });
      add('mail.mailbox.create', 'write', 'mail.mailbox.create');
      add('mail.mailbox.delete', 'write', 'mail.mailbox.delete');
      add('mail.mailbox.password', 'write', 'mail.mailbox.password');
      add('mail.mailbox.quota', 'write', 'mail.mailbox.quota');
      add('mail.forwarder.set', 'write', 'mail.forwarder', value => value, p => ({ domain: p.domain, account: p.account, forward: p.forward, remove: false }));
      add('mail.forwarder.delete', 'write', 'mail.forwarder', value => value, p => ({ domain: p.domain, account: p.account, forward: p.forward, remove: true }));
      add('mail.autoreply.set', 'write', 'mail.autoreply', value => value, p => ({ domain: p.domain, account: p.account, message: p.message, clear: false }));
      add('mail.autoreply.clear', 'write', 'mail.autoreply', value => value, p => ({ domain: p.domain, account: p.account, clear: true }));
      add('mail.catchall.set', 'write', 'mail.catchall');
      // Its own stack, so a mail server without the filter installed keeps
      // every other mail tool and is told which one thing is missing.
      if (probes.antispam.available) add('mail.antispam.set', 'write', 'mail.antispam');
      else skipMany(['mail.antispam.set'], `spam filtering is not runnable with panel privilege: ${probes.antispam.reason || 'install it first'}`);
      add('mail.queue.list', 'read', 'mail.queue.list');
      add('mail.queue.action', 'write', 'mail.queue.action');
    } else skipMany(MAIL_CAPS, `Postfix and Dovecot are not both runnable with panel privilege: ${probes.mail.reason || 'install them first'}`);

    if (probes.webmail.available) add('webmail.status', 'read', 'webmail.status', value => value, () => ({}));
    else skipMany(WEBMAIL_CAPS, `Roundcube is not runnable under the panel domain: ${probes.webmail.reason || 'install it first'}`);

    if (probes.fail2ban.available) {
      add('fail2ban.list', 'read', 'fail2ban.list', value => value, () => ({}));
      add('fail2ban.unban', 'write', 'fail2ban.unban', value => value, p => ({ jail: p.jail, ip: p.ip }));
    } else skipMany(FAIL2BAN_CAPS, `fail2ban is not runnable with panel privilege: ${probes.fail2ban.reason || 'install it first'}`);

    // ── Moving in from somewhere else ──────────────────────────────
    // Preview and apply refuse per item and say why, so all they need is
    // somewhere to put things. Reading an archive is not here at all: that is a
    // parser, it needs no privilege, and it hands these jobs a plan.
    if (probes.web.available || probes.mail.available) {
      add('migrate.preview', 'read', 'migrate.preview', value => value, p => ({ plan: p.plan }));
      // `archivePath` travels beside the plan rather than inside it. The plan is
      // rebuilt field by field from somebody else's archive and may never name a
      // file on this machine; the path is put here by the panel at execution
      // time, from its own staging directory, and dropping it here is what made
      // a migration build the shape of an account and fill none of it.
      add('migrate.apply', 'write', 'migrate.apply', value => value, p => ({ plan: p.plan, archivePath: p.archivePath }));
    } else skipMany(MIGRATE_CAPS, 'this machine has neither a web stack nor a mail stack yet, so there is nowhere to migrate an account into');

    // The IMAP copy asks Dovecot whether it knows the imapc driver rather than
    // assuming that a machine with Dovecot on it can read another server's
    // mail. A build without imapc would draw a working-looking button that
    // fails on the first mailbox somebody tried to move.
    if (probes.mail.available) {
      let imapc;
      try { imapc = await client.run('migrate.imap.probe', {}); }
      catch (error) { imapc = { available: false, reason: error.message }; }
      if (imapc.available) {
        add('migrate.imap.inspect', 'read', 'migrate.imap.inspect', value => value,
          p => ({ host: p.host, port: p.port, security: p.security, username: p.username, password: p.password, allowUntrusted: p.allowUntrusted }));
        add('migrate.imap.pull', 'write', 'migrate.imap.pull', value => value,
          p => ({ domain: p.domain, account: p.account, host: p.host, port: p.port, security: p.security, username: p.username, password: p.password, allowUntrusted: p.allowUntrusted, replace: p.replace }));
      } else skipMany(IMAP_MIGRATE_CAPS, imapc.reason || 'Dovecot on this machine cannot read another server over IMAP');
    } else skipMany(IMAP_MIGRATE_CAPS, `there is no mailbox on this machine to copy into: ${probes.mail.reason || 'install Postfix and Dovecot first'}`);

    lastState = { privileged: service, stacks: probes };
    return { capabilities: caps, missing, state: lastState };
  }

  return { name: 'native-stacks', capabilities, state: () => lastState, client };
}

const DATABASE_CAPS = ['database.list', 'database.tables', 'database.create', 'database.drop', 'database.user.create', 'database.user.drop', 'database.grant', 'database.password', 'database.dump', 'database.import'];
const RUNTIME_CAPS = ['runtime.list', 'runtime.status', 'runtime.set', 'runtime.clear', 'runtime.restart', 'runtime.install'];
const SITE_CAPS = ['site.statistics.status', 'site.statistics.enable', 'site.protect.list', 'site.protect.set', 'site.protect.clear', 'runtime.list', 'runtime.status', 'runtime.set', 'runtime.clear', 'runtime.restart', 'runtime.install', 'site.list', 'site.create', 'site.delete', 'site.document-root', 'site.redirect', 'site.alias.set', 'site.reload',
  'site.files.list', 'site.files.read', 'site.files.write', 'site.files.folder', 'site.files.delete', 'site.files.rename',
  'site.files.place', 'site.files.stage', 'site.files.archive', 'site.files.extract',
  'staging.reserve', 'staging.discard',
  'sftp.status', 'sftp.enable', 'sftp.disable'];
const CERTIFICATE_CAPS = ['certificate.list', 'certificate.issue', 'certificate.renew', 'certificate.https'];
const WEBMAIL_CAPS = ['webmail.status'];
const FAIL2BAN_CAPS = ['fail2ban.list', 'fail2ban.unban'];
const PHP_CAPS = ['php.versions', 'site.php.versions', 'site.php.set', 'application.list', 'application.install'];
const MAIL_CAPS = ['mail.domains', 'mail.mailbox.list', 'mail.mailbox.create', 'mail.mailbox.delete', 'mail.mailbox.password', 'mail.mailbox.quota', 'mail.forwarder.set', 'mail.forwarder.delete', 'mail.autoreply.set', 'mail.autoreply.clear', 'mail.catchall.set', 'mail.queue.list', 'mail.queue.action'];
const MIGRATE_CAPS = ['migrate.preview', 'migrate.apply'];
const IMAP_MIGRATE_CAPS = ['migrate.imap.inspect', 'migrate.imap.pull'];
const ALL_CAPABILITIES = ['stack.install', 'stack.probe', ...DATABASE_CAPS, ...SITE_CAPS, ...CERTIFICATE_CAPS, ...MAIL_CAPS, ...WEBMAIL_CAPS, ...FAIL2BAN_CAPS, ...PHP_CAPS, ...MIGRATE_CAPS, ...IMAP_MIGRATE_CAPS];

module.exports = { createNativeStackBackend };
