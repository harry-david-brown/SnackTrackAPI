require('./helpers/legacyReceiptPolicy');
const test = require('node:test');
const assert = require('node:assert/strict');

const { GetUserSummaryService } = require('../dist/services/user/GetUserSummaryService');

test('recap currency and rate snapshot scope caches without changing ordinary summary totals', async () => {
  const keys = [], snapshots = [];
  let rateId = 'rates-a';
  const profile = { id: 'u', email: 'u@example.com', timezone: 'UTC', receiptProjectionRevision: '1' };
  const service = new GetUserSummaryService(
    { findProjectionProfileById: async () => profile },
    { findByUserId: async () => [] },
    { calculateWrappedAnalytics: async (_, snapshot) => { snapshots.push(snapshot); return {}; } },
    { getUserSummary: async key => { keys.push(key); return null; }, cacheUserSummary: async () => {} },
    { snapshot: async () => ({ id: rateId, date: '2023-12-10', rates: { CAD: 1.5, USD: 1 } }) },
  );
  await service.execute({ userId: 'u', includeWrapped: true, displayCurrency: 'CAD' });
  await service.execute({ userId: 'u', includeWrapped: true, displayCurrency: 'USD' });
  rateId = 'rates-b';
  await service.execute({ userId: 'u', includeWrapped: true, displayCurrency: 'USD' });
  await service.execute({ userId: 'u', includeWrapped: false });
  assert.equal(new Set(keys.filter(k => k.includes('wrapped'))).size, 3);
  assert.ok(keys.some(k => k === 'u:r1-v10-UTC'));
  assert.deepEqual(snapshots.map(s => s.displayCurrency), ['CAD', 'USD', 'USD']);
});

test('user summary operation owns timezone repair, aggregation, and cache write', async () => {
  const events = [];
  const profile = {
    id: 'user-id',
    email: 'user@example.com',
    timezone: 'UTC',
    receiptProjectionRevision: '0',
  };
  const users = {
    findProjectionProfileById: async () => ({ ...profile }),
    updateTimezone: async (_userId, timezone) => {
      profile.timezone = timezone;
      profile.receiptProjectionRevision = '1';
      events.push(`timezone:${timezone}`);
    },
  };
  const receipts = {
    findByUserId: async () => [
      {
        amountSpent: 12.345,
        dataSource: 'email',
        restaurantName: ' Test Kitchen ',
        orderDate: new Date(),
      },
      {
        amountSpent: 0,
        dataSource: 'csv',
        restaurantName: '---',
        orderDate: new Date(),
      },
    ],
  };
  const cache = {
    invalidateAllUserCaches: async () => events.push('invalidate'),
    getUserSummary: async () => null,
    cacheUserSummary: async (_key, summary) =>
      events.push(`cache:${summary.statistics.totalReceipts}`),
  };
  const wrapped = { calculateWrappedAnalytics: async () => ({}) };

  const summary = await new GetUserSummaryService(users, receipts, wrapped, cache).execute({
    userId: 'user-id',
    includeWrapped: false,
    requestTimezone: 'America/Toronto',
  });

  assert.deepEqual(events, ['timezone:America/Toronto', 'invalidate', 'cache:2']);
  assert.equal(summary.statistics.totalSpent, 12.35);
  assert.equal(summary.statistics.averageSpent, 6.18);
  assert.deepEqual(summary.statistics.topRestaurants, [
    { name: 'Test Kitchen', count: 1, total: 12.35 },
  ]);
  assert.equal(summary.validation.zeroAmountReceipts, 1);
});

test('user summary operation returns a valid cached projection without querying receipts', async () => {
  const cached = { user: { id: 'cached' } };
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
  const cache = { getUserSummary: async () => cached };

  const result = await new GetUserSummaryService(users, receipts, {}, cache).execute({
    userId: 'user-id',
    includeWrapped: false,
  });

  assert.equal(result, cached);
});
