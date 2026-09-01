const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dashboardInsightEditionCacheCodec,
  userSummaryCacheCodec,
} = require('../dist/services/core/cacheProjections');

test('user summary cache codec rejects malformed cached JSON', () => {
  assert.equal(userSummaryCacheCodec.decode('{not-json'), null);
  assert.equal(userSummaryCacheCodec.decode(JSON.stringify({ user: { id: 'user-id' } })), null);
});

test('user summary cache codec accepts the documented projection', () => {
  const summary = {
    user: { id: 'user-id', email: 'user@example.com', dataSource: 'csv' },
    statistics: {
      totalSpent: 12.5,
      averageSpent: 12.5,
      totalReceipts: 1,
      dataSourceBreakdown: { email: 1 },
      monthlyBreakdown: { '2026-08': { count: 1, total: 12.5 } },
      topRestaurants: [{ name: 'Test Kitchen', count: 1, total: 12.5 }],
    },
    validation: { issues: [], zeroAmountReceipts: 0, refundedReceipts: 0 },
    recentReceipts: [
      {
        restaurantName: 'Test Kitchen',
        amountSpent: 12.5,
        orderDate: '2026-08-01T12:00:00.000Z',
        dataSource: 'email',
      },
    ],
  };

  assert.deepEqual(userSummaryCacheCodec.decode(userSummaryCacheCodec.encode(summary)), summary);
});

test('dashboard edition cache codec rejects missing insight identity fields', () => {
  const edition = {
    localDate: '2026-08-31',
    timezone: 'America/Toronto',
    generatedAt: '2026-08-31T12:00:00.000Z',
    nextRefreshAt: '2026-09-01T04:00:00.000Z',
    metricVersion: 'test-v1',
    availableCandidateCount: 1,
    insights: [{ presentation: 'hero' }],
  };

  assert.equal(dashboardInsightEditionCacheCodec.decode(JSON.stringify(edition)), null);
});
