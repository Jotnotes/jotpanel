'use strict';

/*
 * Paths are relative to the account archive root after an optional cpmove or
 * username wrapper has been removed. cPanel warns that this layout is not a
 * stable integration API, so readers accept current and older variants.
 */
const CPANEL_PATHS = Object.freeze({
  account: Object.freeze(['cp/*', 'quota', 'homedir_paths']),
  domains: Object.freeze(['userdata/**', 'addons', 'sds', 'sds2', 'pds']),
  databases: Object.freeze(['mysql/*.sql', 'mysql.sql']),
  mailboxes: Object.freeze(['homedir/etc/<domain>/passwd', 'homedir/etc/<domain>/quota', 'homedir/mail/<domain>/<account>/**']),
  forwarders: Object.freeze(['va/<domain>']),
  autoresponders: Object.freeze(['homedir/.autoresponder/**', 'va/<domain>']),
  dns: Object.freeze(['dnszones/<domain>.db']),
  cron: Object.freeze(['cron/*']),
  ftpAccounts: Object.freeze(['proftpdpasswd']),
  files: Object.freeze(['homedir/**']),
  awstats: Object.freeze(['homedir/tmp/awstats/awstatsMMYYYY.<domain>.txt']),
  webalizer: Object.freeze(['homedir/tmp/webalizer/**/webalizer.hist']),
  rawLogs: Object.freeze(['logs/**', 'homedir/access-logs/**']),
  certificates: Object.freeze(['apache_tls/**', 'sslcerts/**', 'sslkeys/**', 'homedir/ssl/**'])
});

const TOP_LEVEL = new Set([
  'authnlinks', 'apache_tls', 'bandwidth', 'bandwidth_db', 'ccs', 'counters',
  'cp', 'cron', 'customizations', 'dnssec_keys', 'dnszones', 'domainkeys',
  'homedir', 'httpfiles', 'ips', 'locale', 'logs', 'mm', 'mma', 'mms',
  'mysql', 'mysql-timestamps', 'psql', 'resellerconfig', 'resellerfeatures',
  'resellerpackages', 'ssl', 'sslcerts', 'sslkeys', 'suspended', 'suspendinfo',
  'userconfig', 'userdata', 'va', 'vad', 'vf', 'addons', 'autossl.json',
  'bandwidth_db.json', 'bandwidth_db.data.json', 'digestshadow',
  'has_sslstorage', 'homedir_paths', 'mysql.sql', 'mysql_host_notes.json',
  'nobodyfiles', 'pds', 'proftpdpasswd', 'quota', 'sds', 'sds2', 'shadow',
  'shell', 'version', 'webcalls.json', 'public_html', 'public_ftp', 'mail',
  'etc', 'tmp', '.autoresponder', '.cpanel'
]);

function emptyPlan() {
  return {
    account: {
      user: null,
      mainDomain: null,
      contactEmail: null,
      plan: null,
      quotaMb: null,
      phpVersion: null
    },
    domains: [],
    databases: [],
    dbUsers: [],
    mailboxes: [],
    forwarders: [],
    autoresponders: [],
    dns: [],
    cron: [],
    ftpAccounts: [],
    files: [],
    statistics: [],
    rawLogs: [],
    certificates: [],
    // Where things sit inside the archive as it was handed to us, wrapper and
    // all. Everything above is described by its stripped path, which is right
    // for reading and wrong for extracting: an unpacker is given the member
    // name the archive really uses. Recorded once here rather than reconstructed
    // by every caller that wants to pull bytes out afterwards.
    archive: { wrapper: null, homePrefix: null },
    warnings: [],
    unsupported: []
  };
}

function addWarning(plan, message) {
  if (message && !plan.warnings.includes(message)) plan.warnings.push(message);
}

function addUnsupported(plan, what, why) {
  if (!what || !why) return;
  if (!plan.unsupported.some(item => item.what === what && item.why === why)) {
    plan.unsupported.push({ what, why });
  }
}

