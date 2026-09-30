'use strict';

// The server operations service.
//
// It owns three things and deliberately no more. What this server can actually
// do, which it asks the engine rather than assuming. Reads, which need no
// approval. And writes, which are proposals on the existing action store and go
// through the same approve-then-execute path as everything else in the panel.
//
// The rule that shapes the whole file: a result is not success until the thing
// underneath has been read back. Every backend handler verifies its own work
// and returns `verified: true`; anything that comes back without it is recorded
// as a failure, because a green card over an unchecked write is the one bug
// that would make this panel worse than no panel.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { OPERATIONS, READS, READ_SCOPES, getOperation } = require('./ops/catalogue');
const { redact: redactSecrets, SECRET_PARAM, SECRET_RESULT } = require('./secrets');
const { createReconciler } = require('./ops/reconcile');

// Operations whose catalogue row deletes the whole resource named by its own
// scope, rather than something inside it. A mailbox delete removes one
// mailbox under a mail domain, not the domain's mail hosting itself, so it is
// deliberately not in this list — there is no catalogue row that deletes a
// mail domain or a DNS zone outright today, so ownership of those kinds is
// never released by this file. Add a row here only when the matching
// catalogue operation actually removes the resource `scope.param` names.
const RELEASES_OWNERSHIP = new Set(['site.delete', 'database.drop', 'dns.zone.delete']);

// The screens, and the capability each one needs before it is allowed to
// appear. A section with nothing available is not rendered as a dead tile; the
// panel prints why instead.
// Operations that are a backup run, and therefore owe the health record a run
// whether they work or not. Both make an artifact on this machine; the second
// also sends it somewhere else, and the sending is part of whether the backup
// is real.
const BACKUP_RUN_OPERATIONS = new Set(['backup.create', 'backup.offsite.store']);

const SECTIONS = [
  {
    id: 'reseller', title: 'Accounts and packages', art: 'people',
    blurb: 'Take on customer accounts, put them on a package, stop and start them, and move one limit for one account.',
    requires: ['entitlements.package.create'],
    capabilities: ['entitlements.package.create', 'entitlements.package.assign', 'entitlements.package.archive',
      'entitlements.account_limit.override', 'entitlements.account_limit.override.clear', 'entitlements.organization.link',
      // The account lifecycle belongs on this screen because it is the same
      // job: taking somebody on, and deciding whether they are running.
      'account.create', 'account.suspend', 'account.unsuspend', 'account.role.set'],
  },
  {
    id: 'services', title: 'Services and processes', art: 'server',
    blurb: 'Start, stop and restart what runs on this machine, and see what is using it.',
    requires: ['system.metrics.history', 'service.list', 'process.list'],
    capabilities: ['system.metrics', 'system.metrics.history', 'service.list', 'service.status', 'service.control', 'process.list', 'process.kill', 'system.reboot'],
  },
  {
    id: 'logs', title: 'Logs', art: 'document',
    blurb: 'Read, search and download the web, mail and system logs.',
    requires: ['log.sources', 'log.journal'],
    capabilities: ['log.sources', 'log.tail', 'log.search', 'log.download', 'log.journal'],
  },
  {
    id: 'databases', title: 'Databases', art: 'storage',
    blurb: 'Create databases and users, grant access, browse tables, dump and import.',
    requires: ['database.list'],
    capabilities: ['database.list', 'database.tables', 'database.create', 'database.drop', 'database.user.create',
      'database.user.drop', 'database.grant', 'database.password', 'database.dump', 'database.import', 'stack.install'],
  },
  {
    id: 'mailadmin', title: 'Mail administration', art: 'mail',
    blurb: 'Mailboxes, forwarders, automatic replies, catch-all, spam, signing keys and the queue.',
    requires: ['mail.mailbox.list', 'mail.queue.list', 'mail.domains'],
    capabilities: ['mail.domains', 'mail.mailbox.list', 'mail.mailbox.create', 'mail.mailbox.delete', 'mail.mailbox.password',
      'mail.mailbox.quota', 'mail.forwarder.set', 'mail.forwarder.delete', 'mail.autoreply.set', 'mail.autoreply.clear',
      'mail.catchall.set', 'mail.antispam.set', 'mail.dkim.show', 'mail.dkim.enable', 'mailauth.setup', 'mail.queue.list', 'mail.queue.action',
      'webmail.status', 'stack.install'],
  },
  {
    id: 'serversites', title: 'Websites on this server', art: 'websites',
    blurb: 'PHP version, the language a site runs, subdomains, parked domains and password-protected directories.',
    requires: ['site.list'],
    capabilities: ['runtime.list', 'runtime.status', 'runtime.set', 'runtime.clear', 'runtime.restart', 'runtime.install',
      'site.list', 'site.create', 'site.delete', 'site.document-root', 'site.redirect', 'site.reload',
      'site.statistics.status', 'site.statistics.enable',
      'site.php.versions', 'site.php.set', 'php.versions', 'application.list', 'application.install', 'site.files.list', 'site.files.read', 'site.files.write',
      'site.files.folder', 'site.files.delete', 'site.files.rename', 'site.files.place', 'site.files.stage',
      'site.files.archive', 'site.files.extract', 'staging.reserve', 'staging.discard', 'site.alias.set', 'site.protect.list', 'site.protect.set', 'site.protect.clear',
      'certificate.list', 'certificate.issue', 'certificate.renew', 'certificate.https', 'stack.install'],
  },
  {
    id: 'filesadmin', title: 'Files and upload accounts', art: 'files',
    blurb: 'Permissions and archives inside the account file area. Uploads go over SFTP, which is turned on per website.',
    requires: ['disk.usage', 'file.list'],
    capabilities: ['disk.usage', 'sftp.status', 'sftp.enable', 'sftp.disable', 'file.list', 'file.permissions', 'file.archive', 'file.extract'],
  },
  {
    id: 'backups', title: 'Backups', art: 'archive',
    blurb: 'Archives of the files, the mail and the databases, and a restore that can put back one file rather than an account.',
    requires: ['backup.health.list'],
    capabilities: ['backup.health.list', 'backup.incidents.list', 'backup.list', 'backup.contents', 'backup.fetch', 'backup.file.versions', 'backup.file.preview', 'backup.schedule.status', 'backup.create', 'backup.restore', 'backup.schedule.set', 'backup.schedule.clear'],
  },
{
    id: 'integrations', title: 'Integrations', art: 'globe',
    blurb: 'Who serves each thing this panel needs from outside: mail security, DNS, certificates, offsite backups and the rest. Keys are entered once, here, and never shown again.',
    requires: ['integration.list'],
    capabilities: ['integration.list', 'integration.connect', 'integration.disconnect',
      'capability.mail.security.set', 'capability.dns.hosting.zone.create',
      'capability.certificate.issuance.issue', 'capability.backup.offsite.store',
      'capability.email.transactional.send', 'integration.test'],
  },
  {
    // A section of its own rather than a filter on the one above, because it
    // answers a different question. Integrations asks who serves each thing.
    // This asks where the backups go, whether that place answered the last time
    // anybody checked, and lets somebody check now. A destination also carries
    // state no other integration has — a last test, and whether it passed — and
    // an operator setting up backups should not have to read past mail security
    // and DNS to find it. It is one store seen twice: the same bindings, the
    // same connect and disconnect, no second table anywhere.
    id: 'backupdestinations', title: 'Backup destinations', art: 'files',
    blurb: 'Where a backup goes when it leaves this machine. A destination is connected once, tested by writing a real object and reading it back, and used by every backup from then on.',
    requires: ['integration.list'],
    capabilities: ['integration.list', 'integration.connect', 'integration.disconnect', 'integration.test',
      'capability.backup.offsite.store', 'capability.backup.offsite.list', 'capability.backup.offsite.retrieve'],
  },
  {
    id: 'dnszone', title: 'DNS zone', art: 'globe',
    blurb: 'The records that exist right now, not only a form to add another.',
    requires: ['dns.records'],
    capabilities: ['dns.zones', 'dns.records', 'dns.record.create', 'dns.record.delete', 'dns.zone.create', 'dns.zone.delete', 'dns.zone.records', 'mailauth.check', 'dmarc.reports.read'],
  },
  {
    id: 'security', title: 'Firewall, updates and keys', art: 'shield',
    blurb: 'Open a port, ban an address, install security updates, manage SSH access.',
    requires: ['fail2ban.list', 'firewall.list', 'packages.status', 'sshkey.list'],
    capabilities: ['panel.domain.set', 'firewall.list', 'firewall.rule', 'firewall.guard.arm', 'firewall.guard.confirm', 'firewall.guard.status',
      'fail2ban.list', 'fail2ban.unban', 'packages.status', 'packages.apply', 'sshkey.list', 'sshkey.add', 'sshkey.remove', 'stack.install'],
  },
  {
    id: 'migration', title: 'Move in from another server', art: 'portability',
    blurb: 'Look at the account you are leaving, see exactly what it holds, and build it here without switching anything over.',
    requires: ['migrate.preview', 'migrate.imap.inspect'],
    capabilities: ['migrate.preview', 'migrate.apply', 'migrate.imap.inspect', 'migrate.imap.pull'],
  },
  {
    id: 'console', title: 'Command console', art: 'panel',
    blurb: 'One command at a time, recorded, behind a typed confirmation. Not an interactive shell.',
    requires: ['console.run'],
    capabilities: ['console.run'],
  },
];

