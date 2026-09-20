const test = require('node:test');
const assert = require('node:assert/strict');

const { mapReceiptRow } = require('../dist/services/data/receiptRowMapper');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');

const row = (overrides = {}) => ({
  id: '22222222-2222-4222-8222-222222222222',
  user_id: '11111111-1111-4111-8111-111111111111',
  items: [{ name: 'Soup', quantity: 2, price: 8 }],
  amount_spent: '24.50',
  receipt_type: 'uber_eats',
  restaurant_name: 'Noodle House',
  order_date: '2026-08-01T12:00:00.000Z',
  data_source: 'email',
  delivery_time: null,
  external_id: null,
  ...overrides,
});

test('receipt row mapper validates and maps the canonical database record', () => {
  const receipt = mapReceiptRow(row());
  assert.equal(receipt.amountSpent, 24.5);
  assert.equal(receipt.receiptType, 'uber_eats');
  assert.equal(receipt.dataSource, 'email');
  assert.deepEqual(receipt.items, [{ name: 'Soup', quantity: 2, price: 8 }]);
});

for (const [label, override] of [
  ['receipt enum', { receipt_type: 'UBER' }],
  ['source enum', { data_source: 'spreadsheet' }],
  ['amount', { amount_spent: 'not-money' }],
  ['date', { order_date: 'not-a-date' }],
  ['JSON shape', { items: { name: 'Soup' } }],
  ['item quantity', { items: [{ name: 'Soup', quantity: -1, price: 8 }] }],
]) {
  test(`receipt row mapper rejects malformed database ${label}`, () => {
    assert.throws(
      () => mapReceiptRow(row(override)),
      (error) => error.code === 'DATABASE_ERROR',
    );
  });
}

test('receipt row mapper explicitly supports the migrated legacy string-item representation', () => {
  const receipt = mapReceiptRow(row({ items: ['Soup'] }));
  assert.deepEqual(receipt.items, [{ name: 'Soup', quantity: 1, price: 0 }]);
});

test('receipt repository rejects malformed aggregate and cutoff rows', async () => {
  const aggregate = new ReceiptRepository({
    query: async () => ({
      rows: [{ count: 'not-count', receipts: [], timezone: 'America/Toronto' }],
    }),
  });
  await assert.rejects(
    aggregate.findPage({ userId: 'user-1' }, 20, 0),
    (error) => error.code === 'DATABASE_ERROR',
  );

  const cutoff = new ReceiptRepository({
    query: async () => ({ rows: [{ receipt_type: 'UBER', latest: new Date() }] }),
  });
  await assert.rejects(
    cutoff.getLatestCsvReceiptDates('user-1'),
    (error) => error.code === 'DATABASE_ERROR',
  );
});