function textOf(entry) {
  return entry.buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function cleanScalar(value) {
  if (value == null) return null;
  let result = String(value).trim();
  if (!result) return null;
  if ((result.startsWith('"') && result.endsWith('"')) ||
      (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1);
  }
  return result.trim() || null;
}

function safeNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function normalizeDomain(value) {
  const domain = cleanScalar(value);
  if (!domain) return null;
  const result = domain.toLowerCase().replace(/\.$/, '');
  return /^[a-z0-9_*-]+(?:\.[a-z0-9_-]+)+$/i.test(result) ? result : null;
}

function prepareEntries(input, plan) {
  if (!(input instanceof Map)) throw new TypeError('parseCpanelArchive expects a Map of archive paths to Buffers');

  const entries = [];
  const byPath = new Map();
  const wrapperUsers = [];

  for (const [rawKey, buffer] of input) {
    if (typeof rawKey !== 'string') {
      addWarning(plan, 'Refused an archive entry whose path was not a string.');
      continue;
    }
    if (!Buffer.isBuffer(buffer)) {
      addWarning(plan, 'Refused ' + JSON.stringify(rawKey) + ' because its value was not a Buffer.');
      continue;
    }

    const securityPath = rawKey.replace(/\\/g, '/');
    const securityParts = securityPath.split('/');
    if (
      securityPath.includes('\0') ||
      securityPath.startsWith('/') ||
      /^[a-z]:\//i.test(securityPath) ||
      securityPath.startsWith('//') ||
      securityParts.includes('..')
    ) {
      addWarning(plan, 'Refused hostile archive path ' + JSON.stringify(rawKey) + '.');
      continue;
    }

    const parts = securityParts.filter((part, index) => part && !(part === '.' && index === 0));
    if (!parts.length || parts.some(part => part === '..')) {
      addWarning(plan, 'Refused hostile or empty archive path ' + JSON.stringify(rawKey) + '.');
      continue;
    }

    let wrapper = null;
    if (/^cpmove-[a-z0-9][a-z0-9_-]*$/i.test(parts[0])) {
      wrapper = parts.shift();
      wrapperUsers.push(wrapper.replace(/^cpmove-/i, ''));
    } else if (parts.length > 1 && !TOP_LEVEL.has(parts[0]) && TOP_LEVEL.has(parts[1])) {
      wrapper = parts.shift();
      if (/^[a-z0-9][a-z0-9_-]*$/i.test(wrapper)) wrapperUsers.push(wrapper);
    }

    const path = parts.join('/');
    if (!path) continue;
    if (byPath.has(path)) {
      const previous = byPath.get(path);
      if (!previous.buffer.equals(buffer)) {
        addWarning(plan, 'Two archive entries normalize to ' + JSON.stringify(path) + ' with different contents; the first was kept.');
      }
      continue;
    }

    const entry = { path, rawPath: rawKey, wrapper, buffer, sizeBytes: buffer.length };
    entries.push(entry);
    byPath.set(path, entry);
  }

  addWarning(
    plan,
    'Symlink targets cannot be validated from a Map of path-to-Buffer values because archive entry types and link targets are absent; the unpacking caller must reject links that leave the tree.'
  );

  return { entries, byPath, wrapperUsers };
}

function detectArchive(entries) {
  const paths = entries.map(entry => entry.path);
  const hasCpanel = paths.some(path =>
    /^(cp|homedir|userdata|mysql|dnszones|cron|va|vf|apache_tls|sslcerts|sslkeys)\//.test(path) ||
    /^(mysql\.sql|addons|sds|sds2|pds|quota|proftpdpasswd|version)$/.test(path)
  );
  const looksPartialHome = paths.some(path =>
    /^(public_html|public_ftp|mail|etc|tmp|\.autoresponder|\.cpanel)(\/|$)/.test(path)
  );
  const pleskMarker = paths.find(path =>
    /(^|\/)(backup_info[^/]*\.xml|dump\.xml|plesk\.xml)$/i.test(path) ||
    /^domains\/[^/]+\/backup_info/i.test(path)
  );
  const directAdminMarker = paths.find(path =>
    /(^|\/)(user\.conf|backup\/user\.conf)$/i.test(path) ||
    /^domains\/[^/]+\/(domain\.conf|public_html\/)/i.test(path)
  );

  if (!hasCpanel && pleskMarker) {
    throw new Error('Not a cPanel archive: detected a Plesk archive marker at ' + pleskMarker + '.');
  }
  if (!hasCpanel && directAdminMarker) {
    throw new Error('Not a cPanel archive: detected a DirectAdmin archive marker at ' + directAdminMarker + '.');
  }
  if (!hasCpanel && !looksPartialHome) {
    throw new Error('Not a cPanel archive: no cPanel account or home-directory markers were found.');
  }
  return { partialHome: !hasCpanel && looksPartialHome };
}

function parseAssignments(text) {
  const result = Object.create(null);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([^:=\s]+)\s*[:=]\s*(.*)$/);
    if (match) result[match[1].trim().toUpperCase()] = cleanScalar(match[2]);
  }
  return result;
}

function stripYamlComment(line) {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "'" && !double) single = !single;
    else if (char === '"' && !single && line[index - 1] !== '\\') double = !double;
    else if (char === '#' && !single && !double && (index === 0 || /\s/.test(line[index - 1]))) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseLooseYaml(text) {
  const scalars = Object.create(null);
  const maps = Object.create(null);
  const lists = Object.create(null);
  let section = null;
  let sectionIndent = -1;

  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = stripYamlComment(rawLine).replace(/\s+$/, '');
    if (!withoutComment.trim() || withoutComment.trim() === '---') continue;
    const indent = withoutComment.match(/^\s*/)[0].length;
    const content = withoutComment.trim();

    if (section && indent > sectionIndent) {
      if (content.startsWith('- ')) {
        if (!lists[section]) lists[section] = [];
        const value = cleanScalar(content.slice(2));
        if (value) lists[section].push(value);
        continue;
      }
      const child = content.match(/^([^:]+):\s*(.*)$/);
      if (child) {
        if (!maps[section]) maps[section] = Object.create(null);
        maps[section][cleanScalar(child[1])] = cleanScalar(child[2]);
        continue;
      }
    }

    const match = content.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    const key = cleanScalar(match[1]);
    const value = cleanScalar(match[2]);
    if (!value) {
      section = key;
      sectionIndent = indent;
      continue;
    }

    section = null;
    sectionIndent = -1;
    if (value.startsWith('[') && value.endsWith(']')) {
      lists[key] = value.slice(1, -1).split(',').map(cleanScalar).filter(Boolean);
    } else {
      scalars[key] = value;
    }
  }
  return { scalars, maps, lists };
}

function findExact(byPath, paths) {
  for (const path of paths) {
    if (byPath.has(path)) return byPath.get(path);
  }
  return null;
}

function valuesFromList(entry) {
  if (!entry) return [];
  return textOf(entry)
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map(line => cleanScalar(line.split(/\s+/)[0]))
    .filter(Boolean);
}

function mapFromFile(entry) {
  const result = Object.create(null);
  if (!entry) return result;
  const yaml = parseLooseYaml(textOf(entry));
  for (const [key, value] of Object.entries(yaml.scalars)) result[key] = value;
  for (const [section, values] of Object.entries(yaml.maps)) {
    if (section.toLowerCase().includes('domain')) {
      for (const [key, value] of Object.entries(values)) result[key] = value;
    }
  }
  for (const rawLine of textOf(entry).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([^:=\s]+)\s*[:=]\s*(.+)$/);
    if (match) result[cleanScalar(match[1])] = cleanScalar(match[2]);
  }
  return result;
}

function chooseAccountValue(plan, label, candidates) {
  const present = candidates.filter(candidate => candidate && candidate.value != null && candidate.value !== '');
  if (!present.length) return null;
  present.sort((left, right) => right.score - left.score);
  const winner = present[0];
  for (const candidate of present.slice(1)) {
    if (String(candidate.value) !== String(winner.value)) {
      addWarning(
        plan,
        label + ' disagrees: ' + winner.source + ' says ' + JSON.stringify(winner.value) +
        ' while ' + candidate.source + ' says ' + JSON.stringify(candidate.value) +
        '; ' + winner.source + ' was preferred.'
      );
    }
  }
  return winner.value;
}