const UPLOAD_TTL_MS = 60 * 60 * 1000;

const SETUP_OPTIONS = {
  databases: {
    // Two engines, two doors. One door and two engines is how the panel ends up
    // with an operation nothing can reach.
    install: [
      { operation: 'stack.install.database', label: 'Install MariaDB here' },
      { operation: 'stack.install.postgres', label: 'Install PostgreSQL here' },
    ],
    buy: { label: 'Buy a managed database', href: 'https://www.digitalocean.com/products/managed-databases' },
    connect: { label: 'Connect an existing database', kind: 'database' },
  },
  mailadmin: {
    install: { operation: 'stack.install.mail', label: 'Install Postfix and Dovecot' },
    buy: { label: 'Buy hosted mail', href: 'https://www.fastmail.com/business/' },
    connect: { label: 'Connect an existing mail service', kind: 'mail' },
  },
  serversites: {
    install: { operation: 'stack.install.web', label: 'Install nginx here' },
    buy: { label: 'Buy managed web hosting', href: 'https://www.digitalocean.com/products/app-platform' },
    connect: { label: 'Connect an existing web server', kind: 'web' },
    php: {
      install: { operation: 'stack.install.php', label: 'Install PHP here' },
      buy: { label: 'Buy managed PHP hosting', href: 'https://www.cloudways.com/en/php-hosting.php' },
      connect: { label: 'Connect an existing PHP service', kind: 'php' },
    },
    certificates: {
      install: { operation: 'stack.install.certificates', label: 'Install certbot here' },
      buy: { label: 'Buy a managed certificate', href: 'https://www.digicert.com/tls-ssl/tls-ssl-certificates' },
      connect: { label: 'Connect an existing ACME service', kind: 'certificate' },
    },
  },
};

