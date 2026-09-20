const test = require('node:test');
const assert = require('node:assert/strict');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const { decodeOrderOutcome } = require('../dist/models/OrderEvidence');
const {
  buildDashboardInsightCatalogue,
  buildDashboardInsightEdition,
} = require('../dist/services/analytics/dashboard');
const {
  buildDashboardDataset,
  dashboardCohort,
} = require('../dist/services/analytics/dashboard/normalization');
const { dashboardInsightEditionCacheCodec } = require('../dist/services/core/cacheProjections');

const timezone = 'America/Toronto';
const now = new Date('2023-12-11T18:00:00Z');
function order(
  id,
  {
    amount = 20,
    fulfillment = 'completed',
    restaurant = 'Test Kitchen',
    date = '2023-12-10T17:00:00Z',
    currency = 'CAD',
    precision = 'minute',
    role = 'placed',
    eventTimezone = timezone,
    items = [],
    minutes = 30,
  } = {},
) {
  const receipt = {
    id,
    userId: 'fixture-user',
    receiptType: 'uber_eats',
    dataSource: 'csv',
    restaurantName: restaurant,
    amountSpent: amount ?? 0,
    monetaryDetails: { currencyCode: currency },
    items,
    orderDate: date ? new Date(date) : undefined,
    deliveryTime: date ? new Date(Date.parse(date) + minutes * 60_000) : undefined,
    resolution: {
      version: 1,
      amountBasis: 'receipt_total',
      adjustments: [],
      issues: [],
      sources: ['csv'],
      timestamp: {
        raw: date ?? '',
        role,
        timezone: eventTimezone,
        precision,
        convention: 'fixture',
      },
      reconciliation: {
        policyVersion: 3,
        status: 'standalone',
        method: 'fixture',
        observationIds: [id],
      },
      orderOutcome: {
        version: 3,
        kind: 'order',
        fulfillment,
        fulfillmentConfidence: 'confirmed',
        refundStatus: 'none_established',
        refundConfidence: 'unknown',
        originalCharge: amount,
        netAmount: amount,
        confirmedRefundAmount: null,
        estimatedRefundAmount: null,
        financialObservationIds: [id],
        cancellationCharge: fulfillment === 'canceled' ? amount : null,
        financialConfidence: amount === null ? 'unknown' : 'confirmed',
        events: [],
        issues: [],
      },
    },
  };
  decodeOrderOutcome(receipt.resolution.orderOutcome);
  return receipt;
}
const catalogue = (receipts, date = now) =>
  buildDashboardInsightCatalogue(receipts, timezone, date);
const insights = (result) => new Map(result.eligible.map((c) => [c.insight.id, c.insight]));
const event = (insight, label) => insight.events.find((e) => e.label === label);