function normalizeHomePath(value, user, source, plan) {
  let path = cleanScalar(value);
  if (path == null) return null;
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (path.split('/').includes('..')) {
    addWarning(plan, 'Refused traversal in ' + source + ': ' + JSON.stringify(value) + '.');
    return null;
  }
  if (path.startsWith('/')) {
    const match = path.match(/^\/home\d*\/([^/]+)(?:\/(.*))?$/);
    if (!match) {
      addWarning(plan, 'Refused absolute path outside a cPanel home directory in ' + source + ': ' + JSON.stringify(value) + '.');
      return null;
    }
    if (user && match[1] !== user) {
      addWarning(plan, source + ' points at home directory ' + JSON.stringify(match[1]) + ' rather than account ' + JSON.stringify(user) + '; the path was refused.');
      return null;
    }
    path = match[2] || '';
  }
  path = path.replace(/^\.\/+/, '').replace(/^homedir\/+/, '').replace(/^\/+|\/+$/g, '');
  return path;
}

function buildAccount(context, plan) {
  const { entries, byPath, wrapperUsers } = context;
  const cpEntries = entries.filter(entry => /^cp\/[^/]+$/.test(entry.path)).sort((a, b) => a.path.localeCompare(b.path));
  if (cpEntries.length > 1) addWarning(plan, 'More than one cp account file was present; the first explicit account record was used.');
  const cpEntry = cpEntries[0] || null;
  const cp = cpEntry ? parseAssignments(textOf(cpEntry)) : Object.create(null);

  const basenameUser = cpEntry ? cpEntry.path.split('/').pop() : null;
  plan.account.user = chooseAccountValue(plan, 'Account username', [
    { value: cp.USER || cp.USERNAME, source: cpEntry ? cpEntry.path : 'cp account file', score: 100 },
    { value: basenameUser, source: cpEntry ? cpEntry.path + ' filename' : null, score: 70 },
    { value: wrapperUsers[0], source: 'archive wrapper directory', score: 40 }
  ]);
  if (wrapperUsers.some(user => user !== wrapperUsers[0])) {
    addWarning(plan, 'Archive entries used inconsistent wrapper directory names: ' + Array.from(new Set(wrapperUsers)).join(', ') + '.');
  }

  plan.account.contactEmail = chooseAccountValue(plan, 'Contact email', [
    { value: cp.CONTACTEMAIL, source: cpEntry ? cpEntry.path + ' CONTACTEMAIL' : null, score: 100 },
    { value: cp.CONTACTEMAIL2, source: cpEntry ? cpEntry.path + ' CONTACTEMAIL2' : null, score: 80 }
  ]);
  plan.account.plan = cp.PLAN || null;

  const quotaEntry = findExact(byPath, ['quota']);
  const quotaBytes = quotaEntry ? safeNumber(textOf(quotaEntry).trim()) : null;
  const quotaFileMb = quotaBytes == null ? null : quotaBytes / (1024 * 1024);
  const cpQuotaRaw = cp.QUOTA && !/^(unlimited|none)$/i.test(cp.QUOTA) ? safeNumber(cp.QUOTA) : null;
  plan.account.quotaMb = chooseAccountValue(plan, 'Account quota', [
    { value: quotaFileMb, source: 'quota byte file', score: 100 },
    { value: cpQuotaRaw, source: cpEntry ? cpEntry.path + ' QUOTA field (MiB)' : null, score: 70 }
  ]);
  if (cp.QUOTA && /^(unlimited|none)$/i.test(cp.QUOTA)) {
    addUnsupported(plan, 'Unlimited account quota', 'The output schema cannot distinguish an unlimited quota from an absent quota, so quotaMb is null.');
  }

  return { cp, cpEntry };
}

