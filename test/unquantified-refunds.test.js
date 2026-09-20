const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractEmailOrderEvidence,
} = require('../dist/services/extraction/ReceiptOrderEvidenceExtractor');
const { orderAdjustmentProvider } = require('../dist/services/extraction/ReceiptClassifier');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const { decodeOrderSourceEvidence, decodeOrderOutcome } = require('../dist/models/OrderEvidence');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const { calculateCheckoutDifference } = require('../dist/services/receipt/CheckoutDifference');
const { resolveObservations } = require('../dist/services/receipt/ReceiptResolutionService');
const {
  buildReceiptReconciliationAudit,
} = require('../dist/services/receipt/ReceiptReconciliationAudit');
const orderId = '12345678-1234-1234-1234-123456789abc';
const timezone = 'America/Toronto';

function source(id, evidence = {}, extra = {}) {
  return {
    id,
    receipt: {
      userId: 'fixture-user',
      dataSource: 'email',
      receiptType: 'uber_eats',
      externalId: orderId,
      restaurantName: 'Pizza Place (Bank Street)',
      orderDate: new Date('2023-12-10T17:00Z'),
      amountSpent: 40,
      monetaryDetails: { currencyCode: 'CAD' },
      items: [],
      resolution: {
        version: 1,
        amountBasis: 'receipt_total',
        adjustments: [],
        issues: [],
        sourceMessageId: `gmail:${id}`,
        orderEvidence: {
          version: 1,
          parserVersion: 3,
          documentKind: 'original',
          fulfillment: 'completed',
          recordedTotal: 40,
          totalState: 'known',
          timestamps: [],
          payments: [],
          issues: [],
          ...evidence,
        },
      },
      ...extra,
    },
  };
}
function notice(id = 'notice', extra = {}) {
  return source(
    id,
    {
      ...extractEmailOrderEvidence({
        text: 'Uber Eats\nJanuary 10, 2024\nYour refund has been applied to your Uber Cash for your order.',
        total: null,
        timezone,
      }),
      ...extra,
    },
    { amountSpent: 0, orderDate: new Date('2024-01-10T17:00Z') },
  );
}
const resolve = (observations) => {
  const result = resolveOrderOutcome(observations);
  assert.deepEqual(decodeOrderOutcome(JSON.parse(JSON.stringify(result))), result);
  assert.deepEqual(resolveOrderOutcome([...observations].reverse()), result);
  return result;
};
const revised = (id = 'revised', previousTotal = 40, recordedTotal = 30) =>
  source(id, {
    documentKind: 'updated',
    previousTotal,
    recordedTotal,
  });

test('affirmative applied-refund text preserves unknown amount, destination and reference without a fake payment', () => {
  for (const phrase of [
    'Your refund has been applied',
    'Your refund was issued',
    'Your refund has been processed',
    'We issued a refund',
    'We have applied your refund',
    'We’ve completed your refund',
    'We refunded your order',
    'We have refunded you',
    "You've been refunded",
    'After reviewing your order, we issued a refund',
    'When we reviewed your order, we issued a refund',
  ]) {
    const evidence = extractEmailOrderEvidence({
      text: `Uber Eats\nJanuary 10, 2024\n${phrase} to your Uber Cash for your order.\nRefund ID: refund-one`,
      total: null,
      timezone,
    });
    assert.deepEqual(decodeOrderSourceEvidence(JSON.parse(JSON.stringify(evidence))), evidence);
    assert.equal(evidence.documentKind, 'refund', phrase);
    assert.equal(evidence.refundConfirmed, true, phrase);
    assert.equal(evidence.refundReference, 'refund-one');
    assert.equal(evidence.refundDestination, 'provider_wallet');
    assert.equal(evidence.refundAmount, undefined);
    assert.equal(evidence.recordedTotal, null);
    assert.equal(evidence.orderHeaderDay, undefined, 'refund issue day is not the order day');
    assert.deepEqual(evidence.payments, []);
  }
  const evidence = notice().receipt.resolution.orderEvidence;
  for (const value of [false, 'true', 1, null])
    assert.throws(() => decodeOrderSourceEvidence({ ...evidence, refundConfirmed: value }));
});

