const assert = require('node:assert/strict');
const test = require('node:test');

const {
  GmailImportAcquisitionService,
  resolveIncrementalGmailSearchAfter,
} = require('../dist/services/import/GmailImportAcquisitionService');
const {
  GmailImportLifecycleService,
} = require('../dist/services/import/GmailImportLifecycleService');
const { deduplicateReceipts } = require('../dist/services/import/ReceiptDeduplicator');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');

const receipt = ({ amount, externalId, minute = '2026-08-01T12:30:00.000Z' }) =>
  new Receipt(
    'user-1',
    [],
    amount,
    ReceiptType.UBER_EATS,
    'Example Kitchen',
    new Date(minute),
    DataSource.EMAIL,
    undefined,
    externalId,
  );

test('Gmail acquisition owns credential preflight and incremental message retrieval', async () => {
  const calls = [];
  const service = new GmailImportAcquisitionService(
    {
      getEmailPages: (_user, options) => {
        calls.push(options);
        return { async *[Symbol.asyncIterator]() {} };
      },
    },
    { getLatestCsvReceiptDates: async () => ({ uber_eats: new Date('2026-08-10T00:00:00Z') }) },
    {
      get: async () => ({
        lastSuccessfulCheckAt: '2026-08-20T00:00:00.000Z',
        gmailBaselineCompletedAt: '2026-08-01T00:00:00.000Z',
      }),
    },
    { get: async () => ({ allowForwardedReceipts: false }) },
    () => new Date('2026-08-31T00:00:00.000Z').getTime(),
  );

  const result = await service.acquire(
    { id: 'user-1', email: 'user@example.test', gmailRefreshToken: 'refresh-token' },
    'background',
  );
  assert.equal(result.searchAfter.toISOString(), '2026-08-18T00:00:00.000Z');
  assert.equal(calls[0].after.toISOString(), '2026-08-18T00:00:00.000Z');

  await assert.rejects(
    service.acquire({ id: 'user-1', email: 'user@example.test' }, 'manual'),
    /usable Gmail connection/,
  );
});

test('incremental cursor uses the earliest export cutoff with a reread window', () => {
  const after = resolveIncrementalGmailSearchAfter({
    lastSuccessfulCheckAt: null,
    gmailBaselineCompletedAt: '2026-08-15T00:00:00.000Z',
    csvCutoffs: {
      uber_eats: new Date('2026-08-10T00:00:00.000Z'),
      doordash: new Date('2026-08-12T00:00:00.000Z'),
    },
  });
  assert.equal(after.toISOString(), '2026-08-08T00:00:00.000Z');
});

test('receipt deduplication preserves revisions and ambiguous same-minute purchases', () => {
  const original = receipt({ amount: 20, externalId: 'order-1' });
  const tipUpdate = receipt({ amount: 25, externalId: 'order-1' });
  const fallbackDuplicate = receipt({ amount: 10 });
  const fallbackUpdate = receipt({ amount: 12 });

  const result = deduplicateReceipts([original, tipUpdate, fallbackDuplicate, fallbackUpdate]);
  assert.equal(result.receipts.length, 4);
  assert.deepEqual(
    result.receipts.map((value) => value.amountSpent).sort((left, right) => left - right),
    [10, 12, 20, 25],
  );
  assert.equal(result.duplicatesFound, 0);
  assert.equal(result.higherAmountReplacements, 0);
  assert.equal(result.totalBeforeDeduplication, 67);
  assert.equal(result.totalAfterDeduplication, 42);
});

test('Gmail lifecycle adapter owns sync transitions and reconnect persistence ordering', async () => {
  const calls = [];
  const service = new GmailImportLifecycleService(
    {
      startSyncRun: async (...args) => {
        calls.push(['start', ...args]);
        return 'run-1';
      },
      completeSyncRun: async (...args) => calls.push(['complete', ...args]),
      failSyncRun: async (...args) => calls.push(['fail', ...args]),
    },
    { markTrackingReconnectRequired: async (userId) => calls.push(['tracking', userId]) },
    { markGmailReconnectRequired: async (userId) => calls.push(['connection', userId]) },
  );

  assert.equal(await service.start('user-1', 'manual', 'job-1'), 'run-1');
  await service.fail('run-1', 'user-1', 'GMAIL_SYNC_FAILED', 'manual');
  await service.markReconnectRequired('user-1');
  assert.deepEqual(calls, [
    ['start', 'user-1', 'manual', 'job-1'],
    ['fail', 'run-1', 'user-1', 'GMAIL_SYNC_FAILED', 'manual'],
    ['connection', 'user-1'],
    ['tracking', 'user-1'],
  ]);
});
