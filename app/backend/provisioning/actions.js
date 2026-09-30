'use strict';

const {
  assertIpAddress,
  assertLocalPart,
  assertOwnedDnsZone,
  assertOwnedDomain,
  assertPassword,
  assertQuotaMb,
  assertSafeRelativePath,
  assertUsername,
  normalizeDomain,
  requiredString,
} = require('./scope');

const ACTIONS = {
  CREATE_EMAIL_ACCOUNT: 'create_email_account',
  CREATE_FTP_ACCOUNT: 'create_ftp_account',
  FETCH_ACCOUNT_STATS: 'fetch_account_stats',
  ADD_DNS_RECORD: 'add_dns_record',
};

function buildProposal({ actionKey, label, summary, accountContext, call, metadata = {}, riskLevel = 'standard' }) {
  return {
    actionKey,
    label,
    summary,
    riskLevel,
    accountId: accountContext.accountId,
    cpanelUser: accountContext.cpanelUser,
    scope: {
      accountId: accountContext.accountId,
      cpanelUser: accountContext.cpanelUser,
      primaryDomain: accountContext.primaryDomain,
    },
    call,
    metadata,
    requiresApproval: true,
    requiresConfirmText: riskLevel === 'destructive' ? 'EXECUTE' : null,
  };
}

function proposeCreateEmailAccount(input, accountContext) {
  const { localPart, domain } = splitEmailInput(input.email, input.localPart, input.domain);
  const scopedDomain = assertOwnedDomain(accountContext, domain);
  const emailLocalPart = assertLocalPart(localPart);
  const quotaMb = assertQuotaMb(input.quotaMb, 1024);
  const password = assertPassword(input.password);

  return buildProposal({
    actionKey: ACTIONS.CREATE_EMAIL_ACCOUNT,
    label: `Create email account ${emailLocalPart}@${scopedDomain}`,
    summary: `Create a ${quotaMb} MB mailbox for ${emailLocalPart}@${scopedDomain}.`,
    accountContext,
    call: {
      api: 'cpanel-uapi',
      module: 'Email',
      function: 'add_pop',
      user: accountContext.cpanelUser,
      params: {
        email: emailLocalPart,
        domain: scopedDomain,
        password,
        quota: quotaMb,
      },
    },
    metadata: {
      email: `${emailLocalPart}@${scopedDomain}`,
      quotaMb,
    },
  });
}

function proposeCreateFtpAccount(input, accountContext) {
  const username = assertUsername(input.username);
  const domain = assertOwnedDomain(accountContext, input.domain || accountContext.primaryDomain);
  const password = assertPassword(input.password);
  const homedir = assertSafeRelativePath(input.homeDirectory || `public_html/${username}`);
  const allowedIp = assertIpAddress(input.allowedIp);
  const quotaMb = assertQuotaMb(input.quotaMb, 0);

  return buildProposal({
    actionKey: ACTIONS.CREATE_FTP_ACCOUNT,
    label: `Create FTP account ${username}@${domain}`,
    summary: `Create FTP access rooted at /${homedir} and restricted to ${allowedIp}.`,
    accountContext,
    call: {
      api: 'cpanel-uapi',
      module: 'Ftp',
      function: 'add_ftp',
      user: accountContext.cpanelUser,
      params: {
        user: username,
        domain,
        pass: password,
        homedir,
        quota: quotaMb,
      },
      enforcement: {
        type: 'source-ip-allowlist',
        allowedIp,
        note: 'cPanel UAPI creates the FTP user; the real adapter must enforce this IP rule with the host FTP/firewall layer.',
      },
    },
    metadata: {
      ftpLogin: `${username}@${domain}`,
      homeDirectory: homedir,
      allowedIp,
      quotaMb,
    },
  });
}

function proposeFetchAccountStats(input, accountContext) {
  const domain = input.domain ? assertOwnedDomain(accountContext, input.domain) : accountContext.primaryDomain;
  const displayWindow = input.window || 'current_month';

  return buildProposal({
    actionKey: ACTIONS.FETCH_ACCOUNT_STATS,
    label: `Fetch hosting stats for ${domain}`,
    summary: `Fetch disk, bandwidth, and visitor stats for ${domain}; higashi analytics remains the visitor source of record in UI.`,
    riskLevel: 'read-only',
    accountContext,
    call: {
      api: 'cpanel-uapi',
      module: 'StatsBar',
      function: 'get_stats',
      user: accountContext.cpanelUser,
      params: {
        display: 'diskusage|bandwidthusage',
      },
      companionCalls: [
        {
          api: 'cpanel-uapi',
          module: 'Bandwidth',
          function: 'query',
          user: accountContext.cpanelUser,
          params: { grouping: 'domain', domains: domain },
        },
      ],
    },
    metadata: {
      domain,
      window: displayWindow,
      analyticsSource: 'higashi',
    },
  });
}

function proposeAddDnsRecord(input, accountContext) {
  const zone = assertOwnedDnsZone(accountContext, input.zone || input.domain);
  const recordType = requiredString(input.type, 'type').toUpperCase();
  const validTypes = new Set(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);
  if (!validTypes.has(recordType)) throw new Error(`Unsupported DNS record type: ${recordType}`);

  const name = normalizeDnsName(input.name, zone);
  const ttl = input.ttl === undefined ? 3600 : Number(input.ttl);
  if (!Number.isInteger(ttl) || ttl < 60) throw new Error('ttl must be an integer >= 60');

  const recordData = buildDnsRecordData(recordType, input);

  return buildProposal({
    actionKey: ACTIONS.ADD_DNS_RECORD,
    label: `Add ${recordType} record for ${name}`,
    summary: `Add ${recordType} DNS record ${name} in ${zone}.`,
    accountContext,
    call: {
      api: 'cpanel-uapi',
      module: 'ZoneEdit',
      function: 'add_zone_record',
      user: accountContext.cpanelUser,
      params: {
        domain: zone,
        name,
        type: recordType,
        ttl,
        ...recordData,
      },
    },
    metadata: {
      zone,
      name,
      type: recordType,
      ttl,
    },
  });
}

function splitEmailInput(email, localPart, domain) {
  if (email) {
    const parts = requiredString(email, 'email').split('@');
    if (parts.length !== 2) throw new Error('email must be local@domain');
    return { localPart: parts[0], domain: parts[1] };
  }
  return { localPart, domain };
}

function normalizeDnsName(name, zone) {
  const raw = requiredString(name, 'name').trim().toLowerCase();
  if (raw === '@') return zone;
  const fqdn = raw.endsWith(zone) ? raw : `${raw.replace(/\.$/, '')}.${zone}`;
  return normalizeDomain(fqdn);
}

function buildDnsRecordData(type, input) {
  if (type === 'MX') {
    const exchange = normalizeDomain(requiredString(input.exchange || input.value, 'exchange'));
    const preference = input.preference === undefined ? 10 : Number(input.preference);
    if (!Number.isInteger(preference) || preference < 0) throw new Error('MX preference must be a non-negative integer');
    return { exchange, preference };
  }

  const value = requiredString(input.value, 'value');
  if (type === 'A') return { address: value };
  if (type === 'AAAA') return { address: value };
  if (type === 'CNAME') return { cname: normalizeDomain(value) };
  return { txtdata: value };
}

module.exports = {
  ACTIONS,
  proposeCreateEmailAccount,
  proposeCreateFtpAccount,
  proposeFetchAccountStats,
  proposeAddDnsRecord,
};
