const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseReceiptListFilters } = require('../dist/http/validation/receiptListFilters');
const { receiptHistoryQuery } = require('../dist/services/data/ReceiptHistoryQuery');
const { createReceiptsRouter } = require('../dist/routes/receipts');
const { mapReceiptPageResponse } = require('../dist/http/mappers/receiptResponse');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');

test('calendar day boundaries are inclusive local days while explicit ISO timestamps retain instant semantics', () => {
  const days = parseReceiptListFilters('account', {
    startDate: '2023-12-10',
    endDate: '2023-12-10',
    outcome: 'canceled',
    currencyCode: 'CAD',
    minAmount: '0',
    maxAmount: '50',
  });
  assert.equal(days.startDay, '2023-12-10');
  assert.equal(days.endDay, '2023-12-10');
  assert.equal(days.startDate, undefined);
  assert.equal(days.endDate, undefined);
  const query = receiptHistoryQuery(days, 20, 0);
  assert.match(query.sql, /history_day <= \$\d+::date/);
  assert.match(query.sql, /order_fulfillment='canceled'/);
  assert.equal(query.params.includes('CAD'), true);
  const instant = parseReceiptListFilters('account', { startDate: '2023-12-10T23:15:00-05:00' });
  assert.equal(instant.startDate.toISOString(), '2023-12-11T04:15:00.000Z');
  assert.equal(instant.startDay, undefined);
});

test('receipt filter validation rejects rolled dates, ambiguous clocks, unsupported outcomes/currencies and invalid money', () => {
  for (const query of [
    { startDate: '2023-02-29' },
    { endDate: '2024-02-30T10:00:00Z' },
    { startDate: '2024-01-10T10:00:00' },
    { startDate: '10/12/2023' },
    { startDate: ['2023-12-10'] },
    { startDate: '2024-01-02', endDate: '2024-01-01' },
    { startDate: '2024-01-02T10:00Z', endDate: '2024-01-01T10:00Z' },
    { minAmount: '-1' },
    { maxAmount: 'NaN' },
    { maxAmount: '3.456' },
    { maxAmount: '1000001' },
    { minAmount: '30', maxAmount: '20' },
    { outcome: 'hide_duplicates' },
    { currencyCode: 'BTC' },
    { receiptType: 'other' },
  ])
    assert.throws(
      () => parseReceiptListFilters('account', query),
      (error) => error.code === 'VALIDATION_ERROR',
      JSON.stringify(query),
    );
});

test('the authenticated receipt route passes scoped filters and page-timezone context to the canonical mapper', async () => {
  const receipts = await decemberCanonicalOrders();
  const calls = [];
  const pass = (_req, _res, next) => next();
  const router = createReceiptsRouter({
    authenticate: pass,
    paginate: pass,
    listReceipts: {
      execute: async (input) => {
        calls.push(input);
        return { receipts: [receipts[1]], total: 1, timezone: 'America/Toronto' };
      },
    },
    clearReceipts: {
      clearReceipts: async () => {
        throw Error('must not mutate');
      },
    },
  });
  const handler = router.stack.find((layer) => layer.route?.methods.get).route.stack.at(-1).handle;
  const response = await new Promise((resolve, reject) =>
    handler(
      {
        user: { userId: 'token-account' },
        query: {
          limit: '20',
          userId: 'attacker-account',
          outcome: 'canceled',
          startDate: '2023-12-10',
          endDate: '2023-12-10',
        },
      },
      { json: resolve },
      reject,
    ),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].filters.userId, 'token-account');
  assert.equal(calls[0].filters.outcome, 'canceled');
  assert.deepEqual(response, mapReceiptPageResponse([receipts[1]], 1, 1, 20, 'America/Toronto'));
  assert.equal(response.items[0].orderDay, '2023-12-10');
});

test('history timezone fallback preserves available legacy dates and never overrides a known event timezone', async () => {
  const base = (await decemberCanonicalOrders())[0];
  const legacy = { ...base, resolution: undefined, orderDate: new Date('2024-01-31T12:30:00Z') };
  assert.equal(
    mapReceiptPageResponse([legacy], 1, 1, 20, 'Pacific/Kiritimati').items[0].orderDay,
    '2024-02-01',
  );
  const missing = {
    ...base,
    resolution: { ...base.resolution, timestamp: undefined },
    orderDate: legacy.orderDate,
  };
  assert.equal(
    mapReceiptPageResponse([missing], 1, 1, 20, 'Pacific/Kiritimati').items[0].orderOutcome
      .orderDay,
    '2024-02-01',
  );
  assert.equal(
    mapReceiptPageResponse([base], 1, 1, 20, 'Asia/Tokyo').items[0].orderDay,
    '2023-12-10',
  );
});
