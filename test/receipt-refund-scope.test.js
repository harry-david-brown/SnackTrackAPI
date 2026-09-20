const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  extractEmailOrderEvidence,
} = require('../dist/services/extraction/ReceiptOrderEvidenceExtractor');
const { decodeOrderSourceEvidence, decodeOrderOutcome } = require('../dist/models/OrderEvidence');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const { mapReceiptResponse } = require('../dist/http/mappers/receiptResponse');
const {
  buildReceiptReconciliationAudit,
} = require('../dist/services/receipt/ReceiptReconciliationAudit');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const timezone = 'America/Toronto';
const orderId = '12345678-1234-1234-1234-123456789abc';
function observation(id, evidence = {}, extra = {}) {
  return {
    id,
    receipt: {
      userId: 'fixture-user',
      externalId: orderId,
      dataSource: 'email',
      receiptType: 'uber_eats',
      restaurantName: 'Pizza Place (Bank St.)',
      items: [],
      amountSpent: 40,
      orderDate: new Date('2023-12-10T17:00Z'),
      monetaryDetails: { currencyCode: 'CAD' },
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
          timestamps: [],
          recordedTotal: 40,
          totalState: 'known',
          payments: [],
          issues: [],
          ...evidence,
        },
      },
      ...extra,
    },
  };
}
const extract = (text) => extractEmailOrderEvidence({ text, total: null, timezone });
function notice(id, scope, extra = {}) {
  return observation(
    id,
    {
      ...extract(`Your order has been ${scope === 'full' ? 'fully' : 'partially'} refunded.`),
      ...extra,
    },
    { amountSpent: 0, orderDate: new Date('2024-01-10T17:00Z') },
  );
}
function resolve(sources) {
  const result = resolveOrderOutcome(sources);
  assert.deepEqual(resolveOrderOutcome([...sources].reverse()), result);
  assert.deepEqual(decodeOrderOutcome(JSON.parse(JSON.stringify(result))), result);
  return result;
}

test('completed order-level refund wording retains full/partial scope independently of money', () => {
  for (const [scope, phrases] of [
    [
      'full',
      [
        'Your order has been fully refunded.',
        'Your order was refunded in full.',
        'We’ve fully refunded your order.',
        'We refunded your order in full.',
        'We issued a full refund to your Uber Cash for your order.',
        'Your full refund has been processed for your order.',
        'A full refund for your order has been issued.',
        'For your order, we issued a full refund.',
      ],
    ],
    [
      'partial',
      [
        'Your order has been partially refunded.',
        'Your order was refunded in part.',
        'We partially refunded your order.',
        'We refunded part of your order.',
        'We refunded a portion of your order.',
        'We issued a partial refund for your order.',
        'Your partial refund was applied for your order.',
        'A partial refund has been issued for your order.',
      ],
    ],
  ])
    for (const text of phrases) {
      const evidence = extract(text);
      assert.equal(evidence.refundScope, scope, text);
      assert.equal(evidence.refundConfirmed, true, text);
      assert.equal(evidence.recordedTotal, null);
      assert.equal(evidence.refundAmount, undefined);
      assert.deepEqual(evidence.payments, []);
      assert.deepEqual(decodeOrderSourceEvidence(JSON.parse(JSON.stringify(evidence))), evidence);
    }
});

test('item refunds, exceptions, generic wording and footer promises cannot claim whole-order scope', () => {
  for (const text of [
    'We issued a full refund for the missing item in your order.',
    "We issued a full refund for your order's missing item.",
    'We issued a full refund of your tip for your order.',
    'We issued a full refund for your order, excluding the delivery fee.',
    'We issued a full refund for your order except the tip.',
    'Your refund has been applied for your order. You can request a full refund under our policy.',
    'We issued a refund for your order.',
    'We issued a full refund.',
  ])
    assert.equal(extract(text).refundScope, undefined, text);
  for (const text of [
    'Your order has not been fully refunded.',
    'We will issue a full refund for your order.',
    'If your order has been fully refunded, you can contact support.',
    'We issued a full refund for your order only if the restaurant agreed.',
    'We processed your partial refund request for your order.',
    'The message "Your order has been fully refunded" is an example.',
    '> Your order has been partially refunded.',
    'We issued a full refund policy for your order.',
    'We refunded you CA$10.00 only if your order was wrong.',
  ]) {
    const evidence = extract(text);
    assert.equal(evidence.refundScope, undefined, text);
    assert.equal(evidence.refundConfirmed, undefined, text);
    assert.deepEqual(evidence.payments, [], text);
  }
});

