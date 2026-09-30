'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createZip, readArchiveFile, sha256, safeArchivePath } = require('./archiveFormat');

const PACKAGE_FORMAT = 'jotpanel-account';
const LEGACY_PACKAGE_FORMAT = 'arca-account';
const PACKAGE_VERSION = 1;
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.xml', '.txt', '.md', '.php', '.py', '.rb', '.go', '.sql', '.csv', '.svg', '.yml', '.yaml', '.ini', '.conf', '.htaccess']);

function isNativeSource(source) { return source === 'jotpanel' || source === 'arca'; }

function createPortabilityService({
  db,
  actionStore,
  uploadsDir,
  importsDir,
  decryptDeploy,
  encryptDeploy,
  decryptMail,
  encryptMail,
  now = () => new Date(),
} = {}) {
  if (!db || !actionStore || !uploadsDir) throw new Error('portability service is missing required dependencies');
  const incomingDir = importsDir || path.join(path.dirname(uploadsDir), 'data', 'imports');
  fs.mkdirSync(incomingDir, { recursive: true, mode: 0o700 });

  function proposeExport(userId) {
    return actionStore.enqueue({
      accountId: userId,
      kind: 'portability.export',
      actionKey: 'export_account_package',
      label: 'Download a complete account package',
      summary: 'Package the account data, sites, files, mail settings and encrypted credentials into one verified ZIP.',
      riskLevel: 'read-only',
      requiresApproval: true,
      metadata: { passphraseRequired: true, format: `${PACKAGE_FORMAT}/v${PACKAGE_VERSION}` },
    });
  }

  function acceptImportUpload(userId, uploadedPath, originalName) {
    if (!uploadedPath || !fs.existsSync(uploadedPath)) throw new Error('Archive upload is missing');
    const id = `import_${crypto.randomBytes(10).toString('hex')}`;
    const ext = path.extname(originalName || '').slice(0, 12).replace(/[^a-z0-9.]/gi, '') || '.archive';
    const storedPath = path.join(incomingDir, `${id}${ext}`);
    fs.renameSync(uploadedPath, storedPath);
    fs.chmodSync(storedPath, 0o600);
    try {
      const inspection = inspectArchive(storedPath);
      const digest = sha256(fs.readFileSync(storedPath));
      const action = actionStore.enqueue({
        accountId: userId,
        kind: 'portability.restore',
        actionKey: 'restore_account_package',
        label: isNativeSource(inspection.source)
          ? 'Restore this JotPanel account package'
          : `Migrate this ${inspection.sourceLabel} account archive`,
        summary: inspection.summary,
        riskLevel: 'destructive',
        requiresApproval: true,
        requiresConfirmText: 'RESTORE',
        metadata: {
          archivePath: storedPath,
          archiveName: path.basename(originalName || storedPath),
          archiveSha256: digest,
          inspection,
          passphraseRequired: isNativeSource(inspection.source),
        },
      });
      return { action, inspection };
    } catch (error) {
      try { fs.unlinkSync(storedPath); } catch {}
      throw error;
    }
  }

  function inspectArchive(filePath) {
    const { format, entries } = readArchiveFile(filePath);
    const manifestBuf = entries.get('manifest.json');
    if (manifestBuf) {
      const manifest = parseJson(manifestBuf, 'manifest.json');
      if (![PACKAGE_FORMAT, LEGACY_PACKAGE_FORMAT].includes(manifest.format) || manifest.version !== PACKAGE_VERSION) {
        throw new Error(`Unsupported JotPanel package version: ${manifest.format || 'unknown'}/${manifest.version || 'unknown'}`);
      }
      verifyManifest(entries, manifest);
      const data = parseJson(requireEntry(entries, 'account/data.json'), 'account/data.json');
      return {
        source: manifest.format === LEGACY_PACKAGE_FORMAT ? 'arca' : 'jotpanel',
        sourceLabel: 'JotPanel',
        archiveFormat: format,
        packageVersion: manifest.version,
        createdAt: manifest.createdAt,
        owner: { name: data.user?.name || null, email: data.user?.email || null },
        counts: manifest.counts || {},
        contents: manifest.contents,
        warnings: [],
        summary: `Replace this account with the verified package created ${manifest.createdAt || 'at an unknown time'}. Existing account content is kept aside until the database restore commits.`,
      };
    }

    const source = detectForeignSource(entries);
    const inventory = foreignInventory(entries, source);
    return {
      source,
      sourceLabel: source === 'cpanel' ? 'cPanel' : source === 'plesk' ? 'Plesk' : 'DirectAdmin',
      archiveFormat: format,
      counts: inventory.counts,
      sample: inventory.sample,
      warnings: inventory.warnings,
      summary: `${inventory.counts.webFiles} web files can be brought into a new JotPanel site. Service-level items are reported individually and are never claimed as restored unless JotPanel can verify them.`,
    };
  }

  function executeExport(actionId, userId, passphrase) {
    const action = requireApproved(actionId, userId, 'portability.export');
    try {
      const built = buildNativePackage(userId, passphrase);
      const report = {
        ok: true,
        verified: true,
        filename: built.filename,
        sha256: sha256(built.buffer),
        bytes: built.buffer.length,
        counts: built.manifest.counts,
        contents: built.manifest.contents,
      };
      actionStore.markExecuted(action.id, report);
      return { ...built, report };
    } catch (error) {
      actionStore.markFailed(action.id, error);
      throw error;
    }
  }

  function executeRestore(actionId, userId, passphrase) {
    const action = requireApproved(actionId, userId, 'portability.restore');
    const meta = action.metadata || {};
    try {
      if (!meta.archivePath || !fs.existsSync(meta.archivePath)) throw new Error('The uploaded archive is no longer present');
      const currentDigest = sha256(fs.readFileSync(meta.archivePath));
      if (currentDigest !== meta.archiveSha256) throw new Error('The uploaded archive changed after it was approved');
      const parsed = readArchiveFile(meta.archivePath);
      const report = isNativeSource(meta.inspection?.source)
        ? restoreNative(userId, parsed.entries, passphrase)
        : restoreForeign(userId, parsed.entries, meta.inspection?.source);
      if (!report.ok) throw Object.assign(new Error('Restore did not complete'), { report });
      actionStore.markExecuted(action.id, report);
      try { fs.unlinkSync(meta.archivePath); } catch {}
      return report;
    } catch (error) {
      actionStore.markFailed(action.id, error, error.report || null);
      throw error;
    }
  }

  function buildNativePackage(userId, passphrase) {
    requirePassphrase(passphrase);
    const user = db.prepare('SELECT id,name,email,password,plan,subdomain,storage_gb,created_at FROM users WHERE id=?').get(userId);
    if (!user) throw new Error('Account not found');

    const data = snapshotAccount(db, userId);
    data.user = { ...user, id: undefined, password: undefined };
    const secrets = {
      userPasswordHash: user.password,
      deploy: data.deploy_credentials.map(row => ({ id: row.id, password: decryptDeploy(row.password || '') })),
      mail: data.mail_accounts.map(row => ({ id: row.id, password: decryptMail(row.password || '') })),
    };
    data.deploy_credentials = data.deploy_credentials.map(({ password, ...row }) => row);
    data.mail_accounts = data.mail_accounts.map(({ password, ...row }) => row);

    const payloadEntries = [];
    const missing = [];
    for (const row of data.files) {
      if (!row.disk_path || !fs.existsSync(row.disk_path)) { missing.push(`Vault file missing on disk: ${row.name} (${row.id})`); continue; }
      const name = `account/files/${safeSegment(row.id)}-${safeFilename(row.name)}`;
      const body = fs.readFileSync(row.disk_path);
      payloadEntries.push({ name, data: body });
      row.package_path = name;
      delete row.disk_path;
    }
    for (const row of data.pub_files) {
      if (!row.disk_path || !fs.existsSync(row.disk_path)) { missing.push(`Published file missing on disk: ${row.name} (${row.id})`); continue; }
      const name = `account/published/${safeSegment(row.id)}-${safeFilename(row.name)}`;
      const body = fs.readFileSync(row.disk_path);
      payloadEntries.push({ name, data: body });
      row.package_path = name;
      delete row.disk_path;
    }
    if (missing.length) {
      const error = new Error(`Package refused because ${missing.length} referenced file(s) could not be read: ${missing.join('; ')}`);
      error.failures = missing;
      throw error;
    }

    const accountJson = Buffer.from(JSON.stringify(data, null, 2));
    const secretBody = Buffer.from(JSON.stringify(secrets));
    const encryptedSecrets = sealWithPassphrase(secretBody, passphrase);
    const entries = [
      { name: 'account/data.json', data: accountJson },
      { name: 'account/secrets.enc', data: encryptedSecrets },
      ...payloadEntries,
    ];
    const contents = entries.map(entry => ({
      path: entry.name,
      bytes: entry.data.length,
      sha256: sha256(entry.data),
      kind: entry.name === 'account/secrets.enc' ? 'encrypted-secrets'
        : entry.name === 'account/data.json' ? 'account-data' : 'file',
    }));
    const manifest = {
      format: PACKAGE_FORMAT,
      version: PACKAGE_VERSION,
      createdAt: now().toISOString(),
      encrypted: { algorithm: 'aes-256-gcm', keyDerivation: 'pbkdf2-sha256', iterations: 240000 },
      owner: { name: user.name, email: user.email },
      counts: accountCounts(data),
      contents,
    };
    const zipEntries = [{ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...entries];
    const buffer = createZip(zipEntries, { date: now() });

    // A package is not successful merely because Buffer.concat returned. Read
    // it through the same parser used by restore and verify every listed hash.
    const verifyPath = path.join(incomingDir, `.verify-${crypto.randomBytes(8).toString('hex')}.zip`);
    try {
      fs.writeFileSync(verifyPath, buffer, { mode: 0o600 });
      const reread = readArchiveFile(verifyPath);
      verifyManifest(reread.entries, manifest);
    } finally {
      try { fs.unlinkSync(verifyPath); } catch {}
    }
    const stamp = now().toISOString().slice(0, 10);
    return { buffer, manifest, filename: `jotpanel-account-${stamp}.zip` };
  }

  function restoreNative(userId, entries, passphrase) {
    requirePassphrase(passphrase);
    const manifest = parseJson(requireEntry(entries, 'manifest.json'), 'manifest.json');
    verifyManifest(entries, manifest);
    const data = parseJson(requireEntry(entries, 'account/data.json'), 'account/data.json');
    const secrets = JSON.parse(openWithPassphrase(requireEntry(entries, 'account/secrets.enc'), passphrase).toString('utf8'));
    const prepared = prepareNativeRows(data, secrets, userId, entries, uploadsDir, encryptDeploy, encryptMail);
    const result = applyPreparedRestore(db, prepared, userId, uploadsDir);
    return {
      ok: true,
      verified: true,
      source: 'jotpanel',
      restoredAt: now().toISOString(),
      restored: result.restored,
      failures: [],
      warnings: result.warnings,
      message: `Restored ${result.restored.files} vault files, ${result.restored.publishedFiles} published files, ${result.restored.sites} sites, ${result.restored.mailAccounts} mail connections and ${result.restored.scheduledJobs} scheduled jobs.`,
    };
  }

  function restoreForeign(userId, entries, source) {
    const inventory = foreignInventory(entries, source);
    const report = {
      ok: true,
      verified: true,
      source,
      restoredAt: now().toISOString(),
      restored: { sites: 0, webFiles: 0, vaultArtifacts: 0 },
      failures: [],
      warnings: [...inventory.warnings],
      notRestored: [],
    };
    const website = extractForeignWebsite(entries, source);
    if (!website.files.length) {
      report.ok = false;
      report.failures.push({ item: 'website files', reason: 'No recognised document root was found in the archive.' });
      return report;
    }

    const id = randomId();
    const wsId = randomId();
    const nowIso = now().toISOString();
    const staged = [];
    const vaultRows = [];
    const siteRows = [];
    for (const file of website.files) {
      if (isTextFile(file.path, file.data)) {
        siteRows.push({ id: randomId(), name: file.relative, type: file.relative.endsWith('.html') || file.relative.endsWith('.htm') ? 'page' : 'asset', content: file.data.toString('utf8') });
      } else {
        const fid = randomId();
        const diskName = `${fid}_${safeFilename(path.posix.basename(file.relative))}`;
        staged.push({ name: diskName, data: file.data });
        vaultRows.push({ id: fid, name: `migration/${file.relative}`, size: file.data.length, mime: 'application/octet-stream', folder: 'migration' });
      }
    }

    const artifactNames = [...entries.keys()].filter(isMigrationArtifact);
    for (const name of artifactNames) {
      const fid = randomId();
      const body = entries.get(name);
      const diskName = `${fid}_${safeFilename(path.posix.basename(name))}`;
      staged.push({ name: diskName, data: body });
      vaultRows.push({ id: fid, name: `migration-artifacts/${path.posix.basename(name)}`, size: body.length, mime: 'application/octet-stream', folder: 'migration' });
      report.notRestored.push({ item: name, reason: name.endsWith('.sql') ? 'Database dump saved in Files but not imported into a database service.' : 'Configuration artifact saved in Files but not activated.' });
    }

    const stageDir = path.join(path.dirname(uploadsDir), `restore-stage-${randomId()}`);
    const copiedPaths = [];
    fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
    try {
      for (const item of staged) fs.writeFileSync(path.join(stageDir, item.name), item.data, { mode: 0o600 });
      const targetDir = path.join(uploadsDir, userId);
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      const tx = db.transaction(() => {
        db.prepare('INSERT INTO sites (id,user_id,name,domain,status,echo_context,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, userId, `${inventory.sourceLabel} migration`, website.domain || null, 'draft', JSON.stringify({ migratedFrom: source }), nowIso, nowIso);
        db.prepare('INSERT INTO workspaces (id,site_id,parent_id,name,type,sort_order,created_at) VALUES (?,?,?,?,?,?,?)')
          .run(wsId, id, null, 'Imported website', 'general', 0, nowIso);
        for (const row of siteRows) {
          const hash = sha256(Buffer.from(row.content));
          db.prepare(`INSERT INTO site_files (id,workspace_id,site_id,name,type,content,content_hash,sync_state,created_at,updated_at)
                      VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run(row.id, wsId, id, row.name, row.type, row.content, hash, 'local', nowIso, nowIso);
        }
        for (const row of vaultRows) {
          const diskName = staged.find(s => s.name.startsWith(`${row.id}_`)).name;
          const target = path.join(targetDir, diskName);
          fs.copyFileSync(path.join(stageDir, diskName), target);
          copiedPaths.push(target);
          db.prepare('INSERT INTO files (id,user_id,name,size,mime,folder,disk_path) VALUES (?,?,?,?,?,?,?)')
            .run(row.id, userId, row.name, row.size, row.mime, row.folder, target);
        }
      });
      tx();
      report.restored = { sites: 1, webFiles: siteRows.length, vaultArtifacts: vaultRows.length };
    } catch (error) {
      for (const target of copiedPaths) { try { fs.unlinkSync(target); } catch {} }
      report.ok = false;
      report.failures.push({ item: 'database restore', reason: error.message });
      return report;
    } finally {
      try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    }

    for (const mailbox of inventory.mailboxes) {
      report.notRestored.push({ item: `mailbox ${mailbox}`, reason: 'Mailbox data was detected, but the archive does not contain a reusable password. No mailbox was created.' });
    }
    for (const cert of inventory.certificates) {
      report.notRestored.push({ item: cert, reason: 'Private certificate material is never installed from a foreign archive. Request a fresh certificate after DNS is checked.' });
    }
    report.message = `Imported ${report.restored.webFiles} website files into a draft site and saved ${report.restored.vaultArtifacts} other artifacts in Files. ${report.notRestored.length} service-level item(s) are listed as not restored.`;
    return report;
  }

  function requireApproved(id, userId, kind) {
    const action = actionStore.get(id);
    if (!action || action.accountId !== userId || action.kind !== kind) throw new Error('Approved action not found');
    if (action.status !== 'approved') throw new Error(`Action ${id} must be approved before execution`);
    return action;
  }

  return { proposeExport, acceptImportUpload, inspectArchive, executeExport, executeRestore };
}

function snapshotAccount(db, userId) {
  const safeAll = (sql, ...args) => { try { return db.prepare(sql).all(...args); } catch { return []; } };
  const sites = safeAll('SELECT * FROM sites WHERE user_id=?', userId);
  const siteIds = sites.map(s => s.id);
  const bySites = (table) => !siteIds.length ? [] : safeAll(`SELECT * FROM ${table} WHERE site_id IN (${siteIds.map(() => '?').join(',')})`, ...siteIds);
  const workspaces = bySites('workspaces');
  const workspaceIds = workspaces.map(w => w.id);
  return {
    schema: PACKAGE_VERSION,
    user: null,
    settings: safeAll('SELECT * FROM settings WHERE user_id=?', userId),
    files: safeAll('SELECT * FROM files WHERE user_id=?', userId),
    journal: safeAll('SELECT * FROM journal WHERE user_id=?', userId),
    beneficiaries: safeAll('SELECT * FROM beneficiaries WHERE user_id=?', userId),
    deadmans: safeAll('SELECT * FROM deadmans WHERE user_id=?', userId),
    pub_folders: safeAll('SELECT * FROM pub_folders WHERE user_id=?', userId),
    pub_files: safeAll('SELECT * FROM pub_files WHERE user_id=?', userId),
    deploy_credentials: safeAll('SELECT * FROM deploy_credentials WHERE user_id=?', userId),
    mail_accounts: safeAll('SELECT * FROM mail_accounts WHERE user_id=?', userId),
    provisioning_accounts: safeAll('SELECT * FROM provisioning_accounts WHERE user_id=?', userId),
    sites,
    workspaces,
    site_files: !workspaceIds.length ? [] : safeAll(`SELECT * FROM site_files WHERE workspace_id IN (${workspaceIds.map(() => '?').join(',')})`, ...workspaceIds),
    site_deploy_targets: bySites('site_deploy_targets'),
    scheduled_jobs: safeAll('SELECT * FROM scheduled_jobs WHERE user_id=?', userId),
    scheduled_job_runs: safeAll('SELECT * FROM scheduled_job_runs WHERE user_id=?', userId),
    ai_usage: safeAll('SELECT * FROM ai_usage WHERE user_id=?', userId),
    audit_log: safeAll('SELECT * FROM audit_log WHERE user_id=?', userId),
    account_lifecycle: safeAll('SELECT * FROM account_lifecycle WHERE user_id=?', userId),
    web_events: safeAll('SELECT * FROM web_events WHERE user_id=?', userId),
  };
}

function accountCounts(data) {
  return {
    files: data.files.length,
    publishedFiles: data.pub_files.length,
    sites: data.sites.length,
    siteFiles: data.site_files.length,
    mailAccounts: data.mail_accounts.length,
    deployConnections: data.deploy_credentials.length,
    scheduledJobs: data.scheduled_jobs.length,
    journalEntries: data.journal.length,
  };
}

function verifyManifest(entries, manifest) {
  if (!Array.isArray(manifest.contents) || !manifest.contents.length) throw new Error('Package manifest has no contents list');
  for (const item of manifest.contents) {
    const body = requireEntry(entries, safeArchivePath(item.path));
    if (body.length !== item.bytes) throw new Error(`${item.path} size does not match its manifest`);
    if (sha256(body) !== item.sha256) throw new Error(`${item.path} failed its SHA-256 check`);
  }
}

function prepareNativeRows(data, secrets, userId, entries, uploadsDir, encryptDeploy, encryptMail) {
  const maps = {};
  const mapIds = (name, rows) => {
    const map = new Map();
    for (const row of rows || []) map.set(row.id, randomId());
    maps[name] = map;
    return map;
  };
  mapIds('files', data.files); mapIds('journal', data.journal); mapIds('beneficiaries', data.beneficiaries);
  mapIds('pub_folders', data.pub_folders); mapIds('pub_files', data.pub_files);
  mapIds('deploy_credentials', data.deploy_credentials); mapIds('mail_accounts', data.mail_accounts);
  mapIds('sites', data.sites); mapIds('workspaces', data.workspaces); mapIds('site_files', data.site_files);
  mapIds('site_deploy_targets', data.site_deploy_targets); mapIds('scheduled_jobs', data.scheduled_jobs);
  mapIds('scheduled_job_runs', data.scheduled_job_runs); mapIds('ai_usage', data.ai_usage);
  mapIds('account_lifecycle', data.account_lifecycle); mapIds('web_events', data.web_events);

  const targetDir = path.join(uploadsDir, userId);
  const diskFiles = [];
  const rows = {};
  const userRows = (items) => (items || []).map(row => ({ ...row, user_id: userId }));

  rows.settings = userRows(data.settings);
  rows.journal = userRows(data.journal).map(r => ({ ...r, id: maps.journal.get(r.id) }));
  rows.beneficiaries = userRows(data.beneficiaries).map(r => ({ ...r, id: maps.beneficiaries.get(r.id) }));
  rows.deadmans = userRows(data.deadmans);
  rows.files = userRows(data.files).map(r => {
    const id = maps.files.get(r.id);
    const diskName = `${id}_${safeFilename(r.name)}`;
    diskFiles.push({ diskName, data: requireEntry(entries, r.package_path) });
    const { package_path, ...clean } = r;
    return { ...clean, id, disk_path: path.join(targetDir, diskName) };
  });
  rows.pub_folders = userRows(data.pub_folders).map(r => ({
    ...r, id: maps.pub_folders.get(r.id), parent: r.parent ? maps.pub_folders.get(r.parent) || null : null,
  }));
  rows.pub_files = userRows(data.pub_files).map(r => {
    const id = maps.pub_files.get(r.id);
    const diskName = `${id}_${safeFilename(r.name)}`;
    diskFiles.push({ diskName, data: requireEntry(entries, r.package_path) });
    const { package_path, ...clean } = r;
    return { ...clean, id, folder: maps.pub_folders.get(r.folder) || r.folder || 'root', disk_path: path.join(targetDir, diskName) };
  });

  const deploySecrets = new Map((secrets.deploy || []).map(s => [s.id, s.password]));
  rows.deploy_credentials = userRows(data.deploy_credentials).map(r => ({
    ...r, id: maps.deploy_credentials.get(r.id), password: encryptDeploy(deploySecrets.get(r.id) || ''),
  }));
  const mailSecrets = new Map((secrets.mail || []).map(s => [s.id, s.password]));
  rows.mail_accounts = userRows(data.mail_accounts).map(r => ({
    ...r, id: maps.mail_accounts.get(r.id), password: encryptMail(mailSecrets.get(r.id) || ''),
  }));
  rows.provisioning_accounts = userRows(data.provisioning_accounts);
  rows.sites = userRows(data.sites).map(r => ({ ...r, id: maps.sites.get(r.id) }));
  rows.workspaces = (data.workspaces || []).map(r => ({
    ...r, id: maps.workspaces.get(r.id), site_id: maps.sites.get(r.site_id), parent_id: r.parent_id ? maps.workspaces.get(r.parent_id) || null : null,
  }));
  rows.site_files = (data.site_files || []).map(r => ({
    ...r, id: maps.site_files.get(r.id), workspace_id: maps.workspaces.get(r.workspace_id), site_id: maps.sites.get(r.site_id),
  }));
  rows.site_deploy_targets = (data.site_deploy_targets || []).map(r => ({
    ...r, id: maps.site_deploy_targets.get(r.id), site_id: maps.sites.get(r.site_id), credential_id: maps.deploy_credentials.get(r.credential_id),
  })).filter(r => r.site_id && r.credential_id);
  rows.scheduled_jobs = userRows(data.scheduled_jobs).map(r => ({ ...r, id: maps.scheduled_jobs.get(r.id) }));
  rows.scheduled_job_runs = userRows(data.scheduled_job_runs).map(r => ({
    ...r, id: maps.scheduled_job_runs.get(r.id), job_id: maps.scheduled_jobs.get(r.job_id),
  })).filter(r => r.job_id);
  rows.ai_usage = userRows(data.ai_usage).map(r => ({ ...r, id: maps.ai_usage.get(r.id) || randomId() }));
  // audit_log has an integer primary key, so let SQLite issue fresh ids.
  rows.audit_log = userRows(data.audit_log).map(({ id, ...r }) => r);
  rows.account_lifecycle = userRows(data.account_lifecycle).map(r => ({ ...r, id: maps.account_lifecycle.get(r.id) || randomId() }));
  rows.web_events = userRows(data.web_events).map(r => ({ ...r, id: maps.web_events.get(r.id) || randomId(), site_id: maps.sites.get(r.site_id) || null }));

  return { user: data.user || {}, passwordHash: secrets.userPasswordHash || null, rows, diskFiles };
}

function applyPreparedRestore(db, prepared, userId, uploadsDir) {
  const targetDir = path.join(uploadsDir, userId);
  const stageDir = path.join(path.dirname(uploadsDir), `restore-stage-${randomId()}`);
  const rollbackDir = path.join(path.dirname(uploadsDir), `restore-rollback-${randomId()}`);
  fs.mkdirSync(stageDir, { recursive: true, mode: 0o700 });
  for (const file of prepared.diskFiles) fs.writeFileSync(path.join(stageDir, file.diskName), file.data, { mode: 0o600 });
  let movedOld = false;
  try {
    if (fs.existsSync(targetDir)) { fs.renameSync(targetDir, rollbackDir); movedOld = true; }
    fs.renameSync(stageDir, targetDir);

    const tx = db.transaction(() => {
      deleteAccountRows(db, userId);
      if (prepared.user.name || prepared.user.email || prepared.passwordHash) {
        const current = db.prepare('SELECT name,email,password FROM users WHERE id=?').get(userId);
        db.prepare('UPDATE users SET name=?,email=?,password=?,plan=?,subdomain=?,storage_gb=? WHERE id=?')
          .run(prepared.user.name || current.name, prepared.user.email || current.email,
            prepared.passwordHash || current.password, prepared.user.plan || 'starter',
            prepared.user.subdomain || null, prepared.user.storage_gb || 10, userId);
      }
      const order = ['settings','journal','beneficiaries','deadmans','files','pub_folders','pub_files',
        'deploy_credentials','mail_accounts','provisioning_accounts','sites','workspaces','site_files',
        'site_deploy_targets','scheduled_jobs','scheduled_job_runs','ai_usage','audit_log','account_lifecycle','web_events'];
      for (const table of order) insertRows(db, table, prepared.rows[table] || []);
      verifyPreparedRestore(db, prepared, userId, targetDir);
    });
    tx();
    try { if (movedOld) fs.rmSync(rollbackDir, { recursive: true, force: true }); } catch {}
  } catch (error) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch {}
    if (movedOld) { try { fs.renameSync(rollbackDir, targetDir); } catch {} }
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
    throw error;
  }

  return {
    restored: {
      files: prepared.rows.files.length,
      publishedFiles: prepared.rows.pub_files.length,
      sites: prepared.rows.sites.length,
      siteFiles: prepared.rows.site_files.length,
      mailAccounts: prepared.rows.mail_accounts.length,
      deployConnections: prepared.rows.deploy_credentials.length,
      scheduledJobs: prepared.rows.scheduled_jobs.length,
    },
    warnings: [],
  };
}

function verifyPreparedRestore(db, prepared, userId, targetDir) {
  const count = (label, sql, args, expected) => {
    let actual;
    try { actual = db.prepare(sql).get(...args).count; }
    catch (error) {
      if (expected === 0) return;
      throw new Error(`${label} could not be verified after restore: ${error.message}`);
    }
    if (actual !== expected) throw new Error(`${label} restore verification expected ${expected}, found ${actual}`);
  };
  count('Vault files', 'SELECT COUNT(*) count FROM files WHERE user_id=?', [userId], prepared.rows.files.length);
  count('Published files', 'SELECT COUNT(*) count FROM pub_files WHERE user_id=?', [userId], prepared.rows.pub_files.length);
  count('Sites', 'SELECT COUNT(*) count FROM sites WHERE user_id=?', [userId], prepared.rows.sites.length);
  count('Site files', `SELECT COUNT(*) count FROM site_files sf JOIN sites s ON s.id=sf.site_id WHERE s.user_id=?`, [userId], prepared.rows.site_files.length);
  count('Mail connections', 'SELECT COUNT(*) count FROM mail_accounts WHERE user_id=?', [userId], prepared.rows.mail_accounts.length);
  count('Deploy connections', 'SELECT COUNT(*) count FROM deploy_credentials WHERE user_id=?', [userId], prepared.rows.deploy_credentials.length);
  count('Scheduled jobs', 'SELECT COUNT(*) count FROM scheduled_jobs WHERE user_id=?', [userId], prepared.rows.scheduled_jobs.length);

  for (const file of prepared.diskFiles) {
    const restoredPath = path.join(targetDir, file.diskName);
    if (!fs.existsSync(restoredPath)) throw new Error(`Restored file is missing after write: ${file.diskName}`);
    if (sha256(fs.readFileSync(restoredPath)) !== sha256(file.data)) throw new Error(`Restored file failed its SHA-256 check: ${file.diskName}`);
  }
}

function deleteAccountRows(db, userId) {
  const tryRun = (sql) => { try { db.prepare(sql).run(userId); } catch {} };
  // Site children first; not every historical database has foreign keys for
  // all of these tables.
  for (const table of ['site_deploy_targets','site_files','workspaces']) {
    tryRun(`DELETE FROM ${table} WHERE site_id IN (SELECT id FROM sites WHERE user_id=?)`);
  }
  for (const table of ['web_events','scheduled_job_runs','scheduled_jobs','account_lifecycle','ai_usage',
    'provisioning_accounts','mail_accounts','deploy_credentials','pub_files','pub_folders','files',
    'deadmans','beneficiaries','journal','settings','audit_log','sites']) {
    tryRun(`DELETE FROM ${table} WHERE user_id=?`);
  }
}

function insertRows(db, table, rows) {
  if (!rows.length) return;
  const allowed = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
  for (const row of rows) {
    const cols = Object.keys(row).filter(c => allowed.has(c) && row[c] !== undefined);
    if (!cols.length) continue;
    const values = cols.map(c => row[c]);
    db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...values);
  }
}

function detectForeignSource(entries) {
  const names = [...entries.keys()].map(n => n.toLowerCase());
  if (names.some(n => /(^|\/)homedir\//.test(n)) || names.some(n => /(^|\/)cp\//.test(n))) return 'cpanel';
  if (names.some(n => n.endsWith('dump.xml')) || names.some(n => /(^|\/)backup_info/.test(n)) || names.some(n => /(^|\/)httpdocs\//.test(n))) return 'plesk';
  if (names.some(n => /(^|\/)domains\/[^/]+\/public_html\//.test(n)) || names.some(n => n.endsWith('/user.conf'))) return 'directadmin';
  throw new Error('Archive is not recognised as JotPanel, cPanel, Plesk, or DirectAdmin');
}

function foreignInventory(entries, source) {
  const website = extractForeignWebsite(entries, source);
  const names = [...entries.keys()];
  const mailboxes = new Set();
  const certificates = [];
  for (const name of names) {
    const low = name.toLowerCase();
    const mail = low.match(/(?:^|\/)mail\/([^/]+)\/([^/]+)\//);
    if (mail) mailboxes.add(`${mail[2]}@${mail[1]}`);
    if (/\.(pem|key|crt|p12|pfx)$/.test(low) && /(ssl|cert|private)/.test(low)) certificates.push(name);
  }
  const artifacts = names.filter(isMigrationArtifact);
  const warnings = [];
  if (mailboxes.size) warnings.push(`${mailboxes.size} mailbox data set(s) detected. Passwords cannot be recovered from these archives, so mailboxes will be listed but not silently created.`);
  if (certificates.length) warnings.push(`${certificates.length} certificate/private-key file(s) detected. They will not be installed; JotPanel will request fresh certificates.`);
  if (artifacts.some(n => n.toLowerCase().endsWith('.sql'))) warnings.push('Database dumps will be kept in Files for review, not imported into an unknown database service.');
  return {
    sourceLabel: source === 'cpanel' ? 'cPanel' : source === 'plesk' ? 'Plesk' : 'DirectAdmin',
    counts: { entries: entries.size, webFiles: website.files.length, mailboxes: mailboxes.size, certificates: certificates.length, artifacts: artifacts.length },
    sample: website.files.slice(0, 20).map(f => f.relative),
    warnings,
    mailboxes: [...mailboxes],
    certificates,
  };
}

function extractForeignWebsite(entries, source) {
  const out = [];
  let domain = null;
  for (const [name, data] of entries) {
    const normal = name.replace(/\\/g, '/');
    let marker = null;
    let inferred = null;
    if (source === 'cpanel') marker = '/homedir/public_html/';
    if (source === 'directadmin') {
      const m = normal.match(/(?:^|\/)domains\/([^/]+)\/public_html\/(.+)$/i);
      if (m) {
        inferred = m[1];
        const relative = safeArchivePath(m[2]);
        domain = domain || inferred;
        out.push({ path: normal, relative, data });
        continue;
      }
    }
    if (source === 'plesk') {
      const lower = normal.toLowerCase();
      const idx = lower.lastIndexOf('/httpdocs/');
      if (lower.startsWith('httpdocs/')) marker = normal.slice(0, 'httpdocs/'.length);
      else if (idx >= 0) marker = normal.slice(0, idx + '/httpdocs/'.length);
    }
    let idx = marker ? normal.toLowerCase().indexOf(marker.toLowerCase()) : -1;
    if (source === 'cpanel' && idx < 0 && normal.toLowerCase().startsWith('homedir/public_html/')) { marker = 'homedir/public_html/'; idx = 0; }
    if (idx < 0) continue;
    const relative = safeArchivePath(normal.slice(idx + marker.length));
    if (!relative || relative.endsWith('/')) continue;
    domain = domain || inferred;
    out.push({ path: normal, relative, data });
  }
  return { files: out, domain };
}

function isMigrationArtifact(name) {
  const low = name.toLowerCase();
  if (/\.(pem|key|crt|p12|pfx)$/.test(low)) return false;
  return low.endsWith('.sql') || /(?:^|\/)(dns|zones?)\//.test(low) || low.endsWith('dump.xml') || low.endsWith('user.conf');
}

function isTextFile(name, data) {
  if (data.length > 6 * 1024 * 1024) return false;
  if (TEXT_EXT.has(path.extname(name).toLowerCase())) return true;
  const sample = data.subarray(0, Math.min(data.length, 4096));
  return !sample.includes(0);
}

function sealWithPassphrase(plain, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, 240000, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from('ARCASEAL1'), salt, iv, tag, body]);
}

function openWithPassphrase(sealed, passphrase) {
  if (sealed.subarray(0, 9).toString('ascii') !== 'ARCASEAL1') throw new Error('Credential envelope is not a supported sealed payload');
  try {
    const salt = sealed.subarray(9, 25);
    const iv = sealed.subarray(25, 37);
    const tag = sealed.subarray(37, 53);
    const body = sealed.subarray(53);
    const key = crypto.pbkdf2Sync(passphrase, salt, 240000, 32, 'sha256');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new Error('The package passphrase is wrong, or the encrypted credentials are damaged');
  }
}

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12) throw new Error('A package passphrase of at least 12 characters is required');
}

function parseJson(buffer, label) {
  try { return JSON.parse(buffer.toString('utf8')); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function requireEntry(entries, name) {
  const body = entries.get(name);
  if (!body) throw new Error(`Package is missing ${name}`);
  return body;
}

function safeFilename(name) {
  return String(name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 180) || 'file';
}

function safeSegment(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || randomId();
}

function randomId() {
  return crypto.randomBytes(10).toString('hex');
}

module.exports = {
  PACKAGE_FORMAT,
  PACKAGE_VERSION,
  createPortabilityService,
  sealWithPassphrase,
  openWithPassphrase,
  detectForeignSource,
  foreignInventory,
};
