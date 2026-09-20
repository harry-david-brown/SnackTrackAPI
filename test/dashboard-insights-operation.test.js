require('./helpers/legacyReceiptPolicy');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');

const {
  GetDashboardInsightsService,
} = require('../dist/services/user/GetDashboardInsightsService');

test('dashboard operation returns the daily cached edition without querying receipts', async () => {
  const cached = { metricVersion: 'cached' };
  const users = {
    findProjectionProfileById: async () => ({
      id: 'user-id',
      email: 'user@example.com',
      timezone: 'UTC',
      receiptProjectionRevision: '0',
    }),
  };
  const receipts = {
    findByUserId: async () => {
      throw new Error('should not query');
    },
  };
  const cache = { getDashboardInsightEdition: async () => cached };

  const result = await new GetDashboardInsightsService(users, receipts, cache).execute({
    userId: 'user-id',
    devDayOffset: 0,
  });

  assert.equal(result, cached);
});

test('dashboard preview bypasses shared cache reads and writes', async () => {
  let cacheOperations = 0;
  const users = {
    findProjectionProfileById: async () => ({
      id: 'user-id',
      email: 'user@example.com',
      timezone: 'UTC',
      receiptProjectionRevision: '0',
    }),
  };
  const receipts = { findByUserId: async () => [] };
  const cache = {
    getDashboardInsightEdition: async () => {
      cacheOperations += 1;
    },
    cacheDashboardInsightEdition: async () => {
      cacheOperations += 1;
    },
  };

  await new GetDashboardInsightsService(users, receipts, cache).execute({
    userId: 'user-id',
    devDayOffset: 1,
  });

  assert.equal(cacheOperations, 0);
});

test('dashboard insight drill-down returns only the exact contributing orders', async () => {
  const makeReceipt = (id, hour) => {
    const value = new Receipt(
      'user-id',
      [],
      20,
      ReceiptType.UBER_EATS,
      'Test Kitchen',
      new Date(`2026-08-13T${hour}:00:00.000Z`),
      DataSource.CSV,
    );
    value.id = id;
    return value;
  };
  const history = [makeReceipt('one', '10'), makeReceipt('two', '12'), makeReceipt('three', '18'), makeReceipt('other-day', '09')];
  history[3].orderDate = new Date('2026-08-12T09:00:00.000Z');
  const users = {
    findProjectionProfileById: async () => ({
      id: 'user-id', email: 'user@example.com', timezone: 'UTC', receiptProjectionRevision: '0',
    }),
  };
  const service = new GetDashboardInsightsService(
    users,
    { findByUserId: async () => history },
    {},
  );

  const result = await service.getInsightOrders({
    userId: 'user-id',
    insightId: 'multi-order-day',
    localDate: '2026-08-13',
    page: 1,
    limit: 30,
  });

  assert.equal(result.total, 3);
  assert.deepEqual(result.receipts.map(receipt => receipt.id), ['three', 'two', 'one']);
});