test('a quantified completed scope notice preserves the stated amount and wallet destination', () => {
  for (const text of [
    'We issued a full refund of CA$22.48 to your Uber Cash for your order.',
    'We’ve issued a full refund of CA$22.48 to your Uber Cash for your order.',
    'We have applied your full refund in the amount of CA$22.48 to your Uber Cash for your order.',
    'Your full refund has been processed: CA$22.48 to your Uber Cash for your order.',
  ]) {
    const evidence = extract(text);
    assert.equal(evidence.refundScope, 'full', text);
    assert.equal(evidence.refundAmount, 22.48, text);
    assert.equal(evidence.refundConfirmed, undefined);
    assert.equal(evidence.recordedTotal, null);
    assert.equal(evidence.payments.length, 1);
    assert.equal(evidence.payments[0].amount, 22.48);
    assert.equal(evidence.payments[0].tender, 'provider_wallet');
    const original = observation('original', { recordedTotal: 22.48 });
    const result = resolve([original, observation('refund', evidence)]);
    assert.equal(result.refundStatus, 'full');
    assert.equal(result.netAmount, 0);
    assert.equal(result.confirmedRefundAmount, 22.48);
  }
  assert.equal(
    extract('We issued a full refund of CA$22.48 for your order only if approved.').refundAmount,
    undefined,
  );
});

test('scope decoding rejects malformed values and preserves conflicting statements rather than choosing the first', () => {
  const evidence = extract(
    'Your order has been fully refunded. Your order has been partially refunded.',
  );
  assert.equal(evidence.refundScope, 'conflicted');
  assert.equal(evidence.refundConfirmed, true);
  for (const refundScope of [null, false, true, 0, 'FULL', 'item'])
    assert.throws(() => decodeOrderSourceEvidence({ ...evidence, refundScope }));
  assert.throws(() => decodeOrderSourceEvidence({ ...evidence, documentKind: 'original' }));
  assert.equal(
    decodeOrderSourceEvidence({ ...evidence, refundScope: undefined }).refundScope,
    undefined,
  );
});

test('known refund scope never manufactures dollars, a zero balance, another purchase or changed fulfillment', () => {
  for (const scope of ['full', 'partial'])
    for (const fulfillment of ['completed', 'canceled']) {
      const original = observation('original', {
        fulfillment,
        documentKind: fulfillment === 'canceled' ? 'cancellation' : 'original',
      });
      const refund = notice('notice', scope);
      const sources = [original, refund];
      const result = resolve(sources);
      assert.equal(result.refundStatus, scope);
      assert.equal(result.refundConfidence, 'confirmed');
      assert.equal(result.fulfillment, fulfillment);
      assert.equal(result.originalCharge, 40);
      assert.equal(result.netAmount, null);
      assert.equal(result.confirmedRefundAmount, null);
      assert.equal(result.estimatedRefundAmount, null);
      assert.equal(result.cancellationCharge, null);
      assert.equal(result.events.filter((e) => e.kind === 'refund').length, 0);
      const groups = reconcileReceiptGroups(sources, timezone, [], 3);
      assert.equal(groups.length, 1);
      const projected = projectReconciledGroup(groups[0], 'canonical-order');
      const metrics = summarizeOrderMetrics([projected]);
      assert.equal(metrics.attempts, 1);
      assert.equal(metrics.confirmedRefunds, 1);
      assert.equal(metrics.fullyRefunded, scope === 'full' ? 1 : 0);
      assert.equal(metrics.partiallyRefunded, scope === 'partial' ? 1 : 0);
      assert.equal(metrics.unclassifiedRefunds, 0);
      assert.equal(metrics.currencies[0].confirmedRefundsWithUnknownAmount, 1);
      assert.equal(metrics.currencies[0].unknownPriceOrders, 1);
      const response = mapReceiptResponse(projected);
      assert.equal(response.orderOutcome.refundStatus, scope);
      assert.equal(response.orderOutcome.netAmount, null);
      assert.equal(response.orderOutcome.confirmedRefundAmount, null);
      const audit = buildReceiptReconciliationAudit(
        { receipts: [], observations: sources, coverage: [], timezone },
        {
          receipts: [projected],
          observations: sources.map((source) => ({ ...source, receiptId: projected.id })),
          coverage: [],
          timezone,
        },
        [],
        true,
      );
      assert.equal(audit.orders[0].evidence.find((s) => s.id === 'notice').refundScope, scope);
    }
});