test('active policy preserves the insight catalogue for 267 deliveries, 81 unspecified statuses and five cancellations', async () => {
  const { ACTIVE_RECEIPT_POLICY } = require('../dist/services/receipt/ReceiptPolicy');
  const { WrappedAnalyticsCalculator } = require('../dist/services/analytics/WrappedAnalyticsService');
  const { analyticsReceipts } = require('./helpers/order-events-fixture');
  assert.equal(ACTIVE_RECEIPT_POLICY, 3);
  const deliveries = Array.from({ length: 267 }, (_, i) => order(`delivered-${i}`, {
    date: new Date(Date.UTC(2023, 0, 1 + i, i % 2 ? 6 : 18)).toISOString(),
    restaurant: ['Starbucks', "McDonald’s (Bank Street)", 'Pizza Pizza (Bank Street)'][i % 3],
    items: [{ name: ['Latte', 'Fries', 'Pizza'][i % 3], quantity: 1, price: 5 }],
    amount: 10 + i % 15,
    minutes: 20 + i % 50,
  }));
  for (const receipt of deliveries.slice(0, 6)) Object.assign(receipt.resolution.orderOutcome, {
    refundStatus: 'partial', refundConfidence: 'confirmed', confirmedRefundAmount: 2,
  });
  const cancellations = Array.from({ length: 5 }, (_, i) => order(`canceled-${i}`, { fulfillment: 'canceled' }));
  const unspecified = Array.from({ length: 81 }, (_, i) => order(`email-${i}`, {
    fulfillment: 'unknown', precision: 'day', role: 'receipt',
  }));
  const base = [...deliveries, ...cancellations];
  const receipts = [...base, ...unspecified];
  const before = structuredClone(receipts);
  const result = catalogue(receipts);
  assert.ok(result.eligible.length > 25, `Only ${result.eligible.length} candidates survived`);
  const byId = insights(result);
  for (const id of ['top-restaurants', 'peak-hunger-hour', 'longest-order-streak', 'biggest-splurge', 'refunds-and-cancellations'])
    assert.ok(byId.has(id), id);
  for (const id of ['order-outcomes', 'net-order-costs', 'order-evidence-quality', 'unlinked-adjustments'])
    assert.equal(byId.has(id), false, id);
  assert.equal(event(byId.get('refunds-and-cancellations'), 'Refunded orders').value, 6);
  const calculator = new WrappedAnalyticsCalculator();
  const baseline = await calculator.calculate(analyticsReceipts(base), timezone);
  const wrapped = await calculator.calculate(analyticsReceipts(receipts), timezone);
  assert.equal(wrapped.orderMetrics.attempts, 353);
  assert.equal(wrapped.orderMetrics.deliveries, 267);
  assert.equal(wrapped.orderMetrics.unknownFulfillment, 81);
  assert.equal(wrapped.deliveryDayRanking.status, 'available');
  assert.deepEqual(wrapped.deliveryDayRanking, baseline.deliveryDayRanking);
  for (const key of ['lateNightOrders', 'longestStreak', 'singleItemOrders', 'chainDependency']) {
    assert.ok(wrapped.shame[key], key);
    assert.deepEqual(wrapped.shame[key], baseline.shame[key], key);
  }
  for (const key of ['mostExpensiveOrder', 'coffeeAddiction', 'nightOwl'])
    assert.deepEqual(wrapped.flex[key], baseline.flex[key], key);
  for (const key of ['peakHungerHour', 'weekendWarrior', 'deliveryWaits']) {
    assert.ok(wrapped.patterns[key], key);
    assert.deepEqual(wrapped.patterns[key], baseline.patterns[key], key);
  }
  assert.ok(wrapped.comparative.missedInvestment);
  assert.deepEqual(receipts, before, 'Presentation must not rewrite receipt outcomes');
});

test('Home explicitly labels confirmed refunds whose amount and resulting cost are unknown', () => {
  const receipt = order('unknown-refund-amount', { amount: null });
  Object.assign(receipt.resolution.orderOutcome, {
    originalCharge: 40,
    refundStatus: 'confirmed_unclassified',
    refundConfidence: 'confirmed',
    confirmedRefundAmount: null,
  });
  const refunds = insights(catalogue([receipt])).get('refunds-and-cancellations');
  assert.equal(event(refunds, 'Refunded orders').value, 1);
  assert.equal(refunds.events.some(e => /unknown|full|partial/i.test(e.label)), false);
  assert.equal(refunds.events.some(e => /unknown|full|partial/i.test(e.label)), false);
  assert.equal(event(refunds, 'Refunded · CAD'), undefined);
});

test('confirmed refunds with unknown starting balances have a factual breakdown, not an invented full/partial classification', () => {
  const receipt = order('unclassified', { amount: null });
  Object.assign(receipt.resolution.orderOutcome, {
    refundStatus: 'confirmed_unclassified',
    refundConfidence: 'confirmed',
    confirmedRefundAmount: 10,
  });
  const result = insights(catalogue([receipt]));
  const refunds = result.get('refunds-and-cancellations');
  assert.equal(event(refunds, 'Refunded orders').value, 1);
  assert.equal(refunds.events.some(e => /unknown|full|partial/i.test(e.label)), false);
  assert.equal(refunds.events.some(e => /unknown|full|partial/i.test(e.label)), false);
  assert.equal(
    event(refunds, 'Refunded · CAD').value,
    '10.00',
  );
  assert.ok(!result.has('biggest-splurge'));
});

