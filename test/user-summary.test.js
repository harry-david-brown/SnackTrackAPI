const test = require('node:test');
const assert = require('node:assert/strict');

const { GetUserSummaryService } = require('../dist/services/user/GetUserSummaryService');

test('user summary operation owns timezone repair, aggregation, and cache write', async () => {
  const events = [];
  const users = {
    findById: async () => ({ id: 'user-id', email: 'user@example.com', timezone: 'UTC' }),
    updateTimezone: async (_userId, timezone) => events.push(`timezone:${timezone}`),
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
    cacheUserSummary: async (_key, summary) => events.push(`cache:${summary.statistics.totalReceipts}`),
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
    findById: async () => ({ id: 'user-id', email: 'user@example.com', timezone: 'UTC' }),
  };
  const receipts = { findByUserId: async () => { throw new Error('should not query'); } };
  const cache = { getUserSummary: async () => cached };

  const result = await new GetUserSummaryService(users, receipts, {}, cache).execute({
    userId: 'user-id',
    includeWrapped: false,
  });

  assert.equal(result, cached);
});
