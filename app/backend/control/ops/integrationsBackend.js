'use strict';

// The Integration Manager, as designed in docs/INTEGRATION_MANAGER.md.
//
// It is a backend on the existing engine rather than a system beside it, which
// is the whole point: connecting a vendor, and asking a vendor to do something,
// are writes, so they are proposed, approved, executed and read back down the
// one path everything else already uses. Nothing here re-implements approval,
// the record, or verification.
//
// Three nouns, and the middle one is the load-bearing idea.
//
//   A CAPABILITY is what somebody wants done, named in our words and never in a
//   vendor's: mail.security, dns.hosting, certificate.issuance, backup.offsite.
//
//   A PROVIDER implements capabilities. THE LOCAL MACHINE IS A PROVIDER LIKE
//   ANY OTHER. rspamd here and a cloud filter somewhere else are two providers
//   of one capability, so "install it on this box" and "use a vendor" stop
//   being two features.
//
//   A BINDING connects a capability to a provider at a scope and holds the
//   credential. It is the only thing in the system that holds a secret, the
//   secret is encrypted with the same field encryption the action record uses,
//   and no code path returns it to anybody, including the admin who typed it.

const crypto = require('crypto');
const { createDestination, joinPrefix, DESTINATION_PROVIDER_IDS } = require('./backupDestinations');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* the SMTP provider is simply absent without it */ }

// ── The capabilities ─────────────────────────────────────────────
// A fixed list. The assistant and the panel both ask for these by name, and
// nothing in a request may name a provider, so a caller cannot reach a vendor
// it was not given.
const CAPABILITIES = Object.freeze({
  'mail.security': {
    title: 'Mail security',
    blurb: 'Filter incoming mail for spam and malware.',
    operations: ['set'],
  },
  'dns.hosting': {
    title: 'DNS hosting',
    blurb: 'Hold the zone for a domain and answer for it.',
    operations: ['zone.create'],
  },
  'certificate.issuance': {
    title: 'Certificates',
    blurb: 'Issue and renew the certificate a website is served with.',
    operations: ['issue'],
  },
  'backup.offsite': {
    title: 'Offsite backups',
    blurb: 'Keep a copy of a backup somewhere that is not this machine.',
    // `retrieve` is what makes the word offsite mean anything: a destination
    // that can only be written to holds copies nobody can use. `list` is how
    // somebody recovering finds what is actually out there instead of guessing
    // at a filename.
    operations: ['store', 'list', 'retrieve'],
  },
  'email.transactional': {
    title: 'Transactional email',
    blurb: 'Send the panel\'s own mail: sign-in links, alerts, reports.',
    operations: ['send'],
  },
  'monitoring.uptime': {
    title: 'Uptime monitoring',
    blurb: 'Watch a site from outside this machine and say when it stops answering.',
    operations: ['watch'],
  },
  'storage.object': {
    title: 'Object storage',
    blurb: 'Somewhere to put files that is not this disk.',
    operations: ['put'],
  },
  'cdn.delivery': {
    title: 'Content delivery',
    blurb: 'Serve a site from more places than this one.',
    operations: ['enable'],
  },
  'domain.registration': {
    title: 'Domain registration',
    blurb: 'Register and renew domain names.',
    operations: ['register'],
  },
  'ai.completion': {
    title: 'AI',
    blurb: 'The brain behind the assistant.',
    operations: ['complete'],
  },
  'payments.charge': {
    title: 'Payments',
    blurb: 'Take money for hosting.',
    operations: ['charge'],
  },
  'identity.sso': {
    title: 'Sign-in',
    blurb: 'Let people sign in with an account they already have.',
    operations: ['authenticate'],
  },
});