function buildDomains(context, accountState, plan) {
  const { entries, byPath } = context;
  const domainMap = new Map();
  const kindScore = { parked: 10, subdomain: 20, addon: 30, main: 100 };

  function fact(domainValue, field, value, source, score) {
    const domain = normalizeDomain(domainValue);
    if (!domain || value == null || value === '') return;
    if (!domainMap.has(domain)) {
      domainMap.set(domain, {
        domain,
        kind: null,
        documentRoot: null,
        phpVersion: null,
        _facts: Object.create(null)
      });
    }
    const row = domainMap.get(domain);
    const previous = row._facts[field];
    if (previous && String(previous.value) !== String(value)) {
      const winner = score > previous.score ? { value, source, score } : previous;
      const loser = winner === previous ? { value, source, score } : previous;
      addWarning(
        plan,
        domain + ' ' + field + ' disagrees: ' + winner.source + ' says ' +
        JSON.stringify(winner.value) + ' while ' + loser.source + ' says ' +
        JSON.stringify(loser.value) + '; ' + winner.source + ' was preferred.'
      );
    }
    if (!previous || score > previous.score) {
      row._facts[field] = { value, source, score };
      row[field] = value;
    }
  }

  function domainKind(domain, kind, source, score) {
    const normalized = normalizeDomain(domain);
    if (!normalized || !kind) return;
    fact(normalized, 'kind', kind, source, score + (kindScore[kind] || 0));
  }

  const mainEntries = entries.filter(entry => /^userdata\/(?:[^/]+\/)?main$/.test(entry.path));
  let userdataMain = null;
  for (const entry of mainEntries) {
    const parsed = parseLooseYaml(textOf(entry));
    if (parsed.scalars.main_domain) {
      userdataMain = { value: normalizeDomain(parsed.scalars.main_domain), source: entry.path };
      break;
    }
  }

  const cpMain = normalizeDomain(accountState.cp.DNS || accountState.cp.DOMAIN);
  const mainDomain = chooseAccountValue(plan, 'Main domain', [
    { value: userdataMain && userdataMain.value, source: userdataMain && userdataMain.source + ' main_domain', score: 100 },
    { value: cpMain, source: accountState.cpEntry ? accountState.cpEntry.path + ' DNS field' : null, score: 80 }
  ]);
  plan.account.mainDomain = mainDomain;
  if (mainDomain) domainKind(mainDomain, 'main', userdataMain ? userdataMain.source : (accountState.cpEntry ? accountState.cpEntry.path : 'account record'), 100);

  const addonsEntry = findExact(byPath, ['addons']);
  for (const domain of Object.keys(mapFromFile(addonsEntry))) domainKind(domain, 'addon', addonsEntry.path, 60);
  const subdomainsEntry = findExact(byPath, ['sds']);
  for (const domain of valuesFromList(subdomainsEntry)) domainKind(domain, 'subdomain', subdomainsEntry.path, 60);
  const parkedEntry = findExact(byPath, ['pds']);
  for (const domain of valuesFromList(parkedEntry)) domainKind(domain, 'parked', parkedEntry.path, 60);

  const sds2Entry = findExact(byPath, ['sds2']);
  for (const [domain, root] of Object.entries(mapFromFile(sds2Entry))) {
    domainKind(domain, 'subdomain', sds2Entry.path, 65);
    const normalized = normalizeHomePath(root, plan.account.user, sds2Entry.path, plan);
    if (normalized != null) fact(domain, 'documentRoot', normalized, sds2Entry.path, 65);
  }

  for (const entry of mainEntries) {
    const parsed = parseLooseYaml(textOf(entry));
    const addonMap = parsed.maps.addon_domains || Object.create(null);
    for (const domain of Object.keys(addonMap)) domainKind(domain, 'addon', entry.path + ' addon_domains', 80);
    const subdomains = parsed.lists.sub_domains || Object.keys(parsed.maps.sub_domains || {});
    for (const domain of subdomains) domainKind(domain, 'subdomain', entry.path + ' sub_domains', 80);
    const parked = parsed.lists.parked_domains || Object.keys(parsed.maps.parked_domains || {});
    for (const domain of parked) domainKind(domain, 'parked', entry.path + ' parked_domains', 80);
  }

  const userdataFiles = entries.filter(entry =>
    /^userdata\//.test(entry.path) &&
    !/(?:^|\/)(main|main\.cache|cache|ipv6|.*_SSL)$/.test(entry.path)
  );
  for (const entry of userdataFiles) {
    const parsed = parseLooseYaml(textOf(entry));
    const basename = entry.path.split('/').pop();
    const fromName = normalizeDomain(basename);
    const fromData = normalizeDomain(parsed.scalars.servername || parsed.scalars.server_name);
    if (fromName && fromData && fromName !== fromData) {
      addWarning(plan, entry.path + ' is named for ' + fromName + ' but its servername is ' + fromData + '; servername was preferred.');
    }
    const domain = fromData || fromName;
    if (!domain) continue;
    if (domain === mainDomain) domainKind(domain, 'main', entry.path, 100);

    const documentRoot = normalizeHomePath(
      parsed.scalars.documentroot || parsed.scalars.document_root,
      plan.account.user,
      entry.path + ' documentroot',
      plan
    );
    if (documentRoot != null) fact(domain, 'documentRoot', documentRoot, entry.path + ' documentroot', 100);
    const phpVersion = cleanScalar(parsed.scalars.phpversion || parsed.scalars.php_version);
    if (phpVersion) fact(domain, 'phpVersion', phpVersion, entry.path + ' phpversion', 100);
  }

  for (const row of domainMap.values()) {
    if (!row.kind) {
      addWarning(plan, 'Could not classify ' + row.domain + ' as main, addon, subdomain, or parked from the archive; kind is null.');
    }
    delete row._facts;
    plan.domains.push(row);
  }

  const kindOrder = { main: 0, addon: 1, subdomain: 2, parked: 3 };
  plan.domains.sort((left, right) =>
    (kindOrder[left.kind] == null ? 9 : kindOrder[left.kind]) -
    (kindOrder[right.kind] == null ? 9 : kindOrder[right.kind]) ||
    left.domain.localeCompare(right.domain)
  );

  const mainRow = plan.domains.find(row => row.domain === mainDomain);
  plan.account.phpVersion = chooseAccountValue(plan, 'Account PHP version', [
    { value: mainRow && mainRow.phpVersion, source: mainRow ? mainRow.domain + ' userdata' : null, score: 100 },
    { value: accountState.cp.PHPVERSION || accountState.cp.PHP_VERSION, source: accountState.cpEntry ? accountState.cpEntry.path + ' PHPVERSION' : null, score: 60 }
  ]);
}

function buildDatabases(context, plan) {
  const { entries, byPath } = context;
  const databases = new Map();
  const users = new Set();

  function database(name) {
    if (!databases.has(name)) databases.set(name, { name, users: [], dumpPath: null });
    return databases.get(name);
  }

  for (const entry of entries) {
    const match = entry.path.match(/^mysql\/(.+)\.sql$/i);
    if (!match) continue;
    const name = match[1];
    const row = database(name);
    if (row.dumpPath && row.dumpPath !== entry.path) {
      addWarning(plan, 'Database ' + name + ' has more than one dump; ' + row.dumpPath + ' was kept and ' + entry.path + ' was not selected.');
    } else row.dumpPath = entry.path;
  }

  const grantsEntry = findExact(byPath, ['mysql.sql']);
  if (grantsEntry) {
    const sql = textOf(grantsEntry);
    const grantPattern = /GRANT\s+([\s\S]*?)\s+ON\s+(?:\x60([^\x60]+)\x60|([A-Za-z0-9_$.-]+))\s*\.\s*\*\s+TO\s+(?:'([^']+)'|\x60([^\x60]+)\x60|([^\s@;]+))\s*@\s*(?:'[^']*'|\x60[^\x60]*\x60|[^\s;]+)/gi;
    let match;
    while ((match = grantPattern.exec(sql))) {
      const name = match[2] || match[3];
      const username = match[4] || match[5] || match[6];
      if (!name || name === '*' || !username) continue;
      users.add(username);
      const privileges = match[1].split(',').map(value => value.trim().replace(/\s+/g, ' ').toUpperCase()).filter(Boolean);
      const row = database(name);
      const existing = row.users.find(item => item.username === username);
      if (existing) existing.privileges = Array.from(new Set(existing.privileges.concat(privileges))).sort();
      else row.users.push({ username, privileges: Array.from(new Set(privileges)).sort() });
    }

    const createUserPattern = /CREATE\s+USER(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:'([^']+)'|\x60([^\x60]+)\x60|([^\s@;]+))\s*@/gi;
    while ((match = createUserPattern.exec(sql))) {
      const username = match[1] || match[2] || match[3];
      if (username) users.add(username);
    }
  }

  for (const row of databases.values()) {
    row.users.sort((left, right) => left.username.localeCompare(right.username));
    if (!row.dumpPath) addWarning(plan, 'Database ' + row.name + ' appears in mysql.sql grants but has no dump in mysql/.');
    plan.databases.push(row);
  }
  plan.databases.sort((left, right) => left.name.localeCompare(right.name));
  plan.dbUsers = Array.from(users).sort().map(username => ({ username }));
}