test('December Home insights agree with canonical attempts, delivered-day costs and refund/cancellation facts', async () => {
  const receipts = await decemberCanonicalOrders();
  const result = insights(catalogue(receipts));
  assert.equal(summarizeOrderMetrics(receipts).attempts, 5);
  assert.equal(summarizeOrderMetrics(receipts).deliveries, 4);
  assert.equal(summarizeOrderMetrics(receipts).currencies[0].netSpend, 157.02);
  assert.equal(result.get('multi-order-day').value, 4);
  assert.equal(result.get('multi-order-day').title, '4 orders.');
  assert.equal(result.get('multi-order-day').period.startDate, '2023-12-10');
  assert.deepEqual(result.get('multi-order-day').busyDay, { date: '2023-12-10', spending: [{ currencyCode: 'CAD', amount: 113.76 }] });
  assert.equal(result.get('multi-order-day').detail, 'One busy day.');
  assert.equal(result.get('multi-order-day').methodology, undefined);
  assert.equal(
    event(result.get('refunds-and-cancellations'), 'Refunded · CAD').value,
    '22.48',
  );
  assert.equal(result.get('biggest-splurge').order.amount, 48.46);
  const dataset = buildDashboardDataset(receipts, timezone, now);
  assert.equal(dataset.sourceCoverage, 'mixed');
  assert.equal(dashboardCohort(dataset, 'deliveries').receipts.length, 4);
  assert.equal(dashboardCohort(dataset, 'restaurants').receipts.length, 3);
  assert.equal(dashboardCohort(dataset, 'net-cost').receipts.length, 5);
  const edition = buildDashboardInsightEdition(receipts, timezone, 'fixture-user', now);
  assert.equal(edition.metricVersion, 'daily-v22');
  assert.ok(edition.insights.length >= 5);
  assert.equal(edition.insights.some(i => ['order-outcomes', 'net-order-costs', 'order-evidence-quality', 'unlinked-adjustments'].includes(i.id)), false);
  assert.deepEqual(
    dashboardInsightEditionCacheCodec.decode(JSON.stringify(edition)),
    JSON.parse(JSON.stringify(edition)),
  );
});

test('charged cancellation is a cost, never a delivered basket or wait; groceries remain visible outside food stories', () => {
  const items = [{ name: 'Hash Brown', quantity: 1, price: 2 }];
  const receipts = [
    order('food-a', { items, amount: 0 }),
    order('food-b', { items }),
    order('groceries', {
      restaurant: 'Metro (2515 Bank Street)',
      amount: 400,
      items: [{ ...items[0], quantity: 100 }],
    }),
    order('canceled', {
      fulfillment: 'canceled',
      restaurant: 'Canceled Kitchen',
      amount: 500,
      minutes: 500,
      items: [{ ...items[0], quantity: 500 }],
    }),
  ];
  const result = insights(catalogue(receipts));
  assert.equal(result.get('biggest-splurge').order.amount, 500);
  assert.deepEqual(result.get('biggest-splurge').order.items, []);
  assert.equal(result.has('detailed-biggest-order'), false);
  assert.equal(result.get('multi-order-day').value, 3);
  assert.equal(result.get('most-ordered-meal').value, 2);
  assert.equal(result.get('most-ordered-meal').headline, 'Hash Brown');
  assert.equal(result.get('longest-delivery').value, 30);
  assert.equal(result.get('accumulated-delivery-time').value, 1.5);
  const rows = result.get('top-restaurants').rows;
  assert.ok(rows.some((row) => row.label === 'Metro' && row.count === 1));
  assert.equal(
    rows.some((row) => row.label === 'Canceled Kitchen'),
    false,
  );
  assert.equal(
    result.get('restaurant-loyalty').value,
    67,
    'zero net cost still counts as delivery activity',
  );
});

test('date-only and payment timestamps cannot become placement-hour or delivery-window records', () => {
  for (const precision of ['day', 'received']) {
    const receipts = [1, 2, 3].map((i) =>
      order(String(i), { date: '2023-12-10T05:00:00Z', precision }),
    );
    const result = insights(catalogue(receipts));
    assert.equal(result.get('multi-order-day').value, 3);
    for (const id of [
      'peak-hunger-hour',
      'hunger-hour-podium',
      'night-owl',
      'longest-delivery',
      'latest-ever-order',
      'accumulated-delivery-time',
    ])
      assert.equal(result.has(id), false, id);
  }
  const result = insights(catalogue([1, 2, 3].map((i) => order(String(i), { role: 'receipt' }))));
  assert.equal(result.has('peak-hunger-hour'), false);
});

