const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mapReceiptResponse } = require('../dist/http/mappers/receiptResponse');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const { orderMetricEligibility } = require('../dist/services/analytics/shared/orderMetrics');
const mobileFixture = require('../../SnackTrackApp/__tests__/fixtures/order-event-history.json');
const { contractSchemas } = require('../dist/config/openapiContracts');

test('December History DTO and mobile fixture agree with five canonical attempts and wallet-inclusive net cost', async () => {
  const receipts = await decemberCanonicalOrders();
  const response = receipts.map(mapReceiptResponse);
  assert.deepEqual(JSON.parse(JSON.stringify(response)), mobileFixture);
  assert.equal(response.length, 5);
  assert.equal(response.filter((r) => r.orderOutcome.fulfillment === 'completed').length, 4);
  assert.equal(
    response.reduce((sum, r) => sum + Math.round(r.orderOutcome.netAmount * 100), 0),
    15702,
  );
  assert.equal(
    response.every((r) => r.orderOutcome.orderDay === '2023-12-10'),
    true,
  );
  assert.equal(
    response[0].orderOutcome.events.find((e) => e.kind === 'refund').tender,
    'provider_wallet',
  );
  assert.equal(response[4].orderOutcome.netAmount, 45.83);
  assert.deepEqual(
    response[4].orderOutcome.events.map((e) => e.amount),
    [39.61, 6.22],
  );
  const schema = contractSchemas.ReceiptOrderOutcome;
  assert.deepEqual(Object.keys(response[0].orderOutcome).sort(), [...schema.required].sort());
  assert.deepEqual(
    Object.keys(response[0].orderOutcome.events[0]).sort(),
    [...schema.properties.events.items.required].sort(),
  );
});

test('History DTO uses canonical unknown money and counting eligibility, not a compatibility zero or stale amount', async () => {
  const receipt = (await decemberCanonicalOrders())[0];
  const original = receipt.resolution.orderOutcome;
  for (const financialConfidence of ['unknown', 'conflicted']) {
    const input = {
      ...receipt,
      amountSpent: 999,
      resolution: {
        ...receipt.resolution,
        orderOutcome: {
          ...original,
          netAmount: financialConfidence === 'conflicted' ? 40 : null,
          confirmedRefundAmount: null,
          refundStatus: 'confirmed_unclassified',
          financialConfidence,
        },
      },
    };
    assert.equal(mapReceiptResponse(input).orderOutcome.netAmount, null);
    assert.equal(
      mapReceiptResponse(input).orderOutcome.netAmount,
      orderMetricEligibility(input).netAmount,
    );
  }
  const unresolved = {
    ...receipt,
    dataSource: 'email',
    resolution: {
      ...receipt.resolution,
      reconciliation: { ...receipt.resolution.reconciliation, status: 'unresolved' },
    },
  };
  assert.equal(mapReceiptResponse(unresolved).orderOutcome.counting, 'possible_additional_order');
  unresolved.dataSource = 'csv';
  unresolved.resolution.reconciliation.reason = 'identity_conflict';
  assert.equal(mapReceiptResponse(unresolved).orderOutcome.counting, 'possible_additional_order');
  unresolved.resolution.orderOutcome = { ...original, kind: 'unlinked_adjustment' };
  assert.equal(mapReceiptResponse(unresolved).orderOutcome.counting, 'unlinked_adjustment');
  assert.equal(mapReceiptResponse(unresolved).orderOutcome.orderDay, null);
});

test('History exposes financial facts without document identifiers, payment references, card suffixes or raw text', async () => {
  const receipt = (await decemberCanonicalOrders())[0];
  const input = {
    ...receipt,
    resolution: {
      ...receipt.resolution,
      orderOutcome: {
        ...receipt.resolution.orderOutcome,
        financialObservationIds: ['private-source'],
        issues: ['private-parser-text'],
        events: receipt.resolution.orderOutcome.events.map((e) => ({
          ...e,
          reference: 'private-payment',
          cardLastFour: '5028',
          timestamp: { role: 'payment', raw: 'private-raw', precision: 'minute' },
        })),
      },
    },
  };
  const result = mapReceiptResponse(input).orderOutcome;
  const serialized = JSON.stringify(result);
  for (const field of [
    'reference',
    'cardLastFour',
    'timestamp',
    'key',
    'observationIds',
    'financialObservationIds',
    'issues',
    'private-',
  ])
    assert.equal(serialized.includes(field), false, field);
});

test('History preserves travel/midnight order days and never substitutes adjustment or unknown timezones', async () => {
  const receipt = (await decemberCanonicalOrders())[0];
  const withZone = (timezone, orderDate) => ({
    ...receipt,
    orderDate: new Date(orderDate),
    resolution: { ...receipt.resolution, timestamp: { ...receipt.resolution.timestamp, timezone } },
  });
  assert.equal(
    mapReceiptResponse(withZone('Pacific/Kiritimati', '2024-01-31T12:30:00Z')).orderOutcome
      .orderDay,
    '2024-02-01',
  );
  assert.equal(
    mapReceiptResponse(withZone('America/Toronto', '2023-12-11T04:59:00Z')).orderOutcome.orderDay,
    '2023-12-10',
  );
  assert.equal(
    mapReceiptResponse(withZone('invalid-zone', '2023-12-10T12:00:00Z')).orderOutcome.orderDay,
    null,
  );
});