function homeRelative(path, partialHome) {
  if (path === 'homedir') return '';
  if (path.startsWith('homedir/')) return path.slice('homedir/'.length);
  return partialHome ? path : null;
}

function parseMailboxQuota(text) {
  const result = Object.create(null);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([^:\s]+)\s*:\s*(\d+)/);
    if (match) result[match[1]] = Number(match[2]);
  }
  return result;
}

function buildMail(context, plan) {
  const { entries, byPath, partialHome } = context;
  const mailboxMap = new Map();

  function mailbox(domainValue, accountValue, source) {
    const domain = normalizeDomain(domainValue);
    const account = cleanScalar(accountValue);
    if (!domain || !account || account.includes('@') || account === '*') return null;
    const address = (account + '@' + domain).toLowerCase();
    if (!mailboxMap.has(address)) {
      mailboxMap.set(address, {
        address,
        domain,
        account,
        quotaMb: null,
        hasPassword: false,
        _sources: [source]
      });
    } else mailboxMap.get(address)._sources.push(source);
    return mailboxMap.get(address);
  }

  for (const entry of entries) {
    const relative = homeRelative(entry.path, partialHome);
    if (relative == null) continue;
    const passwdMatch = relative.match(/^etc\/([^/]+)\/passwd$/);
    if (!passwdMatch) continue;
    const domain = passwdMatch[1];
    const quotaPath = (partialHome ? '' : 'homedir/') + 'etc/' + domain + '/quota';
    const quotaEntry = byPath.get(quotaPath) || byPath.get('etc/' + domain + '/quota');
    const quotas = quotaEntry ? parseMailboxQuota(textOf(quotaEntry)) : Object.create(null);

    for (const rawLine of textOf(entry).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const account = line.split(':')[0];
      const row = mailbox(domain, account, entry.path);
      if (!row) continue;
      if (Object.prototype.hasOwnProperty.call(quotas, account)) {
        if (quotas[account] === 0) addWarning(plan, row.address + ' has a zero/unlimited cPanel mailbox quota; quotaMb is null.');
        else row.quotaMb = quotas[account] / (1024 * 1024);
      }
    }
  }

  for (const entry of entries) {
    const relative = homeRelative(entry.path, partialHome);
    if (relative == null) continue;
    const match = relative.match(/^mail\/([^/]+)\/([^/]+)\/(?:cur|new|tmp)\//);
    if (!match) continue;
    const row = mailbox(match[1], match[2], entry.path);
    if (row && row._sources.length === 1) {
      addWarning(plan, 'Mailbox ' + row.address + ' was inferred from Maildir content because no passwd entry described it.');
    }
  }

  for (const row of mailboxMap.values()) {
    delete row._sources;
    plan.mailboxes.push(row);
  }
  plan.mailboxes.sort((left, right) => left.address.localeCompare(right.address));
  if (plan.mailboxes.length) {
    addWarning(plan, 'Mailbox password hashes cannot be reused on the target; every mailbox has hasPassword false and needs a new password.');
  }

  const autoresponderMap = new Map();
  for (const entry of entries) {
    const relative = homeRelative(entry.path, partialHome);
    if (relative == null || !relative.startsWith('.autoresponder/')) continue;
    let filename = relative.slice('.autoresponder/'.length);
    let kind = 'plain';
    if (/\.json$/i.test(filename)) { filename = filename.replace(/\.json$/i, ''); kind = 'json'; }
    else if (/\.body$/i.test(filename)) { filename = filename.replace(/\.body$/i, ''); kind = 'body'; }
    try { filename = decodeURIComponent(filename); } catch {}
    const address = filename.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      addUnsupported(plan, 'Autoresponder ' + entry.path, 'The autoresponder address could not be recovered from its filename.');
      continue;
    }
    if (!autoresponderMap.has(address)) autoresponderMap.set(address, { address, subject: null, body: null });
    const row = autoresponderMap.get(address);
    const content = textOf(entry);
    if (kind === 'json') {
      try {
        const data = JSON.parse(content);
        row.subject = cleanScalar(data.subject) || row.subject;
        row.body = cleanScalar(data.body == null ? data.message : data.body) || row.body;
      } catch {
        addUnsupported(plan, 'Autoresponder ' + entry.path, 'Its JSON could not be parsed safely.');
      }
    } else if (kind === 'body') row.body = content;
    else {
      const split = content.split(/\r?\n\r?\n/);
      const headers = split.shift() || '';
      const subject = headers.match(/^Subject:\s*(.+)$/im);
      row.subject = subject ? cleanScalar(subject[1]) : row.subject;
      row.body = cleanScalar(split.join('\n\n')) || row.body;
    }
  }
  for (const row of autoresponderMap.values()) {
    if (row.subject == null && row.body == null) {
      addUnsupported(plan, 'Autoresponder ' + row.address, 'The archive identified it but contained no subject or body that could be represented.');
    } else plan.autoresponders.push(row);
  }
  plan.autoresponders.sort((left, right) => left.address.localeCompare(right.address));

  for (const entry of entries.filter(item => /^va\/[^/]+$/.test(item.path))) {
    const domain = normalizeDomain(entry.path.slice(3));
    if (!domain) continue;
    for (const rawLine of textOf(entry).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const separator = line.indexOf(':');
      if (separator < 1) continue;
      const local = line.slice(0, separator).trim();
      const targets = line.slice(separator + 1).split(',').map(value => value.trim()).filter(Boolean);
      const from = local.includes('@') ? local.toLowerCase() : (local + '@' + domain).toLowerCase();
      if (local === '*') {
        addUnsupported(plan, 'Catch-all mail route for ' + domain, 'The plan schema represents address forwarders but has no catch-all routing rule.');
        continue;
      }
      for (const target of targets) {
        if (/autorespond/i.test(target)) continue;
        if (target.startsWith('|')) {
          addUnsupported(plan, 'Piped mail route ' + from, 'The target executes a program and cannot be represented as an address forwarder.');
        } else if (/^:(?:fail|blackhole):/i.test(target)) {
          addUnsupported(plan, 'Discard or reject route ' + from, 'The output schema has no discard or SMTP rejection rule.');
        } else plan.forwarders.push({ from, to: target });
      }
    }
  }
  plan.forwarders.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
}

function stripZoneComment(line) {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"' && line[index - 1] !== '\\') quoted = !quoted;
    if (line[index] === ';' && !quoted) return line.slice(0, index);
  }
  return line;
}

