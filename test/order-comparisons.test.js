const test = require('node:test');
const assert = require('node:assert/strict');
const { decemberCanonicalOrders, analyticsReceipts } = require('./helpers/order-events-fixture');
const {
  buildOrderComparisonProfile,
} = require('../dist/services/analytics/shared/orderComparisons');
const {
  WrappedAnalyticsService,
  WrappedAnalyticsCalculator,
} = require('../dist/services/analytics/WrappedAnalyticsService');
const {
  isWrappedPercentiles,
} = require('../dist/services/analytics/shared/orderComparisonContracts');
const { userSummaryCacheCodec } = require('../dist/services/core/cacheProjections');
const {
  WrappedAnalyticsQueryRepository,
} = require('../dist/services/analytics/WrappedAnalyticsQueryRepository');
const { GetUserSummaryService } = require('../dist/services/user/GetUserSummaryService');

test('comparison profile uses canonical net cost, deliveries and explicitly timed late-night share', async () => {
  const receipts = await decemberCanonicalOrders();
  assert.deepEqual(buildOrderComparisonProfile(receipts, 'America/Toronto'), {
    currencyCode: 'CAD',
    netSpend: 157.02,
    pricedOrders: 5,
    estimatedNetCost: false,
    deliveries: 4,
    timedDeliveries: 4,
    nightOwlShare: 0.5,
  });
  for (const r of receipts) r.resolution.timestamp.precision = 'day';
  const dateOnly = buildOrderComparisonProfile(receipts, 'America/Toronto');
  assert.equal(dateOnly.netSpend, 157.02);
  assert.equal(dateOnly.deliveries, 4);
  assert.equal(dateOnly.timedDeliveries, 0);
  assert.equal(dateOnly.nightOwlShare, null);
});

test('each comparison has independent evidence requirements, with no fake zero for an unknown measure', async () => {
  const receipts = await decemberCanonicalOrders();
  receipts[0].resolution.orderOutcome.netAmount = null;
  assert.equal(buildOrderComparisonProfile(receipts, 'America/Toronto').netSpend, null);
  assert.equal(buildOrderComparisonProfile(receipts, 'America/Toronto').deliveries, 4);
  receipts[0].resolution.orderOutcome.fulfillment = 'unknown';
  assert.equal(buildOrderComparisonProfile(receipts, 'America/Toronto').deliveries, null);
  assert.equal(buildOrderComparisonProfile(receipts, 'America/Toronto').nightOwlShare, null);
  const extra = structuredClone(receipts[1]);
  extra.dataSource = 'email';
  extra.resolution.reconciliation.status = 'unresolved';
  assert.equal(buildOrderComparisonProfile([...receipts, extra], 'America/Toronto').netSpend, null);
});

test('unlinked adjustments and legacy sources exclude only unsupported comparisons; currencies are not combined', async () => {
  const receipts = await decemberCanonicalOrders();
  const orphan = structuredClone(receipts[0]);
  orphan.resolution.orderOutcome.kind = 'unlinked_adjustment';
  const profile = buildOrderComparisonProfile([...receipts, orphan], 'America/Toronto');
  assert.equal(profile.netSpend, null);
  assert.equal(profile.deliveries, 4);
  const legacy = structuredClone(receipts[0]);
  delete legacy.resolution.orderOutcome;
  assert.equal(
    buildOrderComparisonProfile([...receipts, legacy], 'America/Toronto').netSpend,
    null,
  );
  const usd = structuredClone(receipts[0]);
  usd.monetaryDetails.currencyCode = 'USD';
  assert.equal(buildOrderComparisonProfile([...receipts, usd], 'America/Toronto').netSpend, 157.02);
});

test('comparison query decoder rejects null, malformed, duplicate and impossible ranked rows', async () => {
  const target = buildOrderComparisonProfile(await decemberCanonicalOrders(), 'America/Toronto');
  const valid = { metric: 'spent', lower_count: 99, sample_size: 100, estimated_net_cost: false };
  for (const rows of [
    [{ ...valid, lower_count: null }],
    [{ ...valid, sample_size: '' }],
    [{ ...valid, lower_count: [] }],
    [{ ...valid, sample_size: [100] }],
    [{ ...valid, lower_count: 100 }],
    [{ ...valid, lower_count: 0.5 }],
    [{ ...valid, estimated_net_cost: 'false' }],
    [{ ...valid, metric: 'fake' }],
    [valid, valid],
  ])
    await assert.rejects(
      new WrappedAnalyticsQueryRepository({ query: async () => ({ rows }) }).getPercentileRanks(
        'fixture-user',
        3,
        target,
      ),
      (e) => e.code === 'DATABASE_ERROR',
    );
  let parameters;
  const repository = new WrappedAnalyticsQueryRepository({
    query: async (_sql, params) => {
      parameters = params;
      return { rows: [valid] };
    },
  });
  const result = await repository.getPercentileRanks('fixture-user', 3, target);
  assert.deepEqual(result.totalSpent, { lowerCount: 99, sampleSize: 100 });
  assert.equal(result.orderCount, null);
  assert.equal(JSON.parse(parameters[2]).net_spend, 157.02);
});

