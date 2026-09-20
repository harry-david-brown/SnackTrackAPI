const test = require('node:test');
const assert = require('node:assert/strict');
const { decemberCanonicalOrders, analyticsReceipts } = require('./helpers/order-events-fixture');
const { GetUserSummaryService } = require('../dist/services/user/GetUserSummaryService');
const {
  WrappedAnalyticsCalculator,
} = require('../dist/services/analytics/WrappedAnalyticsService');
const {
  summarizeOrderMetrics,
  mostDeliveriesDay,
  summarizeOrderMetricPeriods,
} = require('../dist/services/analytics/shared/orderMetrics');
const { spendingByCurrency } = require('../dist/services/analytics/shared/receiptMetrics');
const { userSummaryCacheCodec } = require('../dist/services/core/cacheProjections');
const { isOrderMetrics } = require('../dist/services/analytics/shared/orderMetricContracts');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');

async function summary(receipts) {
  const wrapped = new WrappedAnalyticsCalculator();
  return new GetUserSummaryService(
    {
      findProjectionProfileById: async () => ({
        receiptProjectionRevision: '0',
        id: 'fixture-user',
        email: 'fixture@example.com',
        timezone: 'America/Toronto',
      }),
    },
    { findByUserId: async () => receipts },
    {
      calculateWrappedAnalytics: async () =>
        wrapped.calculate(analyticsReceipts(receipts), 'America/Toronto'),
    },
    { getUserSummary: async () => null, cacheUserSummary: async () => {} },
  ).execute({ userId: 'fixture-user', includeWrapped: true });
}

test('December replay agrees across shared metrics, summary, periods, coverage and Wrapped', async () => {
  const receipts = await decemberCanonicalOrders();
  const result = await summary(receipts);
  const metrics = summarizeOrderMetrics(receipts);
  assert.ok(isOrderMetrics(metrics));
  assert.deepEqual(
    { metrics, ranking: mostDeliveriesDay(receipts, 'America/Toronto') },
    require('./fixtures/analytics/order-event-metrics.json'),
  );
  assert.equal(metrics.attempts, 5);
  assert.equal(metrics.deliveries, 4);
  assert.equal(metrics.chargedCancellations, 1);
  assert.equal(metrics.confirmedRefunds, 1);
  assert.equal(metrics.currencies[0].netSpend, 157.02);
  assert.equal(metrics.currencies[0].deliveredNetSpend, 113.76);
  assert.deepEqual(metrics.currencies[0].payments, [
    { tender: 'card', charges: 153.81, refunds: 0, refundReversals: 0 },
    { tender: 'provider_wallet', charges: 25.69, refunds: 22.48, refundReversals: 0 },
  ]);
  assert.equal(result.statistics.totalReceipts, 5);
  assert.equal(result.statistics.totalSpent, 157.02);
  assert.equal(
    result.statistics.topRestaurants.reduce((n, r) => n + r.count, 0),
    4,
  );
  assert.deepEqual(result.statistics.dataSourceBreakdown, { csv: 5, email: 5 });
  assert.deepEqual(result.statistics.orderMetrics, metrics);
  assert.deepEqual(result.statistics.orderMetricPeriods.days['2023-12-10'], metrics);
  assert.deepEqual(result.statistics.orderMetricPeriods.months['2023-12'], metrics);
  assert.deepEqual(result.wrappedAnalytics.orderMetrics, metrics);
  assert.deepEqual(result.wrappedAnalytics.coverage.dataSources, ['csv', 'email']);
  assert.equal(result.wrappedAnalytics.coverage.orderCount, 5);
  const day = result.wrappedAnalytics.deliveryDayRanking;
  assert.equal(day.status, 'available');
  assert.equal(day.day, '2023-12-10');
  assert.equal(day.deliveries, 4);
  assert.equal(day.spending[0].netSpend, 113.76);
  assert.equal(result.wrappedAnalytics.shame.laziestDay.orderCount, 4);
  assert.equal(result.wrappedAnalytics.shame.laziestDay.totalSpent, 113.76);
  assert.deepEqual(
    userSummaryCacheCodec.decode(JSON.stringify(result)),
    JSON.parse(JSON.stringify(result)),
  );
});