test('hour percentages use timed deliveries only and travel clock labels use the event timezone', () => {
  const receipts = [1, 2, 3].map((i) =>
    order(String(i), { date: '2023-12-09T18:30:00Z', eventTimezone: 'Asia/Tokyo' }),
  );
  receipts.push(...[4, 5, 6, 7, 8].map((i) => order(String(i), { precision: 'day' })));
  const result = insights(catalogue(receipts));
  assert.equal(result.get('night-owl').value, 100);
  assert.match(result.get('peak-hunger-hour').detail, /100%/);
  assert.equal(event(result.get('latest-ever-order'), 'Latest local order time').value, '3:30 AM');
  assert.equal(result.get('multi-order-day').value, 8);
});

test('unresolved originals and orphan adjustments cannot win or hide established activity and cost stories', () => {
  const stable = [order('a'), order('b'), order('c')];
  const uncertain = order('possible', { amount: 500 });
  uncertain.dataSource = 'email';
  uncertain.resolution.reconciliation.status = 'unresolved';
  const orphan = order('orphan');
  orphan.resolution.orderOutcome.kind = 'unlinked_adjustment';
  const receipts = [...stable, uncertain, orphan];
  const result = insights(catalogue(receipts));
  assert.equal(summarizeOrderMetrics(receipts).attempts, 3);
  assert.equal(summarizeOrderMetrics(receipts).currencies[0].netSpend, 60);
  assert.equal(result.get('multi-order-day').value, 3);
  assert.equal(result.get('biggest-splurge').order.amount, 20);
  assert.ok(result.has('top-restaurants'));
  for (const id of ['order-evidence-quality', 'unlinked-adjustments', 'net-order-costs', 'order-outcomes'])
    assert.equal(result.has(id), false);
});

test('unknown cost stays unknown, never a zero-price winner or false foodflation change', () => {
  const receipts = [1, 2, 3].map((i) =>
    order(String(i), { amount: null, items: [{ name: 'Pizza', quantity: 1, price: 0 }] }),
  );
  const result = insights(catalogue(receipts));
  assert.equal(summarizeOrderMetrics(receipts).currencies[0].pricedOrders, 0);
  assert.equal(result.get('multi-order-day').value, 3);
  assert.deepEqual(result.get('multi-order-day').busyDay.spending, []);
  assert.equal(result.get('top-restaurants').rows[0].amount, undefined);
  assert.equal(result.has('biggest-splurge'), false);
  assert.equal(
    [...result.keys()].some((id) => id.startsWith('foodflation-')),
    false,
  );
  const priced = order('priced', { amount: 20 });
  const incomplete = insights(catalogue([...receipts, priced]));
  assert.deepEqual(incomplete.get('multi-order-day').busyDay.spending, []);
});

test('multi-currency delivery days keep all deliveries and separate costs; merchant sums do not imply conversion', () => {
  const receipts = [order('cad-a'), order('cad-b'), order('usd', { currency: 'USD', amount: 500 })];
  const result = insights(catalogue(receipts));
  assert.equal(result.get('multi-order-day').value, 3);
  assert.deepEqual(result.get('multi-order-day').busyDay.spending, [{ currencyCode: 'CAD', amount: 40 }, { currencyCode: 'USD', amount: 500 }]);
  assert.equal(result.get('top-restaurants').rows[0].amount, undefined);
  assert.equal(result.get('biggest-splurge').order.amount, 20);
  assert.match(result.get('biggest-splurge').methodology.assumption, /recorded order costs/);
  const unknownCurrency = insights(catalogue([order('unknown', { currency: 'UNKNOWN' })]));
  assert.equal(unknownCurrency.has('biggest-splurge'), false);
});

test('missing dates or unknown fulfillment do not suppress other established activity', () => {
  for (const extra of [
    order('undated', { date: undefined }),
    order('unknown', { fulfillment: 'unknown' }),
  ]) {
    if (extra.id === 'undated') extra.orderDate = undefined;
    const result = insights(catalogue([order('a'), order('b'), order('c'), extra]));
    assert.equal(result.get('multi-order-day').value, 3);
    assert.ok(result.has('restaurant-loyalty'));
    assert.equal(result.has('order-evidence-quality'), false);
  }
});

