const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  startReceiptImportOutcome: start,
  recordReceiptImportPage: page,
  resolveReceiptImportOutcome: resolve,
  decodeReceiptImportOutcomeState: decode,
} = require('../dist/services/import/ReceiptImportOutcome');
const {
  decodeReceiptImportOutcome,
  decodeReceiptImportOutcomeLedger,
  receiptImportOutcomeFields,
} = require('../dist/services/import/ReceiptImportOutcome');
const { importCompletionResult } = require('../dist/services/import/ImportCompletionResult');
const { toImportOperation } = require('../dist/services/import/ImportJobTypes');

function order(id, observationIds, amount = 20, extra = {}) {
  return {
    id,
    userId: 'user',
    dataSource: 'email',
    receiptType: 'uber_eats',
    restaurantName: 'Restaurant',
    orderDate: new Date('2023-12-10T17:00:00Z'),
    amountSpent: amount ?? 0,
    items: [],
    monetaryDetails: { currencyCode: 'CAD' },
    resolution: {
      version: 1,
      amountBasis: 'receipt_total',
      adjustments: [],
      issues: [],
      reconciliation: { policyVersion: 3, status: 'matched', observationIds },
      orderOutcome: {
        version: 3,
        kind: 'order',
        fulfillment: 'completed',
        financialConfidence: 'confirmed',
        netAmount: amount,
        events: [],
      },
    },
    ...extra,
  };
}
function checked(state, final) {
  assert.deepEqual(decode(JSON.parse(JSON.stringify(state))), state);
  const result = resolve(state, final);
  assert.deepEqual(decodeReceiptImportOutcome(result), result);
  assert.deepEqual(resolve(state, [...final].reverse()), result);
  assert.equal(
    result.ordersProcessed,
    result.newOrders + result.updatedOrders + result.unchangedOrders,
  );
  return result;
}

test('a new order enriched on a later page is one new order, not new plus updated', () => {
  const original = order('a', ['email']);
  const enriched = order('a', ['email', 'export'], 15);
  let state = page(start([]), [], [original], ['email']);
  state = page(state, [original], [enriched], ['export']);
  const result = checked(state, [enriched]);
  assert.equal(result.newOrders, 1);
  assert.equal(result.updatedOrders, 0);
  assert.equal(result.sourceDocuments, 2);
  assert.equal(result.currencies[0].netAmount, 15);
  assert.deepEqual(
    checked(page(state, [enriched], [enriched], ['email', 'export']), [enriched]),
    result,
  );
});

test('many updates to an existing order count once; unchanged checked orders stay unchanged', () => {
  const original = order('a', ['original']);
  const other = order('b', ['other']);
  const one = order('a', ['original', 'one'], 15);
  const two = order('a', ['original', 'one', 'two'], 10);
  let state = page(start([original, other]), [original, other], [one, other], ['one']);
  state = page(state, [one, other], [two, other], ['two', 'other']);
  const result = checked(state, [two, other]);
  assert.equal(result.newOrders, 0);
  assert.equal(result.updatedOrders, 1);
  assert.equal(result.unchangedOrders, 1);
});

test('temporary duplicate orders that merge later report the final single membership', () => {
  const one = order('a', ['one']);
  const two = order('b', ['two']);
  const final = order('a', ['one', 'two', 'identity']);
  let state = page(start([]), [], [one], ['one']);
  state = page(state, [one], [one, two], ['two']);
  state = page(state, [one, two], [final], ['identity']);
  assert.equal(checked(state, [final]).newOrders, 1);
});

test('two existing purchases merging become one enriched order, not a new purchase', () => {
  const before = [order('a', ['one']), order('b', ['two'])];
  const final = [order('a', ['one', 'two', 'identity'])];
  const result = checked(page(start(before), before, final, ['identity']), final);
  assert.equal(result.newOrders, 0);
  assert.equal(result.updatedOrders, 1);
});

test('a split preserves only one baseline purchase per final order without changing associations', () => {
  const before = [order('a', ['one', 'two'])];
  const final = [order('a', ['one']), order('b', ['two', 'new'])];
  const result = checked(page(start(before), before, final, ['new']), final);
  assert.equal(result.newOrders, 1);
  assert.equal(result.updatedOrders, 1);
});

test('lineage accounting can reassign an earlier owner instead of falsely reporting a new order', () => {
  const before = [order('a', ['one', 'two']), order('b', ['three'])];
  const final = [order('a', ['one', 'three']), order('c', ['two', 'new'])];
  const result = checked(page(start(before), before, final, ['new']), final);
  assert.equal(result.newOrders, 0);
  assert.equal(result.updatedOrders, 2);
});

test('late ambiguity counts all affected unmatched orders, not only the incoming email', () => {
  const before = [order('a', ['export', 'email-one'])];
  const unmatched = (id) => {
    const receipt = order(id, [id]);
    receipt.resolution.reconciliation.status = 'unresolved';
    return receipt;
  };
  const final = [
    order('a', ['export'], 20, { dataSource: 'csv' }),
    unmatched('email-one'),
    unmatched('email-two'),
  ];
  const result = checked(page(start(before), before, final, ['email-two']), final);
  assert.equal(result.newOrders, 0);
  assert.equal(result.updatedOrders, 1);
  assert.equal(result.unresolvedOrders, 2);
  assert.equal(result.currencies[0].netAmount, 20);
  assert.equal(result.currencies[0].possibleAdditionalAmount, 40);
});

