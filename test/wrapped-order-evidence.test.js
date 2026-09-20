const test = require('node:test');
const assert = require('node:assert/strict');
const { decemberCanonicalOrders, analyticsReceipts } = require('./helpers/order-events-fixture');
const {
  WrappedAnalyticsCalculator,
} = require('../dist/services/analytics/WrappedAnalyticsService');
const { wrappedSpending } = require('../dist/services/analytics/shared/wrappedSpending');

const calculate = (receipts, timezone = 'America/Toronto') =>
  new WrappedAnalyticsCalculator().calculate(analyticsReceipts(receipts), timezone);

async function delivery({
  currency = 'CAD',
  net = 10,
  date = '2023-12-10T06:00:00Z',
  restaurant = 'Starbucks',
  items,
} = {}) {
  const receipt = (await decemberCanonicalOrders()).find(
    (r) =>
      r.resolution.orderOutcome.fulfillment === 'completed' &&
      r.resolution.orderOutcome.netAmount > 0,
  );
  receipt.restaurantName = restaurant;
  receipt.orderDate = new Date(date);
  receipt.deliveryTime = new Date(receipt.orderDate.getTime() + 40 * 60000);
  receipt.monetaryDetails.currencyCode = currency;
  receipt.items = items ?? [{ name: 'Latte', price: 18, quantity: 1 }];
  // Deliberately different compatibility amount: calculations must use outcomes.
  receipt.amountSpent = 999;
  Object.assign(receipt.resolution.orderOutcome, {
    originalCharge: net,
    netAmount: net,
    financialConfidence: net === null ? 'unknown' : 'confirmed',
    refundStatus: 'none_established',
    confirmedRefundAmount: null,
    estimatedRefundAmount: null,
    events: [],
  });
  return receipt;
}

test('December behavior stories use the same four deliveries and net costs, without the charged cancellation', async () => {
  const orders = await decemberCanonicalOrders();
  const before = structuredClone(orders);
  const result = await calculate(orders);
  assert.equal(result.orderMetrics.attempts, 5);
  assert.equal(result.orderMetrics.deliveries, 4);
  assert.equal(result.orderMetrics.currencies[0].netSpend, 157.02);
  assert.equal(result.shame.lateNightOrders.count, 2);
  assert.equal(result.shame.lateNightOrders.totalSpent, 19.47);
  assert.equal(result.shame.lateNightOrders.spending[0].confirmedRefundAmount, 22.48);
  assert.equal(result.shame.lateNightOrders.spending[0].payments[1].charges, 19.47);
  assert.equal(result.shame.lateNightOrders.worstOffender.amount, 19.47);
  assert.equal(result.flex.mostExpensiveOrder.amount, 48.46);
  assert.equal(result.flex.mostExpensiveOrder.currencyCode, 'CAD');
  assert.equal(result.shame.laziestDay.totalSpent, 113.76);
  assert.equal(result.shame.chainDependency.orderCount, 2);
  assert.equal(result.shame.chainDependency.totalSpent, 19.47);
  assert.equal(result.patterns.weekendWarrior.weekendOrders, 4);
  assert.equal(result.patterns.weekendWarrior.weekendSpending, 113.76);
  assert.equal(result.patterns.weekendWarrior.ratio, null); // No invented 5x weekday comparison.
  assert.equal(result.comparative.missedInvestment.amountSpent, 113.76);
  assert.deepEqual(structuredClone(orders), before);
});

test('unknown delivery costs are not free, but still count in behavior stories', async () => {
  const known = await delivery();
  const unknown = await delivery({ net: null });
  const result = await calculate([known, unknown]);
  for (const story of [
    result.shame.lateNightOrders,
    result.flex.nightOwl,
    result.shame.chainDependency,
  ]) {
    assert.equal(story.totalSpent, null);
    assert.equal(story.spending[0].netSpend, 10);
    assert.equal(story.spending[0].pricedOrders, 1);
    assert.equal(story.spending[0].unknownPriceOrders, 1);
  }
  assert.equal(result.shame.lateNightOrders.count, 2);
  assert.equal(result.shame.lateNightOrders.worstOffender, undefined);
  assert.equal(result.flex.mostExpensiveOrder.amount, 10);
  assert.equal(result.flex.mostExpensiveOrder.currencyCode, 'CAD');
  assert.equal(result.shame.singleItemOrders.count, 1);
  assert.equal(result.shame.singleItemOrders.totalSpent, 10);
  const unpricedOnly = await calculate([unknown]);
  assert.equal(unpricedOnly.patterns.deliveryWaits.longestWait.amount, null);
});