test('spending periods include cancellation costs; delivery frequency uses only completed deliveries', () => {
  const receipts = [];
  for (let i = 1; i <= 3; i++)
    receipts.push(order(`nov-${i}`, { date: `2023-11-0${i}T17:00:00Z`, amount: 10 }));
  for (let i = 1; i <= 5; i++)
    receipts.push(order(`dec-${i}`, { date: `2023-12-0${i}T17:00:00Z`, amount: 10 }));
  receipts.push(
    order('dec-cancel', { date: '2023-12-08T17:00:00Z', amount: 100, fulfillment: 'canceled' }),
  );
  const result = insights(catalogue(receipts));
  assert.equal(result.get('month-to-date-spending').comparison.current, 150);
  assert.equal(result.get('month-to-date-spending').comparison.previous, 30);
  assert.equal(result.get('rolling-order-frequency').comparison.current, 5);
  assert.equal(result.get('rolling-order-frequency').comparison.previous, 3);
  assert.equal(result.get('rolling-average-basket').comparison.current, 25);
  assert.equal(
    result.has('hypothetical-investment'),
    false,
    'short history does not qualify for the investment illustration',
  );
});

test('refunded balances are not menu prices; explicit comparable item/subtotal evidence can still show price changes', () => {
  const a = order('a', {
    date: '2023-10-01T17:00:00Z',
    amount: 0,
    items: [{ name: 'Pizza', quantity: 1, price: 0 }],
  });
  const b = order('b', {
    date: '2023-12-10T17:00:00Z',
    amount: 20,
    items: [{ name: 'Pizza', quantity: 1, price: 0 }],
  });
  Object.assign(a.resolution.orderOutcome, {
    refundStatus: 'full',
    refundConfidence: 'confirmed',
    confirmedRefundAmount: 20,
    originalCharge: 20,
  });
  assert.equal(
    catalogue([a, b]).eligible.some((c) => c.family === 'foodflation'),
    false,
  );
  a.monetaryDetails.subtotal = 20;
  b.monetaryDetails.subtotal = 25;
  const change = catalogue([a, b]).eligible.find((c) => c.family === 'foodflation');
  assert.equal(change.insight.comparison.previous, 20);
  assert.equal(change.insight.comparison.current, 25);
});

test('merged export membership keeps detailed sources available even when the projection source is email', () => {
  const receipts = [order('a'), order('b'), order('c')];
  for (const receipt of receipts) {
    receipt.dataSource = 'email';
    receipt.resolution.sources = ['email', 'csv'];
    receipt.items = [{ name: 'Pizza', quantity: 1, price: 10 }];
  }
  const dataset = buildDashboardDataset(receipts, timezone, now);
  assert.equal(dataset.sourceCoverage, 'mixed');
  assert.equal(dataset.exportReceipts.length, 3);
  assert.equal(insights(catalogue(receipts)).get('most-ordered-meal').value, 3);
  assert.equal(
    buildDashboardInsightEdition(receipts, timezone, 'fixture-user', now).partialExportProvider,
    'uber_eats',
  );
  assert.equal(
    catalogue(receipts).eligible.some((c) => c.locked),
    false,
  );
});

test('reversed row order preserves insight facts and the selected edition, including tied costs and timestamps', () => {
  const receipts = [
    order('a'),
    order('b', { restaurant: 'Other Kitchen' }),
    order('c'),
    order('d', { amount: 40, fulfillment: 'canceled' }),
  ];
  const forward = buildDashboardInsightEdition(receipts, timezone, 'fixture-user', now);
  const reversed = buildDashboardInsightEdition(
    [...receipts].reverse(),
    timezone,
    'fixture-user',
    now,
  );
  assert.deepEqual(reversed, forward);
  assert.deepEqual(catalogue([...receipts].reverse()), catalogue(receipts));
});

test('foodflation requires the same explicit branch and provider, not just a brand name', () => {
  const a = order('a', {
    restaurant: "McDonald's (100 Bank Street)",
    date: '2023-10-01T17:00:00Z',
    items: [{ name: 'Fries', price: 5, quantity: 1 }],
  });
  const b = order('b', {
    restaurant: "McDonald's (200 Bank Street)",
    items: [{ name: 'Fries', price: 10, quantity: 1 }],
  });
  a.monetaryDetails.subtotal = 5;
  b.monetaryDetails.subtotal = 10;
  assert.equal(
    catalogue([a, b]).eligible.some((c) => c.family === 'foodflation'),
    false,
  );
  b.restaurantName = a.restaurantName;
  b.receiptType = 'doordash';
  assert.equal(
    catalogue([a, b]).eligible.some((c) => c.family === 'foodflation'),
    false,
  );
  b.receiptType = 'uber_eats';
  assert.ok(catalogue([a, b]).eligible.some((c) => c.family === 'foodflation'));
});