test('a confirmed refund with unknown starting balance appears consistently without inventing spend or refund size', async () => {
  const canonical = (await decemberCanonicalOrders())[0];
  const original = structuredClone(canonical);
  const notice = structuredClone(canonical);
  original.resolution.orderEvidence = {
    version: 1,
    parserVersion: 3,
    documentKind: 'original',
    fulfillment: 'completed',
    recordedTotal: null,
    totalState: 'unavailable',
    timestamps: [],
    payments: [],
    issues: [],
  };
  notice.resolution.orderEvidence = {
    ...original.resolution.orderEvidence,
    documentKind: 'refund',
    fulfillment: 'unknown',
    payments: [
      { kind: 'refund', amount: 10, tender: 'provider_wallet', reference: 'confirmed-refund' },
    ],
  };
  const outcome = resolveOrderOutcome([
    { id: 'original', receipt: original },
    { id: 'refund', receipt: notice },
  ]);
  canonical.resolution.orderOutcome = outcome;
  const result = await summary([canonical]);
  const metrics = result.statistics.orderMetrics;
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.deliveries, 1);
  assert.equal(metrics.confirmedRefunds, 1);
  assert.equal(metrics.unclassifiedRefunds, 1);
  assert.equal(metrics.fullyRefunded, 0);
  assert.equal(metrics.partiallyRefunded, 0);
  assert.equal(metrics.likelyRefunds, 0);
  assert.equal(metrics.currencies[0].confirmedRefundAmount, 10);
  assert.equal(metrics.currencies[0].netSpend, 0);
  assert.equal(metrics.currencies[0].pricedOrders, 0);
  assert.equal(metrics.currencies[0].unknownPriceOrders, 1);
  assert.deepEqual(result.wrappedAnalytics.orderMetrics, metrics);
  assert.deepEqual(result.statistics.orderMetricPeriods.months['2023-12'], metrics);
  assert.ok(isOrderMetrics(metrics));
  assert.equal(isOrderMetrics({ ...metrics, unclassifiedRefunds: -1 }), false);
  assert.deepEqual(
    userSummaryCacheCodec.decode(JSON.stringify(result)),
    JSON.parse(JSON.stringify(result)),
  );
  canonical.resolution.orderOutcome = resolveOrderOutcome([{ id: 'refund', receipt: notice }]);
  const orphanMetrics = summarizeOrderMetrics([canonical]);
  assert.equal(orphanMetrics.unlinkedAdjustments, 1);
  assert.equal(orphanMetrics.attempts, 0);
  assert.equal(
    orphanMetrics.confirmedRefunds,
    0,
    'an unassociated refund is not a counted refunded order',
  );
});

test('an amount-less confirmed refund stays unpriced across Summary, periods, Wrapped and cache decoding', async () => {
  const canonical = (await decemberCanonicalOrders())[0];
  const original = structuredClone(canonical);
  original.resolution.orderEvidence = {
    version: 1,
    parserVersion: 3,
    documentKind: 'original',
    fulfillment: 'completed',
    recordedTotal: 40,
    totalState: 'known',
    timestamps: [],
    payments: [],
    issues: [],
  };
  const notice = structuredClone(original);
  Object.assign(notice.resolution.orderEvidence, {
    documentKind: 'refund',
    fulfillment: 'unknown',
    recordedTotal: null,
    totalState: 'unavailable',
    refundConfirmed: true,
  });
  canonical.resolution.orderOutcome = resolveOrderOutcome([
    { id: 'original', receipt: original },
    { id: 'notice', receipt: notice },
  ]);
  canonical.amountSpent = 999; // A stale compatibility value cannot override canonical unknown cost.
  const result = await summary([canonical]);
  const metrics = result.statistics.orderMetrics;
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.deliveries, 1);
  assert.equal(metrics.confirmedRefunds, 1);
  assert.equal(metrics.unclassifiedRefunds, 1);
  assert.equal(metrics.likelyRefunds, 0);
  assert.equal(metrics.currencies[0].confirmedRefundAmount, 0);
  assert.equal(metrics.currencies[0].confirmedRefundsWithUnknownAmount, 1);
  assert.equal(metrics.currencies[0].unknownPriceOrders, 1);
  assert.equal(metrics.currencies[0].pricedOrders, 0);
  assert.equal(result.statistics.totalSpent, 0);
  assert.deepEqual(result.wrappedAnalytics.orderMetrics, metrics);
  assert.deepEqual(result.statistics.orderMetricPeriods.months['2023-12'], metrics);
  assert.deepEqual(
    userSummaryCacheCodec.decode(JSON.stringify(result)),
    JSON.parse(JSON.stringify(result)),
  );
});