test('a standalone scoped refund remains an unlinked adjustment and repeated copies remain one notice', () => {
  for (const scope of ['full', 'partial']) {
    const refund = notice('refund', scope),
      copy = notice('copy', scope);
    const result = resolve([refund, copy]);
    assert.equal(result.kind, 'unlinked_adjustment');
    assert.equal(result.refundStatus, scope);
    assert.equal(result.originalCharge, null);
    assert.equal(result.netAmount, null);
    assert.deepEqual(result.events, []);
  }
});

test('zero exports retain their recorded balance without inventing a full refund from a partial notice', () => {
  for (const scope of ['full', 'partial']) {
    const exported = observation(
      'export',
      { documentKind: 'export', recordedTotal: 0 },
      { dataSource: 'csv', amountSpent: 0, items: [{ name: 'Pizza', quantity: 1, price: 40 }] },
    );
    exported.receipt.resolution.amountBasis = 'export_total';
    const result = resolve([exported, notice('refund', scope)]);
    assert.equal(result.refundStatus, scope);
    assert.equal(result.netAmount, 0);
    assert.equal(result.financialConfidence, 'inferred');
    assert.equal(result.originalCharge, null);
    assert.equal(result.confirmedRefundAmount, null);
    assert.equal(result.estimatedRefundAmount, null);
    assert.deepEqual(result.events, []);
  }
});

test('explicit later revisions supersede older scope but arrival times cannot pick between contradictory notices', () => {
  const original = observation('original');
  const partial = notice('partial', 'partial');
  const full = notice('full', 'full', { revisionOf: 'gmail:partial' });
  assert.equal(resolve([original, partial, full]).refundStatus, 'full');
  const unknown = observation('unknown', {
    ...extract('Your refund has been applied.'),
    revisionOf: 'gmail:full',
  });
  assert.equal(resolve([original, partial, full, unknown]).refundStatus, 'confirmed_unclassified');
  const revised = observation('revised', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 30,
    revisionOf: 'gmail:full',
  });
  const result = resolve([original, partial, full, revised]);
  assert.equal(result.netAmount, 30);
  assert.equal(result.confirmedRefundAmount, 10);
  assert.equal(result.refundStatus, 'partial');
  const unsequenced = notice('other', 'full', {
    timestamps: [
      {
        role: 'received',
        precision: 'second',
        raw: '2026-01-01T00:00Z',
        instant: '2026-01-01T00:00Z',
      },
    ],
  });
  const conflicted = resolve([original, partial, unsequenced]);
  assert.equal(conflicted.refundStatus, 'conflicted');
  assert.equal(conflicted.refundConfidence, 'confirmed');
  assert.equal(conflicted.netAmount, null);
  partial.receipt.resolution.orderEvidence.revisionOf = 'gmail:full';
  assert.equal(resolve([original, partial, full]).refundStatus, 'conflicted');
});

test('a scoped description contradicting its own balance is reviewable without discarding known monetary evidence', () => {
  for (const [scope, net] of [
    ['full', 30],
    ['partial', 0],
  ]) {
    const revision = notice('revision', scope, {
      documentKind: 'updated',
      recordedTotal: net,
      totalState: 'known',
      previousTotal: 40,
    });
    const result = resolve([observation('original'), revision]);
    assert.equal(result.refundStatus, 'conflicted');
    assert.equal(result.refundConfidence, 'confirmed');
    assert.equal(result.netAmount, net);
    assert.equal(result.confirmedRefundAmount, 40 - net);
    assert.match(result.issues.join(' '), /refund scope requires review/);
    const projected = projectReconciledGroup(
      reconcileReceiptGroups([observation('original'), revision], timezone, [], 3)[0],
      'scope-conflict',
    );
    const metrics = summarizeOrderMetrics([projected]);
    assert.equal(metrics.confirmedRefunds, 1);
    assert.equal(metrics.unclassifiedRefunds, 1);
    assert.equal(metrics.currencies[0].netSpend, net);
    const snapshot = { receipts: [projected], observations: [], coverage: [], timezone };
    assert.equal(
      buildReceiptReconciliationAudit(snapshot, snapshot, [], true).orders[0].reviewRequired,
      true,
    );
  }
  const quantified = notice('refund', 'full', {
    refundAmount: 10,
    payments: [{ kind: 'refund', amount: 10, tender: 'provider_wallet' }],
  });
  assert.equal(resolve([observation('original'), quantified]).refundStatus, 'conflicted');
});

