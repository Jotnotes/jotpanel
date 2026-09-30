'use strict';

function createMockProvisioningAdapter({ now = () => new Date() } = {}) {
  const executedCalls = [];

  async function execute(call, accountContext) {
    const execution = {
      ok: true,
      adapter: 'mock-cpanel-whm',
      executedAt: now().toISOString(),
      accountId: accountContext.accountId,
      cpanelUser: accountContext.cpanelUser,
      call,
    };
    executedCalls.push(execution);

    if (call.module === 'StatsBar') {
      execution.data = {
        disk: { usedMb: 6144, limitMb: 20480 },
        bandwidth: { usedGb: 42.8, limitGb: 250 },
        visitors: { source: 'higashi', unique30d: 12840 },
      };
    }

    return execution;
  }

  return {
    name: 'mock-cpanel-whm',
    execute,
    getExecutedCalls: () => executedCalls.map((call) => JSON.parse(JSON.stringify(call))),
  };
}

module.exports = {
  createMockProvisioningAdapter,
};
