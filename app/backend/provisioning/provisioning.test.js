'use strict';

const assert = require('assert/strict');
const {
  ACTIONS,
  createMockProvisioningAdapter,
  createProvisioningService,
} = require('./index');

const account = {
  accountId: 'acct_123',
  cpanelUser: 'higashi',
  primaryDomain: 'higashi.example',
  domains: ['higashi.example', 'panel.higashi.example'],
  allowedDnsZones: ['higashi.example'],
};

async function run() {
  await testEmailProposalRequiresApproval();
  await testScopeBlocksForeignDomain();
  await testFtpProposalCarriesIpEnforcement();
  await testDnsApprovalExecutesThroughAdapter();
  await testStatsProposalUsesHigashiAnalyticsMetadata();
  console.log('provisioning tests passed');
}

async function testEmailProposalRequiresApproval() {
  const adapter = createMockProvisioningAdapter();
  const service = createProvisioningService({ adapter });

  const action = await service.propose({
    intent: 'create an email account',
    account,
    input: {
      email: 'hello@higashi.example',
      password: 'correct-horse-99',
      quotaMb: 2048,
    },
  });

  assert.equal(action.status, 'pending');
  assert.equal(action.actionKey, ACTIONS.CREATE_EMAIL_ACCOUNT);
  assert.equal(action.call.module, 'Email');
  assert.equal(action.call.function, 'add_pop');
  assert.equal(adapter.getExecutedCalls().length, 0);
}

async function testScopeBlocksForeignDomain() {
  const service = createProvisioningService();

  await assert.rejects(
    () => service.propose({
      intent: ACTIONS.CREATE_EMAIL_ACCOUNT,
      account,
      input: {
        email: 'ops@other.example',
        password: 'correct-horse-99',
      },
    }),
    /outside account scope/
  );
}

async function testFtpProposalCarriesIpEnforcement() {
  const service = createProvisioningService();

  const action = await service.propose({
    intent: 'grant ftp',
    account,
    input: {
      username: 'deploy',
      domain: 'higashi.example',
      password: 'correct-horse-99',
      homeDirectory: 'public_html/releases',
      allowedIp: '203.0.113.7',
      quotaMb: 512,
    },
  });

  assert.equal(action.call.module, 'Ftp');
  assert.equal(action.call.function, 'add_ftp');
  assert.equal(action.call.enforcement.allowedIp, '203.0.113.7');
  assert.equal(action.call.params.homedir, 'public_html/releases');
}

async function testDnsApprovalExecutesThroughAdapter() {
  const adapter = createMockProvisioningAdapter();
  const service = createProvisioningService({ adapter });

  const action = await service.propose({
    intent: 'add dns record',
    account,
    input: {
      zone: 'higashi.example',
      type: 'A',
      name: 'app',
      value: '198.51.100.42',
      ttl: 600,
    },
  });

  await assert.rejects(() => service.executeApproved(action.id, { account }), /must be approved/);
  await service.approveAction(action.id, { approvedBy: 'steve' });
  const executed = await service.executeApproved(action.id, { account });

  assert.equal(executed.status, 'executed');
  assert.equal(adapter.getExecutedCalls().length, 1);
  assert.equal(adapter.getExecutedCalls()[0].call.params.name, 'app.higashi.example');
}

async function testStatsProposalUsesHigashiAnalyticsMetadata() {
  const service = createProvisioningService();

  const action = await service.propose({
    intent: 'show bandwidth and visitors',
    account,
    input: { domain: 'higashi.example' },
  });

  assert.equal(action.actionKey, ACTIONS.FETCH_ACCOUNT_STATS);
  assert.equal(action.riskLevel, 'read-only');
  assert.equal(action.metadata.analyticsSource, 'higashi');
  assert.equal(action.call.module, 'StatsBar');
  assert.equal(action.call.companionCalls[0].module, 'Bandwidth');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