for (const dataSource of ['email', 'csv'])
  test(`${dataSource}: unresolved original and unlinked adjustment stay visible but do not inflate established totals or rankings`, async () => {
    const receipts = await decemberCanonicalOrders();
    const uncertain = structuredClone(receipts.find((r) => r.amountSpent > 0));
    uncertain.dataSource = dataSource;
    uncertain.resolution.reconciliation.status = 'unresolved';
    const unlinked = structuredClone(uncertain);
    unlinked.resolution.orderOutcome.kind = 'unlinked_adjustment';
    const result = await summary([...receipts, uncertain, unlinked]);
    assert.equal(result.statistics.totalSpent, 157.02);
    assert.equal(result.statistics.totalReceipts, 5);
    assert.equal(result.statistics.orderMetrics.possibleAdditionalOrders, 1);
    assert.equal(result.statistics.orderMetrics.unlinkedAdjustments, 1);
    assert.equal(
      result.statistics.orderMetrics.currencies[0].possibleAdditionalSpend,
      uncertain.resolution.orderOutcome.netAmount,
    );
    assert.equal(result.wrappedAnalytics.deliveryDayRanking.status, 'available');
    assert.equal(result.wrappedAnalytics.shame.laziestDay.orderCount, 4);
    assert.equal(result.wrappedAnalytics.shame.chainDependency.orderCount, 2);
  });

test('unknown costs remain unpriced, zero is not a refund, and no legacy percentile is relabeled', async () => {
  const receipts = await decemberCanonicalOrders();
  const unknown = structuredClone(receipts[0]);
  Object.assign(unknown.resolution.orderOutcome, {
    netAmount: null,
    financialConfidence: 'unknown',
    refundStatus: 'zero_unexplained',
    refundConfidence: 'unknown',
  });
  const metrics = summarizeOrderMetrics([unknown]);
  assert.equal(metrics.currencies[0].unknownPriceOrders, 1);
  assert.equal(metrics.confirmedRefunds, 0);
  assert.equal(metrics.likelyRefunds, 0);
  assert.deepEqual(spendingByCurrency([unknown]), {
    primary: 'CAD',
    buckets: { CAD: { total: 0, count: 0 } },
  });
  const result = await new WrappedAnalyticsCalculator().calculate(
    analyticsReceipts([unknown]),
    'America/Toronto',
    { sampleSize: 150, orderCount: { percentile: 99, topPercent: 1 } },
  );
  assert.equal(result.flex.mostExpensiveOrder, undefined);
  assert.equal(result.shame.singleItemOrders, undefined);
  assert.equal(result.percentiles, undefined);
  assert.equal(result.deliveryDayRanking.spending[0].unknownPriceOrders, 1);
});

test('primary currency follows the largest share of established receipts, including unknown prices', async () => {
  const receipts = await decemberCanonicalOrders();
  const cadUnknown = receipts.slice(0, 2).map((receipt, index) => {
    const copy = structuredClone(receipt);
    copy.id = `cad-unknown-${index}`;
    copy.resolution.orderOutcome.netAmount = null;
    copy.resolution.orderOutcome.financialConfidence = 'unknown';
    return copy;
  });
  const usdKnown = structuredClone(receipts[2]);
  usdKnown.id = 'usd-known';
  usdKnown.monetaryDetails.currencyCode = 'USD';

  assert.equal(spendingByCurrency([...cadUnknown, usdKnown]).primary, 'CAD');
});

test('day ranking and period grouping retain event timezone after travel and never rank missing dates', async () => {
  const receipts = await decemberCanonicalOrders();
  const order = receipts.find((r) => r.resolution.orderOutcome.fulfillment === 'completed');
  order.orderDate = new Date('2023-12-10T05:30:00Z');
  assert.equal(mostDeliveriesDay([order], 'America/Los_Angeles').day, '2023-12-10');
  assert.equal(
    summarizeOrderMetricPeriods([order], 'America/Los_Angeles').days['2023-12-10'].deliveries,
    1,
  );
  delete order.orderDate;
  assert.deepEqual(mostDeliveriesDay([order], 'UTC'), {
    status: 'matching',
    reason: 'missing_order_dates',
  });
  assert.equal(summarizeOrderMetricPeriods([order], 'UTC').undatedRecords, 1);
});