test('mixed and unknown currencies retain costs separately and never produce a scalar price record', async () => {
  const orders = await Promise.all([
    delivery({ currency: 'CAD', net: 10 }),
    delivery({ currency: 'USD', net: 20 }),
    delivery({ currency: 'UNKNOWN', net: 40 }),
  ]);
  const result = await calculate(orders);
  assert.equal(result.shame.lateNightOrders.count, 3);
  assert.equal(result.shame.lateNightOrders.totalSpent, null);
  assert.equal(result.shame.lateNightOrders.worstOffender, undefined);
  assert.deepEqual(
    result.shame.lateNightOrders.spending.map((s) => [s.currencyCode, s.netSpend]),
    [
      ['CAD', 10],
      ['UNKNOWN', 40],
      ['USD', 20],
    ],
  );
  assert.equal(result.shame.chainDependency.totalSpent, null);
  assert.equal(result.shame.chainDependency.allChains[0].spent, null);
  assert.equal(result.shame.laziestDay.totalSpent, null);
  assert.equal(result.flex.mostExpensiveOrder.amount, 10);
  assert.equal(result.flex.mostExpensiveOrder.currencyCode, 'CAD');
  assert.equal((await calculate([orders[2]])).shame.singleItemOrders, undefined);
});

test('coffee frequency survives discounts/refunds without calling item list prices actual coffee spend', async () => {
  const refunded = await delivery({ net: 0 });
  Object.assign(refunded.resolution.orderOutcome, {
    originalCharge: 22.48,
    confirmedRefundAmount: 22.48,
    refundStatus: 'full',
  });
  const discounted = await delivery({
    net: 6.75,
    items: [
      { name: 'Latte', price: 8, quantity: 1 },
      { name: 'Sandwich', price: 12, quantity: 1 },
    ],
  });
  const grocery = await delivery({ restaurant: 'Metro (2515 Bank Street Ottawa)', net: 30 });
  const canceled = await delivery({ net: 25 });
  canceled.resolution.orderOutcome.fulfillment = 'canceled';
  const result = await calculate([refunded, discounted, grocery, canceled]);
  assert.equal(result.flex.coffeeAddiction.orderCount, 2);
  assert.equal(result.flex.coffeeAddiction.totalSpent, null);
  assert.equal(result.flex.coffeeAddiction.averagePrice, null);
  assert.match(result.flex.coffeeAddiction.disclaimer, /cannot be allocated to coffee alone/);
  assert.equal(result.orderMetrics.deliveries, 3);
  assert.equal(result.patterns.deliveryWaits.totalOrders, 3);
  assert.equal(result.shame.singleItemOrders.count, 1); // No canceled/grocery basket.
});

test('delivery streaks retain multicurrency/unknown costs and export timezones without claims about cooking', async () => {
  const receipts = await Promise.all([
    delivery({ date: '2023-12-10T05:30:00Z', net: 10 }),
    delivery({ date: '2023-12-11T05:30:00Z', net: null }),
    delivery({ date: '2023-12-12T05:30:00Z', currency: 'USD', net: 12 }),
  ]);
  const result = await calculate(receipts, 'America/Los_Angeles');
  assert.equal(result.shame.longestStreak.days, 3);
  assert.equal(result.shame.longestStreak.startDate, '2023-12-10');
  assert.equal(result.shame.longestStreak.totalSpent, null);
  assert.equal(result.shame.longestStreak.spending.length, 2);
  assert.doesNotMatch(result.shame.longestStreak.message, /cooking/);
  assert.equal(result.patterns.peakHungerHour.hour, 0);
});

test('current-year counts include unpriced attempts while average and costs do not conceal them', async () => {
  const year = new Date().getUTCFullYear();
  const receipts = await Promise.all([
    delivery({ date: `${year}-02-01T17:00:00Z`, net: 10 }),
    delivery({ date: `${year}-02-02T17:00:00Z`, net: null }),
  ]);
  receipts[0].resolution.orderOutcome.fulfillment = 'canceled';
  const result = await calculate(receipts);
  assert.equal(result.comparative.spentThisYear.orderCount, 2);
  assert.equal(result.comparative.spentThisYear.totalSpent, null);
  assert.equal(result.comparative.spentThisYear.averagePerOrder, null);
  assert.equal(result.comparative.spentThisYear.spending[0].cancellationCost, 10);
});

