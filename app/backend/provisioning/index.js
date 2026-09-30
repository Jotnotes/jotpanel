'use strict';

const { createApprovalQueue } = require('./approvalQueue');
const {
  ACTIONS,
  proposeAddDnsRecord,
  proposeCreateEmailAccount,
  proposeCreateFtpAccount,
  proposeFetchAccountStats,
} = require('./actions');
const { mapIntent } = require('./intentMap');
const { createMockProvisioningAdapter } = require('./mockAdapter');
const { normalizeAccountContext } = require('./scope');

const ACTION_BUILDERS = {
  [ACTIONS.CREATE_EMAIL_ACCOUNT]: proposeCreateEmailAccount,
  [ACTIONS.CREATE_FTP_ACCOUNT]: proposeCreateFtpAccount,
  [ACTIONS.FETCH_ACCOUNT_STATS]: proposeFetchAccountStats,
  [ACTIONS.ADD_DNS_RECORD]: proposeAddDnsRecord,
};

function createProvisioningService({ adapter = createMockProvisioningAdapter(), queue = createApprovalQueue() } = {}) {
  async function propose({ intent, input = {}, account }) {
    const actionKey = mapIntent(intent);
    const accountContext = normalizeAccountContext(account);
    const builder = ACTION_BUILDERS[actionKey];
    if (!builder) throw new Error(`No builder for action ${actionKey}`);

    const proposal = builder(input, accountContext);
    return queue.enqueue({
      ...proposal,
      intent: String(intent),
    });
  }

  async function approveAction(id, approval = {}) {
    return queue.approve(id, approval);
  }

  async function rejectAction(id, rejection = {}) {
    return queue.reject(id, rejection);
  }

  async function executeApproved(id, { account } = {}) {
    const approved = queue.get(id);
    if (!approved) throw new Error(`Unknown approval action: ${id}`);
    if (approved.status !== 'approved') throw new Error(`Action ${id} must be approved before execution`);

    const accountContext = normalizeAccountContext(account || {
      accountId: approved.accountId,
      cpanelUser: approved.cpanelUser,
      primaryDomain: approved.scope.primaryDomain,
      domains: [approved.scope.primaryDomain],
      allowedDnsZones: [approved.scope.primaryDomain],
    });
    assertSameAccount(approved, accountContext);

    try {
      const result = await adapter.execute(approved.call, accountContext);
      if (!result || result.ok !== true) {
        const message = result && (result.error || result.message)
          ? (result.error || result.message)
          : 'The panel adapter did not verify the requested change';
        const error = new Error(message);
        error.result = result || null;
        throw error;
      }
      return queue.markExecuted(id, result);
    } catch (error) {
      // A failed execution is part of the record, not a thrown request that
      // leaves an approved card looking as though nobody ever ran it.
      if (typeof queue.markFailed === 'function') {
        queue.markFailed(id, error, error.result || null);
      }
      throw error;
    }
  }

  return {
    propose,
    approveAction,
    rejectAction,
    executeApproved,
    listActions: queue.list,
    getAction: queue.get,
    adapter,
  };
}

function assertSameAccount(action, accountContext) {
  if (action.accountId !== accountContext.accountId || action.cpanelUser !== accountContext.cpanelUser) {
    throw new Error('Approved action account scope does not match execution context');
  }
}

module.exports = {
  ACTIONS,
  createProvisioningService,
  createMockProvisioningAdapter,
  createApprovalQueue,
  mapIntent,
};
