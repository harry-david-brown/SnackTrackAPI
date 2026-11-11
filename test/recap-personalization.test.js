const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildRecapStories,
  recapOriginalAmount,
} = require('../dist/services/analytics/shared/recapStories');
const { scoreRecapStory } = require('../dist/services/analytics/shared/recapScoring');
const { FrankfurterRecapRates } = require('../dist/services/analytics/FrankfurterRecapRates');
const {
  WrappedAnalyticsCalculator,
} = require('../dist/services/analytics/WrappedAnalyticsService');
const { decemberCanonicalOrders, analyticsReceipts } = require('./helpers/order-events-fixture');
const rates = { id: 'test', date: '2023-12-11', rates: { CAD: 1.5, USD: 1, EUR: 1, GBP: 0.8 } };
const legacy = { shame: {}, flex: {}, comparative: {}, patterns: {}, coverage: {} };
function order(id, changes = {}) {
  const amount = changes.amount === undefined ? 20 : changes.amount;
  return {
    id,
    userId: 'u',
    restaurantName: 'Kitchen (10 Main St)',
    receiptType: 'uber_eats',
    dataSource: 'csv',
    currencyCode: 'CAD',
    amountSpent: amount ?? 0,
    orderDate: new Date('2023-12-10T18:00:00Z'),
    items: [{ name: 'Burger', quantity: 1, price: 20, customizations: ['No onions'] }],
    resolution: {
      version: 1,
      amountBasis: 'receipt_total',
      adjustments: [],
      issues: [],
      orderOutcome: {
        version: 3,
        kind: 'order',
        fulfillment: 'completed',
        originalCharge: amount,
        netAmount: amount,
        confirmedRefundAmount: null,
        refundStatus: 'none_established',
        financialConfidence: amount === null ? 'unknown' : 'confirmed',
        events: [],
      },
    },
    ...changes,
  };
}
const build = (rs, currency = 'CAD', snapshot = rates) =>
  buildRecapStories(rs, 'America/Toronto', currency, snapshot, legacy);