test('weekend behavior compares delivery frequency, not refund amounts, and preserves category money', async () => {
  const receipts = await Promise.all([
    delivery({ date: '2023-12-10T17:00:00Z', net: 0 }),
    delivery({ date: '2023-12-11T17:00:00Z', net: 100 }),
  ]);
  const result = (await calculate(receipts)).patterns.weekendWarrior;
  assert.equal(result.ratioBasis, 'deliveries_per_day');
  assert.equal(result.ratio, 2.5);
  assert.equal(result.weekendSpending, 0);
  assert.equal(result.weekdaySpending, 100);
  assert.equal(result.weekendCosts[0].pricedOrders, 1);
  assert.equal(result.weekdayCosts[0].netSpend, 100);
});

test('legacy spending contract remains numeric and policy-3 estimates remain explicitly labeled', async () => {
  assert.deepEqual(wrappedSpending([{ amountSpent: 5.1 }, { amountSpent: 10.2 }], false), {
    totalSpent: 15.3,
  });
  const estimated = await delivery({ net: 18 });
  estimated.resolution.orderOutcome.financialConfidence = 'inferred';
  const result = await calculate([estimated]);
  assert.equal(result.shame.lateNightOrders.totalSpent, 18);
  assert.equal(result.shame.lateNightOrders.spending[0].estimatedPriceOrders, 1);
  assert.equal(result.flex.mostExpensiveOrder.includesEstimates, true);
});

test('fee trends use unadjusted deliveries, local quarters and only the included periods', async () => {
  const dates = [
    '2025-01-01T17:00:00Z',
    '2025-02-01T17:00:00Z',
    '2025-04-01T03:30:00Z',
    '2025-04-05T17:00:00Z',
    '2025-04-10T17:00:00Z',
    '2025-04-15T17:00:00Z',
    '2024-11-01T17:00:00Z',
  ];
  const receipts = await Promise.all(
    dates.map(async (date, i) => {
      const receipt = await delivery({ date });
      receipt.deliveryFee = i < 3 ? 1 : 2;
      receipt.serviceFee = i < 3 ? 1 : 2;
      return receipt;
    }),
  );
  const refunded = structuredClone(receipts[0]);
  refunded.deliveryFee = 99;
  refunded.resolution.orderOutcome.refundStatus = 'partial';
  refunded.resolution.orderOutcome.netAmount = 5;
  const canceled = structuredClone(receipts[3]);
  canceled.serviceFee = 199;
  canceled.resolution.orderOutcome.fulfillment = 'canceled';
  const result = (await calculate([...receipts, refunded, canceled])).comparative.deliveryFeeTrend;
  assert.equal(result.basis, 'unadjusted_deliveries');
  assert.equal(result.coveredOrderCount, 6);
  assert.equal(result.earliestPeriod.quarter, '2025-Q1');
  assert.equal(result.earliestPeriod.orderCount, 3);
  assert.equal(result.earliestPeriod.averageCompanyFees, 2);
  assert.equal(result.latestPeriod.averageCompanyFees, 4);
  assert.equal(result.companyFeeChangePercent, 100);
  assert.equal(result.coverageStart, '2025-01-01T17:00:00.000Z');
  assert.equal(result.coverageEnd, '2025-04-15T17:00:00.000Z');
  const allRefunded = receipts.map((receipt) => {
    const copy = structuredClone(receipt);
    copy.resolution.orderOutcome.refundStatus = 'full';
    copy.resolution.orderOutcome.netAmount = 0;
    return copy;
  });
  assert.equal((await calculate(allRefunded)).comparative.deliveryFeeTrend, undefined);
});

test('reversing canonical row order preserves tied records, favorite items and every Wrapped story', async () => {
  const dates = [
    '2023-12-09T06:00:00Z',
    '2023-12-10T03:00:00Z',
    '2023-12-10T06:00:00Z',
    '2023-12-11T03:00:00Z',
    '2023-12-11T06:00:00Z',
    '2023-12-12T03:00:00Z',
  ];
  const orders = await Promise.all(
    dates.map(async (date, i) => {
      const receipt = await delivery({
        date,
        items: [{ name: i % 2 ? 'Latte' : 'Espresso', quantity: 1, price: 20 }],
      });
      receipt.id = `wrapped-${i}`;
      return receipt;
    }),
  );
  const expected = await calculate(orders);
  assert.deepEqual(await calculate([...orders].reverse()), expected);
  assert.deepEqual(
    await calculate([orders[4], orders[1], orders[0], orders[5], orders[2], orders[3]]),
    expected,
  );
  orders[0].resolution.orderOutcome.netAmount = null;
  orders[2].monetaryDetails.currencyCode = 'USD';
  orders[2].resolution.orderOutcome.events = [];
  assert.deepEqual(await calculate([...orders].reverse()), await calculate(orders));
});