function zoneLogicalLines(text) {
  const lines = [];
  let pending = '';
  let depth = 0;
  let pendingIndented = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const clean = stripZoneComment(rawLine);
    if (!clean.trim()) continue;
    if (!pending) pendingIndented = /^\s/.test(clean);
    pending += (pending ? ' ' : '') + clean.trim();
    for (const char of clean) {
      if (char === '(') depth += 1;
      if (char === ')') depth -= 1;
    }
    if (depth <= 0) {
      lines.push({ text: pending.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim(), indented: pendingIndented });
      pending = '';
      depth = 0;
    }
  }
  if (pending) lines.push({ text: pending, indented: pendingIndented });
  return lines;
}

function parseZone(entry, zone, plan) {
  const records = [];
  let defaultTtl = null;
  let origin = zone;
  let previousName = null;
  for (const logical of zoneLogicalLines(textOf(entry))) {
    if (/^\$TTL\s+/i.test(logical.text)) {
      defaultTtl = safeNumber(logical.text.split(/\s+/)[1]);
      continue;
    }
    if (/^\$ORIGIN\s+/i.test(logical.text)) {
      origin = normalizeDomain(logical.text.split(/\s+/)[1]) || origin;
      continue;
    }
    if (logical.text.startsWith('$')) continue;
    const tokens = logical.text.match(/"(?:\\.|[^"])*"|[^\s]+/g) || [];
    if (!tokens.length) continue;

    let index = 0;
    let name;
    if (logical.indented && previousName) name = previousName;
    else name = tokens[index++];
    let ttl = defaultTtl;
    if (/^\d+$/.test(tokens[index] || '')) ttl = Number(tokens[index++]);
    if (/^(IN|CH|HS)$/i.test(tokens[index] || '')) index += 1;
    const type = (tokens[index++] || '').toUpperCase();
    if (!type || index > tokens.length) {
      addWarning(plan, 'Could not parse a DNS record in ' + entry.path + ': ' + JSON.stringify(logical.text) + '.');
      continue;
    }
    if (name === '@') name = origin;
    else if (name && !name.endsWith('.') && normalizeDomain(name + '.' + origin)) name = name + '.' + origin;
    if (name) name = name.replace(/\.$/, '');
    previousName = name;
    records.push({ name: name || null, type, ttl, value: tokens.slice(index).join(' ') });
  }
  return records;
}

function buildDns(context, plan) {
  for (const entry of context.entries.filter(item => /^dnszones\/.+\.db$/i.test(item.path))) {
    const zone = normalizeDomain(entry.path.slice('dnszones/'.length).replace(/\.db$/i, ''));
    if (!zone) {
      addWarning(plan, 'Could not identify the DNS zone name for ' + entry.path + '.');
      continue;
    }
    plan.dns.push({ zone, recordsPath: entry.path, records: parseZone(entry, zone, plan) });
  }
  plan.dns.sort((left, right) => left.zone.localeCompare(right.zone));
}

function buildCron(context, plan) {
  for (const entry of context.entries.filter(item => /^cron\/[^/]+$/.test(item.path))) {
    for (const rawLine of textOf(entry).split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) continue;
      const special = line.match(/^(@(?:reboot|yearly|annually|monthly|weekly|daily|midnight|hourly))\s+(.+)$/i);
      if (special) {
        plan.cron.push({ schedule: special[1], command: special[2] });
        continue;
      }
      const match = line.match(/^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+)$/);
      if (match) plan.cron.push({ schedule: match[1], command: match[2] });
      else addWarning(plan, 'Could not parse cron line in ' + entry.path + ': ' + JSON.stringify(line) + '.');
    }
  }
}

function buildFtp(context, plan) {
  const entry = context.byPath.get('proftpdpasswd');
  if (!entry) return;
  for (const rawLine of textOf(entry).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(':');
    if (fields.length < 6) {
      addWarning(plan, 'Could not parse an FTP account line in proftpdpasswd.');
      continue;
    }
    const username = cleanScalar(fields[0]);
    const path = normalizeHomePath(fields[5], plan.account.user, 'proftpdpasswd home for ' + username, plan);
    if (username) plan.ftpAccounts.push({ username, path });
  }
  plan.ftpAccounts.sort((left, right) => left.username.localeCompare(right.username));
}

function assignFileDomain(relativePath, domains) {
  const matches = domains
    .filter(domain => domain.documentRoot != null && domain.documentRoot !== '')
    .filter(domain => relativePath === domain.documentRoot || relativePath.startsWith(domain.documentRoot + '/'))
    .sort((left, right) => right.documentRoot.length - left.documentRoot.length);
  return matches.length ? matches[0].domain : null;
}

