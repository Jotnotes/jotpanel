'use strict';

/**
 * JotPanel's own provisioning adapter.
 *
 * The first native slice is deliberately narrow: account statistics are read
 * from JotPanel's own ledger. Mailbox, FTP and authoritative DNS services need a
 * verified machine helper before they can be advertised as executable. Until
 * that helper exists, returning ok:false is the product feature: no mock result
 * is allowed to become a green “Done” card on a real install.
 */
function createNativeProvisioningAdapter({ db, usageService } = {}) {
  if (!db || !usageService) throw new Error('native provisioning adapter requires database and usage service');

  async function execute(call, accountContext) {
    if (call?.module === 'StatsBar' && call?.function === 'get_stats') {
      const usage = usageService.reportForAccount(accountContext.accountId, {});
      const sites = db.prepare('SELECT COUNT(*) count FROM sites WHERE user_id=?').get(accountContext.accountId)?.count || 0;
      const mail = db.prepare('SELECT COUNT(*) count FROM mail_accounts WHERE user_id=?').get(accountContext.accountId)?.count || 0;
      return {
        ok: true,
        verified: true,
        adapter: 'arca-native',
        executedAt: new Date().toISOString(),
        accountId: accountContext.accountId,
        data: {
          storage: usage.storage,
          assistant: usage.assistant,
          accountState: usage.account_state,
          sites,
          connectedMailboxes: mail,
        },
      };
    }

    const operation = call?.module && call?.function ? `${call.module}.${call.function}` : 'unknown operation';
    return {
      ok: false,
      verified: false,
      adapter: 'arca-native',
      error: `${operation} is not installed as a verified native service on this server. Nothing was changed.`,
      missingCapability: operation,
    };
  }

  return { name: 'arca-native', execute };
}

module.exports = { createNativeProvisioningAdapter };