function createServerOpsService({
  engine, actionStore, ownership,
  // Optional: reseller packages/entitlements. A box that hasn't wired one up
  // (or a test constructing this service directly) behaves exactly as before
  // — every catalogue row's `entitlements` field is only ever consulted when
  // this is present, so its absence is "not metered," never a crash.
  entitlements = null,
  // Run evidence and policy versions live in the panel database, while the
  // archive work stays on the privileged side. Optional for isolated tests
  // that exercise the generic operation service without constructing either.
  backupHealth = null,
  // Called when a backup run reaches a terminal state, so an operator can be
  // told. Optional: a deployment without it keeps every other guarantee and
  // simply says nothing, which is the state this product shipped in until now.
  onBackupOutcome = null,
  // Where an unattended run is filed when the domain carries no ownership claim.
  // Absent on a box that never wired one up, where such a run is skipped rather
  // than filed under a name nobody can query.
  operatorAccountId = () => null,
  uploadDir,
  // Where an uploaded foreign archive waits between being read and being
  // applied. Absent on a service that never wired one up, where a migration
  // still builds everything it can and reports that it carried no content.
  migrationDir = null,
  now = () => new Date(),
  // Identifies this process in the record. An action still marked executing
  // under a different run id was being run by a process that is gone.
  runId = crypto.randomBytes(8).toString('hex'),
  // How the startup pass reads a privileged oneshot's durable result. Absent on
  // a box with no privileged service, where every interrupted action is simply
  // interrupted, which is the honest answer there anyway.
  oneshotResult = null,
  waitForService,
  // Writes the account's own audit trail. The reconciler needs it because it
  // settles actions when nobody is watching, and those endings belong in the
  // owner's record as much as the ones a person sat through.
  audit = () => {},
  log = (...args) => console.log(...args),
} = {}) {
  if (!engine || !actionStore || !ownership) throw new Error('server operations service requires an engine, an action store and an ownership service');
  const dumps = uploadDir ? path.resolve(uploadDir) : null;
  if (dumps) fs.mkdirSync(dumps, { recursive: true });
  const reconciler = createReconciler({
    actionStore, oneshotResult, log, audit,
    ...(waitForService ? { waitForService } : {}),
  });

  // ── What this server can do ──────────────────────────────────────
  // ── Who a screen is for, worked out rather than listed ───────────
  //
  // `surface()` described what the machine can do and said nothing about who
  // was asking, so a reseller was told the firewall and the process list were
  // available and found out otherwise by being refused. The panel papered over
  // it with a hand-kept list of operator-only section ids in the frontend,
  // which is the duplicate that drifts: the engine is the authority and the
  // report has to agree with it.
  //
  // Derived from the scopes the catalogue already declares, so a new operation
  // carries its own answer and nothing has to be remembered.
  const SURFACE_RANK = { account: 1, provider: 2, operator: 3 };
  function audienceOf(scopeKind) {
    if (scopeKind === 'server') return 'operator';
    if (scopeKind === 'own' || scopeKind === 'organization') return 'provider';
    return 'account';
  }
  function sectionAudience(section) {
    const audiences = [
      ...OPERATIONS.filter(op => section.capabilities.includes(op.capability))
        .map(op => audienceOf(op.scope.kind)),
      ...Object.keys(READS).filter(name => section.capabilities.includes(READS[name]))
        .map(name => audienceOf((READ_SCOPES[name] || {}).kind || 'account')),
    ];
    if (!audiences.length) return 'account';
    // The least privileged thing on the screen decides who the screen is for:
    // a section with one customer-level reading on it is worth drawing for a
    // customer even if the rest of it is not.
    return audiences.reduce((low, next) => (SURFACE_RANK[next] < SURFACE_RANK[low] ? next : low), 'operator');
  }
  function callerAudience(membership) {
    if (!membership) return 'account';
    if (membership.rank >= ownership.TOP_TWO) return 'operator';
    if (membership.rank >= ownership.HIERARCHY.reseller) return 'provider';
    return 'account';
  }

  async function surface({ refresh = false, accountId = null, permits = null } = {}) {
    const resolved = await engine.capabilities(refresh);
    const state = id => (resolved.available.has(id)
      ? { id, available: true, backend: resolved.available.get(id).backend }
      : {
        id, available: false,
        // `explicit` means a backend said something specific about this
        // capability. The fallback below is only for a capability nothing on
        // the box has an opinion about, which is a different situation.
        explicit: resolved.missing.has(id),
        reason: resolved.missing.get(id) || `Nothing attached to this panel provides ${id}.`,
      });

    const membership = accountId ? ownership.getMembership(accountId) : null;
    const mine = callerAudience(membership);

    const sections = SECTIONS.map(section => {
      const capabilities = section.capabilities.map(state);
      const audience = sectionAudience(section);
      const permitted = SURFACE_RANK[mine] >= SURFACE_RANK[audience];
      const onMachine = section.requires.some(id => resolved.available.has(id));
      const available = onMachine && permitted;
      const blocked = capabilities.filter(c => !c.available);
      // The single sentence the panel prints in place of the tool. A backend
      // that named the missing piece always wins over the generic fallback,
      // because "postfix is not installed" is worth ten of "unavailable".
      const headline = blocked.find(c => section.requires.includes(c.id) && c.explicit)
        || blocked.find(c => c.explicit)
        || blocked.find(c => section.requires.includes(c.id))
        || blocked[0];
      return {
        id: section.id, title: section.title, art: section.art, blurb: section.blurb,
        available,
        audience,
        reason: available ? null : !permitted
          ? (audience === 'operator'
            ? 'This is the machine itself, which belongs to the account that runs it.'
            : 'This is for an account that provides for others.')
          : headline?.reason || null,
        setup: SETUP_OPTIONS[section.id] || null,
        capabilities,
        // Per operation as well as per section, because a screen can be right
        // for somebody while one thing on it is not: a reseller belongs on the
        // accounts screen and does not get to make another reseller.
        operations: OPERATIONS.filter(op => section.capabilities.includes(op.capability))
          .map(op => {
            const opAudience = audienceOf(op.scope.kind);
            return {
              id: op.id, capability: op.capability, risk: op.risk, confirm: op.confirm || null,
              audience: opAudience,
              available: resolved.available.has(op.capability)
                && SURFACE_RANK[mine] >= SURFACE_RANK[opAudience]
                && (typeof permits !== 'function' || permits(op.capability)),
              description: `Propose ${op.id}. Nothing runs until a person approves it in JotPanel.`,
              inputSchema: op.inputSchema || { type: 'object', additionalProperties: true },
            };
          }),
      };
    });

    // The same report drives non-panel clients. Reads belong here beside
    // operations so a client never keeps a second, stale catalogue. A key sees
    // only the intersection of its scopes, the account's ownership rank and
    // what the attached engine can actually provide.
    const reads = Object.entries(READS).map(([resource, capability]) => {
      const scope = READ_SCOPES[resource] || { kind: 'account' };
      const readAudience = audienceOf(scope.kind || 'account');
      return {
        resource,
        capability,
        method: resource === 'migrate-preview' || resource === 'migrate-imap-inspect' ? 'POST' : 'GET',
        available: resolved.available.has(capability)
          && SURFACE_RANK[mine] >= SURFACE_RANK[readAudience]
          && (typeof permits !== 'function' || permits(capability)),
        description: `Read ${resource} from JotPanel. This does not change anything.`,
        inputSchema: { type: 'object', additionalProperties: true },
      };
    });

    return {
      checked_at: resolved.checkedAt,
      engines: resolved.backends,
      sections,
      reads,
      available_count: sections.filter(s => s.available).length,
    };
  }

  // A caller may be narrower than the account it belongs to. Today that means an
  // API key, which carries its holder's identity and a list of capabilities it
  // is allowed to use; `permits` is absent for a person, which reads as "not
  // narrowed" rather than as "nothing allowed". The check is here rather than at
  // the route because this is where the capability is known, and because every
  // door into an operation comes through these two functions.
  function denyOutOfScope(ctx, capability) {
    if (!ctx || typeof ctx.permits !== 'function') return;
    if (ctx.permits(capability)) return;
    const error = new Error(`This key is not scoped for ${capability}`);
    error.forbidden = true;
    throw error;
  }

  // ── Reads ────────────────────────────────────────────────────────
  // A read needs no approval. It does need permission, which is a different
  // sentence and was for a while the missing one: this function ran the
  // capability for whoever asked and filtered nothing, so an ordinary customer
  // signing in read every website, backup, process, log and firewall rule on
  // the machine. It now goes through the same ownership service `propose` does,
  // against the scope the catalogue declares beside each reading — refusing the
  // machine's own state to anyone but the operator, refusing a resource another
  // organization has claimed, and narrowing the lists to what the caller owns.
  async function read(resource, params = {}, ctx = {}) {
    const reading = String(resource || '');
    const capability = READS[reading];
    if (!capability) throw new Error(`Unknown server reading: ${resource}`);
    denyOutOfScope(ctx, capability);
    const scope = READ_SCOPES[reading];
    const membership = ownership.authorizeRead(ctx.accountId, reading, scope, params);
    const result = await engine.run(capability, params, ctx);
    // Narrowed by reach rather than by a single organization id. The operator
    // sees the whole box, a provider sees its own things and its customers',
    // and an end user sees their own. This used to ask `orgOwns(membership.orgId)`,
    // which meant a reseller's list of websites showed their own and none of
    // the customers they provide for, while the write path would have let them
    // act on those same customers. A list that disagrees with what the buttons
    // allow is the worse half of that pair.
    const data = membership.rank >= ownership.TOP_TWO || !scope.narrow
      ? result.data
      : scope.narrow(result.data, (kind, key) => ownership.reaches(membership, kind, key));
    return { ...data, _capability: capability, _backend: result.backend };
  }

  // The three readings that answer with a file rather than a page go through
  // the same gate. They are not in READS because they stream instead of
  // returning JSON, which changes how the answer travels and nothing about
  // whose answer it is.
  const FILE_READ_SCOPES = {
    'log.download': { kind: 'server' },
    'backup.fetch': { kind: 'backup', param: 'domain' },
    'database.dump': { kind: 'database', param: 'name' },
  };

  function authorizeFileRead(capability, params, ctx) {
    ownership.authorizeRead(ctx.accountId, capability, FILE_READ_SCOPES[capability], params);
  }

  // ── Writes: propose ──────────────────────────────────────────────
  // `options.deliver` names the parameters that were GENERATED rather than
  // typed, so the person who asked for the operation can be shown them once
  // after it runs. Only the names travel into the record; the values stay in
  // the encrypted call body where the form's own passwords already live. A
  // person filling in the form passes nothing here, because they already know
  // what they typed.
  async function propose(userId, operationId, input = {}, ctx = {}, options = {}) {
    const operation = getOperation(operationId);
    // A narrowed caller is refused before the capability is even resolved
    // against the machine, so a key learns nothing about what this box can do
    // outside its own scope.
    denyOutOfScope(ctx, operation.capability);
    if (!(await engine.has(operation.capability))) {
      throw new Error(await engine.reasonFor(operation.capability));
    }
    // Generation happens here, inside the service that protects and spends the
    // action body. The request may ask only for fields the catalogue declares;
    // it can never turn an arbitrary parameter into a readable secret.
    const requestedGeneration = Array.isArray(options.generate) ? options.generate : [];
    const allowedGeneration = new Set(Array.isArray(operation.generates) ? operation.generates : []);
    if (requestedGeneration.some(name => !allowedGeneration.has(name))) {
      throw new Error('This operation cannot generate that value');
    }
    const generatedNames = [...new Set(requestedGeneration)];
    const proposedInput = { ...(input || {}) };
    for (const name of generatedNames) proposedInput[name] = crypto.randomBytes(18).toString('base64url');
    const params = operation.normalize(proposedInput);
    // Refuses before anything is staged: an actor who may not touch this
    // resource never gets a card sitting in the queue waiting for someone
    // else to reject it. The membership resolved here is the one carried into
    // execute(), so who a resource is claimed for reflects who proposed it
    // even if roles change in between.
    const membership = ownership.authorize(userId, operation, params);
    // Whose account this is FOR, which is not always the account doing it. A
    // hoster moving a customer in creates sites, databases and mailboxes that
    // belong to the customer, and claiming them for the hoster leaves the
    // customer unable to see their own account and outside their own package.
    // Resolved from the signed identity against the hierarchy, never taken on
    // trust from the request.
    // `own` joins `server` and `organization` here: none of the three names a
    // thing on the machine, so there is no resource to look an owner up for.
    const NAMES_NO_RESOURCE = new Set(['server', 'organization', 'own']);
    const existingOwner = !NAMES_NO_RESOURCE.has(operation.scope.kind)
      ? ownership.claimant(operation.scope.kind, params[operation.scope.param])
      : null;
    const forOrgId = operation.targetOrg
      ? ownership.actingFor(userId, params[operation.targetOrg])
      // Acting on a customer's existing resource does not make it the
      // operator's. This matters most for backups, where the domain's site can
      // already belong to the customer before a direct backup claim exists.
      : existingOwner?.orgId || membership.orgId;
    // An operation that always generates something worth showing once says so
    // on its own catalogue row, so every caller gets it without having to know.
    // A caller may still name extra fields, which is how the assistant path
    // marks what it invented rather than what a person typed.
    const declared = Array.isArray(operation.deliver) ? operation.deliver : [];
    const asked = Array.isArray(options.deliver) ? options.deliver : [];
    const deliverOnce = [...new Set([...declared, ...asked, ...generatedNames])]
      .filter(name => typeof params[name] === 'string' && params[name]);
    const enqueue = () => actionStore.enqueue({
      accountId: userId,
      kind: `server_ops.${operation.id}`,
      actionKey: operation.id,
      label: operation.label(params),
      summary: operation.summary(params),
      riskLevel: operation.risk,
      requiresApproval: true,
      requiresConfirmText: operation.confirm || null,
      call: { api: 'jotpanel-ops', capability: operation.capability, params },
      metadata: {
        operation: operation.id, group: operation.group, capability: operation.capability,
        params: redactParams(params),
        ...(deliverOnce.length ? { deliverOnce } : {}),
        // Whose organization is about to own whatever this makes. Resolved at
        // proposal time with everything else, so an operation that creates many
        // things at once claims them for the account that asked, even if roles
        // move between the proposal and the approval.
        claimOrgId: forOrgId || membership.orgId || null,
        // `organization` and `own` are excluded alongside `server`: none of them
        // names a thing on the machine, and claiming one into `resource_owners`
        // would put a row there for something that does not live there.
        ...(!NAMES_NO_RESOURCE.has(operation.scope.kind)
          ? { ownership: { kind: operation.scope.kind, key: params[operation.scope.param], orgId: forOrgId } }
          : {}),
      },
    });

    // A capacity-metered operation only gets its card enqueued once the
    // entitlements service confirms the org (and every ancestor reseller
    // above it) has room — the enqueue itself happens *inside* that check,
    // see entitlements.js's admitProposal, so nothing can spend the same
    // headroom between "there's room" and "the card now exists."
    if (entitlements && operation.entitlements) {
      // Most operations cost a fixed one of something and say so as a list. A
      // migration costs whatever the plan holds, which is not known until the
      // plan is read, so a row may give a function instead. Resolved once, here,
      // and the resolved effects are what the holds are taken against.
      const effects = typeof operation.entitlements === 'function'
        ? operation.entitlements(params) : operation.entitlements;
      const result = effects.length
        ? await entitlements.admitProposal(forOrgId, effects, enqueue)
        : { ok: true, proposal: enqueue() };
      if (!result.ok) {
        const error = new Error(entitlementRefusalMessage(result));
        error.entitlementCode = result.code;
        throw error;
      }
      return result.proposal;
    }
    return enqueue();
  }

  const METRIC_WORDS = {
    sites_count: 'website', databases_count: 'database', mailboxes_count: 'mailbox',
    backups_count: 'backup', managed_storage_bytes: 'disk space', ai_cost_microunits_month: 'monthly assistant spend',
  };

  function entitlementRefusalMessage(result) {
    if (result.code === 'ENTITLEMENT_ASSIGNMENT_MISSING') return 'This account has no active package, so nothing that adds to it can proceed yet.';
    if (result.code === 'PROVIDER_CAPACITY_UNAVAILABLE') return 'Provider capacity is unavailable for this account right now.';
    // Storage is measured rather than counted, and a measurement old enough to
    // be wrong is refused instead of used. Says which sites and how to clear
    // it, because "stale reading" on its own is an error message nobody can
    // act on.
    if (result.code === 'USAGE_READING_STALE') {
      const which = (result.unusable || []).slice(0, 3).map(u => u.domain).join(', ');
      const more = (result.unusable || []).length > 3 ? ` and ${result.unusable.length - 3} more` : '';
      return `The disk space this account is using has not been measured recently enough to decide this (${which}${more}). Refresh the usage figures and try again.`;
    }
    const word = METRIC_WORDS[result.metric] || result.metric;
    // An account whose ceiling came down onto usage it already had. Says what
    // is not happening as plainly as what is, because the first thing anybody
    // reads this sentence wanting to know is whether their sites are about to
    // go off, and the answer is no and always no.
    if (result.code === 'ENTITLEMENT_OVERAGE_BLOCKED') {
      const unit = result.metric === 'managed_storage_bytes' ? ' bytes' : '';
      return `This account is already above its ${word} limit (${result.used ?? 0}${unit} in use, ${result.maximum}${unit} allowed), so nothing that adds to it can run. Everything already here keeps working, and deleting is never blocked: bring it back under ${result.maximum}${unit} or raise the package.`;
    }
    if (result.metric === 'managed_storage_bytes') {
      return `This account is already using all the disk space its package allows (${result.used ?? 0} of ${result.maximum} bytes), so nothing that would add to it can run.`;
    }
    if (result.delta === 0) return `This account is already at its ${word} limit (${result.used ?? 0} of ${result.maximum}).`;
    return `This would exceed the ${word} limit (${result.used ?? 0} used, ${result.holds ?? 0} pending, ${result.maximum} allowed).`;
  }

  // ── Writes: the password its owner chose ─────────────────────────
  // An email account has a user and a password and the person whose account it
  // is types the password. The assistant generates one only because a chat
  // message is the wrong place to put a secret: it is streamed, it is on the
  // screen, and on a hosted brain it would leave the machine. So the proposal
  // carries a generated password, and this replaces it with the one the owner
  // typed into the panel on the way through approval.
  //
  // What may be replaced is not read from the request. It is the list of
  // parameters the panel itself generated, fixed when the operation was
  // proposed, so a request cannot name a parameter and have it rewritten. The
  // value goes through the catalogue row's own normalize(), the same
  // validation the form gets.
  function supplySecret(actionId, userId, name, value) {
    const action = actionStore.get(actionId);
    if (!action || action.accountId !== userId || !String(action.kind).startsWith('server_ops.')) {
      throw new Error('Server operation not found');
    }
    const generated = Array.isArray(action.metadata?.deliverOnce) ? action.metadata.deliverOnce : [];
    if (!generated.includes(name)) throw new Error(`This operation has no ${name} for you to choose`);
    const operation = getOperation(action.kind.slice('server_ops.'.length));
    const params = operation.normalize({ ...(action.call?.params || {}), [name]: value });
    return actionStore.amendPending(actionId, item => ({
      ...item,
      label: operation.label(params),
      summary: operation.summary(params),
      call: { ...item.call, params },
      metadata: {
        ...item.metadata,
        params: redactParams(params),
        // Nothing generated is left to hand back, because the person who chose
        // it already has it.
        deliverOnce: generated.filter(entry => entry !== name),
        chosenByOwner: [...(item.metadata?.chosenByOwner || []), name],
      },
    }));
  }

  // ── Writes: execute ──────────────────────────────────────────────
  async function execute(actionId, userId, ctx = {}) {
    const action = actionStore.get(actionId);
    if (!action || action.accountId !== userId || !String(action.kind).startsWith('server_ops.')) {
      throw new Error('Approved server operation not found');
    }
    // Two clicks on Approve, or two tabs open on the same card, land here at
    // the same moment. One of them wins the status change and the other used to
    // be told the action "must be approved before execution", which reads as the
    // approval having been lost rather than as the work already being under way.
    if (action.status === 'executing') throw new Error('That operation is already running.');
    if (action.status === 'executed') throw new Error('That operation has already run.');
    if (action.status !== 'approved') throw new Error(`Action ${actionId} is ${action.status}, so it cannot be executed`);
    const operation = getOperation(action.kind.slice('server_ops.'.length));
    const params = { ...(action.call?.params || {}) };
    let backupRunId = null;
    // A hoster can run a customer's backup. The action belongs in the hoster's
    // own approval record, while the recovery point belongs on the customer's
    // health row. Resolve that owner before execution can add any direct backup
    // claim, and keep the answer for the whole run.
    const backupIdentityId = String(operation.id).startsWith('backup.') && params.domain
      ? (ownerAccountId(params.domain) || userId)
      : userId;

    try {
      // Claimed before a single command runs, and stamped with this process.
      // If the panel dies from here on, the row says executing rather than
      // approved, and the startup pass can tell the difference between an
      // action that was interrupted and one that was never begun.
      actionStore.markExecuting(action.id, { runId });
      // `backup.offsite.store` makes a backup and then sends it, so it is a
      // backup run in every sense that matters and used to be invisible to the
      // health record: it recorded nothing at all, which is why an account
      // whose offsite copies were failing still read as healthy. It gets a run
      // for the same reason `backup.create` does.
      if (BACKUP_RUN_OPERATIONS.has(operation.id)) {
        backupRunId = `brun_${crypto.randomBytes(10).toString('hex')}`;
        params.runId = backupRunId;
        params.trigger = 'manual';
        if (backupHealth) backupHealth.startRun({
          runId: backupRunId, identityId: backupIdentityId, domain: params.domain,
          trigger: 'manual', operationRecordId: action.id,
          requestedComponents: params.parts || [], workerId: runId,
        });
      }
      if (operation.id === 'database.import') {
        const upload = readDump(userId, params.uploadId);
        params.sql = upload.sql;
      }
      // The archive the plan was read out of, turned from a token into a path
      // here and nowhere else. The plan carries an id; this side owns the
      // directory, so no plan can name a file on this machine and have it
      // opened. Missing is not fatal: the sites, databases and mailboxes are
      // still built and the report says the content could not be carried.
      if (operation.id === 'migrate.apply' && params.plan && params.plan.archiveId) {
        const staged = migrationArchivePath(userId, params.plan.archiveId);
        if (staged) params.archivePath = staged;
        else params.plan = { ...params.plan, archiveId: null };
      }
      const result = await engine.run(operation.capability, params, ctx);
      const data = result.data || {};
      // Run evidence belongs in the append-only backup event store. Keeping a
      // second copy inside the action body would make two histories that can
      // disagree, so it is lifted off before the action is recorded.
      const backupRunTruth = operation.id === 'backup.create' ? (data.run_truth || null) : null;
      if (operation.id === 'backup.create') delete data.run_truth;

      // Credentials that have to be shown exactly once and stored nowhere.
      // A migration generates mailbox and database passwords because an archive
      // carries hashes the new machine cannot reuse, and the owner has to be
      // able to read them or the accounts exist and nobody can sign in to them.
      // Writing them into the durable record instead would leave every migrated
      // password sitting in the action history in clear, so they are lifted off
      // the result here, before anything is recorded, and travel only in the
      // response to the run that made them.
      const deliverOnce = data.deliver_once || null;
      delete data.deliver_once;

      // The existing schedule operations are still the only write path. Their
      // verified result becomes an immutable policy version here, after the
      // machine has read the timer back. A suspended schedule is stored but not
      // armed and says verified:false with a note, so it is projected before
      // the generic verification branch returns that honest outcome.
      if (backupHealth && (operation.id === 'backup.schedule.set' || operation.id === 'backup.schedule.clear')) {
        backupHealth.recordPolicyAction({ identityId: backupIdentityId, operation: operation.id, params, result: data });
      }

      // The verification gate. `verified: true` means the handler read the
      // change back out of the thing underneath. A handler that cannot verify
      // must say why in a note, and only a reboot is allowed to be in that
      // position, because nothing inside a machine can watch it restart.
      if (data.verified !== true) {
        if (data.verified === false && data.note) {
          return actionStore.markExecuted(action.id, { ...stripSecrets(data), backend: result.backend, verified: false, unverified_reason: data.note });
        }
        throw new Error('The operation finished without confirming the change against the server, so it is not being recorded as done.');
      }
      if (onBackupOutcome && BACKUP_RUN_OPERATIONS.has(operation.id)) {
        const settled = data.offsite && data.offsite.state === 'failed';
        onBackupOutcome(settled
          ? { ok: false, accountId: backupIdentityId, domain: params.domain, stage: 'offsite', failureCode: 'OFFSITE_TRANSFER_FAILED', failureSummary: data.offsite.summary, runId: backupRunId }
          : { ok: true, accountId: backupIdentityId, domain: params.domain, runId: backupRunId });
      }
      if (backupHealth && BACKUP_RUN_OPERATIONS.has(operation.id)) {
        backupHealth.completeRun({
          identityId: backupIdentityId, operationRecordId: action.id, truth: backupRunTruth,
          fallback: {
            run_id: backupRunId, domain: params.domain, trigger: 'manual',
            started_at: actionStore.get(action.id)?.startedAt || null,
            finished_at: new Date().toISOString(), verified_at: new Date().toISOString(),
            requested_components: params.parts || [], bytes_total: data.bytes_total || 0,
            // Only the offsite operation has anything to say here. A plain
            // local backup leaves this alone, which normalises to
            // `not_configured`, so nothing claims a copy it never tried to make.
            ...(data.offsite ? { offsite: data.offsite } : {}),
          },
        });
      }
      // A verified write against an owned resource either claims it — first
      // write wins, so a create nobody else has already claimed makes this
      // organization its owner — or, for the handful of operations that
      // remove the resource outright, releases it so the name can be claimed
      // again by whoever creates it next.
      // An operation that creates one thing declares its scope and is claimed
      // below. An operation that creates many, which today means a migration,
      // hands back what it made and every one of them is claimed here. Without
      // this a migrated site belonged to nobody: the reads narrow by ownership,
      // so the person who had just moved in could not see what they moved, and
      // no meter counted it against their package afterwards either.
      for (const claim of Array.isArray(data.claims) ? data.claims : []) {
        if (!claim || !claim.kind || !claim.key || !action.metadata?.claimOrgId) continue;
        try { ownership.claim(claim.kind, claim.key, action.metadata.claimOrgId, userId); }
        catch { /* first write wins; a resource somebody else already owns stays theirs */ }
      }
      const scoped = action.metadata?.ownership;
      if (scoped) {
        if (RELEASES_OWNERSHIP.has(operation.id)) ownership.release(scoped.kind, scoped.key);
        else ownership.claim(scoped.kind, scoped.key, scoped.orgId, userId);
      }
      if (operation.id === 'database.import') discardDump(userId, params.uploadId);
      // The archive has been used and holds somebody's entire account, so it
      // goes now rather than waiting out the sweep. The same reasoning as the
      // dump above: the shortest life that still does the job.
      if (operation.id === 'migrate.apply' && params.plan && params.plan.archiveId) {
        discardMigrationArchive(userId, params.plan.archiveId);
      }
      // Installing a stack changes what this machine can do. The capability map
      // is cached, so without this the tools the install just made possible stay
      // invisible until somebody thinks to press Refresh, and the panel tells
      // the person who just installed a mail server that it has no mail server.
      if (operation.capability === 'stack.install' || operation.id === 'panel.domain.set'
        || operation.capability === 'integration.connect' || operation.capability === 'integration.disconnect') {
        try { await engine.refresh(); } catch { /* the next read rebuilds it anyway */ }
      }
      // The resource is now really created and counted by the live meters
      // (resource_owners, or mail.list/backup.list for the domain-scoped
      // ones), so the hold that reserved its headroom has done its job —
      // released rather than left to expire on its own 15-minute timer.
      if (entitlements && operation.entitlements) entitlements.releaseHolds(action.id, { reason: 'executed' });
      const recorded = actionStore.markExecuted(action.id, { ...stripSecrets(data), backend: result.backend, verified: true });
      // A credential the panel generated rather than the person typing it. The
      // assistant creates a mailbox with a password nobody chose, and without
      // this the mailbox exists and nobody can sign in to it. Built from the
      // call parameters after the record is written, so it is handed back on
      // this one response and is in nothing that is kept.
      const generated = generatedCredentials(operation, action, params);
      const once = deliverOnce || (generated.length ? generated : null);
      return once ? { ...recorded, deliver_once: once } : recorded;
    } catch (error) {
      // The panel stopped waiting. The machine did not stop working.
      //
      // Where the operation runs as a privileged oneshot, the unit writes its
      // verified result to disk when it finishes, so the row stays `executing`
      // and the reconciler's watcher settles it from that file. Nothing is
      // asserted here and no capacity is released, because nothing is over.
      //
      // Found on a 1-core box on 2026-09-25: the client's flat five-minute
      // budget expired thirty-one seconds before an apt install the privileged
      // side is allowed thirty-five minutes for. The record said the mail
      // install had failed while Postfix and Dovecot were up and serving.
      if (error.timedOut) {
        const instance = reconciler.adoptTimedOut(action, { runId });
        if (instance) {
          const pending = new Error('This is taking longer than the panel waits at the screen. It is still running on this machine, and the result will appear here by itself as soon as the machine reports it. Do not start it again yet.');
          pending.stillRunning = true;
          pending.actionId = action.id;
          pending.oneshot = instance;
          throw pending;
        }
      }
      // A failed execution never consumed the capacity it held — release it
      // rather than let it sit until the 15-minute expiry, so a failed
      // create doesn't leave the account unable to try again immediately.
      if (entitlements && operation.entitlements) entitlements.releaseHolds(action.id, { reason: 'execution failed' });
      // An offsite send that failed after the local archive was made and
      // verified is not a failed backup, it is a backup with no copy off this
      // machine. Recording it as failed would throw away the true and useful
      // fact that there is a verified artifact here to restore from, and would
      // tell the operator to go and make a backup they already have. It is
      // recorded as `partial`, which counts as a recovery point and still
      // refuses to read as healthy. The action itself still fails, because the
      // operation was asked to put a copy somewhere and did not.
      if (onBackupOutcome && error.offsite && error.keptOnDisk) {
        onBackupOutcome({
          ok: false, accountId: backupIdentityId, domain: params.domain, stage: 'offsite',
          failureCode: 'OFFSITE_TRANSFER_FAILED', failureSummary: error.offsite.summary, runId: backupRunId,
        });
      }
      if (backupHealth && error.offsite && error.keptOnDisk) {
        try {
          backupHealth.completeRun({
            identityId: backupIdentityId, operationRecordId: action.id,
            truth: { status: 'partial', offsite: error.offsite },
            fallback: {
              run_id: backupRunId, domain: params.domain, trigger: 'manual', status: 'partial',
              started_at: actionStore.get(action.id)?.startedAt || null,
              finished_at: new Date().toISOString(), verified_at: new Date().toISOString(),
              requested_components: params.parts || [],
            },
          });
        } catch (recordError) {
          log('[backup-health] a partial run could not enter its event store:', recordError.message);
        }
        actionStore.markFailed(action.id, error, error.state ? { state: error.state } : null);
        throw error;
      }
      if (onBackupOutcome && BACKUP_RUN_OPERATIONS.has(operation.id)) {
        onBackupOutcome({
          ok: false, accountId: backupIdentityId, domain: params.domain,
          stage: error.stage || 'backup', failureCode: error.failureCode || error.code || 'BACKUP_EXECUTION_FAILED',
          failureSummary: error.message, runId: backupRunId,
        });
      }
      if (backupHealth && BACKUP_RUN_OPERATIONS.has(operation.id)) {
        try {
          backupHealth.failRun({
            identityId: backupIdentityId, operationRecordId: action.id,
            truth: error.backupRun || (error.offsite ? { offsite: error.offsite } : null), runId: backupRunId,
            domain: params.domain, trigger: 'manual', error,
            failureCode: error.failureCode || error.code || null, requestedComponents: params.parts || [],
          });
        } catch (recordError) {
          log('[backup-health] a failed run could not enter its event store:', recordError.message);
        }
      }
      actionStore.markFailed(action.id, error, error.state ? { state: error.state } : null);
      throw error;
    }
  }

  // ── Downloads ────────────────────────────────────────────────────
  // A log or a dump is a stream, not a JSON body, so these hand the caller what
  // it needs to write a response and nothing else.
  async function logDownload(id, ctx = {}) {
    authorizeFileRead('log.download', { id }, ctx);
    const result = await engine.run('log.download', { id }, ctx);
    return result.data;
  }

  async function backupDownload(params, ctx = {}) {
    authorizeFileRead('backup.fetch', params, ctx);
    const result = await engine.run('backup.fetch', params, ctx);
    return result.data;
  }

  async function databaseDump(params, ctx = {}) {
    authorizeFileRead('database.dump', params, ctx);
    const result = await engine.run('database.dump', params, ctx);
    return result.data;
  }

  // ── Dump uploads, held until the import is approved ──────────────
  function acceptDumpUpload(userId, filePath, originalName) {
    if (!dumps) throw new Error('This panel has no upload area configured');
    const stat = fs.statSync(filePath);
    if (!stat.size) { safeUnlink(filePath); throw new Error('That file is empty'); }
    if (stat.size > 256 * 1024 * 1024) { safeUnlink(filePath); throw new Error('A dump larger than 256 MB has to be imported from the command line'); }
    const head = readHead(filePath, 4096);
    if (head.includes('\0')) { safeUnlink(filePath); throw new Error('That is not a text SQL dump'); }
    const uploadId = `dump_${crypto.randomBytes(8).toString('hex')}`;
    const target = path.join(dumps, `${userId}.${uploadId}.sql`);
    fs.renameSync(filePath, target);
    sweep();
    return {
      uploadId,
      filename: String(originalName || 'dump.sql').slice(0, 200),
      bytes: stat.size,
      // What the operator is about to run, in the words the file itself uses.
      creates_tables: /CREATE\s+TABLE/i.test(head),
      drops_tables: /DROP\s+(TABLE|DATABASE)/i.test(head),
      first_lines: head.split('\n').slice(0, 8).map(line => line.slice(0, 200)),
    };
  }

  function readDump(userId, uploadId) {
    if (!dumps) throw new Error('This panel has no upload area configured');
    if (!/^dump_[a-f0-9]{16}$/.test(String(uploadId || ''))) throw new Error('That upload reference is not valid');
    const target = path.join(dumps, `${userId}.${uploadId}.sql`);
    if (!fs.existsSync(target)) throw new Error('The uploaded dump is no longer here. Upload it again and re-propose the import.');
    return { sql: fs.readFileSync(target, 'utf8'), path: target };
  }

  function discardDump(userId, uploadId) {
    try { safeUnlink(path.join(dumps, `${userId}.${uploadId}.sql`)); } catch {}
  }

  // ── The archive a migration was read out of ──────────────────────
  // Kept between reading the plan and applying it, for one reason: the plan
  // describes what to build and the archive holds what to put in it, and until
  // now the read threw the archive away, so the two halves of a migration could
  // never meet. Same shape as the dump area beside it, same fifteen-minute
  // sweep, same rule that the caller passes a token and never a path.
  function stageMigrationArchive(userId, filePath, originalName) {
    if (!migrationDir) return null;
    fs.mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
    const archiveId = `mig_${crypto.randomBytes(8).toString('hex')}`;
    const target = path.join(migrationDir, `${userId}.${archiveId}`);
    fs.renameSync(filePath, target);
    fs.chmodSync(target, 0o640);
    sweepMigrations();
    return { archiveId, filename: String(originalName || 'archive').slice(0, 200), bytes: fs.statSync(target).size };
  }

  function migrationArchivePath(userId, archiveId) {
    if (!migrationDir || !/^mig_[a-f0-9]{16}$/.test(String(archiveId || ''))) return null;
    const target = path.join(migrationDir, `${userId}.${archiveId}`);
    return fs.existsSync(target) ? target : null;
  }

  function discardMigrationArchive(userId, archiveId) {
    const target = migrationArchivePath(userId, archiveId);
    if (target) safeUnlink(target);
  }

  function sweepMigrations() {
    if (!migrationDir) return;
    const cutoff = now().getTime() - UPLOAD_TTL_MS;
    for (const entry of fs.readdirSync(migrationDir)) {
      const full = path.join(migrationDir, entry);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
    }
  }

  function sweep() {
    if (!dumps) return;
    const cutoff = now().getTime() - UPLOAD_TTL_MS;
    for (const entry of fs.readdirSync(dumps)) {
      const full = path.join(dumps, entry);
      try { if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full); } catch {}
    }
  }

  // Scheduled backups run with nobody watching, and until now they left nothing
  // in the durable record: a failed 3am backup was a line in a JSON file on the
  // far side of the socket and the operator was never told. This carries those
  // runs into the record the rest of the product uses.
  //
  // The one rule that must survive every later change to this function: a
  // scheduled run is recorded as having run unattended and is NEVER recorded as
  // approved. `executionBasis` says `unattended_schedule`, `approvedBy` stays
  // null, and no approval is ever synthesised for it. A machine that can issue
  // an approval empties the word everywhere else in the product. So an operator
  // asking "what executed here that no person approved" gets the true answer by
  // reading this basis, rather than a filtered guess.
  async function ingestUnattendedRuns() {
    // Ingested exactly once, by the run id the ops side generated. The panel
    // knows what it already holds, so this is idempotent however often it runs.
    const recorded = actionStore.list({ kind: 'server_ops.backup.unattended', limit: 1000 });
    const byRunId = new Map(recorded.map(action => [action.metadata?.runId, action]).filter(([id]) => id));
    // If the action made it in and the health write did not, ask the worker for
    // that journal again. The action is reused below rather than duplicated,
    // which makes a failed projection retryable without making two audit rows.
    const seen = recorded.map(action => action.metadata?.runId).filter(runId => runId && (!backupHealth || backupHealth.getRun(runId)));
    let answer;
    try { answer = await engine.run('backup.runs.unattended', { known: seen }, {}); }
    catch (error) { return { ingested: 0, error: error.message }; }

    const runs = answer?.data?.runs || [];
    let ingested = 0;
    for (const run of runs) {
      // Belt and braces against the thing that must not happen. If a journal
      // entry ever arrives carrying an approval, it is refused rather than
      // recorded, because recording it would put a machine-issued approval into
      // the audit trail.
      if (run.approvedBy || run.approvalId || run.executionBasis !== 'unattended_schedule') continue;
      const failed = run.outcome === 'failed';
      const notStarted = run.outcome === 'not_started';
      const label = notStarted
        ? `Scheduled backup of ${run.domain} did not run`
        : failed
          ? `Scheduled backup of ${run.domain} failed`
          : `Scheduled backup of ${run.domain}`;
      try {
        // Written straight to its terminal state, because it has already
        // happened. There is deliberately no pending or approved stage for it to
        // pass through: a stage like that is an approval-shaped hole somebody
        // would eventually fill in on a machine's behalf.
        const action = byRunId.get(run.runId) || actionStore.recordUnattended({
          accountId: ownerAccountId(run.domain),
          kind: 'server_ops.backup.unattended',
          actionKey: 'backup.create',
          label,
          summary: notStarted
            ? `The schedule was due and nothing ran: ${run.reason}. Nobody approved this, and nobody was asked to.`
            : failed
              ? `Ran automatically under the ${run.schedule?.when || 'stored'} schedule and failed. Nobody approved this run, and nobody was asked to.`
              : `Ran automatically under the ${run.schedule?.when || 'stored'} schedule, archiving ${run.archived} part(s). Nobody approved this run, and nobody was asked to.`,
          outcome: run.outcome,
          error: notStarted ? run.reason : run.error,
          metadata: {
            operation: 'backup.create', group: 'backups', capability: 'backup.create',
            runId: run.runId, schedule: run.schedule || null, domain: run.domain,
          },
          result: {
            executionBasis: 'unattended_schedule', unattended: true, runId: run.runId,
            outcome: run.outcome, domain: run.domain,
            backupId: run.backupId || null, archived: run.archived ?? null, pruned: run.pruned || [],
            startedAt: run.startedAt, finishedAt: run.finishedAt,
            // Verified means the handler read its own result back, which
            // backupCreate does before returning. Carried through rather than
            // assumed here.
            ...(notStarted || failed ? {} : {
              verified: run.verified === true,
              ...(run.verified === true ? {} : { unverified_reason: 'The scheduled run did not confirm its own result.' }),
            }),
          },
        });
        if (backupHealth) {
          const common = {
            identityId: action.accountId, operationRecordId: action.id,
            truth: run.runTruth || null, runId: run.runId, domain: run.domain,
            trigger: 'schedule', requestedComponents: run.schedule?.parts || [],
          };
          if (failed || notStarted) {
            backupHealth.failRun({ ...common, error: notStarted ? run.reason : run.error, failureCode: run.failureCode || (notStarted ? 'SCHEDULE_NOT_STARTED' : null) });
          } else {
            // The offsite half of a scheduled run happens here and not on the
            // root side, because the destination's credential lives in this
            // process's encrypted binding store and the timer that made the
            // archive has no way to read it. That is the right way round: the
            // thing running unattended as root holds no secrets of anybody's.
            //
            // So the archive is already made and verified on disk, and this
            // sends that one rather than making a second. A copy that does not
            // arrive makes the run partial, exactly as it does when somebody
            // asks for an offsite backup by hand.
            let offsite = null;
            if (run.offsiteRequested && run.backupId) {
              try {
                const sent = await engine.run('capability.backup.offsite.store', {
                  domain: run.domain, backupId: run.backupId,
                }, {});
                offsite = (sent.data || {}).offsite || null;
              } catch (error) {
                offsite = error.offsite || {
                  state: 'failed', destination: null,
                  summary: error.unavailable
                    ? 'this schedule asks for an offsite copy and no destination is connected'
                    : error.message,
                  parts_stored: 0, parts_expected: null,
                };
              }
            }
            backupHealth.completeRun({
              identityId: common.identityId, operationRecordId: common.operationRecordId,
              truth: offsite ? { ...(common.truth || {}), status: offsite.state === 'failed' ? 'partial' : 'succeeded', offsite } : common.truth,
              fallback: {
                run_id: run.runId, domain: run.domain, trigger: 'schedule',
                started_at: run.startedAt, finished_at: run.finishedAt,
                verified_at: run.verified === true ? run.finishedAt : null,
                requested_components: common.requestedComponents,
                ...(offsite ? { status: offsite.state === 'failed' ? 'partial' : 'succeeded', offsite } : {}),
              },
            });
            if (onBackupOutcome) {
              onBackupOutcome(offsite && offsite.state === 'failed'
                ? { ok: false, accountId: action.accountId, domain: run.domain, stage: 'offsite', failureCode: 'OFFSITE_TRANSFER_FAILED', failureSummary: offsite.summary, runId: run.runId }
                : { ok: true, accountId: action.accountId, domain: run.domain, runId: run.runId });
            }
          }
        }
        // A scheduled run that failed outright, or never started, is the case
        // an operator most needs to hear about: nobody was watching and there
        // is no card anybody clicked.
        if (onBackupOutcome && (failed || notStarted)) {
          onBackupOutcome({
            ok: false, accountId: action.accountId, domain: run.domain,
            stage: notStarted ? 'schedule' : 'backup',
            failureCode: run.failureCode || (notStarted ? 'SCHEDULE_NOT_STARTED' : 'BACKUP_EXECUTION_FAILED'),
            failureSummary: notStarted ? run.reason : run.error, runId: run.runId,
          });
        }
        ingested += 1;
      } catch (error) {
        // One bad journal entry must not stop the rest being recorded.
        if (typeof console !== 'undefined') console.error('[server-ops] an unattended run could not be recorded:', error.message);
      }
    }
    if (backupHealth) {
      try {
        const scheduleAnswer = await engine.run('backup.schedule.status', {}, {});
        backupHealth.syncSchedules(scheduleAnswer?.data?.schedules || [], { ownerFor: ownerAccountId });
      } catch (error) {
        log('[backup-health] schedules could not be projected:', error.message);
      }
    }
    return { ingested };
  }

  // Whose record it belongs in. A backup resource is claimed when it is first
  // created, and that claim records who created it, so a scheduled run lands in
  // the same account's record as the manual ones for that domain. A domain with
  // no claim yet has nowhere better to go than unattributed, which is honest:
  // inventing an owner for it would put the run in somebody's record on a guess.
  function ownerAccountId(dom) {
    // A site's domain is the canonical claim when it exists. Prefer it over a
    // direct backup row, because an operator may have pressed the button on a
    // customer's behalf and the approval holder is not the recovery-point
    // owner.
    for (const kind of ['site', 'backup', 'mailbox']) {
      try {
        const owner = ownership.resolveOwner(kind, dom);
        if (owner?.createdBy) return owner.createdBy;
      } catch { /* try the next kind */ }
    }
    // A domain nothing has claimed still ran a backup on somebody's machine, and
    // a record filed under a name nobody can query is the same as no record.
    try { return operatorAccountId() || null; } catch { return null; }
  }

  return {
    surface,
    backupDownload, read, propose, supplySecret, execute, logDownload, databaseDump, acceptDumpUpload,
    stageMigrationArchive, migrationArchivePath, discardMigrationArchive,
    reconcile: () => reconciler.reconcile({ runId }),
    ingestUnattendedRuns,
    runId, sections: SECTIONS,
  };
}

