require('./helpers/legacyReceiptPolicy');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
const { buildDashboardInsightCatalogue } = require('../dist/services/analytics/dashboard');
const {
  GetDashboardInsightsService,
} = require('../dist/services/user/GetDashboardInsightsService');
const {
  WrappedAnalyticsCalculator,
} = require('../dist/services/analytics/WrappedAnalyticsService');
const { investmentContext } = require('../dist/services/analytics/shared/historicalInvestment');
const { marketSessions } = require('../dist/services/market/marketCalendar');
const id = '12345678-1234-1234-1234-123456789abc';
const points = marketSessions('2025-12-31', '2026-07-31').map((date, i) => ({
  date,
  close: 100 + i,
}));
const snapshot = {
  id,
  provider: 'finazon',
  adjustment: 'all',
  retrievedAt: '2026-08-01T08:00:00Z',
  valuationDate: '2026-07-31',
  series: { sp500: points, nasdaq: points },
};
const market = investmentContext('historical', snapshot, new Date('2026-08-01'));
function receipts() {
  return [
    '2026-01-01',
    '2026-01-20',
    '2026-02-10',
    '2026-03-10',
    '2026-04-10',
    '2026-07-20',
    '2026-08-01',
  ].map((date, i) => {
    const r = new Receipt(
      'user-id',
      [],
      20,
      ReceiptType.UBER_EATS,
      'Cafe',
      new Date(`${date}T18:00:00Z`),
      DataSource.CSV,
    );
    r.id = `order-${i}`;
    r.monetaryDetails = { currencyCode: 'CAD' };
    return r;
  });
}
test('dashboard calculation, sample count, and pinned receipt drilldown share the cutoff', async () => {
  const rows = receipts();
  const candidate = buildDashboardInsightCatalogue(
    rows,
    'UTC',
    new Date('2026-08-02'),
    market,
  ).eligible.find((c) => c.insight.id === 'hypothetical-investment');
  assert.ok(candidate);
  assert.equal(candidate.insight.historicalInvestment.contributionCount, 6);
  assert.equal(candidate.insight.methodology.sampleSize, 6);
  assert.equal(candidate.orderIds.length, 6);
  assert.ok(!candidate.orderIds.includes('order-6'));
  assert.doesNotMatch(JSON.stringify(candidate.insight), /SPY|QQQ|7%/);
  let requestedId;
  const service = new GetDashboardInsightsService(
    { findProjectionProfileById: async () => ({ timezone: 'UTC' }) },
    { findByUserId: async () => rows },
    {},
    {
      context: async (_, selected) => {
        requestedId = selected;
        return market;
      },
    },
  );
  const page = await service.getInsightOrders({
    userId: 'user-id',
    insightId: 'hypothetical-investment',
    localDate: '2026-08-02',
    snapshotId: id,
    page: 1,
    limit: 50,
  });
  assert.equal(requestedId, id);
  assert.equal(page.total, 6);
  assert.deepEqual(new Set(page.receipts.map((r) => r.id)), new Set(candidate.orderIds));
});
test('snapshot publication and freshness change dashboard cache identity', async () => {
  const keys = [];
  let current = market;
  const service = new GetDashboardInsightsService(
    {
      findProjectionProfileById: async () => ({ timezone: 'UTC', receiptProjectionRevision: '1' }),
    },
    {},
    {
      getDashboardInsightEdition: async (key) => {
        keys.push(key);
        return {};
      },
    },
    { context: async () => current },
  );
  await service.execute({ userId: 'user-id', devDayOffset: 0 });
  current = investmentContext(
    'historical',
    { ...snapshot, id: '22345678-1234-1234-1234-123456789abc' },
    new Date('2026-08-01'),
  );
  await service.execute({ userId: 'user-id', devDayOffset: 0 });
  current = investmentContext('historical', current.snapshot, new Date('2026-10-03'));
  await service.execute({ userId: 'user-id', devDayOffset: 0 });
  assert.equal(new Set(keys).size, 3);
});
test('Wrapped emits historical metadata and omits legacy annual-rate fields', async () => {
  const rows = receipts().map((r) => ({ ...r, currencyCode: 'CAD', deliveryTime: null }));
  const calculator = new WrappedAnalyticsCalculator();
  const result = await calculator.calculate(rows, 'UTC', undefined, market);
  assert.equal(result.comparative.missedInvestment, undefined);
  assert.equal(result.comparative.historicalInvestment.contributed, 120);
  assert.equal(result.comparative.historicalInvestment.contributionCount, 6);
  const unavailable = await calculator.calculate(
    rows,
    'UTC',
    undefined,
    investmentContext('historical', null, new Date()),
  );
  assert.equal(unavailable.comparative.missedInvestment, undefined);
  assert.equal(unavailable.comparative.historicalInvestment, undefined);
  const rollback = await calculator.calculate(rows, 'UTC');
  assert.equal(rollback.comparative.missedInvestment.sp500Return, 7);
});
test('historical dashboard uses known net amounts in one currency and excludes fully refunded contributions', () => {
  const rows = receipts();
  rows[0].amountSpent = 10;
  const refunded = new Receipt(
    'user-id',
    [],
    0,
    ReceiptType.UBER_EATS,
    'Cafe',
    new Date('2026-01-03'),
    DataSource.CSV,
  );
  refunded.id = 'refunded';
  refunded.monetaryDetails = { currencyCode: 'CAD' };
  const euro = new Receipt(
    'user-id',
    [],
    1000,
    ReceiptType.UBER_EATS,
    'Cafe',
    new Date('2026-01-04'),
    DataSource.CSV,
  );
  euro.id = 'euro';
  euro.monetaryDetails = { currencyCode: 'EUR' };
  const candidate = buildDashboardInsightCatalogue(
    [...rows, refunded, euro],
    'UTC',
    new Date('2026-08-02'),
    market,
  ).eligible.find((c) => c.insight.id === 'hypothetical-investment');
  assert.equal(candidate.insight.historicalInvestment.contributed, 110);
  assert.ok(!candidate.orderIds.includes('euro'));
  assert.ok(!candidate.orderIds.includes('refunded'));
});