test('refund requests, future promises, conditions and quoted instructions never confirm an applied refund', () => {
  for (const text of [
    'Your refund has not been applied for your order.',
    "We haven't refunded your order.",
    'We will issue a refund for your order.',
    'We processed your refund request for your order.',
    'We issued a refund offer for your order.',
    'Your refund has been processed but was declined for your order.',
    'Your refund has been processed but is pending approval for your order.',
    'If your refund has been applied for your order, your balance will change.',
    'We issued a refund for your order only if the restaurant agreed.',
    'When we refunded you for your order, the balance would change.',
    'The message "Your refund has been applied" refers to your order.',
    '> Your refund has been applied for your order.',
    'If there is an issue with your order, we refunded you CA$10.00.',
    'The message "We refunded you CA$10.00" refers to your order.',
  ]) {
    const evidence = extractEmailOrderEvidence({ text, total: null });
    assert.equal(evidence.refundConfirmed, undefined, text);
    assert.equal(orderAdjustmentProvider('receipts@uber.com', text), undefined, text);
  }
  assert.equal(
    orderAdjustmentProvider(
      'receipts@uber.com.evil.example',
      'Your refund has been applied for your order.',
    ),
    undefined,
  );
});

test('known purchase plus unquantified refund is one attempt with unknown net cost, not free or still full-price', () => {
  const result = resolve([source('original'), notice()]);
  assert.equal(result.kind, 'order');
  assert.equal(result.originalCharge, 40);
  assert.equal(result.netAmount, null);
  assert.equal(result.financialConfidence, 'unknown');
  assert.equal(result.refundStatus, 'confirmed_unclassified');
  assert.equal(result.refundConfidence, 'confirmed');
  assert.equal(result.confirmedRefundAmount, null);
  assert.equal(result.estimatedRefundAmount, null);
  assert.deepEqual(
    result.events.map((e) => [e.kind, e.amount]),
    [['charge', 40]],
  );
  assert.deepEqual(result.financialObservationIds, ['notice', 'original']);
  const groups = reconcileReceiptGroups([notice(), source('original')], timezone, [], 3);
  assert.equal(groups.length, 1);
  const records = groups.map((group) => projectReconciledGroup(group, 'order'));
  const metrics = summarizeOrderMetrics(records);
  assert.equal(metrics.attempts, 1);
  assert.equal(metrics.deliveries, 1);
  assert.equal(metrics.confirmedRefunds, 1);
  assert.equal(metrics.currencies[0].unknownPriceOrders, 1);
  assert.equal(metrics.currencies[0].confirmedRefundsWithUnknownAmount, 1);
  const snapshot = {
    receipts: records,
    observations: [source('original'), notice()].map((o) => ({ ...o, receiptId: 'order' })),
    coverage: [],
    timezone,
  };
  const audit = buildReceiptReconciliationAudit(snapshot, snapshot, [], true);
  assert.equal(audit.orders[0].netAmount, null);
  assert.equal(audit.orders[0].reviewRequired, true);
  assert.equal(audit.orders[0].evidence.find((o) => o.id === 'notice').refundConfirmed, true);
});

test('orphan confirmations and repeated copies remain evidence, not another purchase or zero-dollar refund', () => {
  const result = resolve([notice(), notice('copy')]);
  assert.equal(result.kind, 'unlinked_adjustment');
  assert.equal(result.refundConfidence, 'confirmed');
  assert.equal(result.confirmedRefundAmount, null);
  assert.equal(result.netAmount, null);
  assert.deepEqual(result.events, []);
  const groups = reconcileReceiptGroups([notice(), notice('copy')], timezone, [], 3);
  const records = groups.map((group) => projectReconciledGroup(group, 'orphan'));
  assert.equal(records.length, 1);
  assert.equal(summarizeOrderMetrics(records).attempts, 0);
  assert.equal(summarizeOrderMetrics(records).unlinkedAdjustments, 1);
  const original = source('original');
  delete original.receipt.externalId;
  const unlinked = notice();
  delete unlinked.receipt.externalId;
  assert.equal(reconcileReceiptGroups([original, unlinked], timezone, [], 3).length, 2);
});

test('zero exports can establish zero net cost but never manufacture the amount of a confirmed refund', () => {
  const exported = source(
    'export',
    { documentKind: 'export', recordedTotal: 0 },
    { dataSource: 'csv', amountSpent: 0, items: [{ name: 'Pizza', quantity: 1, price: 99 }] },
  );
  exported.receipt.resolution.amountBasis = 'export_total';
  for (const input of [
    [exported, notice()],
    [exported, source('original'), notice()],
  ]) {
    const result = resolve(input);
    assert.equal(result.netAmount, 0);
    assert.equal(result.financialConfidence, 'inferred');
    assert.equal(result.refundStatus, 'confirmed_unclassified');
    assert.equal(result.refundConfidence, 'confirmed');
    assert.equal(result.confirmedRefundAmount, null);
    assert.equal(result.estimatedRefundAmount, null);
    assert.equal(result.events.filter((e) => e.kind === 'refund').length, 0);
  }
});