test('failed and unfulfilled attempts never appear as delivered food, even with items and ending timestamps', () => {
  const receipts = ['failed', 'unfulfilled', 'canceled'].map((status) =>
    order(status, {
      fulfillment: status,
      items: [{ name: 'Hash Brown', quantity: 100, price: 2 }],
    }),
  );
  const result = insights(catalogue(receipts));
  assert.equal(summarizeOrderMetrics(receipts).attempts, 3);
  assert.equal(summarizeOrderMetrics(receipts).deliveries, 0);
  assert.equal(summarizeOrderMetrics(receipts).currencies[0].netSpend, 60.00);
  for (const id of [
    'multi-order-day',
    'most-ordered-meal',
    'top-restaurants',
    'longest-delivery',
    'restaurant-loyalty',
  ])
    assert.equal(result.has(id), false, id);
});

test('day grouping survives the repeated DST hour and invalid dates become missing evidence, not a crash', () => {
  const receipts = [
    order('before-fallback', { date: '2023-11-05T05:30:00Z' }),
    order('after-fallback', { date: '2023-11-05T06:30:00Z' }),
    order('later', { date: '2023-11-05T17:00:00Z' }),
  ];
  const result = insights(catalogue(receipts));
  assert.equal(result.get('multi-order-day').period.startDate, '2023-11-05');
  assert.equal(result.get('multi-order-day').value, 3);
  const invalid = order('invalid');
  invalid.orderDate = new Date('invalid');
  const missing = insights(catalogue([...receipts, invalid]));
  assert.equal(missing.get('multi-order-day').value, 3);
  assert.equal(missing.has('order-evidence-quality'), false);
});

test('investment illustration uses known net cost including cancellations and preserves its explicit assumptions', () => {
  const receipts = [1, 2, 3, 4, 5].map((i) =>
    order(String(i), {
      amount: 100,
      date: `2020-01-0${i}T17:00:00Z`,
      fulfillment: i === 5 ? 'canceled' : 'completed',
    }),
  );
  const result = insights(catalogue(receipts));
  assert.equal(result.get('hypothetical-investment').comparison.previous, 500);
  assert.match(
    result.get('hypothetical-investment').methodology.assumption,
    /fixed average annual return/,
  );
  assert.match(
    result.get('hypothetical-investment').methodology.assumption,
    /recorded order costs/,
  );
  assert.equal(result.get('hypothetical-investment').methodology.sampleSize, 5);
});

test('calendar-day labels are not shifted a second time in UTC+14', () => {
  const zone = 'Pacific/Kiritimati';
  const receipts = [1, 2, 3].map((i) =>
    order(String(i), { date: `2020-01-0${i}T17:00:00Z`, eventTimezone: zone }),
  );
  const result = insights(buildDashboardInsightCatalogue(receipts, zone, now));
  assert.equal(event(result.get('longest-order-streak'), 'Started').value, 'Jan 2, 2020');
  assert.equal(event(result.get('longest-order-streak'), 'Made it through').value, 'Jan 4, 2020');
});

test('probable refunds and positive failed export balances remain explicitly inferred, not confirmed settlements', () => {
  const failed = order('failed', { fulfillment: 'failed', amount: 17.37 });
  failed.resolution.orderOutcome.financialConfidence = 'inferred';
  const probable = order('probable', { amount: 0 });
  Object.assign(probable.resolution.orderOutcome, {
    refundStatus: 'probable_full',
    refundConfidence: 'inferred',
    financialConfidence: 'inferred',
    estimatedRefundAmount: 22.48,
  });
  const result = insights(catalogue([failed, probable]));
  assert.equal(result.has('refunds-and-cancellations'), false);
  assert.equal(result.get('biggest-splurge').methodology.estimated, true);
  assert.equal(summarizeOrderMetrics([failed, probable]).currencies[0].netSpend, 17.37);
});