test('explicit refund reversal stays a reversal, not a resurrection of an old full-refund statement', () => {
  const refund = notice('refund', 'full', {
    refundAmount: 40,
    refundReference: 'refund-one',
    payments: [{ kind: 'refund', amount: 40, tender: 'card', reference: 'refund-one' }],
  });
  const reversal = observation('reversal', {
    documentKind: 'refund',
    recordedTotal: null,
    totalState: 'unavailable',
    payments: [{ kind: 'refund_reversal', amount: 40, tender: 'card', reference: 'reversal-one' }],
  });
  const result = resolve([observation('original'), refund, reversal]);
  assert.equal(result.refundStatus, 'reversed');
  assert.equal(result.netAmount, 40);
  assert.equal(result.confirmedRefundAmount, 40);
});

test('scope enrichment of the same monetary snapshot does not create competing receipt revisions or mutate sources', () => {
  const original = observation('original');
  const old = observation('old', { documentKind: 'updated', previousTotal: 40, recordedTotal: 0 });
  const enriched = observation('enriched', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 0,
    refundScope: 'full',
  });
  const inputs = [original, old, enriched];
  const before = JSON.stringify(inputs);
  const result = resolve(inputs);
  assert.equal(result.refundStatus, 'full');
  assert.equal(result.netAmount, 0);
  assert.equal(result.confirmedRefundAmount, 40);
  assert.equal(result.events.filter((e) => e.kind === 'refund').length, 1);
  assert.equal(JSON.stringify(inputs), before);
  enriched.receipt.resolution.orderEvidence.refundScope = 'partial';
  const conflictingCopy = structuredClone(enriched);
  conflictingCopy.id = 'conflicting-copy';
  conflictingCopy.receipt.resolution.sourceMessageId = 'gmail:conflicting-copy';
  conflictingCopy.receipt.resolution.orderEvidence.refundScope = 'full';
  const conflict = resolve([original, enriched, conflictingCopy]);
  assert.equal(conflict.refundStatus, 'conflicted');
  assert.equal(conflict.refundConfidence, 'confirmed');
  assert.equal(conflict.netAmount, 0);
});

test('distinct partial and final refund installments can complete one full refund without a false scope conflict', () => {
  const original = observation('original', { recordedTotal: 100 });
  const partial = notice('partial', 'partial', {
    refundAmount: 10,
    payments: [{ kind: 'refund', amount: 10, tender: 'card', reference: 'first' }],
  });
  const full = notice('full', 'full', {
    refundAmount: 90,
    payments: [{ kind: 'refund', amount: 90, tender: 'card', reference: 'last' }],
  });
  const result = resolve([original, partial, full]);
  assert.equal(result.refundStatus, 'full');
  assert.equal(result.confirmedRefundAmount, 100);
  assert.equal(result.netAmount, 0);
  const reversal = observation('reversal', {
    documentKind: 'refund',
    recordedTotal: null,
    totalState: 'unavailable',
    payments: [{ kind: 'refund_reversal', amount: 100, tender: 'card', reference: 'reversal' }],
  });
  assert.equal(resolve([original, partial, full, reversal]).refundStatus, 'reversed');
});

test('Gmail and Outlook batch extraction preserve scoped notices without changing policy-2 acquisition', async () => {
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
      subject: 'Your refund',
      receivedAt: new Date('2024-01-10T17:00Z'),
      body: `<p>${brand}</p><p>Your order has been fully refunded.</p><a href="https://${host}/orders/${orderId}">View order</a>`,
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
    assert.equal(batch.supportedReceipts[0].resolution.orderEvidence.refundScope, 'full');
    assert.equal(batch.supportedReceipts[0].externalId, orderId);
    assert.equal(new ReceiptExtractor({}, 2).extract(message).classification.isReceipt, false);
  }
});