test('a canceled order remains canceled when its refund amount and final cancellation cost are unknown', () => {
  const result = resolve([
    source('cancellation', { documentKind: 'cancellation', fulfillment: 'canceled' }),
    notice(),
  ]);
  assert.equal(result.fulfillment, 'canceled');
  assert.equal(result.originalCharge, 40);
  assert.equal(result.netAmount, null);
  assert.equal(result.cancellationCharge, null);
  assert.equal(result.refundConfidence, 'confirmed');
});

test('a later identifiable revised balance resolves an amount-less confirmation without double subtraction', () => {
  const result = resolve([source('original'), notice(), revised()]);
  assert.equal(result.netAmount, 30);
  assert.equal(result.confirmedRefundAmount, 10);
  assert.equal(result.refundStatus, 'partial');
  assert.equal(result.events.filter((e) => e.kind === 'refund').length, 1);
  const revisionOnly = notice('revised', {
    documentKind: 'updated',
    recordedTotal: 30,
    totalState: 'known',
  });
  const noStartingBalance = resolve([revisionOnly]);
  assert.equal(noStartingBalance.netAmount, 30);
  assert.equal(noStartingBalance.originalCharge, null);
  assert.equal(noStartingBalance.refundStatus, 'confirmed_unclassified');
  assert.equal(noStartingBalance.confirmedRefundAmount, null);
});

test('distinct or explicitly later unquantified refunds cannot disappear into a previous known refund', () => {
  const balance = revised();
  balance.receipt.resolution.orderEvidence.payments = [
    { kind: 'refund', amount: 10, tender: 'provider_wallet', reference: 'first-refund' },
  ];
  for (const evidence of [{ refundReference: 'another-refund' }, { revisionOf: 'gmail:revised' }]) {
    const result = resolve([source('original'), balance, notice('later', evidence)]);
    assert.equal(result.netAmount, null);
    assert.equal(result.confirmedRefundAmount, null);
    assert.equal(result.refundStatus, 'confirmed_unclassified');
    assert.equal(
      result.events.find((e) => e.kind === 'refund').amount,
      10,
      'retain the previously known payment event',
    );
  }
  const sameEvent = resolve([
    source('original'),
    balance,
    notice('copy', { revisionOf: 'gmail:revised', refundReference: 'first-refund' }),
  ]);
  assert.equal(sameEvent.netAmount, 30);
  assert.equal(sameEvent.confirmedRefundAmount, 10);
});

test('a newer balance explicitly absorbs a previously unquantified additional refund', () => {
  const first = revised('first');
  first.receipt.resolution.orderEvidence.payments = [
    { kind: 'refund', amount: 10, tender: 'provider_wallet', reference: 'first-refund' },
  ];
  const later = notice('second', { refundReference: 'second-refund', revisionOf: 'gmail:first' });
  assert.equal(resolve([source('original'), first, later]).netAmount, null);
  const final = revised('final', 30, 25);
  final.receipt.resolution.orderEvidence.revisionOf = 'gmail:second';
  const outcome = resolve([source('original'), first, later, final]);
  assert.equal(outcome.netAmount, 25);
  assert.equal(outcome.confirmedRefundAmount, 15);
  assert.equal(outcome.refundStatus, 'partial');
  assert.equal(outcome.financialConfidence, 'confirmed');
  const cyclic = structuredClone(later);
  cyclic.receipt.resolution.orderEvidence.revisionOf = 'gmail:final';
  assert.equal(
    resolve([source('original'), first, cyclic, final]).financialConfidence,
    'conflicted',
  );
});

test('refunding a charged cancellation preserves its original charge as well as the revised net cost', () => {
  const canceled = source('canceled', { documentKind: 'cancellation', fulfillment: 'canceled' });
  const update = revised('cancellation-update');
  update.receipt.resolution.orderEvidence.fulfillment = 'unknown';
  const outcome = resolve([canceled, update]);
  assert.equal(outcome.fulfillment, 'canceled');
  assert.equal(outcome.originalCharge, 40);
  assert.equal(outcome.netAmount, 30);
  assert.equal(outcome.cancellationCharge, 30);
  assert.equal(outcome.confirmedRefundAmount, 10);
  assert.equal(outcome.events.find((event) => event.kind === 'charge').amount, 40);
});