test('policy-3 cache rejects malformed currencies, payment allocations and fractional counts', async () => {
  const result = await summary(await decemberCanonicalOrders());
  for (const mutate of [
    (m) => {
      m.attempts = 5.5;
    },
    (m) => {
      m.currencies[0].payments[0].charges = '153.81';
    },
    (m) => {
      m.currencies.push(m.currencies[0]);
    },
    (m) => {
      m.currencies[0].netSpend = -1;
    },
  ]) {
    const copy = structuredClone(result);
    mutate(copy.statistics.orderMetrics);
    assert.equal(userSummaryCacheCodec.decode(JSON.stringify(copy)), null);
  }
});

test('date-only deliveries never become midnight hunger stories and cancellations cannot drive item stories', async () => {
  const receipts = await decemberCanonicalOrders();
  const dateOnly = structuredClone(
    receipts.find((r) => r.resolution.orderOutcome.fulfillment === 'completed'),
  );
  dateOnly.resolution.timestamp.precision = 'day';
  dateOnly.orderDate = new Date('2023-12-10T05:00:00Z');
  const canceled = receipts.find((r) => r.resolution.orderOutcome.fulfillment === 'canceled');
  const result = await new WrappedAnalyticsCalculator().calculate(
    analyticsReceipts([dateOnly, canceled]),
    'America/Toronto',
  );
  assert.equal(result.deliveryDayRanking.deliveries, 1);
  assert.equal(result.shame.lateNightOrders, undefined);
  assert.equal(result.patterns.peakHungerHour, undefined);
  assert.equal(result.patterns.deliveryWaits, undefined);
  assert.equal(result.shame.singleItemOrders.count, 1);
  assert.equal(result.orderMetrics.canceled, 1);
});

test('currency buckets never sum CAD with USD and preserve unpriced costs', async () => {
  const receipts = await decemberCanonicalOrders();
  const usd = structuredClone(
    receipts.find(
      (r) =>
        r.resolution.orderOutcome.fulfillment === 'completed' &&
        r.resolution.orderOutcome.netAmount > 0,
    ),
  );
  usd.monetaryDetails.currencyCode = 'USD';
  usd.resolution.orderOutcome.events = [];
  const result = await summary([...receipts, usd]);
  assert.equal(result.statistics.totalSpent, 157.02);
  assert.equal(result.statistics.totalsByCurrency.USD.total, usd.resolution.orderOutcome.netAmount);
  assert.equal(result.wrappedAnalytics.deliveryDayRanking.spending.length, 2);
  assert.equal(result.statistics.orderMetrics.currencies.length, 2);
});

test('Summary cache rejects old behavior formulas and malformed story-level cost evidence', async () => {
  const result = await summary(await decemberCanonicalOrders());
  assert.equal(result.wrappedAnalytics.behaviorPolicyVersion, 1);
  assert.ok(userSummaryCacheCodec.decode(JSON.stringify(result)));
  for (const mutate of [
    (wrapped) => {
      delete wrapped.behaviorPolicyVersion;
    },
    (wrapped) => {
      wrapped.shame.lateNightOrders.totalSpent = 0;
    },
    (wrapped) => {
      wrapped.shame.lateNightOrders.spending[0].unknownPriceOrders = 1;
    },
    (wrapped) => {
      wrapped.shame.lateNightOrders.spending[0].estimatedPriceOrders = 100;
    },
    (wrapped) => {
      wrapped.shame.chainDependency.allChains[0].spending.push(
        wrapped.shame.chainDependency.allChains[0].spending[0],
      );
    },
    (wrapped) => {
      wrapped.patterns.weekendWarrior.ratio = 5;
      delete wrapped.patterns.weekendWarrior.ratioBasis;
    },
    (wrapped) => {
      wrapped.flex.coffeeAddiction = { totalSpent: 14, averagePrice: 7 };
    },
  ]) {
    const copy = structuredClone(result);
    mutate(copy.wrappedAnalytics);
    assert.equal(userSummaryCacheCodec.decode(JSON.stringify(copy)), null);
  }
});
