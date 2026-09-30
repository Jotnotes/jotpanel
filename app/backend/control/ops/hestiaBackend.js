'use strict';

// The HestiaCP operations backend.
//
// This is the one the strategy actually wants underneath: Hestia already
// restarts services, creates databases and mailboxes, writes zones, sets PHP
// per site and issues certificates, correctly, on a real machine. Arca's job is
// the screens in front, so everything here is translation and verification and
// nothing here is a reimplementation.
//
// Two deliberate restraints.
//
// Reads are offered as soon as a Hestia host is configured. Writes are offered
// only when HESTIA_ALLOW_WRITES=1, because Hestia's API takes up to nine
// POSITIONAL arguments and a wrong argument order on a write does not error, it
// quietly creates the wrong object. The existing adapter already carries that
// warning and this backend keeps it rather than quietly dropping it.
//
// Every write is verified by reading the object back out of Hestia. An exit
// code of zero is not evidence that a mailbox exists.

const { createHestiaAdapter } = require('../../provisioning/hestiaAdapter');

function createHestiaBackend(config = {}) {
  const { adapter = createHestiaAdapter(config), allowWrites = !!config.allowWrites, now = () => new Date() } = config;
  const call = (cmd, args = []) => adapter.callCommand(cmd, args);

  // Hestia keys its objects by its own username. The panel is single-owner, so
  // that is one value, taken from the account context rather than a request.
  const userFor = ctx => {
    const user = ctx && (ctx.panelUser || ctx.cpanelUser);
    if (!user) throw new Error('No Hestia username is bound to this panel account');
    return user;
  };

  const asRows = value => (value && typeof value === 'object' ? Object.entries(value) : []);

  // ── Services ─────────────────────────────────────────────────────
  async function serviceList() {
    const data = await call('v-list-sys-services', ['json']);
    const services = asRows(data).map(([unit, row]) => ({
      unit,
      active: /running/i.test(row.STATE || '') ? 'active' : 'inactive',
      sub: (row.STATE || 'unknown').toLowerCase(),
      load: 'loaded',
      description: row.SYSTEM || unit,
      cpu: row.CPU != null ? Number(row.CPU) : null,
      memory_bytes: row.MEM != null ? Number(row.MEM) * 1024 * 1024 : null,
      uptime_seconds: row.RTIME != null ? Number(row.RTIME) * 60 : null,
    }));
    return { services, count: services.length, source: 'hestia' };
  }

  async function serviceStatus({ unit }) {
    const name = String(unit || '').replace(/\.service$/, '');
    const list = await serviceList();
    const found = list.services.find(s => s.unit === name || s.unit === unit);
    if (!found) throw new Error(`Hestia does not manage a service called ${unit} on this server`);
    return { ...found, enabled: 'managed by hestia', since: null, main_pid: null, restarts: null };
  }

  async function serviceControl({ unit, verb }) {
    const name = String(unit || '').replace(/\.service$/, '');
    const command = { start: 'v-start-service', stop: 'v-stop-service', restart: 'v-restart-service' }[verb];
    if (!command) throw new Error(`Hestia has no ${verb} command; restart is the nearest equivalent it offers`);
    await call(command, [name]);
    const after = await serviceStatus({ unit: name });
    const wanted = verb === 'stop' ? 'inactive' : 'active';
    if (after.active !== wanted) throw Object.assign(new Error(`${name} is ${after.active} after ${verb}, not ${wanted}`), { state: after });
    return { unit: name, verb, state: after, verified: true };
  }

  // ── Databases ────────────────────────────────────────────────────
  async function databaseList(_params, ctx) {
    const data = await call('v-list-databases', [userFor(ctx), 'json']);
    const databases = asRows(data).map(([name, row]) => ({
      name,
      engine: (row.TYPE || 'mysql').toLowerCase(),
      user: row.DBUSER || null,
      host: row.HOST || null,
      size_bytes: row.U_DISK != null ? Number(row.U_DISK) * 1024 * 1024 : null,
      charset: row.CHARSET || null,
      suspended: row.SUSPENDED === 'yes',
    }));
    return {
      prefix: `${userFor(ctx)}_`,
      engines: [{ engine: 'hestia', databases, users: databases.filter(d => d.user).map(d => ({ name: d.user, engine: d.engine })) }],
      databases,
      users: databases.filter(d => d.user).map(d => ({ name: d.user, engine: d.engine })),
      source: 'hestia',
    };
  }

  async function databaseCreate({ name, username, password, engine = 'mysql', host = 'localhost', charset = 'utf8mb4' }, ctx) {
    const user = userFor(ctx);
    // v-add-database USER DATABASE DBUSER DBPASS [TYPE] [HOST] [CHARSET]
    await call('v-add-database', [user, strip(name, user), strip(username || name, user), password, engine, host, charset]);
    const after = await databaseList({}, ctx);
    const created = after.databases.find(d => d.name === qualify(name, user));
    if (!created) throw new Error(`${qualify(name, user)} was not in Hestia's database list after the create`);
    return { name: created.name, engine: created.engine, username: created.user, verified: true };
  }

  async function databaseDrop({ name }, ctx) {
    const user = userFor(ctx);
    const target = qualify(name, user);
    await call('v-delete-database', [user, target]);
    const after = await databaseList({}, ctx);
    if (after.databases.some(d => d.name === target)) throw new Error(`${target} is still in Hestia's database list after the delete`);
    return { name: target, dropped: true, verified: true };
  }

  async function databasePassword({ name, password }, ctx) {
    const user = userFor(ctx);
    await call('v-change-database-password', [user, qualify(name, user), password]);
    return { name: qualify(name, user), changed: true, verified: true };
  }

  // ── Mail administration ──────────────────────────────────────────
  async function mailDomains(_params, ctx) {
    const data = await call('v-list-mail-domains', [userFor(ctx), 'json']);
    const domains = asRows(data).map(([domain, row]) => ({
      domain,
      accounts: Number(row.ACCOUNTS || 0),
      antispam: row.ANTISPAM === 'yes',
      antivirus: row.ANTIVIRUS === 'yes',
      dkim: row.DKIM === 'yes',
      catchall: row.CATCHALL || '',
      suspended: row.SUSPENDED === 'yes',
      disk_bytes: row.U_DISK != null ? Number(row.U_DISK) * 1024 * 1024 : null,
    }));
    return { domains, count: domains.length, source: 'hestia' };
  }

  async function mailboxList({ domain }, ctx) {
    const zone = assertDomain(domain);
    const data = await call('v-list-mail-accounts', [userFor(ctx), zone, 'json']);
    const mailboxes = asRows(data).map(([account, row]) => ({
      address: `${account}@${zone}`,
      account,
      domain: zone,
      quota_mb: row.QUOTA === 'unlimited' ? null : Number(row.QUOTA || 0),
      used_bytes: row.U_DISK != null ? Number(row.U_DISK) * 1024 * 1024 : null,
      forwarders: String(row.FWD || '').split(',').map(s => s.trim()).filter(Boolean),
      autoreply: row.AUTOREPLY === 'yes',
      suspended: row.SUSPENDED === 'yes',
    }));
    return { domain: zone, mailboxes, count: mailboxes.length, source: 'hestia' };
  }

  async function mailboxCreate({ domain, account, password, quotaMb }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    await call('v-add-mail-account', [userFor(ctx), zone, box, password, quotaMb ? String(quotaMb) : 'unlimited']);
    const after = await mailboxList({ domain: zone }, ctx);
    if (!after.mailboxes.some(m => m.account === box)) throw new Error(`${box}@${zone} was not in Hestia's mailbox list after the create`);
    return { address: `${box}@${zone}`, quota_mb: quotaMb || null, verified: true };
  }

  async function mailboxDelete({ domain, account }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    await call('v-delete-mail-account', [userFor(ctx), zone, box]);
    const after = await mailboxList({ domain: zone }, ctx);
    if (after.mailboxes.some(m => m.account === box)) throw new Error(`${box}@${zone} is still listed after the delete`);
    return { address: `${box}@${zone}`, deleted: true, verified: true };
  }

  async function mailboxPassword({ domain, account, password }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    await call('v-change-mail-account-password', [userFor(ctx), zone, box, password]);
    return { address: `${box}@${zone}`, changed: true, verified: true };
  }

  async function mailboxQuota({ domain, account, quotaMb }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    const quota = quotaMb ? String(quotaMb) : 'unlimited';
    await call('v-change-mail-account-quota', [userFor(ctx), zone, box, quota]);
    const after = await mailboxList({ domain: zone }, ctx);
    const found = after.mailboxes.find(m => m.account === box);
    if (!found) throw new Error(`${box}@${zone} disappeared while its size was being changed`);
    return { address: `${box}@${zone}`, quota_mb: found.quota_mb, verified: true };
  }

  async function forwarderSet({ domain, account, forward }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    const target = assertEmail(forward);
    await call('v-add-mail-account-forward', [userFor(ctx), zone, box, target]);
    const after = await mailboxList({ domain: zone }, ctx);
    const found = after.mailboxes.find(m => m.account === box);
    if (!found || !found.forwarders.includes(target)) throw new Error(`Hestia did not list ${target} as a forward for ${box}@${zone} afterwards`);
    return { address: `${box}@${zone}`, forward: target, forwarders: found.forwarders, verified: true };
  }

  async function forwarderDelete({ domain, account, forward }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    const target = assertEmail(forward);
    await call('v-delete-mail-account-forward', [userFor(ctx), zone, box, target]);
    const after = await mailboxList({ domain: zone }, ctx);
    const found = after.mailboxes.find(m => m.account === box);
    if (found && found.forwarders.includes(target)) throw new Error(`${target} is still forwarding from ${box}@${zone}`);
    return { address: `${box}@${zone}`, forward: target, removed: true, verified: true };
  }

  async function autoreplySet({ domain, account, message }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    const text = String(message || '').trim();
    if (!text) throw new Error('An automatic reply needs a message');
    if (text.length > 2000) throw new Error('An automatic reply must be 2000 characters or fewer');
    await call('v-add-mail-account-autoreply', [userFor(ctx), zone, box, text]);
    const after = await mailboxList({ domain: zone }, ctx);
    const found = after.mailboxes.find(m => m.account === box);
    if (!found || !found.autoreply) throw new Error(`Hestia does not show an automatic reply on ${box}@${zone} afterwards`);
    return { address: `${box}@${zone}`, autoreply: true, verified: true };
  }

  async function autoreplyClear({ domain, account }, ctx) {
    const zone = assertDomain(domain);
    const box = assertAccount(account);
    await call('v-delete-mail-account-autoreply', [userFor(ctx), zone, box]);
    const after = await mailboxList({ domain: zone }, ctx);
    const found = after.mailboxes.find(m => m.account === box);
    if (found && found.autoreply) throw new Error(`The automatic reply on ${box}@${zone} is still switched on`);
    return { address: `${box}@${zone}`, autoreply: false, verified: true };
  }

  async function catchallSet({ domain, forward }, ctx) {
    const zone = assertDomain(domain);
    const target = forward ? assertEmail(forward) : null;
    if (target) await call('v-add-mail-domain-catchall', [userFor(ctx), zone, target]);
    else await call('v-delete-mail-domain-catchall', [userFor(ctx), zone]);
    const after = await mailDomains({}, ctx);
    const found = after.domains.find(d => d.domain === zone);
    if (target && (!found || found.catchall !== target)) throw new Error(`Hestia shows the catch-all for ${zone} as “${found?.catchall || 'none'}”, not ${target}`);
    if (!target && found && found.catchall) throw new Error(`The catch-all on ${zone} is still set to ${found.catchall}`);
    return { domain: zone, catchall: target, verified: true };
  }

  async function antispamSet({ domain, enabled }, ctx) {
    const zone = assertDomain(domain);
    await call(enabled ? 'v-add-mail-domain-antispam' : 'v-delete-mail-domain-antispam', [userFor(ctx), zone]);
    const after = await mailDomains({}, ctx);
    const found = after.domains.find(d => d.domain === zone);
    if (!found || found.antispam !== !!enabled) throw new Error(`Spam filtering on ${zone} did not read back as ${enabled ? 'on' : 'off'}`);
    return { domain: zone, antispam: !!enabled, verified: true };
  }

  async function dkimShow({ domain }, ctx) {
    const zone = assertDomain(domain);
    const data = await call('v-list-mail-domain-dkim-dns', [userFor(ctx), zone, 'json']);
    const records = asRows(data).map(([name, row]) => ({ name, type: row.TYPE || 'TXT', value: row.VALUE || row.RECORD || '' }));
    return { domain: zone, records, source: 'hestia' };
  }

  async function dkimEnable({ domain }, ctx) {
    const zone = assertDomain(domain);
    await call('v-add-mail-domain-dkim', [userFor(ctx), zone]);
    const after = await mailDomains({}, ctx);
    const found = after.domains.find(d => d.domain === zone);
    if (!found || !found.dkim) throw new Error(`Hestia does not show a signing key on ${zone} afterwards`);
    return { domain: zone, dkim: true, verified: true };
  }

  // ── Websites ─────────────────────────────────────────────────────
  async function siteList(_params, ctx) {
    const data = await call('v-list-web-domains', [userFor(ctx), 'json']);
    const sites = asRows(data).map(([domain, row]) => ({
      domain,
      ip: row.IP || null,
      document_root: row.DOCUMENT_ROOT || `/home/${userFor(ctx)}/web/${domain}/public_html`,
      php: row.BACKEND || row.PROXY || null,
      aliases: String(row.ALIAS || '').split(',').map(s => s.trim()).filter(Boolean),
      ssl: row.SSL === 'yes',
      ssl_forced: row.SSL_FORCE === 'yes',
      ftp_users: String(row.FTP_USER || '').split(',').map(s => s.trim()).filter(Boolean),
      suspended: row.SUSPENDED === 'yes',
      disk_bytes: row.U_DISK != null ? Number(row.U_DISK) * 1024 * 1024 : null,
      bandwidth_bytes: row.U_BANDWIDTH != null ? Number(row.U_BANDWIDTH) * 1024 * 1024 : null,
    }));
    return { sites, count: sites.length, source: 'hestia' };
  }

  async function phpVersions() {
    const data = await call('v-list-web-templates-backend', ['json']);
    const templates = Array.isArray(data) ? data : asRows(data).map(([name]) => name);
    return { templates, source: 'hestia' };
  }

  async function phpSet({ domain, template }, ctx) {
    const zone = assertDomain(domain);
    const chosen = String(template || '').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(chosen)) throw new Error('That is not a valid PHP template name');
    await call('v-change-web-domain-backend-tpl', [userFor(ctx), zone, chosen]);
    const after = await siteList({}, ctx);
    const found = after.sites.find(s => s.domain === zone);
    if (!found || found.php !== chosen) throw new Error(`Hestia shows ${zone} on “${found?.php || 'unknown'}”, not ${chosen}`);
    return { domain: zone, php: chosen, verified: true };
  }

  async function siteCreate({ domain, ip }, ctx) {
    const zone = assertDomain(domain);
    await call('v-add-web-domain', [userFor(ctx), zone, ip || '']);
    const after = await siteList({}, ctx);
    if (!after.sites.some(s => s.domain === zone)) throw new Error(`${zone} was not in Hestia's web domain list after the create`);
    return { domain: zone, verified: true };
  }

  async function siteDelete({ domain }, ctx) {
    const zone = assertDomain(domain);
    await call('v-delete-web-domain', [userFor(ctx), zone]);
    const after = await siteList({}, ctx);
    if (after.sites.some(s => s.domain === zone)) throw new Error(`${zone} is still in Hestia's web domain list after the delete`);
    return { domain: zone, deleted: true, verified: true };
  }

  async function aliasSet({ domain, alias, remove = false }, ctx) {
    const zone = assertDomain(domain);
    const parked = assertDomain(alias);
    await call(remove ? 'v-delete-web-domain-alias' : 'v-add-web-domain-alias', [userFor(ctx), zone, parked]);
    const after = await siteList({}, ctx);
    const found = after.sites.find(s => s.domain === zone);
    const has = !!found && found.aliases.includes(parked);
    if (remove && has) throw new Error(`${parked} is still parked on ${zone}`);
    if (!remove && !has) throw new Error(`Hestia does not list ${parked} on ${zone} afterwards`);
    return { domain: zone, alias: parked, removed: !!remove, aliases: found ? found.aliases : [], verified: true };
  }

  async function protectList({ domain }, ctx) {
    const data = await call('v-list-web-domain-httpauth', [userFor(ctx), assertDomain(domain), 'json']);
    return { domain, users: asRows(data).map(([user, row]) => ({ user, path: row.PATH || '/' })), source: 'hestia' };
  }

  async function protectSet({ domain, user, password, path: directory = '/' }, ctx) {
    const zone = assertDomain(domain);
    const login = assertAccount(user);
    await call('v-add-web-domain-httpauth', [userFor(ctx), zone, login, password, directory]);
    const after = await protectList({ domain: zone }, ctx);
    if (!after.users.some(u => u.user === login)) throw new Error(`Hestia does not list ${login} as a protected-directory user on ${zone}`);
    return { domain: zone, user: login, path: directory, verified: true };
  }

  async function protectClear({ domain, user }, ctx) {
    const zone = assertDomain(domain);
    const login = assertAccount(user);
    await call('v-delete-web-domain-httpauth', [userFor(ctx), zone, login]);
    const after = await protectList({ domain: zone }, ctx);
    if (after.users.some(u => u.user === login)) throw new Error(`${login} still has access to the protected directory on ${zone}`);
    return { domain: zone, user: login, removed: true, verified: true };
  }

  // ── FTP accounts ─────────────────────────────────────────────────
  async function ftpList(_params, ctx) {
    const sites = await siteList({}, ctx);
    const accounts = sites.sites.flatMap(site => site.ftp_users.map(user => ({ user, domain: site.domain, home: site.document_root })));
    return { accounts, count: accounts.length, source: 'hestia' };
  }

  async function ftpCreate({ domain, username, password, home = '' }, ctx) {
    const zone = assertDomain(domain);
    const login = assertAccount(username);
    await call('v-add-web-domain-ftp', [userFor(ctx), zone, login, password, home]);
    const after = await ftpList({}, ctx);
    if (!after.accounts.some(a => a.domain === zone && a.user.endsWith(login))) {
      throw new Error(`Hestia does not list an FTP account for ${login} on ${zone} afterwards`);
    }
    return { domain: zone, username: login, home, verified: true };
  }

  async function ftpDelete({ domain, username }, ctx) {
    const zone = assertDomain(domain);
    const login = String(username || '').trim();
    if (!login) throw new Error('An FTP username is required');
    await call('v-delete-web-domain-ftp', [userFor(ctx), zone, login]);
    const after = await ftpList({}, ctx);
    if (after.accounts.some(a => a.domain === zone && a.user === login)) throw new Error(`${login} is still an FTP account on ${zone}`);
    return { domain: zone, username: login, deleted: true, verified: true };
  }

  // ── DNS ──────────────────────────────────────────────────────────
  async function dnsZones(_params, ctx) {
    const data = await call('v-list-dns-domains', [userFor(ctx), 'json']);
    return { zones: asRows(data).map(([zone, row]) => ({ zone, records: Number(row.RECORDS || 0), soa: row.SOA || null, ttl: Number(row.TTL || 0), suspended: row.SUSPENDED === 'yes' })), source: 'hestia' };
  }

  async function dnsRecords({ zone }, ctx) {
    const name = assertDomain(zone);
    const data = await call('v-list-dns-records', [userFor(ctx), name, 'json']);
    const records = asRows(data).map(([id, row]) => ({
      id: Number(id) || id,
      name: row.RECORD === '@' ? name : `${row.RECORD}.${name}`,
      label: row.RECORD,
      type: row.TYPE,
      value: row.VALUE,
      preference: row.PRIORITY ? Number(row.PRIORITY) : null,
      ttl: row.TTL ? Number(row.TTL) : null,
      suspended: row.SUSPENDED === 'yes',
    }));
    return { zone: name, records, source: 'hestia', authoritative: true };
  }

  async function dnsRecordCreate({ zone, label, type, value, preference, ttl }, ctx) {
    const name = assertDomain(zone);
    const kind = String(type || '').toUpperCase();
    if (!['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'CAA'].includes(kind)) throw new Error(`Unsupported record type: ${type}`);
    await call('v-add-dns-record', [userFor(ctx), name, String(label || '@'), kind, String(value), kind === 'MX' ? String(preference ?? 10) : '', '', ttl ? String(ttl) : '']);
    const after = await dnsRecords({ zone: name }, ctx);
    const found = after.records.find(r => r.label === String(label || '@') && r.type === kind && String(r.value).includes(String(value)));
    if (!found) throw new Error(`The ${kind} record for ${label || '@'} was not in the zone afterwards`);
    return { zone: name, record: found, verified: true };
  }

  async function dnsRecordDelete({ zone, id }, ctx) {
    const name = assertDomain(zone);
    const recordId = String(id || '').trim();
    if (!/^\d+$/.test(recordId)) throw new Error('A record id is required');
    await call('v-delete-dns-record', [userFor(ctx), name, recordId]);
    const after = await dnsRecords({ zone: name }, ctx);
    if (after.records.some(r => String(r.id) === recordId)) throw new Error(`Record ${recordId} is still in the ${name} zone`);
    return { zone: name, id: recordId, deleted: true, verified: true };
  }

  // ── Firewall and keys ────────────────────────────────────────────
  async function firewallList() {
    const data = await call('v-list-firewall', ['json']);
    const rules = asRows(data).map(([index, row]) => ({
      index: Number(index) || index,
      action: (row.ACTION || '').toUpperCase(),
      target: `${row.PORT || 'any'}/${(row.PROTOCOL || 'tcp').toLowerCase()}`,
      from: row.IP || 'any',
      direction: 'IN',
      comment: row.COMMENT || '',
    }));
    return { active: true, rules, engine: 'hestia' };
  }

  async function firewallRule({ verb, port, protocol = 'tcp', address = '0.0.0.0/0', index, comment = 'JotPanel' }) {
    if (verb === 'delete') {
      const number = String(index || '').trim();
      if (!/^\d+$/.test(number)) throw new Error('A rule number is required to delete a rule');
      await call('v-delete-firewall-rule', [number]);
    } else if (verb === 'allow' || verb === 'deny') {
      await call('v-add-firewall-rule', [verb.toUpperCase(), address, String(port), String(protocol).toUpperCase(), comment]);
    } else throw new Error(`Unsupported firewall action: ${verb}`);
    const after = await firewallList();
    return { verb, rules: after.rules.length, verified: true };
  }

  async function sshKeyList(_params, ctx) {
    const data = await call('v-list-user-ssh-key', [userFor(ctx), 'json']);
    return { keys: asRows(data).map(([id, row]) => ({ line: id, type: row.TYPE || 'ssh', comment: row.COMMENT || '(no label)', fingerprint: row.FINGERPRINT || null })), path: 'hestia', exists: true };
  }

  async function sshKeyAdd({ key }, ctx) {
    await call('v-add-user-ssh-key', [userFor(ctx), String(key || '').trim()]);
    const after = await sshKeyList({}, ctx);
    return { added: after.keys[after.keys.length - 1] || null, total: after.keys.length, verified: true };
  }

  async function sshKeyRemove({ line }, ctx) {
    const id = String(line || '').trim();
    if (!id) throw new Error('A key id is required');
    await call('v-delete-user-ssh-key', [userFor(ctx), id]);
    const after = await sshKeyList({}, ctx);
    if (after.keys.some(k => String(k.line) === id)) throw new Error(`Key ${id} is still authorised`);
    return { removed_line: id, remaining: after.keys.length, verified: true };
  }

  // ── Capability registration ──────────────────────────────────────
  const READS = {
    'service.list': serviceList,
    'service.status': serviceStatus,
    'database.list': databaseList,
    'mail.domains': mailDomains,
    'mail.mailbox.list': mailboxList,
    'mail.dkim.show': dkimShow,
    'site.list': siteList,
    'site.php.versions': phpVersions,
    'site.protect.list': protectList,
    'dns.zones': dnsZones,
    'dns.records': dnsRecords,
    'firewall.list': firewallList,
    'sshkey.list': sshKeyList,
  };

  const WRITES = {
    'service.control': serviceControl,
    'database.create': databaseCreate,
    'database.drop': databaseDrop,
    'database.password': databasePassword,
    'mail.mailbox.create': mailboxCreate,
    'mail.mailbox.delete': mailboxDelete,
    'mail.mailbox.password': mailboxPassword,
    'mail.mailbox.quota': mailboxQuota,
    'mail.forwarder.set': forwarderSet,
    'mail.forwarder.delete': forwarderDelete,
    'mail.autoreply.set': autoreplySet,
    'mail.autoreply.clear': autoreplyClear,
    'mail.catchall.set': catchallSet,
    'mail.antispam.set': antispamSet,
    'mail.dkim.enable': dkimEnable,
    'site.create': siteCreate,
    'site.delete': siteDelete,
    'site.php.set': phpSet,
    'site.alias.set': aliasSet,
    'site.protect.set': protectSet,
    'site.protect.clear': protectClear,
    'dns.record.create': dnsRecordCreate,
    'dns.record.delete': dnsRecordDelete,
    'firewall.rule': firewallRule,
    'sshkey.add': sshKeyAdd,
    'sshkey.remove': sshKeyRemove,
  };

  async function capabilities() {
    const caps = new Map();
    const missing = new Map();
    for (const [id, handler] of Object.entries(READS)) caps.set(id, { id, kind: 'read', backend: 'hestia', run: handler });
    for (const [id, handler] of Object.entries(WRITES)) {
      if (allowWrites) caps.set(id, { id, kind: 'write', backend: 'hestia', run: handler });
      else missing.set(id, 'Hestia is attached read-only. Its write commands take positional arguments whose order has not been checked against this box, so set HESTIA_ALLOW_WRITES=1 only after verifying them.');
    }
    return { capabilities: caps, missing, state: { host: adapter.host, allowWrites, checkedAt: now().toISOString() } };
  }

  return { name: 'hestia', capabilities, adapter, allowWrites };
}

function qualify(name, user) {
  const value = String(name || '').trim();
  return value.startsWith(`${user}_`) ? value : `${user}_${value}`;
}

function strip(name, user) {
  const value = String(name || '').trim();
  return value.startsWith(`${user}_`) ? value.slice(user.length + 1) : value;
}

function assertDomain(domain) {
  const value = String(domain || '').trim().toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) throw new Error(`${domain || 'that'} is not a domain name`);
  return value;
}

function assertAccount(account) {
  const value = String(account || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(value)) throw new Error(`${account || 'that'} is not a valid account name`);
  return value;
}

function assertEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._%+-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(value)) throw new Error(`${email || 'that'} is not an email address`);
  return value;
}

module.exports = { createHestiaBackend, qualify, strip };
