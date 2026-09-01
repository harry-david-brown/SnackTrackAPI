const test = require('node:test');
const assert = require('node:assert/strict');

const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { ReceiptType } = require('../dist/models/Receipt');

test('receipt list and count use the same filter predicates and values', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '1' }], rowCount: 1 };
      return {
        rows: [
          {
            id: 'receipt-id',
            user_id: 'user-id',
            items: [],
            amount_spent: '12.50',
            receipt_type: 'uber_eats',
            restaurant_name: 'Test Kitchen',
            order_date: new Date('2026-08-01T12:00:00.000Z'),
            data_source: 'email',
            delivery_time: null,
            external_id: 'provider-id',
          },
        ],
        rowCount: 1,
      };
    },
  };

  const result = await new ReceiptRepository(postgres).findPage(
    {
      userId: 'user-id',
      receiptType: ReceiptType.UBER_EATS,
      restaurantName: 'Kitchen',
      minAmount: 0,
      maxAmount: 20,
    },
    20,
    0,
  );

  const listQuery = queries.find(({ sql }) => sql.includes('ORDER BY'));
  const countQuery = queries.find(({ sql }) => sql.includes('COUNT(*)'));
  assert.ok(listQuery);
  assert.ok(countQuery);
  assert.match(listQuery.sql, /restaurant_name ILIKE \$3/);
  assert.match(countQuery.sql, /restaurant_name ILIKE \$3/);
  assert.deepEqual(listQuery.params.slice(0, -2), countQuery.params);
  assert.deepEqual(countQuery.params, ['user-id', 'uber_eats', '%Kitchen%', 0, 20]);
  assert.equal(result.total, 1);
  assert.equal(result.receipts[0].id, 'receipt-id');
});
