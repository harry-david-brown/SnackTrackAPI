const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  WrappedAnalyticsCalculator,
  WrappedAnalyticsService,
} = require('../dist/services/analytics/WrappedAnalyticsService');
const {
  WrappedAnalyticsQueryRepository,
} = require('../dist/services/analytics/WrappedAnalyticsQueryRepository');

const boundaryFixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'analytics', 'wrapped-boundaries.json'), 'utf8'),
);

const fixtureReceipts = (scenario) =>
  scenario.receipts.map((receipt, index) => ({
    ...receipt,
    userId: 'fixture-user',
    restaurantName: `Fixture Restaurant ${index + 1}`,
    orderDate: receipt.orderDate === null ? null : new Date(receipt.orderDate),
    amountSpent: 20,
    items: [{ name: 'Fixture Meal', quantity: 1, price: 20 }],
    deliveryTime: null,
  }));

test('wrapped formulas run as a pure calculator over supplied records and time policy', async () => {
  const calculator = new WrappedAnalyticsCalculator();
  const result = await calculator.calculate(
    [
      {
        id: 'receipt-1',
        userId: 'user-1',
        restaurantName: 'Cafe',
        orderDate: new Date('2026-08-01T03:00:00.000Z'),
        amountSpent: 20,
        items: [{ name: 'Soup', quantity: 1, price: 20 }],
        receiptType: 'uber_eats',
        dataSource: 'email',
        deliveryTime: null,
      },
    ],
    'UTC',
  );

  assert.equal(result.coverage.orderCount, 1);
  assert.equal(result.shame.lateNightOrders.count, 1);
});

test('wrapped orchestration performs queries while delegating formulas to the calculator port', async () => {
  const calls = [];
  const calculator = {
    calculate: async (receipts, timezone, percentiles) => {
      calls.push({ receipts, timezone, percentiles });
      return { shame: {}, flex: {}, comparative: {}, patterns: {} };
    },
  };
  const queries = {
    getUserTimezone: async () => 'America/Toronto',
    getUserReceipts: async () => [{ id: 'receipt-1' }],
    getPercentileRanks: async () => null,
  };

  await new WrappedAnalyticsService(queries, undefined, calculator).calculateWrappedAnalytics(
    'user-1',
  );
  assert.deepEqual(calls, [
    { receipts: [{ id: 'receipt-1' }], timezone: 'America/Toronto', percentiles: undefined },
  ]);
});

test('wrapped analytics query adapter rejects malformed receipt and percentile rows', async () => {
  const receiptQueries = {
    query: async () => ({
      rows: [
        {
          id: 'receipt-1',
          user_id: 'user-1',
          restaurant_name: 'Cafe',
          order_date: new Date(),
          amount_spent: 20,
          items: [],
          receipt_type: 'not-a-provider',
          data_source: 'email',
          delivery_time: null,
          external_id: null,
        },
      ],
    }),
  };
  await assert.rejects(
    new WrappedAnalyticsQueryRepository(receiptQueries).getUserReceipts('user-1'),
    (error) => error.code === 'DATABASE_ERROR',
  );

  const percentileQueries = {
    query: async () => ({
      rows: [{ spent_rank: 2, orders_rank: 0.5, night_owl_rank: 0.5, sample_size: 100 }],
    }),
  };
  await assert.rejects(
    new WrappedAnalyticsQueryRepository(percentileQueries).getPercentileRanks('user-1', 3),
    (error) => error.code === 'DATABASE_ERROR',
  );
});

test('fixture formulas honor both edges of the shared local late-night window', async () => {
  const scenario = boundaryFixtures.timezoneBoundary;
  const result = await new WrappedAnalyticsCalculator().calculate(
    fixtureReceipts(scenario),
    scenario.timezone,
  );

  assert.equal(result.shame.lateNightOrders.count, 2);
  assert.equal(result.shame.lateNightOrders.totalSpent, 40);
  assert.equal(result.flex.nightOwl.count, 2);
  assert.equal(result.flex.nightOwl.percentage, 50);
});

test('sparse fixture produces coverage without inventing date-dependent formulas', async () => {
  const scenario = boundaryFixtures.sparse;
  const result = await new WrappedAnalyticsCalculator().calculate(
    fixtureReceipts(scenario),
    scenario.timezone,
  );

  assert.deepEqual(result.coverage, {
    orderCount: 1,
    earliestOrderDate: null,
    latestOrderDate: null,
    dataSources: ['email'],
    hasExportData: false,
  });
  assert.equal(result.shame.lateNightOrders, undefined);
  assert.equal(result.shame.longestStreak, undefined);
  assert.equal(result.patterns.weekendWarrior, undefined);
});

test('mixed provider, source, and currency-shaped fixtures retain truthful coverage', async () => {
  const scenario = boundaryFixtures.mixed;
  const result = await new WrappedAnalyticsCalculator().calculate(
    fixtureReceipts(scenario),
    scenario.timezone,
  );

  assert.equal(result.coverage.orderCount, 2);
  assert.deepEqual(result.coverage.dataSources, ['csv', 'email']);
  assert.equal(result.coverage.hasExportData, true);
  // Currency-aware comparisons are deliberately unavailable until every
  // persisted source supplies currency and localized comparison prices.
  assert.equal(result.comparative.couldHaveBought, undefined);
  assert.equal(result.comparative.costPerMeal, undefined);
});