test('an orphan refund becoming attached is one new established order, not an extra purchase', () => {
  const orphan = order('a', ['refund'], null);
  orphan.resolution.orderOutcome.kind = 'unlinked_adjustment';
  const final = order('a', ['refund', 'original'], 0);
  final.resolution.orderOutcome.events = [
    { kind: 'refund', amount: 20, key: 'refund', observationIds: ['refund'] },
  ];
  let state = page(start([]), [], [orphan], ['refund']);
  assert.equal(checked(state, [orphan]).unlinkedAdjustments, 1);
  assert.equal(checked(state, [orphan]).newOrders, 0);
  state = page(state, [orphan], [final], ['original']);
  const result = checked(state, [final]);
  assert.equal(result.newOrders, 1);
  assert.equal(result.adjustedOrders, 1);
  assert.equal(result.unlinkedAdjustments, 0);
});

test('new cancellation discovery and financial adjustments are separate non-additive counts', () => {
  const before = order('a', ['original']);
  before.resolution.orderOutcome.fulfillment = 'unknown';
  const final = order('a', ['original', 'cancellation'], 10);
  final.resolution.orderOutcome.fulfillment = 'canceled';
  final.resolution.orderOutcome.events = [
    { kind: 'refund', amount: 10, key: 'refund', observationIds: ['cancellation'] },
  ];
  const result = checked(page(start([before]), [before], [final], ['cancellation']), [final]);
  assert.equal(result.updatedOrders, 1);
  assert.equal(result.adjustedOrders, 1);
  assert.equal(result.cancellationsRecovered, 1);
  assert.equal(result.ordersProcessed, 1);
});

test('currencies and unknown amounts remain separate; unrelated concurrent history is excluded', () => {
  const cad = order('a', ['cad'], 10);
  const usd = order('b', ['usd'], 20, { monetaryDetails: { currencyCode: 'USD' } });
  const unknown = order('c', ['unknown'], null, { monetaryDetails: { currencyCode: 'UNKNOWN' } });
  const state = page(start([]), [], [cad, usd, unknown], ['cad', 'usd', 'unknown']);
  const result = checked(state, [cad, usd, unknown, order('unrelated', ['unrelated'], 999)]);
  assert.equal(result.ordersProcessed, 3);
  assert.deepEqual(
    result.currencies.map((c) => [c.currencyCode, c.netAmount, c.pricedOrders, c.unpricedOrders]),
    [
      ['CAD', 10, 1, 0],
      ['UNKNOWN', 0, 0, 1],
      ['USD', 20, 1, 0],
    ],
  );
});

test('empty imports have zero results and malformed stored state fails closed', () => {
  const before = [order('a', ['original'])];
  assert.equal(checked(start(before), before).ordersProcessed, 0);
  for (const invalid of [
    null,
    {},
    { ...start(before), version: 2 },
    { ...start(before), importedObservationIds: ['a', 'a'] },
    { ...start(before), baseline: [{ ...start(before).baseline[0], fingerprint: 'invalid' }] },
  ])
    assert.throws(() => decode(invalid), /Invalid receipt import outcome state/);
});

test('compatibility totals preserve zero and currency uncertainty without adding possible amounts', () => {
  const cad = order('a', ['cad'], 0);
  const possibleUsd = order('b', ['usd'], 20, { monetaryDetails: { currencyCode: 'USD' } });
  possibleUsd.resolution.reconciliation.status = 'unresolved';
  const result = checked(page(start([]), [], [cad, possibleUsd], ['cad', 'usd']), [
    cad,
    possibleUsd,
  ]);
  assert.equal(receiptImportOutcomeFields(result).totalAmount, 0);
  assert.equal(receiptImportOutcomeFields(result).currencyCode, 'CAD');
  possibleUsd.resolution.reconciliation.status = 'standalone';
  const mixed = checked(page(start([]), [], [cad, possibleUsd], ['cad', 'usd']), [
    cad,
    possibleUsd,
  ]);
  assert.equal(receiptImportOutcomeFields(mixed).totalAmount, null);
  assert.equal(receiptImportOutcomeFields(mixed).currencyCode, null);
});

test('public outcomes are validated and retained without exposing internal membership ledgers', () => {
  const final = order('a', ['email']);
  const result = checked(page(start([]), [], [final], ['email']), [final]);
  assert.deepEqual(
    toImportOperation({ result: { receiptOutcome: result } }).result.receiptOutcome,
    result,
  );
  const notice = importCompletionResult({
    newOrders: 99,
    importedCount: 99,
    receiptOutcome: result,
  });
  assert.equal(notice.body, '1 new order added.');
  for (const invalid of [
    null,
    {},
    { ...result, ordersProcessed: 2 },
    { ...result, adjustedOrders: 2 },
    { ...result, currencies: [...result.currencies, ...result.currencies] },
  ]) {
    assert.throws(
      () => toImportOperation({ result: { receiptOutcome: invalid } }),
      /Invalid receipt import outcome/,
    );
  }
  const state = start([]);
  assert.deepEqual(
    decodeReceiptImportOutcomeLedger({ ...state, scopes: { gmail: state } }).scopes.gmail,
    state,
  );
  assert.throws(() => decodeReceiptImportOutcomeLedger(state), /Invalid receipt import accounting/);
  assert.throws(
    () => decodeReceiptImportOutcomeLedger({ ...state, scopes: { bad: state } }),
    /Invalid receipt import accounting/,
  );
});