function buildFiles(context, plan) {
  for (const entry of context.entries) {
    const relativePath = homeRelative(entry.path, context.partialHome);
    if (relativePath == null || !relativePath) continue;
    plan.files.push({
      archivePath: entry.path,
      relativePath,
      domain: assignFileDomain(relativePath, plan.domains),
      sizeBytes: entry.sizeBytes
    });
  }
  plan.files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function awstatsSection(text, name) {
  const match = text.match(new RegExp('(?:^|\\n)BEGIN_' + name + '\\s+\\d+\\s*\\n([\\s\\S]*?)(?:\\nEND_' + name + '(?:\\n|$))', 'i'));
  return match ? match[1].split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')) : [];
}

function parseAwstats(entry, plan) {
  const basename = entry.path.split('/').pop();
  const nameMatch = basename.match(/^awstats(\d{2})(\d{4})\.(.+)\.txt$/i);
  if (!nameMatch) return null;
  const month = Number(nameMatch[1]);
  const year = Number(nameMatch[2]);
  const domain = normalizeDomain(nameMatch[3].replace(/\.ssl$/i, ''));
  if (month < 1 || month > 12 || !domain) {
    addWarning(plan, 'Could not identify the month or domain for AWStats file ' + entry.path + '.');
    return null;
  }

  const text = textOf(entry);
  const versionMatch = text.match(/AWSTATS DATA FILE\s+([0-9.]+)/i);
  const version = versionMatch ? Number(versionMatch[1]) : null;
  const trafficColumnsTrusted = version != null && version >= 5 && version < 9;
  if (!versionMatch) {
    addWarning(plan, entry.path + ' does not identify its AWStats data-file version; TotalVisits and TotalUnique are read by name, but BEGIN_TIME column totals are not trusted.');
  } else if (!trafficColumnsTrusted) {
    addWarning(plan, entry.path + ' uses AWStats data format ' + versionMatch[1] + '; pages, hits, and bandwidthBytes are only trusted here for AWStats data formats 5.x through 8.x and are therefore null.');
  }
  const general = Object.create(null);
  for (const line of awstatsSection(text, 'GENERAL')) {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match) general[match[1]] = match[2].trim();
  }

  function trafficTotals(sectionName) {
    let pages = 0;
    let hits = 0;
    let bandwidth = 0;
    let found = false;
    for (const line of awstatsSection(text, sectionName)) {
      const fields = line.split(/\s+/);
      if (fields.length < 4) continue;
      const values = fields.slice(1, 4).map(safeNumber);
      if (values.some(value => value == null)) continue;
      pages += values[0];
      hits += values[1];
      bandwidth += values[2];
      found = true;
    }
    return found ? { pages, hits, bandwidth } : null;
  }

  const traffic = trafficColumnsTrusted ? (trafficTotals('TIME') || trafficTotals('DAY')) : null;
  if (!traffic && trafficColumnsTrusted) {
    addWarning(plan, entry.path + ' has no reliable BEGIN_TIME or BEGIN_DAY totals; pages, hits, and bandwidthBytes are null.');
  }
  const visits = safeNumber(general.TotalVisits);
  const uniqueVisitors = safeNumber(general.TotalUnique);
  if (visits == null || uniqueVisitors == null) {
    addWarning(plan, entry.path + ' is missing TotalVisits or TotalUnique in BEGIN_GENERAL; the absent field is null.');
  }
  return {
    domain,
    month,
    year,
    source: 'awstats',
    visits,
    uniqueVisitors,
    pages: traffic ? traffic.pages : null,
    hits: traffic ? traffic.hits : null,
    bandwidthBytes: traffic ? traffic.bandwidth : null,
    archivePath: entry.path
  };
}

function webalizerDomain(entry, context) {
  const relative = homeRelative(entry.path, context.partialHome);
  if (relative == null) return null;
  const match = relative.match(/^tmp\/webalizer\/(?:(.+)\/)?webalizer\.hist$/i);
  if (!match) return null;
  const fromDirectory = normalizeDomain(match[1]);
  if (fromDirectory) return fromDirectory;
  const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1);
  const config = context.byPath.get(directory + 'webalizer.conf');
  if (config) {
    const host = textOf(config).match(/^\s*HostName\s+(\S+)/im);
    if (host) return normalizeDomain(host[1]);
  }
  return null;
}

function parseWebalizer(entry, context, plan) {
  const domain = webalizerDomain(entry, context);
  if (!domain) addWarning(plan, 'Could not identify the domain for Webalizer history ' + entry.path + '; domain is null.');
  const rows = [];
  for (const rawLine of textOf(entry).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/).map(Number);
    if (fields.length < 10 || fields.slice(0, 10).some(value => !Number.isFinite(value))) continue;
    const month = fields[0];
    const year = fields[1];
    const hits = fields[2];
    const sites = fields[4];
    const kilobytes = fields[5];
    const pages = fields[8];
    const visits = fields[9];
    if (month < 1 || month > 12 || year < 1970) continue;
    rows.push({
      domain,
      month,
      year,
      source: 'webalizer',
      visits,
      uniqueVisitors: sites,
      pages,
      hits,
      bandwidthBytes: kilobytes * 1024,
      archivePath: entry.path
    });
  }
  if (!rows.length) addWarning(plan, 'No trustworthy monthly rows were found in Webalizer history ' + entry.path + '.');
  return rows;
}

function monthFromFilename(filename) {
  let match = filename.match(/(?:^|[-_.])(\d{4})[-_.](0[1-9]|1[0-2])(?:[-_.]|$)/);
  if (match) return { year: Number(match[1]), month: Number(match[2]) };
  match = filename.match(/(?:^|[-_.])(0[1-9]|1[0-2])[-_.](\d{4})(?:[-_.]|$)/);
  if (match) return { year: Number(match[2]), month: Number(match[1]) };
  const names = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
  match = filename.match(/(?:^|[-_.])(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-_.](\d{4})(?:[-_.]|$)/i);
  return match ? { year: Number(match[2]), month: names[match[1].slice(0, 3).toLowerCase()] } : { year:null, month:null };
}

function buildStatistics(context, plan) {
  for (const entry of context.entries) {
    if (/\/awstats\d{2}\d{4}\..+\.txt$/i.test('/' + entry.path)) {
      const row = parseAwstats(entry, plan);
      if (row) plan.statistics.push(row);
    }
    if (/\/webalizer\.hist$/i.test('/' + entry.path)) {
      plan.statistics.push(...parseWebalizer(entry, context, plan));
      addWarning(plan, 'Webalizer uniqueVisitors uses its monthly unique-sites count (unique hosts), which is not the same definition as AWStats TotalUnique.');
    }
  }

  const groups = new Map();
  for (const row of plan.statistics) {
    const key = [row.domain, row.year, row.month].join('|');
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(row.source);
  }
  for (const [key, sources] of groups) {
    if (sources.size > 1) {
      const parts = key.split('|');
      addWarning(plan, 'Both AWStats and Webalizer exist for ' + parts[0] + ' ' + parts[1] + '-' + String(parts[2]).padStart(2, '0') + '; both rows were retained.');
    }
  }

  plan.statistics.sort((left, right) =>
    String(left.domain).localeCompare(String(right.domain)) ||
    left.year - right.year ||
    left.month - right.month ||
    left.source.localeCompare(right.source)
  );
}

function buildRawLogs(context, plan) {
  for (const entry of context.entries) {
    let filename = null;
    if (entry.path.startsWith('logs/')) filename = entry.path.slice('logs/'.length);
    else {
      const relative = homeRelative(entry.path, context.partialHome);
      if (relative && relative.startsWith('access-logs/')) filename = relative.slice('access-logs/'.length);
    }
    if (!filename || filename.includes('/')) continue;
    const domainMatch = filename.match(/([a-z0-9_-]+(?:\.[a-z0-9_-]+)+)/i);
    const date = monthFromFilename(filename);
    plan.rawLogs.push({
      domain: domainMatch ? normalizeDomain(domainMatch[1]) : null,
      archivePath: entry.path,
      month: date.month,
      year: date.year,
      compressed: /\.(?:gz|bz2|xz|zip)$/i.test(filename)
    });
  }
  plan.rawLogs.sort((left, right) => left.archivePath.localeCompare(right.archivePath));
}

