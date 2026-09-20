const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
function observation(id, source, time, total = 20, extra = {}) {
  return {
    id,
    receipt: {
      userId: 'user',
      receiptType: 'doordash',
      dataSource: source,
      restaurantName: 'Grimaldi‘s Garden City',
      orderDate: new Date(time),
      amountSpent: total,
      items: source === 'csv' ? [{ name: 'Pizza', quantity: 2, price: 38.4 }] : [],
      monetaryDetails: { currencyCode: 'USD' },
      resolution: {
        version: 1,
        amountBasis: source === 'csv' ? 'item_subtotal' : 'receipt_total',
        adjustments: [],
        issues: [],
        timestamp: {
          raw: time,
          role: 'placed',
          timezone: 'America/Toronto',
          convention: 'fixture',
          precision: 'minute',
        },
      },
      ...extra,
    },
  };
}
const run = (observations) => reconcileReceiptGroups(observations, 'America/Toronto', [], 2);
test('newly identified copies of one email remain one source order without bridging conflicting IDs', () => {
  const a = observation('a', 'email', '2026-07-05T12:00:00Z');
  a.receipt.resolution.sourceMessageId = 'gmail:one';
  const b = structuredClone(a);
  b.id = 'b';
  b.receipt.externalId = 'known';
  const x = observation('x', 'csv', '2026-07-06T12:00:00Z', 30, { externalId: 'known' });
  assert.equal(run([a, b, x]).length, 1);
  const c = structuredClone(b);
  c.id = 'c';
  c.receipt.externalId = 'conflict';
  assert.equal(run([b, c]).length, 2);
});
test('comparable subtotals disambiguate otherwise identical baskets', () => {
  const a = observation('a', 'csv', '2026-07-05T12:00:00Z'),
    b = observation('b', 'csv', '2026-07-05T14:00:00Z');
  const c = observation('c', 'email', '2026-07-05T12:00:00Z'),
    d = observation('d', 'email', '2026-07-05T14:00:00Z');
  for (const o of [a, b, c, d]) {
    o.receipt.items = [{ name: 'Pizza', quantity: 1, price: 10 }];
    o.receipt.resolution.timestamp.precision = 'day';
  }
  a.receipt.monetaryDetails.subtotal = c.receipt.monetaryDetails.subtotal = 10;
  b.receipt.monetaryDetails.subtotal = d.receipt.monetaryDetails.subtotal = 15;
  assert.deepEqual(
    run([d, b, c, a]).map((g) => g.method),
    ['subtotal', 'subtotal'],
  );
});
test('event timezone wins during travel and across the daylight-saving boundary', () => {
  const x = observation('x', 'csv', '2026-03-08T08:30:00Z'),
    e = observation('e', 'email', '2026-03-08T23:30:00Z');
  x.receipt.resolution.timestamp.timezone = 'America/Los_Angeles';
  assert.equal(run([x, e]).length, 1);
  const y = observation('y', 'email', '2026-03-08T07:30:00Z');
  assert.equal(run([x, y]).length, 2, 'same UTC day is not necessarily the same event-local day');
});
test('unique same-day pair merges lower email total hours apart, preserving source evidence', () => {
  const x = observation('x', 'csv', '2026-07-05T21:41:53Z', 76.8),
    e = observation('e', 'email', '2026-07-05T17:41:57Z', 61.39);
  const groups = run([e, x]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].method, 'unique_day');
  const r = projectReconciledGroup(groups[0], 'canonical');
  assert.equal(r.amountSpent, 61.39);
  assert.equal(r.items[0].quantity, 2);
  assert.deepEqual(r.resolution.sources, ['csv', 'email']);
  assert.deepEqual(run([x, e]), groups);
});
test('later competing email invalidates a prior inferred merge', () => {
  const x = observation('x', 'csv', '2026-07-05T18:00:00Z'),
    e = observation('e', 'email', '2026-07-05T08:00:00Z');
  assert.equal(run([e, x]).length, 1);
  const late = observation('later', 'email', '2026-07-05T09:00:00Z');
  const result = run([e, x, late]);
  assert.equal(result.length, 3);
  assert.equal(result.filter((g) => g.reason === 'ambiguous').length, 2);
});
test('multiple orders use mutually separated times and never force remaining pairs', () => {
  const a = observation('a', 'csv', '2026-07-05T12:00:00Z'),
    b = observation('b', 'csv', '2026-07-05T22:00:00Z');
  const c = observation('c', 'email', '2026-07-05T12:20:00Z'),
    d = observation('d', 'email', '2026-07-05T06:00:00Z');
  const result = run([a, b, c, d]);
  assert.equal(result.length, 3);
  assert.equal(result.filter((g) => g.method === 'time').length, 1);
});
test('date-only timestamps cannot resolve multiple purchases', () => {
  const a = observation('a', 'csv', '2026-07-05T12:00:00Z'),
    b = observation('b', 'csv', '2026-07-05T22:00:00Z');
  const c = observation('c', 'email', '2026-07-05T12:00:00Z');
  c.receipt.resolution.timestamp.precision = 'day';
  assert.equal(run([a, b, c]).length, 3);
});
test('provider identity crosses days, revisions preserve lower latest total', () => {
  const a = observation('a', 'csv', '2026-07-05T12:00:00Z', 40, { externalId: 'same' });
  const b = observation('b', 'email', '2026-07-06T12:00:00Z', 30, { externalId: 'same' });
  const c = observation('c', 'email', '2026-07-07T12:00:00Z', 20, { externalId: 'same' });
  b.receipt.resolution.sourceRevisionAt = '2026-07-06T12:00:00Z';
  c.receipt.resolution.sourceRevisionAt = '2026-07-07T12:00:00Z';
  const groups = run([a, b, c]);
  assert.equal(groups.length, 1);
  assert.equal(projectReconciledGroup(groups[0], 'id').amountSpent, 20);
});
test('branchless matching requires uniqueness across branches; explicit conflicts never merge', () => {
  const a = observation('a', 'csv', '2026-07-05T12:00:00Z', 20, {
    restaurantName: 'McDonald’s (Bank St.)',
  });
  const b = observation('b', 'email', '2026-07-05T22:00:00Z', 20, {
    restaurantName: "McDonald's and Uber Eats",
  });
  assert.equal(run([a, b]).length, 1);
  const c = observation('c', 'csv', '2026-07-05T13:00:00Z', 20, {
    restaurantName: 'McDonalds (Other St)',
  });
  assert.equal(run([a, b, c]).length, 3);
  b.receipt.restaurantName = 'McDonalds (Other St)';
  assert.equal(run([a, b]).length, 2);
});
test('currency, identity, provider, user and local date conflicts prevent fallbacks', () => {
  const x = observation('x', 'csv', '2026-07-06T02:00:00Z'),
    e = observation('e', 'email', '2026-07-05T17:00:00Z');
  assert.equal(run([x, e]).length, 1);
  for (const extra of [
    { userId: 'other' },
    { receiptType: 'uber_eats' },
    { monetaryDetails: { currencyCode: 'CAD' } },
    { orderDate: new Date('2026-07-06T16:00:00Z') },
  ])
    assert.equal(run([x, { ...e, receipt: { ...e.receipt, ...extra } }]).length, 2);
  x.receipt.externalId = 'x';
  e.receipt.externalId = 'e';
  assert.equal(run([x, e]).length, 2);
});
test('coverage preserves interval gaps and flags incomplete exports', () => {
  const e = observation('e', 'email', '2026-07-05T17:00:00Z');
  const coverage = [
    {
      provider: 'doordash',
      start: '2026-07-01',
      end: '2026-07-03',
      quality: 'declared',
      incomplete: false,
    },
    {
      provider: 'doordash',
      start: '2026-07-06',
      end: '2026-07-09',
      quality: 'declared',
      incomplete: false,
    },
  ];
  assert.equal(reconcileReceiptGroups([e], 'America/Toronto', coverage)[0].reason, undefined);
  coverage.push({
    provider: 'doordash',
    start: '2026-07-05',
    end: '2026-07-05',
    quality: 'observed',
    incomplete: true,
  });
  assert.equal(
    reconcileReceiptGroups([e], 'America/Toronto', coverage)[0].reason,
    'incomplete_export',
  );
});
