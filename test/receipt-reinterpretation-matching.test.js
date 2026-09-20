const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');
const { groupReceiptFamilies } = require('../dist/services/receipt/ReceiptFamilyResolver');

const timezone = 'America/Toronto';
function source(id, dataSource, amount, providerId, parserVersion = 3) {
  const observation = {
    id,
    receipt: {
      userId: 'user',
      receiptType: 'uber_eats',
      dataSource,
      restaurantName: 'Pizza Pizza (1717 Bank St.)',
      orderDate: new Date('2023-12-10T06:00:00Z'),
      amountSpent: amount,
      externalId: providerId,
      items: [],
      monetaryDetails: { currencyCode: 'CAD' },
      resolution: {
        version: 1,
        amountBasis: dataSource === 'csv' ? 'export_total' : 'receipt_total',
        adjustments: [],
        issues: [],
        ...(dataSource === 'email' ? { sourceMessageId: `gmail:${id}` } : {}),
        orderEvidence: {
          version: 1,
          parserVersion,
          documentKind: dataSource === 'csv' ? 'export' : 'original',
          fulfillment: 'completed',
          orderHeaderDay: '2023-12-10',
          recordedTotal: amount,
          totalState: 'known',
          timestamps: [],
          payments: [],
          issues: [],
        },
      },
    },
  };
  if (parserVersion !== 3) delete observation.receipt.resolution.orderEvidence;
  return observation;
}
const run = (observations) => reconcileReceiptGroups(observations, timezone, [], 3);
const memberships = (groups) => groups.map((g) => g.observations.map((o) => o.id).sort()).sort();
const copyAsCurrent = (old, id) => {
  const current = structuredClone(old);
  current.id = id;
  current.receipt.resolution.orderEvidence = source(
    id,
    old.receipt.dataSource,
    old.receipt.amountSpent,
  ).receipt.resolution.orderEvidence;
  return current;
};

test('a corrected provider identity moves all interpretations of the same email, not its old price to another purchase', () => {
  const a = source('export-a', 'csv', 43.26, 'order-a');
  const b = source('export-b', 'csv', 19.47, 'order-b');
  const old = source('old-email', 'email', 19.47, 'order-a', 2);
  const current = copyAsCurrent(old, 'current-email');
  current.receipt.externalId = 'order-b';
  const inputs = [a, b, old, current];
  const frozen = structuredClone(inputs);
  const expected = [['current-email', 'export-b', 'old-email'], ['export-a']];
  for (const records of [inputs, [...inputs].reverse(), [old, a, current, b]]) {
    const groups = run(records);
    assert.deepEqual(memberships(groups), expected);
    const orders = groups.map((g, i) => projectReconciledGroup(g, `order-${i}`));
    assert.equal(
      orders.reduce((sum, r) => sum + Math.round(r.amountSpent * 100), 0),
      6273,
    );
    assert.equal(orders.find((r) => r.externalId === 'order-a').amountSpent, 43.26);
  }
  assert.deepEqual(inputs, frozen, 'immutable observations must not be rewritten');
});

test('a corrected export timezone cannot turn identical retained rows into two purchases', () => {
  const old = source('old-export', 'csv', 19.47, undefined, 2);
  old.receipt.resolution.rows = [
    { Request_Time_Local: '2023-12-10T01:00:00Z', Order_Price: '19.47' },
  ];
  old.receipt.orderDate = new Date('2023-12-10T01:00:00Z');
  const current = copyAsCurrent(old, 'current-export');
  current.receipt.orderDate = new Date('2023-12-10T06:00:00Z');
  const groups = run([old, current]);
  assert.deepEqual(memberships(groups), [['current-export', 'old-export']]);
  assert.equal(
    projectReconciledGroup(groups[0], 'order').orderDate.toISOString(),
    '2023-12-10T06:00:00.000Z',
  );
});