test('comparison service uses independent minimum sample sizes and tie-safe top-percent rounding', async () => {
  const receipts = analyticsReceipts(await decemberCanonicalOrders());
  let target;
  const service = new WrappedAnalyticsService({
    getUserTimezone: async () => 'America/Toronto',
    getUserReceipts: async () => receipts,
    getPercentileRanks: async (_userId, minimum, profile) => {
      assert.equal(minimum, 3);
      target = profile;
      return {
        policyVersion: 3,
        currencyCode: 'CAD',
        estimatedNetCost: true,
        totalSpent: { lowerCount: 198, sampleSize: 200 },
        orderCount: { lowerCount: 98, sampleSize: 99 },
        nightOwl: { lowerCount: 197, sampleSize: 200 },
      };
    },
  });
  const result = await service.calculateWrappedAnalytics('fixture-user');
  assert.equal(target.netSpend, 157.02);
  assert.deepEqual(result.percentiles.totalSpent, {
    percentile: 99,
    topPercent: 1,
    sampleSize: 200,
  });
  assert.equal(result.percentiles.orderCount, undefined);
  assert.deepEqual(result.percentiles.nightOwl, { percentile: 98, topPercent: 2, sampleSize: 200 });
  assert.equal(result.percentiles.policyVersion, 3);
  assert.match(result.percentiles.methodology, /include recorded\/export estimates/);
});

test('Summary and Wrapped reuse one receipt snapshot even when an import changes the database before comparisons finish', async () => {
  const receipts = await decemberCanonicalOrders();
  const originalIds = receipts.map((r) => r.id);
  let reads = 0;
  const wrapped = new WrappedAnalyticsService({
    getUserTimezone: async () => {
      throw Error('must use snapshot timezone');
    },
    getUserReceipts: async () => {
      throw Error('must not read a second set of receipts');
    },
    getPercentileRanks: async (_userId, _minimum, target) => {
      assert.equal(target.deliveries, 4);
      assert.equal(target.netSpend, 157.02);
      return {
        policyVersion: 3,
        currencyCode: 'CAD',
        totalSpent: null,
        orderCount: null,
        nightOwl: null,
        estimatedNetCost: false,
      };
    },
  });
  const summary = await new GetUserSummaryService(
    {
      findProjectionProfileById: async () => ({
        receiptProjectionRevision: '0',
        id: 'fixture-user',
        email: 'fixture@example.test',
        timezone: 'America/Toronto',
      }),
    },
    {
      findByUserId: async () => {
        reads++;
        return structuredClone(receipts);
      },
    },
    wrapped,
    { getUserSummary: async () => null, cacheUserSummary: async () => {} },
  ).execute({ userId: 'fixture-user', includeWrapped: true });
  assert.equal(reads, 1);
  assert.equal(
    summary.statistics.totalSpent,
    summary.wrappedAnalytics.orderMetrics.currencies[0].netSpend,
  );
  assert.equal(summary.statistics.totalReceipts, summary.wrappedAnalytics.orderMetrics.attempts);
  assert.deepEqual(
    receipts.map((r) => r.id),
    originalIds,
  );
  await assert.rejects(
    wrapped.calculateWrappedAnalytics('other-user', { receipts, timezone: 'America/Toronto' }),
    /another account/,
  );
});