// A proposal is shown to the owner and kept forever. Passwords go into the
// encrypted call body that executes; they never go into the readable summary.
// The rows the panel and the chat both know how to show once: what it is for,
// who it belongs to, and the secret itself. Names come off the action's own
// metadata, which was fixed when the operation was proposed, so nothing in a
// request can ask for a parameter to be read out.
function generatedCredentials(operation, action, params) {
  const names = action.metadata && Array.isArray(action.metadata.deliverOnce) ? action.metadata.deliverOnce : [];
  const who = params.account && params.domain ? `${params.account}@${params.domain}`
    : params.username || params.name || params.domain || '';
  return names
    .filter(name => typeof params[name] === 'string' && params[name])
    .map(name => ({ what: operation.label(params), label: operation.label(params), username: who, password: params[name] }));
}

// The audit summary shown on the card and kept for ever. The rule it applies
// lives in control/secrets.js, with the two other places that used to keep
// their own slightly different copy of it.
function redactParams(params) {
  return redactSecrets(params, { pattern: SECRET_PARAM });
}

// What an operation returned. A narrower rule than the one above, on purpose:
// a result carries object keys, paths and archive names under fields called
// `key` and `path`, and blanking those throws away the part of the record that
// says what actually happened.
function stripSecrets(data) {
  const copy = JSON.parse(JSON.stringify(data || {}));
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const key of Object.keys(value)) {
      if (SECRET_RESULT.test(key)) value[key] = '[protected]';
      else walk(value[key]);
    }
  };
  walk(copy);
  return copy;
}

function readHead(file, bytes) {
  const handle = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const read = fs.readSync(handle, buffer, 0, bytes, 0);
    return buffer.slice(0, read).toString('utf8');
  } finally { fs.closeSync(handle); }
}

function safeUnlink(file) { try { fs.unlinkSync(file); } catch {} }

module.exports = { createServerOpsService, SECTIONS };