test('superseded provider IDs cannot veto a supported refund family', () => {
  const old = source('old', 'email', 22.48, 'wrong-id', 2);
  const current = copyAsCurrent(old, 'current');
  current.receipt.externalId = 'correct-id';
  const refund = source('refund', 'email', 0, 'correct-id');
  Object.assign(refund.receipt.resolution.orderEvidence, {
    documentKind: 'refund',
    previousTotal: 22.48,
    revisionOf: 'current',
    refundConfirmed: true,
  });
  const groups = groupReceiptFamilies([[old, current], [refund]]);
  assert.deepEqual(memberships(groups.map((observations) => ({ observations }))), [
    ['current', 'old', 'refund'],
  ]);
  assert.deepEqual(memberships(run([old, current, refund])), [['current', 'old', 'refund']]);
});

test('a refund explicitly referencing an older interpretation follows its corrected document', () => {
  const old = source('old', 'email', 30, undefined, 2);
  const current = copyAsCurrent(old, 'current');
  current.receipt.amountSpent = 22.48;
  current.receipt.resolution.orderEvidence.recordedTotal = 22.48;
  const refund = source('refund', 'email', 0);
  Object.assign(refund.receipt.resolution.orderEvidence, {
    documentKind: 'refund',
    revisionOf: 'old',
    refundConfirmed: true,
  });
  assert.deepEqual(memberships(run([old, current, refund])), [['current', 'old', 'refund']]);
  const outcome = resolveOrderOutcome([old, current, refund]);
  assert.equal(outcome.netAmount, 0);
  assert.equal(outcome.originalCharge, 22.48);
  assert.equal(outcome.confirmedRefundAmount, 22.48);
  assert.equal(outcome.financialConfidence, 'confirmed');
});

test('an invalidated provider ID is not carried forward when the current parser finds no ID', () => {
  const old = source('old', 'email', 19.47, 'wrong-id', 2);
  const current = copyAsCurrent(old, 'current');
  delete current.receipt.externalId;
  const wrong = source('wrong-export', 'csv', 43.26, 'wrong-id');
  wrong.receipt.resolution.orderEvidence.orderHeaderDay = '2023-12-11';
  const correct = source('correct-export', 'csv', 19.47, 'correct-id');
  assert.deepEqual(memberships(run([old, wrong, current, correct])), [
    ['correct-export', 'current', 'old'],
    ['wrong-export'],
  ]);
});

test('equally current conflicting IDs stay one unresolved source document, never multiple purchases', () => {
  const old = source('old', 'email', 19.47, 'obsolete', 2);
  const a = copyAsCurrent(old, 'current-a');
  const b = copyAsCurrent(old, 'current-b');
  a.receipt.externalId = 'a';
  b.receipt.externalId = 'b';
  for (const records of [
    [a, old, b],
    [b, old, a],
  ]) {
    const groups = run(records);
    assert.deepEqual(memberships(groups), [['current-a', 'current-b', 'old']]);
    assert.equal(groups[0].reason, 'identity_conflict');
    assert.equal(projectReconciledGroup(groups[0], 'canonical').externalId, undefined);
  }
  const independent = structuredClone(b);
  independent.receipt.resolution.sourceMessageId = 'gmail:independent';
  assert.equal(
    run([old, independent]).length,
    2,
    'different source documents must not supersede each other',
  );
  independent.receipt.resolution.sourceMessageId = old.receipt.resolution.sourceMessageId;
  independent.receipt.userId = 'another-user';
  assert.equal(run([old, independent]).length, 2, 'source document identity is account scoped');
});

