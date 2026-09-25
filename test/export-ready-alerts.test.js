const test = require('node:test');
const assert = require('node:assert/strict');
process.env.JWT_SECRET ||= 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-at-least-thirty-two-characters';
const { isExportReadyMessage } = require('../dist/services/import/ExportReadyMessage');
const { ExportReadyAlertService } = require('../dist/services/import/ExportReadyAlertService');
const { ImportLockService } = require('../dist/services/import/ImportLockService');

const fixtures = [
  [
    'uber_eats',
    'Uber <noreply@uber.com>',
    'Your Uber data is ready for download',
    'Go to download page',
  ],
  [
    'doordash',
    'DoorDash <privacy@doordash.com>',
    'Your data archive is ready',
    'View Your Data Archive',
  ],
];
for (const [provider, from, subject, body] of fixtures) {
  test(`${provider}: only trusted ready messages qualify`, () => {
    assert.equal(isExportReadyMessage(provider, from, subject, body), true);
    assert.equal(
      isExportReadyMessage(provider, 'sender@doordash.com.attacker.test', subject, body),
      false,
    );
    assert.equal(
      isExportReadyMessage(provider, from, 'Your order receipt', 'Thanks for ordering'),
      false,
    );
    assert.equal(
      isExportReadyMessage(
        provider,
        from,
        'Data request received',
        'We will email you when your data is ready.',
      ),
      false,
    );
  });
}

test('disabled rollout does not enqueue background access', async () => {
  const service = new ExportReadyAlertService(
    {
      due: () => {
        throw Error('must not query');
      },
    },
    {},
    {},
    {},
    {},
    false,
  );
  assert.equal(await service.enqueueEligible(), 0);
});

test('multiple pending providers receive independent durable jobs', async () => {
  const jobs = [];
  const scheduled = [];
  const candidates = ['uber_eats', 'doordash'].map((provider) => ({
    userId: 'user',
    provider,
    requestId: provider + '-request',
  }));
  const service = new ExportReadyAlertService(
    { due: async () => candidates, scheduled: async (c) => scheduled.push(c) },
    { create: async (job) => jobs.push(job) },
    {},
    {},
    {},
    true,
  );
  assert.equal(await service.enqueueEligible(), 2);
  assert.equal(scheduled.length, 2);
  assert.notEqual(jobs[0].idempotencyKey, jobs[1].idempotencyKey);
  assert.equal(jobs[0].kind, 'export_ready_check');
  assert.equal(jobs[1].initialCheckpoint.requestId, 'doordash-request');
});

test('revoked and replaced requests cannot read a mailbox', async () => {
  for (const state of [
    {
      status: 'requested',
      requestId: 'new',
      requestedAt: '2026-09-01',
      readyAlert: { consentState: 'granted', consentVersion: 'export-ready-background-v1' },
    },
    {
      status: 'requested',
      requestId: 'old',
      requestedAt: '2026-09-01',
      readyAlert: { consentState: 'revoked' },
    },
    {
      status: 'imported',
      requestId: 'old',
      requestedAt: '2026-09-01',
      readyAlert: { consentState: 'granted', consentVersion: 'export-ready-background-v1' },
    },
  ]) {
    const service = new ExportReadyAlertService(
      {},
      {},
      { getPreferences: async () => ({ export: { providers: { doorDash: state } } }) },
      {
        hasExportReadyEmail: () => {
          throw Error('must not read');
        },
      },
      {},
      true,
    );
    assert.equal(
      (
        await service.execute(
          { userId: 'user', exportProvider: 'doordash', checkpoint: { requestId: 'old' } },
          {},
        )
      ).skipped,
      true,
    );
  }
});

test('both mailbox adapters detect both delivery providers without committing lifecycle outside the worker transaction', async () => {
  const original = ImportLockService.assertLockOwned;
  ImportLockService.assertLockOwned = async () => {};
  try {
    for (const provider of ['uber_eats', 'doordash'])
      for (const mailbox of ['gmail', 'outlook']) {
        const state = {
          status: 'requested',
          requestId: 'request',
          requestedAt: '2026-09-01',
          readyAlert: { consentState: 'granted', consentVersion: 'export-ready-background-v1' },
        };
        const calls = [];
        const status = {
          getPreferences: async () => ({
            export: { providers: { uberEats: state, doorDash: state } },
            gmailConnection: {
              connectionHealth: mailbox === 'gmail' ? 'valid' : 'disconnected',
              connectionMode: 'offline',
            },
            outlookConnection: {
              connectionHealth: mailbox === 'outlook' ? 'valid' : 'disconnected',
              connectionMode: 'offline',
            },
          }),
          getConnection: async () => ({ user: { id: 'user' } }),
        };
        const adapter = {
          hasExportReadyEmail: async (_, after, delivery) => {
            calls.push([after, delivery]);
            return true;
          },
        };
        const service = new ExportReadyAlertService({}, {}, status, adapter, adapter, true);
        const result = await service.execute(
          { userId: 'user', exportProvider: provider, checkpoint: { requestId: 'request' } },
          {},
        );
        assert.equal(result.exportReadyDetected, true);
        assert.deepEqual(calls, [['2026-09-01', provider]]);
        assert.equal(state.status, 'requested');
      }
  } finally {
    ImportLockService.assertLockOwned = original;
  }
});

test('DoorDash screenshot reference qualifies without an invented ready subject', () => {
  assert.equal(isExportReadyMessage('doordash','DoorDash <privacy@doordash.com>','Your personal data',
    'Your data archive will be available for 14 days. If it is not downloaded during that time frame, you will need to make another request. View Your Data Archive'),true);
  assert.equal(isExportReadyMessage('doordash','privacy@doordash.com','Request received',
    'We will email you when your data is ready. Download your data after that email arrives.'),false);
});

test('background consent is persisted transactionally and never copies old Uber permission', async () => {
  const { ExportReadyAlertRepository } = require('../dist/services/data/ExportReadyAlertRepository');
  const calls = [];
  let transactions = 0;
  const query = async (sql, params) => { calls.push({ sql, params }); return { rows: [], rowCount: 1 }; };
  const repository = new ExportReadyAlertRepository({
    query: () => { throw Error('writes must be transactional'); },
    withTransaction: async callback => { transactions += 1; return callback({ query }); },
  });
  await repository.setConsent('user', 'doordash', 'granted');
  assert.equal(transactions, 1);
  assert.deepEqual(calls[2].params, ['user', 'doordash', 'granted', 'export-ready-background-v1']);
  assert.equal(calls.some(call => /monitoring_consent_state/.test(call.sql)), false);
});