test('current comparisons discard unsupported metrics independently, while missing days do not erase all-time delivery standings', async () => {
  const receipts = analyticsReceipts(await decemberCanonicalOrders());
  const comparison = {
    policyVersion: 3,
    currencyCode: 'CAD',
    sampleSize: 200,
    methodology: 'Separate eligible groups.',
    totalSpent: { percentile: 70, topPercent: 30, sampleSize: 150 },
    orderCount: { percentile: 60, topPercent: 40, sampleSize: 200 },
    nightOwl: { percentile: 50, topPercent: 50, sampleSize: 120 },
  };
  for (const receipt of receipts) {
    receipt.orderDate = null;
    receipt.resolution.timestamp.precision = 'day';
  }
  let result = await new WrappedAnalyticsCalculator().calculate(
    receipts,
    'America/Toronto',
    comparison,
  );
  assert.equal(result.deliveryDayRanking.status, 'matching');
  assert.deepEqual(result.percentiles.orderCount, comparison.orderCount);
  assert.equal(result.percentiles.nightOwl, undefined);
  receipts[0].resolution.orderOutcome.netAmount = null;
  result = await new WrappedAnalyticsCalculator().calculate(
    receipts,
    'America/Toronto',
    comparison,
  );
  assert.equal(result.percentiles.totalSpent, undefined);
  assert.deepEqual(result.percentiles.orderCount, comparison.orderCount);
  receipts[0].resolution.orderOutcome.fulfillment = 'unknown';
  assert.equal(
    (await new WrappedAnalyticsCalculator().calculate(receipts, 'America/Toronto', comparison))
      .percentiles,
    undefined,
  );
  const fresh = analyticsReceipts(await decemberCanonicalOrders());
  result = await new WrappedAnalyticsCalculator().calculate(fresh, 'America/Toronto', {
    ...comparison,
    currencyCode: 'USD',
  });
  assert.equal(result.percentiles.totalSpent, undefined);
  assert.deepEqual(result.percentiles.nightOwl, comparison.nightOwl);
});

test('comparison cache and runtime contract retain separate sizes and reject malformed version, range, currency and denominator', () => {
  const comparison = {
    policyVersion: 3,
    sampleSize: 200,
    currencyCode: 'CAD',
    methodology: 'Separate eligible groups.',
    totalSpent: { percentile: 29, topPercent: 71, sampleSize: 200 },
    orderCount: { percentile: 60, topPercent: 40, sampleSize: 100 },
  };
  const projection = (percentiles) => ({
    user: { id: 'fixture-user', email: 'fixture@example.test', dataSource: 'csv' },
    statistics: {
      totalSpent: 0,
      averageSpent: 0,
      totalReceipts: 0,
      dataSourceBreakdown: {},
      monthlyBreakdown: {},
      topRestaurants: [],
    },
    validation: { issues: [], zeroAmountReceipts: 0, refundedReceipts: 0 },
    recentReceipts: [],
    wrappedAnalytics: { percentiles },
  });
  assert.equal(isWrappedPercentiles(comparison), true);
  assert.deepEqual(
    userSummaryCacheCodec.decode(JSON.stringify(projection(comparison))).wrappedAnalytics
      .percentiles,
    comparison,
  );
  for (const invalid of [
    { ...comparison, policyVersion: 4 },
    { ...comparison, sampleSize: 100 },
    { ...comparison, currencyCode: 'UNKNOWN' },
    { ...comparison, methodology: '' },
    { ...comparison, totalSpent: { ...comparison.totalSpent, sampleSize: 99 } },
    { ...comparison, totalSpent: { ...comparison.totalSpent, topPercent: 70 } },
    { ...comparison, totalSpent: { ...comparison.totalSpent, percentile: 100, topPercent: 0 } },
  ]) {
    assert.equal(isWrappedPercentiles(invalid), false);
    assert.equal(userSummaryCacheCodec.decode(JSON.stringify(projection(invalid))), null);
  }
  assert.equal(
    isWrappedPercentiles({ sampleSize: 100, totalSpent: { percentile: 100, topPercent: 1 } }),
    true,
  );
});

test('an exact whole-percent boundary is not rounded down by floating division', async () => {
  const service = new WrappedAnalyticsService({
    getUserTimezone: async () => 'America/Toronto',
    getUserReceipts: async () => analyticsReceipts(await decemberCanonicalOrders()),
    getPercentileRanks: async () => ({
      policyVersion: 3,
      currencyCode: 'CAD',
      estimatedNetCost: false,
      totalSpent: { lowerCount: 29, sampleSize: 100 },
      orderCount: null,
      nightOwl: null,
    }),
  });
  assert.deepEqual(
    (await service.calculateWrappedAnalytics('fixture-user')).percentiles.totalSpent,
    { percentile: 29, topPercent: 71, sampleSize: 100 },
  );
});