for (const dataSource of ['email', 'csv'])
  test(`${dataSource}: a disputed source document cannot claim either export or inflate established spending`, () => {
    const a = source('export-a', 'csv', 43.26, 'a');
    const b = source('export-b', 'csv', 19.47, 'b');
    const suspect = source('suspect-a', dataSource, 22.48, 'a');
    if (dataSource === 'csv')
      suspect.receipt.resolution.rows = [{ retained: 'same source document' }];
    const conflicting = structuredClone(suspect);
    conflicting.id = 'suspect-b';
    conflicting.receipt.externalId = 'b';
    const input = [a, suspect, b, conflicting];
    const before = structuredClone(input);
    for (const records of [input, [...input].reverse()]) {
      const groups = run(records);
      assert.deepEqual(memberships(groups), [
        ['export-a'],
        ['export-b'],
        ['suspect-a', 'suspect-b'],
      ]);
      const projected = groups.map((g, i) => projectReconciledGroup(g, `canonical-${i}`));
      const disputed = projected.find((r) => r.resolution.reconciliation.status === 'unresolved');
      assert.equal(disputed.externalId, undefined);
      assert.equal(disputed.resolution.reconciliation.reason, 'identity_conflict');
      const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
      const metrics = summarizeOrderMetrics(projected);
      assert.equal(metrics.attempts, 2);
      assert.equal(metrics.deliveries, 2);
      assert.equal(metrics.possibleAdditionalOrders, 1);
      assert.equal(metrics.currencies[0].netSpend, 62.73);
      assert.equal(metrics.currencies[0].possibleAdditionalSpend, 22.48);
    }
    assert.deepEqual(input, before);
  });

test('explicit references cannot use a disputed document to join an original/refund family', () => {
  const a = source('a', 'email', 22.48, 'a');
  const b = structuredClone(a);
  b.id = 'b';
  b.receipt.externalId = 'b';
  const refund = source('refund', 'email', 0);
  Object.assign(refund.receipt.resolution.orderEvidence, {
    documentKind: 'refund',
    revisionOf: 'a',
    previousTotal: 22.48,
    refundConfirmed: true,
  });
  assert.equal(groupReceiptFamilies([[a], [b], [refund]]).length, 3);
  const groups = run([a, b, refund]);
  assert.deepEqual(memberships(groups), [['a', 'b'], ['refund']]);
  assert.equal(
    groups.find((g) => g.observations.some((o) => o.id === 'refund')).reason,
    'unlinked_adjustment',
  );
});

test('revision chains retain references to a superseded interpretation without using its stale balance', () => {
  const original = source('original', 'email', 22.48, 'same-order');
  const oldEdit = source('old-edit', 'email', 22.48, 'same-order', 2);
  const currentEdit = copyAsCurrent(oldEdit, 'current-edit');
  Object.assign(currentEdit.receipt.resolution.orderEvidence, {
    documentKind: 'updated',
    recordedTotal: 10,
    previousTotal: 22.48,
    revisionOf: 'original',
    refundConfirmed: true,
  });
  currentEdit.receipt.amountSpent = 10;
  const final = source('final', 'email', 0, 'same-order');
  Object.assign(final.receipt.resolution.orderEvidence, {
    documentKind: 'refund',
    previousTotal: 10,
    revisionOf: 'old-edit',
    refundConfirmed: true,
  });
  const result = resolveOrderOutcome([original, oldEdit, currentEdit, final]);
  assert.equal(result.netAmount, 0);
  assert.equal(result.originalCharge, 22.48);
  assert.equal(result.confirmedRefundAmount, 22.48);
  assert.equal(result.refundStatus, 'full');
  assert.ok(!result.financialObservationIds.includes('old-edit'));
  const groups = run([original, oldEdit, currentEdit, final]);
  assert.equal(groups.length, 1);
  const projected = projectReconciledGroup(groups[0], 'canonical');
  assert.equal(projected.resolution.orderOutcome.netAmount, 0);
  assert.equal(projected.resolution.orderOutcome.confirmedRefundAmount, 22.48);
});

test('export reinterpretation recognizes the same retained row multiset in reversed item order', () => {
  const old = source('old', 'csv', 19.47, undefined, 2);
  old.receipt.orderDate = new Date('2023-12-10T01:00:00Z');
  old.receipt.resolution.rows = [{ Item: 'Pizza' }, { Item: 'Dip' }, { Item: 'Dip' }];
  const current = copyAsCurrent(old, 'current');
  current.receipt.orderDate = new Date('2023-12-10T06:00:00Z');
  current.receipt.resolution.rows.reverse();
  assert.deepEqual(memberships(run([old, current])), [['current', 'old']]);
  const changed = structuredClone(current);
  changed.receipt.resolution.rows.pop();
  assert.equal(run([old, changed]).length, 2, 'changed export rows remain separate evidence');
});