test('known amounts and explicit identity conflicts remain authoritative with new confirmation evidence', () => {
  const known = notice('known', {
    refundConfirmed: undefined,
    refundAmount: 10,
    payments: [{ kind: 'refund', amount: 10, reference: 'refund-one', tender: 'provider_wallet' }],
  });
  const result = resolve([
    source('original'),
    notice('unknown', { refundReference: 'refund-one' }),
    known,
  ]);
  assert.equal(result.netAmount, 30);
  assert.equal(result.confirmedRefundAmount, 10);
  const conflict = notice();
  conflict.receipt.monetaryDetails.currencyCode = 'USD';
  assert.equal(resolve([source('original'), conflict]).financialConfidence, 'conflicted');
  const sameIdentity = reconcileReceiptGroups([source('original'), conflict], timezone, [], 3);
  assert.equal(
    sameIdentity.length,
    1,
    'shared provider identity remains one order with conflicting money evidence',
  );
  assert.equal(
    projectReconciledGroup(sameIdentity[0], 'order').resolution.orderOutcome.financialConfidence,
    'conflicted',
  );
  const differentIdentity = notice();
  differentIdentity.receipt.externalId = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
  assert.equal(
    reconcileReceiptGroups([source('original'), differentIdentity], timezone, [], 3).length,
    2,
  );
});

test('Gmail/Outlook extraction retains supported amount-less notices and provider IDs; policy 2 stays unchanged', async () => {
  for (const [provider, brand, from, host] of [
    ['gmail', 'Uber Eats', 'receipts@uber.com', 'www.ubereats.com'],
    ['microsoft', 'DoorDash', 'no-reply@doordash.com', 'www.doordash.com'],
  ]) {
    const message = {
      userId: 'fixture-user',
      provider,
      providerMessageId: 'refund',
      from,
      to: 'redacted',
      receivedAt: new Date('2024-01-10T17:00Z'),
      subject: 'Your refund',
      body: `<p>${brand}</p><p>Your refund has been applied for your order.</p><a href="https://${host}/orders/${orderId}">View order</a>`,
    };
    const batch = await new ReceiptEmailBatchExtractor(
      new ReceiptExtractor({}, 3),
      { capture: async () => {} },
      1,
      Date.now,
      3,
    ).extract([message], timezone, { userId: 'fixture-user', trigger: 'manual' });
    assert.deepEqual(batch.errors, []);
    assert.equal(batch.supportedReceipts.length, 1);
    const receipt = batch.supportedReceipts[0];
    assert.equal(receipt.externalId, orderId);
    assert.equal(receipt.resolution.orderEvidence.refundConfirmed, true);
    assert.equal(receipt.resolution.orderEvidence.recordedTotal, null);
    assert.equal(receipt.resolution.receiptTotal, undefined);
    assert.equal(receipt.resolution.orderEvidence.orderHeaderDay, undefined);
    assert.equal(receipt.resolution.timestamp.precision, 'received');
    assert.equal(new ReceiptExtractor({}, 2).extract(message).classification.isReceipt, false);
  }
});

test('an absent email balance never becomes a zero-total checkout discrepancy or financial residual', () => {
  const unknown = notice().receipt;
  unknown.monetaryDetails = {
    currencyCode: 'CAD',
    subtotal: 20,
    tax: 2,
    tip: 3,
    deliveryFee: 4,
    serviceFee: 5,
  };
  unknown.resolution.receiptTotal = 0;
  unknown.resolution.financialResidual = -34;
  unknown.resolution.residual = -40;
  const exported = source('export', { documentKind: 'export' }, { dataSource: 'csv' }).receipt;
  exported.resolution.exportedTotal = 40;
  exported.resolution.reconstructedSubtotal = 20;
  assert.equal(calculateCheckoutDifference(unknown, exported), undefined);
  const resolved = resolveObservations([unknown, exported], 'order', unknown);
  assert.equal(resolved.resolution.receiptTotal, undefined);
  assert.equal(resolved.resolution.financialResidual, undefined);
  assert.equal(resolved.resolution.residual, undefined);
  assert.equal(resolved.resolution.checkoutDifference, undefined);
  const knownZero = structuredClone(unknown);
  knownZero.resolution.orderEvidence.recordedTotal = 0;
  knownZero.resolution.orderEvidence.totalState = 'known';
  assert.equal(calculateCheckoutDifference(knownZero, exported).amount, -20);
});
