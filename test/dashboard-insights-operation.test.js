const test = require('node:test');
const assert = require('node:assert/strict');

const { GetDashboardInsightsService } = require('../dist/services/user/GetDashboardInsightsService');

test('dashboard operation returns the daily cached edition without querying receipts', async () => {
  const cached = { metricVersion: 'cached' };
  const users = {
    findById: async () => ({ id: 'user-id', email: 'user@example.com', timezone: 'UTC' }),
  };
  const receipts = { findByUserId: async () => { throw new Error('should not query'); } };
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
    findById: async () => ({ id: 'user-id', email: 'user@example.com', timezone: 'UTC' }),
  };
  const receipts = { findByUserId: async () => [] };
  const cache = {
    getDashboardInsightEdition: async () => { cacheOperations += 1; },
    cacheDashboardInsightEdition: async () => { cacheOperations += 1; },
  };

  await new GetDashboardInsightsService(users, receipts, cache).execute({
    userId: 'user-id',
    devDayOffset: 1,
  });

  assert.equal(cacheOperations, 0);
});