// ── The providers ────────────────────────────────────────────────
//
// A manifest is data. `local` providers are the machine itself and need no
// credential; they exist so that resolution has something to resolve to and so
// that the local and remote cases are the same case.
//
// `referral` is declared here and rendered on the card wherever the provider is
// offered. Affiliate links are expected and they are fine; what is not fine is
// a recommendation that ranks on them, so ranking reads `fit` and never
// `referral`, and the disclosure is not optional.
const PROVIDERS = [
  {
    id: 'local.rspamd', name: 'This server (rspamd)', vendor: 'built in', kind: 'local',
    capabilities: ['mail.security'], billing_model: 'included, runs on this machine',
    free_tier: true, data_regions: ['this machine'], docs_url: 'https://rspamd.com/doc/',
    requires: 'antispam', local: { 'mail.security.set': 'mail.antispam.set' },
  },
  {
    id: 'local.bind', name: 'This server (BIND)', vendor: 'built in', kind: 'local',
    capabilities: ['dns.hosting'], billing_model: 'included, runs on this machine',
    free_tier: true, data_regions: ['this machine'], docs_url: 'https://bind9.readthedocs.io/',
    requires: 'dns', local: { 'dns.hosting.zone.create': 'dns.zone.create' },
  },
  {
    id: 'local.certbot', name: "This server (Let's Encrypt)", vendor: 'built in', kind: 'local',
    capabilities: ['certificate.issuance'], billing_model: 'free, rate limited by the issuer',
    free_tier: true, data_regions: ['this machine'], docs_url: 'https://letsencrypt.org/docs/',
    requires: 'certificates', local: { 'certificate.issuance.issue': 'certificate.issue' },
  },
  {
    id: 'local.disk', name: 'This server (local disk)', vendor: 'built in', kind: 'local',
    capabilities: ['backup.offsite'], billing_model: 'included, and it is not offsite',
    free_tier: true, data_regions: ['this machine'], docs_url: null,
    requires: null, local: { 'backup.offsite.store': 'backup.create' },
    caveat: 'A copy on the same machine is not an offsite backup. It is here so the capability has a floor, not because it is sufficient.',
  },
  {
    // Not a vendor, a protocol. Every host already has an SMTP server or an
    // account with somebody who does, so this connects to what they have
    // instead of asking them to sign up for something. It is also the first
    // provider that is not this machine, which is what makes the remote path
    // real rather than designed.
    id: 'smtp.generic', name: 'Any SMTP server', vendor: 'whoever you already use', kind: 'remote',
    capabilities: ['email.transactional'],
    billing_model: 'whatever your mail provider charges you, which is often nothing',
    free_tier: true, data_regions: ['wherever that server is'],
    docs_url: 'https://nodemailer.com/smtp/',
    auth: { fields: [{ name: 'url', label: 'SMTP URL or settings', example: 'smtps://user:password@mail.example.com:465, or {"host":"127.0.0.1","port":25,"ignoreTLS":true} for a relay on this machine' }] },
  },

  // ── Backup destinations ────────────────────────────────────────
  //
  // Three of them, and none is a vendor. A directory, a protocol and an API
  // shape, so the list stays short while the set of services it reaches does
  // not: one S3 adapter is S3, R2, B2, Wasabi and MinIO, and adding a preset
  // for any of those is a row of data rather than a new backend.
  //
  // `kind: 'remote'` here means "reached through an adapter and holding a
  // credential", which is the distinction the rest of this file actually turns
  // on. A directory on a mounted volume is remote in that sense even though it
  // is on this machine, the same way smtp.generic is remote when it is pointed
  // at a relay on loopback.
  {
    id: 'disk.directory', name: 'A directory on this machine', vendor: 'built in', kind: 'remote',
    capabilities: ['backup.offsite'],
    billing_model: 'whatever the volume costs you, which is often nothing',
    free_tier: true, data_regions: ['wherever that volume is'], docs_url: null,
    caveat: 'A second directory on the same disk is not offsite. A mounted volume or a network share is; the panel cannot tell which one you gave it, so that part is on you.',
    auth: { fields: [
      { name: 'directory', label: 'Directory', example: '/mnt/backups', required: true },
      { name: 'prefix', label: 'Folder inside it', example: 'jotpanel' },
    ] },
  },
  {
    id: 'sftp.generic', name: 'Any SFTP server', vendor: 'whoever you already use', kind: 'remote',
    capabilities: ['backup.offsite'],
    billing_model: 'whatever that server costs you',
    free_tier: false, data_regions: ['wherever that server is'],
    docs_url: 'https://www.openssh.com/manual.html',
    auth: { fields: [
      { name: 'host', label: 'Host', example: 'backup.example.com', required: true },
      { name: 'port', label: 'Port', example: '22' },
      { name: 'username', label: 'Username', example: 'backups', required: true },
      // Required, because a destination without one refuses to connect and
      // says so. There is deliberately no "trust it this time" option: first
      // connection is exactly when somebody already in position wins, and the
      // panel offering to skip the check would be automating that. The example
      // is the command that produces the answer, so this is a copy and paste
      // rather than a research task.
      {
        name: 'host_key_fingerprint', label: 'Host key fingerprint', required: true,
        example: 'ssh-keyscan -p 22 backup.example.com | ssh-keygen -lf - (use the SHA256:... value)',
      },
      { name: 'password', label: 'Password', secret: true },
      { name: 'private_key', label: 'Private key', secret: true, multiline: true, example: 'paste the key if there is no password' },
      { name: 'passphrase', label: 'Key passphrase', secret: true },
      { name: 'directory', label: 'Directory on that server', example: '/backups' },
      { name: 'prefix', label: 'Folder inside it', example: 'jotpanel' },
    ] },
  },
  {
    id: 's3.compatible', name: 'S3-compatible object storage', vendor: 'S3, R2, B2, Wasabi, MinIO', kind: 'remote',
    capabilities: ['backup.offsite'],
    // Written and unit tested against a fake S3 that checks the signatures the
    // specification requires, and never once run against a real bucket. Signing
    // quirks, multipart behaviour and error shapes differ enough between AWS,
    // B2 and Wasabi that passing against a fixture says little about passing
    // against any of them, and the thing at stake is whether somebody's backups
    // exist. Offering it would be the button-that-cannot-work rule broken on
    // the one screen where being wrong costs the most.
    //
    // It becomes available when it has been run against a real bucket of each
    // service we say we support. That is a morning's work with one throwaway
    // bucket and a scoped key, not a rewrite.
    available: false,
    unavailable_reason: 'Coming soon. This has not been run against a real bucket yet, and a backup destination that has only been tested against a stand-in is not one this panel will offer you.',
    billing_model: 'per gigabyte stored, and usually per gigabyte retrieved',
    free_tier: false, data_regions: ['wherever the bucket is'],
    docs_url: 'https://docs.aws.amazon.com/AmazonS3/latest/API/sig-v4-authenticating-requests.html',
    auth: { fields: [
      { name: 'endpoint', label: 'Endpoint', example: 'https://s3.us-west-004.backblazeb2.com', required: true },
      { name: 'bucket', label: 'Bucket', example: 'my-backups', required: true },
      { name: 'region', label: 'Region', example: 'us-east-1' },
      { name: 'access_key_id', label: 'Access key', secret: true, required: true },
      { name: 'secret_access_key', label: 'Secret key', secret: true, required: true },
      { name: 'prefix', label: 'Folder inside the bucket', example: 'jotpanel' },
      { name: 'path_style', label: 'Path-style addressing', example: 'true unless your provider insists otherwise' },
    ] },
  },
];

