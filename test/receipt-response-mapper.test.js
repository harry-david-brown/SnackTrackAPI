const test = require('node:test');
const assert = require('node:assert/strict');

const { DataSource, Receipt, ReceiptType } = require('../dist/models/Receipt');
const {
  mapReceiptPageResponse,
  mapReceiptResponse,
} = require('../dist/http/mappers/receiptResponse');

test('receipt response mapper owns the canonical public DTO and page contract', () => {
  const receipt = new Receipt(
    '11111111-1111-4111-8111-111111111111',
    [{ name: 'Soup', quantity: 2, price: 8, customizations: ['Hot'] }],
    24,
    ReceiptType.UBER_EATS,
    'Noodle House',
    new Date('2026-08-01T12:00:00.000Z'),
    DataSource.EMAIL,
    undefined,
    'provider-secret-not-public',
    '22222222-2222-4222-8222-222222222222',
  );

  assert.deepEqual(mapReceiptPageResponse([receipt], 21, 1, 20), {
    items: [
      {
        id: '22222222-2222-4222-8222-222222222222',
        userId: '11111111-1111-4111-8111-111111111111',
        items: [{ name: 'Soup', quantity: 2, price: 8, customizations: ['Hot'] }],
        amountSpent: 24,
        receiptType: 'uber_eats',
        restaurantName: 'Noodle House',
        orderDate: '2026-08-01T12:00:00.000Z',
        dataSource: 'email',
        sources: ['email'],
        currencyCode: 'UNKNOWN',
        amountBasis: 'legacy',
        evidenceSummary: 'Based on exported or legacy totals',
      },
    ],
    pageInfo: {
      page: 1,
      limit: 20,
      total: 21,
      totalPages: 2,
      hasMore: true,
      nextPage: 2,
    },
  });
});

test('receipt response mapper fails instead of emitting an unidentified persisted DTO', () => {
  const receipt = new Receipt('user-id', [], 0, ReceiptType.UNKNOWN);
  assert.throws(() => mapReceiptResponse(receipt), /missing its identity/);
});
