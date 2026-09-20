const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  currentSourceInterpretations,
} = require('../dist/services/receipt/ReceiptSourceInterpretations');

const source = (id, parser, details = {}) => ({
  id,
  receipt: {
    userId: 'user',
    receiptType: 'uber_eats',
    dataSource: 'email',
    resolution: {
      sourceMessageId: 'gmail:message',
      ...(parser === 3 ? { orderEvidence: { parserVersion: 3 } } : {}),
    },
    ...details,
  },
});

test('new parser facts supersede only the same identified document, independent of arrival order', () => {
  const old = source('old', 2),
    current = source('current', 3);
  for (const observations of [
    [old, current],
    [current, old],
  ])
    assert.deepEqual(currentSourceInterpretations(observations), [current]);
  assert.equal(
    currentSourceInterpretations([
      old,
      { ...current, receipt: { ...current.receipt, userId: 'other' } },
    ]).length,
    2,
  );
  assert.equal(
    currentSourceInterpretations([
      old,
      { ...current, receipt: { ...current.receipt, receiptType: 'doordash' } },
    ]).length,
    2,
  );
  assert.equal(
    currentSourceInterpretations([current, source('same-parser', 3)]).length,
    2,
    'conflicting same-parser facts remain reviewable',
  );
  assert.equal(
    currentSourceInterpretations([
      source('unknown-a', 2, { resolution: {} }),
      source('unknown-b', 3, { resolution: { orderEvidence: { parserVersion: 3 } } }),
    ]).length,
    2,
  );
});

test('identical export rows may be reinterpreted, but revised export facts remain evidence', () => {
  const rows = [
    { Order_Status: 'completed', Order_Price: '0', Request_Time_Local: '2023-12-10T00:38:23Z' },
  ];
  const old = source('old', 2, { dataSource: 'csv', resolution: { rows } });
  const current = source('current', 3, {
    dataSource: 'csv',
    resolution: { rows, orderEvidence: { parserVersion: 3 } },
  });
  assert.deepEqual(currentSourceInterpretations([old, current]), [current]);
  const changed = structuredClone(current);
  changed.receipt.resolution.rows[0].Order_Price = '10';
  assert.equal(currentSourceInterpretations([old, changed]).length, 2);
});