const PROVIDERS_BY_ID = new Map(PROVIDERS.map(provider => [provider.id, provider]));

// Scopes, narrowest first. This IS the resolution order: an account's own
// connection beats the reseller's, which beats the host's, which beats the
// machine. A customer who brought their own vendor account keeps using it.
const SCOPES = ['account', 'reseller', 'platform'];

// Ordering the offers. Affiliate links are expected and they are fine; a
// recommendation that ranks on them is not. So this reads fit and nothing else,
// and `referral` is not in scope in this function on purpose. If somebody ever
// wants commission to move an offer up the list, they have to delete this
// comment and the test that guards it, which is exactly the amount of friction
// that decision deserves.
function rankOffers(offers, { alreadyConnected = new Set(), region = null } = {}) {
  const fit = offer => {
    let score = 0;
    if (alreadyConnected.has(offer.id)) score += 40;       // one account, not five
    if (offer.kind === 'local') score += 20;               // no bill, no third party, no data leaving
    if (offer.free_tier) score += 10;
    if (region && (offer.data_regions || []).includes(region)) score += 10;
    return score;
  };
  return [...offers].sort((a, b) => fit(b) - fit(a) || a.name.localeCompare(b.name));
}

function createIntegrationsBackend({ db, protect = v => v, unprotect = v => v, local, now = () => new Date() } = {}) {
  if (!db) throw new Error('the integration manager needs a database');

  db.exec(`
    CREATE TABLE IF NOT EXISTS integration_bindings (
      id                   TEXT PRIMARY KEY,
      provider_id          TEXT NOT NULL,
      capability           TEXT NOT NULL,
      scope_type           TEXT NOT NULL,
      scope_id             TEXT,
      protected_credential TEXT,
      status               TEXT NOT NULL DEFAULT 'connected',
      status_reason        TEXT,
      connected_by         TEXT,
      connected_at         TEXT NOT NULL,
      last_probe_at        TEXT,
      last_probe_ok        INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_binding_scope
      ON integration_bindings (capability, scope_type, COALESCE(scope_id,''));
    CREATE TABLE IF NOT EXISTS integration_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      binding_id  TEXT NOT NULL,
      capability  TEXT NOT NULL,
      operation   TEXT NOT NULL,
      account_id  TEXT,
      at          TEXT NOT NULL,
      outcome     TEXT NOT NULL,
      detail      TEXT
    );
  `);

  const row = id => db.prepare('SELECT * FROM integration_bindings WHERE id=?').get(id);

  // The public shape of a binding. There is no code path that returns the
  // credential, so an admin who wants to know what they typed replaces it.
  //
  // `forOperator` decides how much of the rest anybody gets, and it defaults to
  // false so a caller that forgets to say leaks nothing. Found by testing the
  // tenant side of the boundary on the live box: every signed-in account could
  // read the whole binding list, which meant the binding id, who connected it,
  // the fingerprint, and `ends_with`. On a directory destination that is four
  // characters of a path. On an object store it is the last four characters of
  // the secret access key, handed to every customer on the machine.
  //
  // A tenant has a legitimate question here and it is only this: is there
  // somewhere offsite for my backups to go. That is answered by the capability
  // row. Which vendor, whose account, and what the key looks like are the
  // operator's business, and an id is not harmless either: `integration.test`
  // and `integration.disconnect` both take one as their only parameter, so
  // publishing them hands every tenant the argument for an operation they
  // should never be able to name.
  function publicBinding(record, { forOperator = false } = {}) {
    if (!record) return null;
    const provider = PROVIDERS_BY_ID.get(record.provider_id);
    if (!forOperator) {
      return {
        provider: record.provider_id,
        provider_name: provider ? provider.name : record.provider_id,
        capability: record.capability,
        status: record.status,
        // Deliberately absent: id, scope_id, connected_by, status_reason and
        // the credential projection. `status_reason` carries the far end's own
        // words, which have been observed to name a host and a path.
      };
    }
    const secret = record.protected_credential ? unprotect(record.protected_credential) : '';
    return {
      id: record.id,
      provider: record.provider_id,
      provider_name: provider ? provider.name : record.provider_id,
      capability: record.capability,
      scope: record.scope_type,
      scope_id: record.scope_id || null,
      status: record.status,
      status_reason: record.status_reason || null,
      connected_at: record.connected_at,
      connected_by: record.connected_by || null,
      last_probe_at: record.last_probe_at || null,
      last_probe_ok: record.last_probe_ok == null ? null : !!record.last_probe_ok,
      // Enough to recognise it, never enough to use it.
      credential: secret ? { fingerprint: crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12), ends_with: secret.slice(-4) } : null,
    };
  }

  // ── Resolution ───────────────────────────────────────────────────
  // A server-side function of capability and account. Nothing in a request
  // takes part in it.
  function resolve(capability, ctx = {}) {
    for (const scope of SCOPES) {
      const scopeId = scope === 'account' ? (ctx.accountId || null) : scope === 'reseller' ? (ctx.resellerId || null) : null;
      if (scope !== 'platform' && !scopeId) continue;
      const found = db.prepare(
        `SELECT * FROM integration_bindings
          WHERE capability=? AND scope_type=? AND COALESCE(scope_id,'')=? AND status='connected'`
      ).get(capability, scope, scopeId || '');
      if (found) return { binding: found, provider: PROVIDERS_BY_ID.get(found.provider_id), via: scope };
    }
    // The machine, last, and only where the machine can actually do it. This is
    // the same "permission, not presence" gate the rest of the panel uses: the
    // local provider is offered when the underlying capability is available,
    // never because a package is on disk.
    const localProvider = PROVIDERS.find(p => p.kind === 'local' && p.capabilities.includes(capability));
    if (localProvider) return { binding: null, provider: localProvider, via: 'local' };
    return { binding: null, provider: null, via: 'none' };
  }

  // ── The remote side ──────────────────────────────────────────────
  // One adapter, and the shape every other one follows: probe the credential
  // when it is connected rather than trusting it, do the work, and read back
  // what the far end said rather than assuming it took.
  // A credential is either a URL, or the same settings written as JSON for the
  // cases a URL cannot express. Connecting a host's own relay is the common one:
  // it listens on loopback with a self-signed certificate, which is fine on the
  // machine itself and which a URL has no way to say.
  function smtpSettings(credential) {
    const raw = String(credential || '').trim();
    if (!raw.startsWith('{')) return raw;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('those SMTP settings are not valid JSON'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('those SMTP settings are not a set of settings');
    return parsed;
  }

  // ── Backup destinations, as three more adapters ────────────────
  //
  // The backup engine is not touched. It already knows how to make an archive
  // and how to hand one over: `backup.create` writes it and `backup.fetch`
  // opens it for the panel to read. So storing a backup offsite is those two
  // calls followed by an upload, and the engine gains a destination rather than
  // a rewrite.
  //
  // The destination is resolved, never named by the caller. A site owner asks
  // for `backup.offsite.store` on their own domain and whichever destination
  // the operator configured answers. Nothing in the request reaches a host.
  // ── Reading a destination, which is what recovery needs ─────────
  //
  // Keys are built by `store` as `<domain>/<backup id>/<file>`, so a listing
  // groups by that rather than guessing at filenames. Nothing here parses a
  // name for meaning beyond the two path segments this panel wrote itself.
  async function listRemote(destination, params) {
    const under = params.domain ? joinPrefix(destination.prefix, String(params.domain)) : destination.prefix;
    const objects = await destination.list({ prefix: under, limit: Number(params.limit) || 500 });
    const byBackup = new Map();
    for (const object of objects) {
      const parts = String(object.key).split('/');
      const file = parts.pop();
      const id = parts.pop();
      const dom = parts.pop();
      if (!id || !dom || !file) continue;
      const key = `${dom}/${id}`;
      if (!byBackup.has(key)) byBackup.set(key, { domain: dom, id, files: [], bytes: 0, modified: object.modified || null });
      const entry = byBackup.get(key);
      entry.files.push({ key: object.key, filename: file, bytes: object.bytes });
      entry.bytes += Number(object.bytes || 0);
      if (object.modified && (!entry.modified || object.modified > entry.modified)) entry.modified = object.modified;
    }
    return {
      where: destination.describe(),
      backups: [...byBackup.values()].sort((a, b) => String(b.id).localeCompare(String(a.id))),
      verified: true,
    };
  }

  // Bringing one back so the ordinary restore can run on it.
  //
  // The panel downloads into the staging area it already uses for uploads,
  // because it cannot write to the backup store itself and should not be able
  // to. The privileged side checks every file and installs them, refusing to
  // write over a backup id that is already here. Nothing destructive happens in
  // this function at all: at the end of it there is a new backup in the local
  // store and the customer's live data has not been touched. Restoring is then
  // the same approved, confirmed operation it has always been.
  async function retrieveRemote(destination, params, ctx) {
    const listed = await listRemote(destination, { domain: params.domain, limit: 2000 });
    const found = listed.backups.find(entry => entry.id === params.id && entry.domain === params.domain);
    if (!found) throw new Error(`${params.id} is not a backup of ${params.domain} at that destination`);
    if (!found.files.length) throw new Error(`${params.id} has no files at that destination`);

    // What this panel recorded when it sent the archive, where it still has it.
    // On a rebuilt machine there is no record, and that is said rather than
    // quietly skipped, because "verified" would then mean something weaker than
    // it does everywhere else in this product.
    const expected = typeof params.expectedHashes === 'object' && params.expectedHashes ? params.expectedHashes : {};
    const staged = [];
    try {
      for (const file of found.files) {
        const reservation = (await local.run('staging.reserve', {}, ctx)).data;
        await destination.fetch({ key: file.key, targetPath: reservation.path });
        staged.push({
          staged: reservation.id, filename: file.filename,
          sha256: expected[file.filename] || null, bytes: file.bytes,
        });
      }
      const placed = (await local.run('backup.offsite.stage', {
        domain: params.domain, id: params.id, files: staged,
      }, ctx)).data;
      return {
        domain: params.domain, id: params.id, from: destination.describe(),
        files: placed.files, bytes: placed.bytes,
        hashes_checked: staged.filter(file => file.sha256).length,
        hashes_available: Object.keys(expected).length,
        verified: true,
      };
    } catch (error) {
      // Anything already downloaded is removed. A failed recovery must not
      // leave somebody's data sitting in a shared staging directory.
      for (const file of staged) {
        try { await local.run('staging.discard', { staged: file.staged }, ctx); } catch { /* best effort */ }
      }
      throw error;
    }
  }

  function destinationAdapter(providerId) {
    return {
      // Connected means proven. The probe is the full round trip: an object
      // written, read back, compared byte for byte, and removed. A credential
      // that only opens a socket is not stored as a working destination.
      async probe(credential) {
        try {
          const result = await createDestination(providerId, credential).test();
          return result.ok ? { ok: true, steps: result.steps } : { ok: false, reason: result.reason || 'that destination did not accept and return a test object' };
        } catch (error) { return { ok: false, reason: `that destination did not work: ${error.message}` }; }
      },
      async run(operation, params, credential, ctx = {}) {
        if (operation === 'list') return listRemote(createDestination(providerId, credential), params);
        if (operation === 'retrieve') return retrieveRemote(createDestination(providerId, credential), params, ctx);
        if (operation !== 'store') throw new Error(`a backup destination does not do backup.offsite.${operation}`);
        const destination = createDestination(providerId, credential);

        // 1. The engine makes the backup, exactly as it always does — unless
        //    one already exists and is being sent. A scheduled run makes its
        //    archive on the root side minutes before the panel gets to it, and
        //    making a second one to have something to upload would both waste
        //    the disk and send a copy of something nobody verified.
        const made = params.backupId
          ? await local.run('backup.list', { domain: params.domain }, ctx)
              .then(listed => {
                const found = ((listed.data || listed).backups || []).find(entry => entry.id === params.backupId);
                if (!found) throw new Error(`${params.backupId} is not a backup of ${params.domain} on this machine`);
                return { data: { id: found.id, parts: (found.parts || []).map(name => ({ part: name, file: name })) } };
              })
          : await local.run('backup.create', {
            domain: params.domain, parts: params.parts, keep: params.keep,
          }, ctx);
        const manifest = made.data || made;
        const archived = (manifest.parts || []).filter(part => part.file);
        if (!archived.length) throw new Error(`nothing was archived for ${params.domain}, so there is nothing to send`);

        // 2. Each part is fetched and sent, and each one is read back off the
        //    far end before it counts. A part that uploaded without throwing is
        //    not a part that arrived.
        const stored = [];
        const failed = [];
        for (const part of archived) {
          const name = part.database ? `${part.part}:${part.database}` : part.part;
          try {
            const file = (await local.run('backup.fetch', { domain: params.domain, id: manifest.id, part: name }, ctx)).data;
            const key = joinPrefix(destination.prefix, `${params.domain}/${manifest.id}/${file.filename}`);
            await destination.put({ sourcePath: file.path, key, bytes: file.bytes, sha256: file.sha256 });
            // `deep: true`, which is what makes the adapter read the object back
            // and hash it. Without it the adapter compares lengths and reports
            // `verified_by: 'size'`, and the caller then refuses to call the
            // operation verified, correctly. So `backup.offsite.store` could
            // never satisfy the panel's own verification gate on any machine:
            // the archive arrived, the read-back measured it, and the operation
            // reported that it had finished without confirming anything. The
            // connection test one screen away has always asked for the hash and
            // refused a destination that could not give one.
            const back = await destination.verify({ key, bytes: file.bytes, sha256: file.sha256, deep: true });
            if (!back.matches) { failed.push(`${name}: ${back.reason}`); continue; }
            stored.push({ part: name, key, bytes: back.bytes, verified_by: back.verified_by });
          } catch (error) { failed.push(`${name}: ${error.message}`); }
        }

        // 2b. The manifest goes too, or the copy is not a backup.
        //
        //     Without it the far side holds a set of archives and nothing that
        //     says what they are, which parts they were, or what they hashed
        //     to, and this machine's own copy of that is exactly what is gone
        //     in the case offsite exists for. Found by restoring one: every
        //     archive came back intact and the restore said the backup was not
        //     on this machine, because a backup without its manifest is a pile
        //     of files.
        if (!failed.length) {
          try {
            const manifestFile = (await local.run('backup.fetch', { domain: params.domain, id: manifest.id, part: 'manifest' }, ctx)).data;
            const key = joinPrefix(destination.prefix, `${params.domain}/${manifest.id}/${manifestFile.filename}`);
            await destination.put({ sourcePath: manifestFile.path, key, bytes: manifestFile.bytes, sha256: manifestFile.sha256 });
            const back = await destination.verify({ key, bytes: manifestFile.bytes, sha256: manifestFile.sha256, deep: true });
            if (!back.matches) failed.push(`manifest: ${back.reason}`);
            else stored.push({ part: 'manifest', key, bytes: back.bytes, verified_by: back.verified_by });
          } catch (error) { failed.push(`manifest: ${error.message}`); }
        }

        // 3. A partial send is not a send. The engine learned that lesson about
        //    restores and it is the same lesson here.
        //
        //    The local archive is kept either way and is fully restorable: the
        //    upload failing says nothing about the artifact on this disk, and
        //    throwing away a good backup because a network was down would be a
        //    worse bug than the one this guards. What must not happen is the
        //    run reading as healthy, and that is what `offsite` carries out to
        //    the health record.
        const where = destination.describe();
        const offsite = failed.length
          ? {
            state: 'failed',
            destination: where.where || null,
            summary: `${stored.length} of ${archived.length} parts reached the destination. ${failed.join('; ')}`,
            parts_stored: stored.length,
            parts_expected: archived.length,
          }
          : {
            state: 'succeeded',
            destination: where.where || null,
            summary: null,
            verified_at: new Date().toISOString(),
            parts_stored: stored.length,
            parts_expected: archived.length,
          };

        if (failed.length) {
          throw Object.assign(new Error(
            `${stored.length} of ${archived.length} parts of the ${params.domain} backup reached the destination, `
            + `so there is no offsite copy of this backup. The local archive ${manifest.id} was made and verified and `
            + `is still on this machine. ${failed.join('; ')}`,
          ), { offsite, backupId: manifest.id, keptOnDisk: true, failureCode: 'OFFSITE_TRANSFER_FAILED' });
        }
        // Only ever what was read back, and it says which way. A copy confirmed
        // by length alone is not called verified, deliberately: the point of a
        // read-back is that the bytes are the right bytes, and a matching size
        // is not that.
        //
        // A first attempt at this fixed the wrong end. It added a sentence
        // explaining why the copy could only be measured, so the operation could
        // be recorded as honestly-unverifiable instead of failed. That would
        // have made the red mark go away and left the defect in place: the
        // reason it could only be measured was that this code never asked for a
        // hash. The escape hatch in `serverOps` is for a reboot, because nothing
        // inside a machine can watch it restart, and an offsite copy is not in
        // that position. It can be read back, so it is.
        return {
          id: manifest.id, domain: params.domain, where,
          stored, parts: stored.length,
          verified: stored.length > 0 && stored.every(entry => entry.verified_by !== 'size'),
          verified_by: [...new Set(stored.map(entry => entry.verified_by))].join(', '),
          kept_on_disk: true,
          offsite,
        };
      },
    };
  }

  const REMOTE = {
    'disk.directory': destinationAdapter('disk.directory'),
    'sftp.generic': destinationAdapter('sftp.generic'),
    's3.compatible': destinationAdapter('s3.compatible'),
    'smtp.generic': {
      async probe(credential) {
        if (!nodemailer) return { ok: false, reason: 'this build has no SMTP library' };
        try {
          await nodemailer.createTransport(smtpSettings(credential)).verify();
          return { ok: true };
        } catch (error) { return { ok: false, reason: `that mail server did not accept the connection: ${error.message}` }; }
      },
      async run(operation, params, credential) {
        if (operation !== 'send') throw new Error(`Any SMTP server does not do email.transactional.${operation}`);
        if (!nodemailer) throw new Error('this build has no SMTP library');
        const sent = await nodemailer.createTransport(smtpSettings(credential)).sendMail({
          from: params.from, to: params.to, subject: params.subject, text: params.text || '',
        });
        // The far end names the recipients it accepted. Anything else is us
        // deciding it probably worked.
        const accepted = (sent.accepted || []).map(String);
        return {
          message_id: sent.messageId || null, accepted, rejected: sent.rejected || [],
          verified: accepted.some(address => String(address).toLowerCase() === String(params.to).toLowerCase()),
        };
      },
    },
  };

  async function localCapabilityFor(provider, capability, operation) {
    if (!provider || provider.kind !== 'local') return null;
    return provider.local[`${capability}.${operation}`] || null;
  }

  // What the panel draws. By capability, because that answers the question an
  // operator actually has: who serves this here, and for whom.
  async function view(ctx = {}) {
    // Server-side, off the signed identity, put there by opsContext. Nothing in
    // a request body reaches it, and the default is the safe one.
    const forOperator = ctx.isOperator === true;
    const capabilities = [];
    for (const [id, meta] of Object.entries(CAPABILITIES)) {
      const hit = resolve(id, ctx);
      let reason = null;
      let usable = false;
      if (hit.via === 'local') {
        const capName = await localCapabilityFor(hit.provider, id, meta.operations[0]);
        usable = capName ? await local.has(capName) : false;
        if (!usable) reason = capName ? await local.reasonFor(capName) : 'nothing on this machine serves it';
      } else if (hit.provider) {
        usable = hit.binding && hit.binding.status === 'connected';
        reason = usable ? null : (hit.binding && hit.binding.status_reason) || null;
      } else {
        reason = 'no provider is connected for this yet';
      }
      capabilities.push({
        capability: id, title: meta.title, blurb: meta.blurb,
        served_by: hit.provider ? hit.provider.id : null,
        served_by_name: hit.provider ? hit.provider.name : null,
        via: hit.via, usable, reason,
        binding: hit.binding ? publicBinding(hit.binding, { forOperator }) : null,
        // The three doors, for the screen that appears when nothing is set up.
        offers: rankOffers(PROVIDERS.filter(p => p.capabilities.includes(id)), {
          alreadyConnected: new Set(db.prepare('SELECT DISTINCT provider_id FROM integration_bindings').all().map(r => r.provider_id)),
          region: ctx.region || null,
        }).map(p => ({
          id: p.id, name: p.name, vendor: p.vendor, kind: p.kind,
          billing_model: p.billing_model, free_tier: !!p.free_tier,
          data_regions: p.data_regions, docs_url: p.docs_url || null,
          caveat: p.caveat || null,
          // Whether this can actually be chosen, and why not. Carried out to
          // the screen so it can list the thing and disable it, rather than
          // hiding it and leaving "does this panel do B2" unanswered.
          available: p.available !== false,
          unavailable_reason: p.available === false ? (p.unavailable_reason || null) : null,
          // The shape of the form, never anything anybody typed into it. A
          // provider that needs seven settings gets seven boxes instead of one
          // box and a page of documentation about what to paste into it.
          auth_fields: p.auth && Array.isArray(p.auth.fields)
            ? p.auth.fields.map(field => ({
                name: field.name, label: field.label, example: field.example || null,
                secret: !!field.secret, required: !!field.required, multiline: !!field.multiline,
              }))
            : [],
          // Declared, always shown, and never part of the ordering.
          referral: p.referral ? { present: true, disclosed_as: p.referral.disclosed_as } : { present: false },
        })),
      });
    }
    // The whole list is the operator's screen. It spans every scope, so for
    // anybody else it is not a redaction problem, it is other accounts' rows.
    const bindings = forOperator
      ? db.prepare('SELECT * FROM integration_bindings ORDER BY connected_at DESC').all().map(record => publicBinding(record, { forOperator: true }))
      : [];
    return { capabilities, bindings, providers: PROVIDERS.map(p => ({ ...p, local: undefined })) };
  }

  // ── The writes ───────────────────────────────────────────────────
  async function connect(params, ctx = {}) {
    const provider = PROVIDERS_BY_ID.get(params.provider);
    if (!provider) throw new Error(`${params.provider} is not a provider this panel knows`);
    if (!CAPABILITIES[params.capability]) throw new Error(`${params.capability} is not a capability this panel has`);
    if (!provider.capabilities.includes(params.capability)) {
      throw new Error(`${provider.name} does not do ${params.capability}`);
    }
    if (provider.kind === 'local') throw new Error('This machine serves that already and has no account to connect');
    // Refused here and not only hidden in the screen. A provider that is not
    // ready must not be reachable by anybody who knows the id, or "we do not
    // offer that yet" is a piece of styling rather than a decision.
    if (provider.available === false) throw new Error(provider.unavailable_reason || `${provider.name} is not available in this build yet`);
    // Probed before it is stored. A credential the far end rejects is a
    // refusal now, not a row that looks connected and fails the first time
    // somebody depends on it.
    const adapter = REMOTE[provider.id];
    if (!adapter) throw new Error(`${provider.name} has no adapter in this build`);
    const probe = await adapter.probe(String(params.credential || ''));
    if (!probe.ok) throw new Error(probe.reason || 'that credential was not accepted');
    const id = params.id || `bind_${crypto.randomBytes(8).toString('hex')}`;
    const at = now().toISOString();
    db.prepare(
      `INSERT INTO integration_bindings
         (id, provider_id, capability, scope_type, scope_id, protected_credential, status, connected_by, connected_at)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT (capability, scope_type, COALESCE(scope_id,'')) DO UPDATE SET
         provider_id=excluded.provider_id, protected_credential=excluded.protected_credential,
         status=excluded.status, status_reason=NULL, connected_by=excluded.connected_by, connected_at=excluded.connected_at,
         -- Replacing a connection replaces what is known about it. Found live:
         -- a directory destination was swapped for an object store at the same
         -- scope and the row kept the older one's passing test, so the panel
         -- showed a destination as proven on the strength of a test that had
         -- been run against somewhere else entirely.
         last_probe_at=NULL, last_probe_ok=NULL`
    ).run(id, provider.id, params.capability, params.scope, params.scopeId || null,
      params.credential ? protect(String(params.credential)) : null, 'connected', ctx.accountId || null, at);

    // Read it back, because a row written is not a vendor reachable. A binding
    // whose credential the vendor rejects is recorded as rejected here rather
    // than sitting in a table looking connected.
    const stored = db.prepare(
      `SELECT * FROM integration_bindings WHERE capability=? AND scope_type=? AND COALESCE(scope_id,'')=?`
    ).get(params.capability, params.scope, params.scopeId || '');
    if (!stored) throw new Error('the binding did not read back after being written');
    return { ...publicBinding(stored, { forOperator: true }), verified: true };
  }

  // Test a connection that already exists. Same round trip the probe runs at
  // connect time, run again on demand, because a destination that worked in
  // March is not a destination that works today: a key gets rotated, a bucket
  // policy changes, a disk fills, a host is rebuilt.
  //
  // The result is written to the binding, which is what `last_probe_at` and
  // `last_probe_ok` were declared for and have never held. A binding that has
  // never been tested says so rather than showing a reassuring blank.
  async function testBinding(params) {
    const stored = row(params.id);
    if (!stored) throw new Error('There is no such connection');
    const provider = PROVIDERS_BY_ID.get(stored.provider_id);
    const adapter = provider && REMOTE[stored.provider_id];
    if (!adapter) throw new Error(`${stored.provider_id} has no adapter in this build to test`);
    const credential = stored.protected_credential ? unprotect(stored.protected_credential) : '';
    const at = now().toISOString();
    const probe = await adapter.probe(credential);
    // Written before the answer is returned, and written on failure too. A
    // destination that has stopped working stops reading as connected here
    // rather than staying green until somebody needs it.
    db.prepare('UPDATE integration_bindings SET last_probe_at=?, last_probe_ok=?, status=?, status_reason=? WHERE id=?')
      .run(at, probe.ok ? 1 : 0, probe.ok ? 'connected' : 'failing', probe.ok ? null : String(probe.reason || 'the test did not pass').slice(0, 300), params.id);
    const after = row(params.id);
    if (!probe.ok) {
      const error = new Error(probe.reason || 'that destination did not pass its test');
      error.binding = publicBinding(after, { forOperator: true });
      throw error;
    }
    return {
      ...publicBinding(after, { forOperator: true }),
      steps: probe.steps || [],
      // Proven means an object went there and came back the same. Nothing else
      // in this answer is allowed to say it.
      verified: true,
    };
  }

  async function disconnect(params) {
    const stored = row(params.id);
    if (!stored) throw new Error('There is no such connection');
    db.prepare('DELETE FROM integration_bindings WHERE id=?').run(params.id);
    const after = row(params.id);
    return { id: params.id, removed: true, verified: !after };
  }

  // Route a capability to whoever serves it. The caller names a capability and
  // an operation and never a provider.
  async function route(capability, operation, params, ctx = {}) {
    const hit = resolve(capability, ctx);
    if (!hit.provider) {
      const error = new Error(`Nothing is connected for ${CAPABILITIES[capability] ? CAPABILITIES[capability].title.toLowerCase() : capability} yet`);
      error.unavailable = true;
      throw error;
    }
    const started = now().toISOString();
    try {
      let result;
      if (hit.provider.kind === 'local') {
        const capName = await localCapabilityFor(hit.provider, capability, operation);
        if (!capName) throw new Error(`${hit.provider.name} does not do ${capability}.${operation}`);
        const ran = await local.run(capName, params, ctx);
        result = ran.data || {};
      } else {
        const adapter = REMOTE[hit.provider.id];
        if (!adapter) throw new Error(`${hit.provider.name} has no adapter in this build`);
        // Opened here and nowhere else. It is not in the parameters, not in the
        // record, and not in the answer.
        const credential = hit.binding && hit.binding.protected_credential ? unprotect(hit.binding.protected_credential) : '';
        result = await adapter.run(operation, params, credential, ctx);
      }
      db.prepare('INSERT INTO integration_usage (binding_id, capability, operation, account_id, at, outcome, detail) VALUES (?,?,?,?,?,?,?)')
        .run(hit.binding ? hit.binding.id : `local:${hit.provider.id}`, capability, operation, ctx.accountId || null, started, 'ok', null);
      // The provider is part of the answer, so the record says who did it.
      return { ...result, provider: hit.provider.id, provider_name: hit.provider.name, via: hit.via };
    } catch (error) {
      db.prepare('INSERT INTO integration_usage (binding_id, capability, operation, account_id, at, outcome, detail) VALUES (?,?,?,?,?,?,?)')
        .run(hit.binding ? hit.binding.id : `local:${hit.provider.id}`, capability, operation, ctx.accountId || null, started, 'failed', String(error.message).slice(0, 300));
      throw error;
    }
  }

  // ── The engine backend ───────────────────────────────────────────
  async function capabilities() {
    const caps = new Map();
    const missing = new Map();
    const add = (id, kind, run) => caps.set(id, { id, kind, backend: 'integrations', run });

    add('integration.list', 'read', async (params, ctx) => view(ctx));
    add('integration.connect', 'write', async (params, ctx) => connect(params, ctx));
    add('integration.disconnect', 'write', async params => disconnect(params));
    add('integration.test', 'write', async params => testBinding(params));

    // One catalogue-facing capability per capability operation. Each one is a
    // normal write: proposed, approved, executed and verified by whatever ends
    // up serving it.
    // Rule 3, across the edge of the machine. A capability nothing serves is
    // not a button that fails when pressed: it is absent, with the reason
    // printed. Account-scoped resolution still happens per request; this asks
    // the wider question of whether anything anywhere serves it at all.
    const connected = new Set(db.prepare("SELECT DISTINCT capability FROM integration_bindings WHERE status='connected'").all().map(r => r.capability));
    for (const [id, meta] of Object.entries(CAPABILITIES)) {
      const localProvider = PROVIDERS.find(p => p.kind === 'local' && p.capabilities.includes(id));
      const servable = connected.has(id) || !!localProvider;
      for (const operation of meta.operations) {
        const capId = `capability.${id}.${operation}`;
        if (!servable) {
          missing.set(capId, `nothing is connected for ${meta.title.toLowerCase()} yet. Connect a provider on the Integrations screen.`);
          continue;
        }
        add(capId, 'write', async (params, ctx) => route(id, operation, params, ctx));
      }
    }
    return { capabilities: caps, missing, state: { providers: PROVIDERS.length } };
  }

  return {
    name: 'integrations',
    probe: async () => ({ available: true }),
    capabilities,
    // Exposed for the panel's own read route and for tests.
    view, resolve, connect, disconnect, testBinding, route, publicBinding,
    CAPABILITIES, PROVIDERS,
  };
}

module.exports = { createIntegrationsBackend, rankOffers, CAPABILITIES, PROVIDERS, SCOPES };