function certificateKind(path, content) {
  if (/(\.key$|\/(?:private|key|keys)(?:\/|$))/i.test(path) || /BEGIN (?:RSA |EC )?PRIVATE KEY/.test(content)) return 'key';
  if (/(\.cabundle$|\.chain$|\/(?:cabundle|chain)(?:\/|$))/i.test(path)) return 'chain';
  if (/(\.crt$|\.cert$|\.pem$|\/certificates?(?:\/|$))/i.test(path) || /BEGIN CERTIFICATE/.test(content)) return 'cert';
  return null;
}

function certificateDomain(entry) {
  let match = entry.path.match(/^apache_tls\/([^/]+)\//i);
  if (match) return normalizeDomain(match[1]);
  const basename = entry.path.split('/').pop().replace(/\.(?:crt|cert|pem|key|cabundle|chain)$/i, '');
  return normalizeDomain(basename);
}

function buildCertificates(context, plan) {
  for (const entry of context.entries) {
    if (!/^(apache_tls|sslcerts|sslkeys)\//.test(entry.path) &&
        !/^homedir\/ssl\//.test(entry.path) &&
        !(context.partialHome && /^ssl\//.test(entry.path))) continue;
    const content = textOf(entry);
    const kind = certificateKind(entry.path, content);
    if (!kind) {
      if (/\.csr$/i.test(entry.path)) addUnsupported(plan, 'Certificate signing request ' + entry.path, 'The certificate plan represents installed certificates, keys, and chains, not CSRs.');
      continue;
    }
    const domain = certificateDomain(entry);
    if (!domain) {
      addWarning(plan, 'Could not identify the domain for ' + entry.path + '; the certificate material was not added to the plan.');
      continue;
    }
    plan.certificates.push({ domain, archivePath: entry.path, kind });
  }
  plan.certificates.sort((left, right) => left.domain.localeCompare(right.domain) || left.kind.localeCompare(right.kind));
}

function markUnsupported(context, plan) {
  const categories = [
    [/^vf\//, 'Exim mail filters', 'The plan schema has no mail-filter rules; restoring mailboxes and forwarders does not reproduce these filters.'],
    [/^(mm|mma|mms)\//, 'Mailman mailing lists', 'The plan schema has no mailing-list representation.'],
    [/^psql\//, 'PostgreSQL databases', 'The plan schema represents MySQL-style SQL dumps and grants only.'],
    [/^dnssec_keys\//, 'DNSSEC private material', 'The DNS record schema cannot safely represent or activate DNSSEC signing keys.'],
    [/^domainkeys\//, 'DKIM key material', 'The plan has DNS records but no private DKIM-key installation step.'],
    [/^ccs\//, 'Calendars and contacts', 'The plan schema has no calendar or contacts data.'],
    [/^authnlinks\//, 'External authentication links', 'The plan schema has no external-authentication identity links.'],
    [/^httpfiles\//, 'Custom virtual-host templates', 'The plan schema cannot represent custom Apache virtual-host templates.'],
    [/^reseller(?:config|features|packages)\//, 'Reseller configuration', 'This is a single-account migration plan and has no reseller privileges or packages.'],
    [/^homedir\/tmp\/webalizerftp\//, 'Webalizer FTP statistics', 'The statistics schema represents website traffic, not FTP traffic.'],
    [/\/webalizer\.current$/i, 'Current Webalizer incremental state', 'Its binary/version-specific state is not a trustworthy monthly aggregate.']
  ];
  for (const [pattern, what, why] of categories) {
    if (context.entries.some(entry => pattern.test(entry.path))) addUnsupported(plan, what, why);
  }
}

function parseCpanelArchive(input) {
  const plan = emptyPlan();
  const prepared = prepareEntries(input, plan);
  const detection = detectArchive(prepared.entries);
  const context = { ...prepared, ...detection };
  if (context.partialHome) {
    addWarning(plan, 'This looks like a cPanel home-directory-only backup; account, domain, database, and server metadata may be absent.');
  }

  // One wrapper, or none. A cpmove archive puts everything under cpmove-<user>
  // and a home-only backup usually does not, so this is the difference between
  // a member path that exists and one that does not.
  const wrappers = [...new Set(prepared.entries.map(entry => entry.wrapper).filter(Boolean))];
  plan.archive.wrapper = wrappers.length === 1 ? wrappers[0] : null;
  if (wrappers.length > 1) {
    addWarning(plan, 'The archive holds ' + wrappers.length + ' account folders. Nothing is extracted from it by path, because a prefix that matches more than one account would take the wrong files.');
  }
  plan.archive.homePrefix = (plan.archive.wrapper ? plan.archive.wrapper + '/' : '') + (context.partialHome ? '' : 'homedir/');

  const accountState = buildAccount(context, plan);
  buildDomains(context, accountState, plan);
  buildDatabases(context, plan);
  buildMail(context, plan);
  buildDns(context, plan);
  buildCron(context, plan);
  buildFtp(context, plan);
  buildFiles(context, plan);
  buildStatistics(context, plan);
  buildRawLogs(context, plan);
  buildCertificates(context, plan);
  markUnsupported(context, plan);
  return plan;
}

module.exports = { parseCpanelArchive, CPANEL_PATHS };

/*
 * Three cPanel-specific migration failures that commonly surface late:
 *
 * 1. mysql.sql, not mysql/*.sql, carries host-scoped grants. Restoring both
 *    dumps but missing one shared database user's second GRANT leaves a site
 *    that fails only when the less-used feature queries that database.
 *
 * 2. Mail delivery is split across etc/<domain>/passwd, va/<domain>, vf/<domain>
 *    and .autoresponder. Copying Maildir and recreating addresses can still
 *    lose a catch-all, pipe, or Exim filter, noticed after mail disappears.
 *
 * 3. Scheduled work lives in cron/* rather than the home tree. A home-only or
 *    skip-config backup can look complete while a weekly export, renewal,
 *    cleanup, or billing job simply never runs.
 */