test('same records have different surprise and habit scores for different histories', () => {
  const score = (input) => scoreRecapStory({ magnitude: 50, ...input }).score;
  assert.ok(
    score({ value: 4, baseline: 1, comparisonCount: 20 }) >
      score({ value: 4, baseline: 3, comparisonCount: 20 }),
  );
  assert.ok(score({ share: 0.5, denominator: 40 }) > score({ share: 0.02, denominator: 1000 }));
  assert.ok(score({ share: 1, denominator: 2 }) < score({ share: 0.5, denominator: 40 }));
  assert.equal(score({ value: 4, baseline: 0 }), 15);
});
test('recap spending uses canonical net costs and counts each order once', async () => {
  const receipts = analyticsReceipts(await decemberCanonicalOrders());
  const source = globalThis.structuredClone(receipts);
  const canonical = await new WrappedAnalyticsCalculator().calculate(receipts, 'America/Toronto');
  const recap = buildRecapStories(
    [...receipts, receipts[0]],
    'America/Toronto',
    'CAD',
    rates,
    canonical,
  );
  assert.equal(recap.spending.amount, 157.02);
  assert.equal(recap.stories.find((s) => s.id === 'most-deliveries-day').value, 4);
  assert.equal(
    recap.stories.some((s) => s.id === 'refunded-orders' || s.id === 'cancellation-cost'),
    false,
  );
  assert.deepEqual(receipts, source);
});
test('refund eligibility counts distinct orders, not revisions; proportion controls priority', () => {
  const refunded = Array.from({ length: 10 }, (_, i) => {
    const r = order(`r${i}`);
    r.resolution.orderOutcome.refundStatus = 'full';
    r.resolution.orderOutcome.netAmount = 0;
    r.resolution.orderOutcome.confirmedRefundAmount = 20;
    return r;
  });
  assert.equal(
    build(refunded.slice(0, 9)).stories.some((s) => s.id === 'refunded-orders'),
    false,
  );
  assert.equal(
    build([...refunded.slice(0, 9), refunded[0]]).stories.some((s) => s.id === 'refunded-orders'),
    false,
  );
  const candidate = (n) =>
    build([...refunded, ...Array.from({ length: n - 10 }, (_, i) => order(`n${i}`))]).stories.find(
      (s) => s.id === 'refunded-orders',
    );
  assert.ok(candidate(40).score > candidate(2000).score);
  assert.equal(candidate(40).value, 10);
});
test('conversion, unknown currencies and missing prices do not remove counts', () => {
  const rs = [
    order('cad'),
    order('usd', { currencyCode: 'USD' }),
    order('unknown', { currencyCode: null }),
    order('missing', { amount: null }),
  ];
  const recap = build(rs);
  assert.equal(recap.spending.amount, 70);
  assert.equal(recap.spending.missingPrices, 1);
  assert.equal(recap.spending.assumedCurrencies, 1);
  assert.equal(recap.spending.approximate, true);
  assert.equal(recap.stories.find((s) => s.id === 'most-deliveries-day').value, 4);
  const unavailable = build(rs, 'CAD', { id: 'none', date: '', rates: {} });
  assert.equal(unavailable.spending.amount, 40);
  assert.equal(unavailable.spending.missingPrices, 2);
});
test('branches and customizations remain distinct, row order is stable', () => {
  const rs = Array.from({ length: 5 }, (_, i) => order(`a${i}`));
  const others = Array.from({ length: 5 }, (_, i) =>
    order(`b${i}`, { restaurantName: 'Kitchen (20 Main St)' }),
  );
  const recap = build([...rs, ...others]);
  assert.equal(recap.stories.find((s) => s.id === 'repeated-basket').value, 5);
  assert.deepEqual(recap, build([...rs, ...others].reverse()));
  rs[0].items[0].customizations = ['Extra onions'];
  assert.equal(
    build(rs).stories.some((s) => s.id === 'repeated-basket'),
    false,
  );
});
test('seven-day windows cross years and do not invent comparison coverage', () => {
  const rs = ['2023-12-29', '2023-12-31', '2024-01-03'].map((d, i) =>
    order(String(i), { orderDate: new Date(`${d}T18:00:00Z`) }),
  );
  const week = build(rs).stories.find((s) => s.id === 'spending-burst');
  assert.equal(week.startDate, '2023-12-29');
  assert.equal(week.endDate, '2024-01-04');
  assert.equal(week.value, 60);
  assert.ok(week.score < 30);
});
test('rate adapter caches, single-flights, validates and retains last snapshot on outage', async () => {
  let now = 0,
    calls = 0,
    fail = false;
  const adapter = new FrankfurterRecapRates(
    async () => {
      calls++;
      if (fail) throw Error('offline');
      return {
        ok: true,
        json: async () => ({ date: '2023-12-11', rates: { CAD: 1.5, USD: 1, GBP: 0.8, MXN: 20, AUD: 1.6, NZD: 1.8, JPY: 160 } }),
      };
    },
    () => now,
  );
  const [a, b] = await Promise.all([adapter.snapshot(), adapter.snapshot()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  await adapter.snapshot();
  assert.equal(calls, 1);
  now += 86400001;
  fail = true;
  assert.deepEqual(await adapter.snapshot(), a);
  assert.equal(calls, 2);
  const empty = await new FrankfurterRecapRates(async () => {
    throw Error('offline');
  }).snapshot();
  assert.equal(empty.id, 'unavailable');
});
test('unknown amounts are not manufactured zeroes and balance reconstruction is bounded', () => {
  const r = order('unknown', { amount: null });
  assert.equal(recapOriginalAmount(r), null);
  r.resolution.orderOutcome.netAmount = 12;
  r.resolution.orderOutcome.confirmedRefundAmount = 8;
  assert.equal(recapOriginalAmount(r), 20);
});

test('currency changes do not change scores for known-currency orders', () => {
  const rs = Array.from({ length: 20 }, (_, i) => order(String(i), { currencyCode: i % 2 ? 'USD' : 'CAD', orderDate: new Date(`2023-12-${String(1 + i).padStart(2, '0')}T18:00:00Z`) }));
  const cad = build(rs), usd = build(rs, 'USD');
  for (const a of cad.stories.filter(s => s.fallbackOrder === undefined)) {
    const b = usd.stories.find(s => s.id === a.id);
    assert.ok(b); assert.ok(Math.abs(a.score - b.score) < 0.02, a.id);
  }
});

test('explicit travel dates and DST dates remain local ordering days', () => {
  const rs = [1, 2, 3].map(i => order(String(i), { orderDate: new Date(`2023-11-05T0${i + 3}:30:00Z`) }));
  const day = build(rs).stories.find(s => s.id === 'most-deliveries-day');
  assert.equal(day.startDate, '2023-11-05');
  for (const r of rs) { r.orderDate = new Date('2023-12-09T12:30:00Z'); r.timezone = 'Pacific/Kiritimati'; }
  assert.equal(build(rs).stories.find(s => s.id === 'most-deliveries-day').startDate, '2023-12-10');
});

test('escalation requires declared comparable coverage and respects gaps', () => {
  const rs = [...Array.from({ length: 12 }, (_, i) => order(`new${i}`, { orderDate: new Date('2024-04-10T18:00:00Z') })), ...Array.from({ length: 10 }, (_, i) => order(`old${i}`, { orderDate: new Date(`2024-0${1 + i % 3}-10T18:00:00Z`) }))];
  const run = coverage => buildRecapStories(rs, 'America/Toronto', 'CAD', rates, legacy, coverage, new Date('2024-05-10'));
  assert.equal(run([]).stories.some(s => s.id.startsWith('ordering-escalation')), false);
  assert.equal(run([{ provider: 'uber_eats', start: '2024-01-01', end: '2024-04-30' }]).stories.some(s => s.id === 'ordering-escalation-2024-04'), true);
  assert.equal(run([{ provider: 'uber_eats', start: '2024-01-01', end: '2024-02-01' }, { provider: 'uber_eats', start: '2024-03-01', end: '2024-04-30' }]).stories.some(s => s.id.startsWith('ordering-escalation')), false);
});

test('busy-day orders match the counted local day, deduplicate and preserve time evidence', () => {
  const early = order('early', {
    restaurantName: 'Breakfast',
    orderDate: new Date('2023-12-10T14:12:00Z'),
  });
  early.resolution.timestamp = { role: 'placed', precision: 'minute', timezone: 'America/Toronto' };
  const late = order('late', {
    restaurantName: 'Dinner',
    orderDate: new Date('2023-12-11T03:16:00Z'),
  });
  late.resolution.timestamp = { role: 'placed', precision: 'minute', timezone: 'America/Toronto' };
  late.resolution.orderOutcome.refundStatus = 'full';
  const unknown = order('unknown', { restaurantName: null });
  const canceled = order('canceled');
  canceled.resolution.orderOutcome.fulfillment = 'canceled';
  const nextDay = order('next', { orderDate: new Date('2023-12-11T15:00:00Z') });
  const story = build([late, unknown, early, early, canceled, nextDay]).stories.find(
    (s) => s.id === 'most-deliveries-day',
  );
  assert.equal(story.startDate, '2023-12-10');
  assert.equal(story.value, 3);
  assert.deepEqual(story.orders, [
    { id: 'early', restaurant: 'Breakfast', localTime: '09:12' },
    { id: 'late', restaurant: 'Dinner', localTime: '22:16' },
    { id: 'unknown', restaurant: 'Unknown restaurant', localTime: undefined },
  ]);
});

test('recap supporting receipts use real cohorts, local chronology, and bounded streaks', () => {
  const rs = Array.from({ length: 10 }, (_, i) => {
    const r = order(`day-${i}`, { restaurantName: 'McDonald’s', orderDate: new Date(`2023-12-${String(i + 1).padStart(2, '0')}T18:00:00Z`), amountSpent: 12 });
    r.resolution.timestamp = { role: 'placed', precision: 'minute', timezone: 'America/Toronto' };
    r.resolution.orderOutcome.netAmount = 12;
    return r;
  });
  const biggest = order('biggest', { amount: 80, orderDate: new Date('2023-12-04T19:00:00Z') });
  const stories = build([...rs, biggest]).stories;
  const big = stories.find(s => s.id === 'most-expensive-order');
  assert.equal(big.evidence.orders[0].id, 'biggest');
  assert.equal(big.evidence.orders[0].amount, big.value);
  assert.equal(big.evidence.orders[0].items[0].name, 'Burger');
  const week = stories.find(s => s.id === 'spending-burst');
  assert.equal(week.evidence.orders.length, 3);
  assert.equal(week.evidence.orders[0].id, 'biggest');
  assert.ok(week.evidence.orders.every(o => o.date >= week.startDate && o.date <= week.endDate));
  const streak = stories.find(s => s.id === 'longest-streak');
  assert.equal(streak.evidence.total, 10);
  assert.equal(streak.evidence.orders.length, 6);
  assert.equal(streak.evidence.orders[0].date, '2023-12-01');
  assert.equal(streak.evidence.orders[5].date, '2023-12-10');
  assert.equal(stories.find(s => s.id === 'history-first').evidence.orders[0].id, 'day-0');
  assert.equal(stories.find(s => s.id === 'history-latest').evidence.orders[0].id, 'day-9');
  assert.equal(stories.find(s => s.id === 'repeated-basket').evidence.kind, 'items');
});

test('late-night examples rank across midnight and exclude dates without time evidence', () => {
  const rs = ['23:00', '03:42', '01:16'].map((time, i) => {
    const r = order(`night-${i}`, { orderDate: new Date(`2023-12-10T${time}:00Z`) });
    r.resolution.timestamp = { role: 'placed', precision: 'minute', timezone: 'UTC' };
    return r;
  });
  const data = buildRecapStories([...rs, order('date-only')], 'UTC', 'CAD', rates, {
    ...legacy, shame: { lateNightOrders: { count: 3 } }, flex: { nightOwl: { count: 3, percentage: 100 } },
  });
  for (const id of ['late-night-orders', 'night-owl']) {
    const evidence = data.stories.find(s => s.id === id).evidence;
    assert.deepEqual(evidence.orders.map(o => o.id), ['night-1', 'night-2', 'night-0']);
    assert.equal(evidence.total, 3);
  }
});

test('single-item examples follow the priced restaurant cohort and exclude combos', async () => {
  const solo = order('solo', { amount: 8, restaurantName: 'McDonald’s', items: [{ name: 'McFlurry', quantity: 1, price: 8 }] });
  const combo = order('combo', { amount: 12, restaurantName: 'McDonald’s', items: [{ name: 'Burger combo', quantity: 1, price: 12 }] });
  const expensive = order('expensive', { amount: 30, restaurantName: 'McDonald’s', items: [{ name: 'Burger', quantity: 1, price: 30 }] });
  const receipts = [solo, combo, expensive];
  const canonical = await new WrappedAnalyticsCalculator().calculate(receipts, 'America/Toronto');
  const recap = buildRecapStories(receipts, 'America/Toronto', 'USD', rates, canonical);
  const story = recap.stories.find(s => s.id === 'single-item-orders');
  assert.equal(story.value, 1);
  assert.deepEqual(story.evidence.orders.map(o => o.id), ['solo']);
  assert.equal(story.evidence.total, story.value);
});
