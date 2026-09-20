const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePaymentEvents } = require('../dist/services/receipt/OrderPaymentEvents');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const {
  extractEmailOrderEvidence,
} = require('../dist/services/extraction/ReceiptOrderEvidenceExtractor');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { decodeOrderSourceEvidence, decodeOrderOutcome } = require('../dist/models/OrderEvidence');

const timezone = 'America/Toronto';
const orderId = '12345678-1234-1234-1234-123456789012';
function observation(id, evidence = {}) {
  return {
    id,
    receipt: {
      userId: 'adjustment-fixture',
      dataSource: 'email',
      receiptType: 'uber_eats',
      externalId: orderId,
      restaurantName: 'Pizza Place (Bank Street)',
      orderDate: new Date('2023-12-10T17:00:00Z'),
      amountSpent: 40,
      items: [],
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
          recordedTotal: 40,
          totalState: 'known',
          orderHeaderDay: '2023-12-10',
          timestamps: [],
          payments: [],
          issues: [],
          ...evidence,
        },
      },
    },
  };
}
function adjustment(id, amount, extra = {}) {
  const result = observation(id, {
    documentKind: 'refund',
    recordedTotal: null,
    totalState: 'unavailable',
    fulfillment: 'unknown',
    orderHeaderDay: undefined,
    refundAmount: amount,
    payments: [
      { kind: 'refund', amount, tender: 'provider_wallet', reference: id, currencyCode: 'CAD' },
    ],
    ...extra,
  });
  result.receipt.orderDate = new Date('2024-01-10T17:00:00Z');
  result.receipt.amountSpent = 0;
  return result;
}
const resolve = (sources) => {
  const result = resolveOrderOutcome(sources);
  assert.deepEqual(decodeOrderOutcome(result), result);
  assert.deepEqual(resolveOrderOutcome([...sources].reverse()), result);
  return result;
};

test('referenced payments are one event despite timestamp spelling, delivery and currency enrichment', () => {
  const payment = {
    kind: 'charge',
    amount: 20,
    reference: 'payment-1',
    tender: 'unknown',
    currencyCode: 'UNKNOWN',
  };
  const sources = [
    { ids: ['original'], evidence: { payments: [payment] } },
    {
      ids: ['copy'],
      evidence: {
        payments: [{ ...payment, tender: 'card', currencyCode: 'CAD', cardLastFour: '1234' }],
      },
    },
  ];
  const result = resolvePaymentEvents(sources);
  assert.equal(result.conflict, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].currencyCode, 'CAD');
  assert.equal(result.events[0].tender, 'card');
  assert.deepEqual(result.events[0].observationIds, ['copy', 'original']);
  assert.deepEqual(resolvePaymentEvents([...sources].reverse()), result);
});

test('unreferenced payment copies with equivalent instants do not become extra charges', () => {
  const payment = {
    kind: 'charge',
    amount: 20,
    tender: 'card',
    timestamp: {
      role: 'payment',
      raw: '12/10/23 1:00 PM',
      precision: 'minute',
      instant: '2023-12-10T18:00:00.000Z',
    },
  };
  const result = resolvePaymentEvents([
    { ids: ['a'], evidence: { payments: [payment] } },
    {
      ids: ['b'],
      evidence: {
        payments: [
          {
            ...payment,
            timestamp: {
              ...payment.timestamp,
              raw: 'December 10, 2023 1:00 PM',
              instant: '2023-12-10T13:00:00-05:00',
            },
          },
        ],
      },
    },
  ]);
  assert.equal(result.events.length, 1);
  assert.deepEqual(
    resolvePaymentEvents([
      {
        ids: ['b'],
        evidence: {
          payments: [
            {
              ...payment,
              timestamp: {
                ...payment.timestamp,
                raw: 'December 10, 2023 1:00 PM',
                instant: '2023-12-10T13:00:00-05:00',
              },
            },
          ],
        },
      },
      { ids: ['a'], evidence: { payments: [payment] } },
    ]),
    result,
  );
});

test('an identified refund enriches its uniquely compatible unreferenced snapshot', () => {
  const payment = { kind: 'refund', amount: 10, tender: 'provider_wallet' };
  const result = resolvePaymentEvents([
    { ids: ['notice'], evidence: { payments: [{ ...payment, reference: 'refund-1' }] } },
    { ids: ['receipt'], evidence: { payments: [payment] } },
  ]);
  assert.equal(result.conflict, false);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].reference, 'refund-1');
  assert.deepEqual(result.events[0].observationIds, ['notice', 'receipt']);
});

test('an unreferenced snapshot cannot be assigned between equal-value identified installments', () => {
  const payment = { kind: 'refund', amount: 10, tender: 'provider_wallet' };
  const result = resolvePaymentEvents([
    { ids: ['one'], evidence: { payments: [{ ...payment, reference: 'refund-1' }] } },
    { ids: ['two'], evidence: { payments: [{ ...payment, reference: 'refund-2' }] } },
    { ids: ['unknown'], evidence: { payments: [payment] } },
  ]);
  assert.equal(result.conflict, true);
  assert.equal(
    result.events.find((event) => event.observationIds.includes('unknown')).confidence,
    'conflicted',
  );
});

test('conflicting values for one payment identity are review evidence, not extra settled payments', () => {
  const original = observation('original', {
    payments: [{ kind: 'charge', amount: 40, tender: 'card', reference: 'payment-1' }],
  });
  const update = observation('update', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 30,
    revisionOf: 'original',
    payments: [{ kind: 'charge', amount: 30, tender: 'card', reference: 'payment-1' }],
  });
  const result = resolve([original, update]);
  assert.equal(result.financialConfidence, 'conflicted');
  assert.equal(result.netAmount, null);
  assert.equal(result.events.length, 2);
  assert.ok(result.events.every((event) => event.confidence === 'conflicted'));
});

test('equal-value refund installments with different references count separately; copies count once', () => {
  const original = observation('original');
  const first = adjustment('refund-1', 10);
  const second = adjustment('refund-2', 10);
  const copy = structuredClone(first);
  copy.id = 'forwarded';
  copy.receipt.resolution.sourceMessageId = 'gmail:forwarded';
  const result = resolve([original, first, second, copy]);
  assert.equal(result.netAmount, 20);
  assert.equal(result.confirmedRefundAmount, 20);
  assert.equal(result.refundStatus, 'partial');
  assert.equal(result.events.filter((event) => event.kind === 'refund').length, 2);
});

test('refund-only notices adjust the original purchase across months without creating another order', () => {
  const groups = reconcileReceiptGroups(
    [observation('original'), adjustment('refund-1', 40)],
    timezone,
    [],
    3,
  );
  assert.equal(groups.length, 1);
  const result = projectReconciledGroup(groups[0], 'canonical');
  assert.equal(result.resolution.orderOutcome.netAmount, 0);
  assert.equal(result.resolution.orderOutcome.refundStatus, 'full');
  assert.equal(result.orderDate.toISOString().slice(0, 10), '2023-12-10');
});

test('a refund notice already represented by a revised balance is not subtracted again', () => {
  for (const payments of [[], [{ kind: 'refund', amount: 10, tender: 'provider_wallet' }]]) {
    const update = observation('update', {
      documentKind: 'updated',
      previousTotal: 40,
      recordedTotal: 30,
      revisionOf: 'original',
      payments,
    });
    const result = resolve([observation('original'), update, adjustment('refund-1', 10)]);
    assert.equal(result.netAmount, 30);
    assert.equal(result.confirmedRefundAmount, 10);
    assert.equal(result.events.filter((event) => event.kind === 'refund').length, 1);
  }
});

const eventTime = (instant, role = 'refund') => ({
  role,
  raw: instant,
  instant,
  precision: 'second',
});
function updatedBalance() {
  return observation('update', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 30,
    revisionOf: 'original',
    timestamps: [eventTime('2024-01-02T17:00:00Z', 'received')],
    payments: [
      {
        kind: 'refund',
        amount: 10,
        tender: 'provider_wallet',
        reference: 'refund-1',
        timestamp: eventTime('2024-01-01T17:00:00Z'),
      },
    ],
  });
}
function laterRefund(amount = 5) {
  return adjustment('refund-2', amount, {
    payments: [
      {
        kind: 'refund',
        amount,
        tender: 'provider_wallet',
        reference: 'refund-2',
        timestamp: eventTime('2024-01-03T17:00:00Z'),
      },
    ],
  });
}

test('a distinct later refund updates a revised balance once, including equal-value installments', () => {
  for (const amount of [0.01, 0.1, 5, 10, 30]) {
    const result = resolve([observation('original'), updatedBalance(), laterRefund(amount)]);
    assert.equal(result.netAmount, Math.round((30 - amount) * 100) / 100);
    assert.equal(result.originalCharge, 40);
    assert.equal(result.confirmedRefundAmount, Math.round((10 + amount) * 100) / 100);
    assert.equal(result.refundStatus, amount === 30 ? 'full' : 'partial');
    assert.equal(result.events.filter((event) => event.kind === 'refund').length, 2);
    assert.ok(result.financialObservationIds.includes('refund-2'));
  }
});

test('explicit adjustment relationships update the latest balance without depending on email delivery time', () => {
  const later = adjustment('additional', 5, { revisionOf: 'gmail:update' });
  const update = updatedBalance();
  const forwarded = structuredClone(update);
  forwarded.id = 'aaa-forwarded-update';
  forwarded.receipt.resolution.sourceMessageId = 'microsoft:forwarded-update';
  forwarded.receipt.resolution.orderEvidence.timestamps = [
    eventTime('2024-01-05T17:00:00Z', 'received'),
  ];
  const result = resolve([observation('original'), forwarded, update, later]);
  assert.equal(result.netAmount, 25);
  assert.equal(result.confirmedRefundAmount, 15);
  assert.equal(result.events.filter((event) => event.kind === 'refund').length, 2);
});

test('a refund reversal after a zero revised receipt restores cost, not another order', () => {
  const refunded = observation('update', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 0,
    revisionOf: 'original',
    timestamps: [eventTime('2024-01-02T17:00:00Z', 'received')],
    payments: [
      {
        kind: 'refund',
        amount: 40,
        tender: 'provider_wallet',
        reference: 'refund-1',
        timestamp: eventTime('2024-01-01T17:00:00Z'),
      },
    ],
  });
  const reversal = adjustment('reversal', 40, {
    refundAmount: undefined,
    payments: [
      {
        kind: 'refund_reversal',
        amount: 40,
        tender: 'provider_wallet',
        reference: 'reversal-1',
        timestamp: eventTime('2024-01-03T17:00:00Z'),
      },
    ],
  });
  const result = resolve([observation('original'), refunded, reversal]);
  assert.equal(result.netAmount, 40);
  assert.equal(result.confirmedRefundAmount, 40);
  assert.equal(result.refundStatus, 'reversed');
  assert.equal(result.fulfillment, 'completed');
  assert.equal(result.events.filter((event) => event.kind === 'charge').length, 1);
});

test('repeated notices and forwarded revised receipts cannot create another refund or change chronology', () => {
  const update = updatedBalance();
  const forwarded = structuredClone(update);
  forwarded.id = 'aaa-forwarded-update';
  forwarded.receipt.resolution.sourceMessageId = 'gmail:forwarded-update';
  forwarded.receipt.resolution.orderEvidence.timestamps = [
    eventTime('2024-01-05T17:00:00Z', 'received'),
  ];
  const originalNotice = adjustment('refund-1', 10, {
    payments: [
      {
        ...update.receipt.resolution.orderEvidence.payments[0],
        timestamp: eventTime('2024-01-04T17:00:00Z'),
      },
    ],
  });
  const later = laterRefund();
  const repeatedLater = structuredClone(later);
  repeatedLater.id = 'later-copy';
  repeatedLater.receipt.resolution.sourceMessageId = 'microsoft:later-copy';
  const result = resolve([
    observation('original'),
    forwarded,
    update,
    originalNotice,
    later,
    repeatedLater,
  ]);
  assert.equal(result.netAmount, 25);
  assert.equal(result.confirmedRefundAmount, 15);
  assert.equal(result.events.filter((event) => event.kind === 'refund').length, 2);
});

test('a newer revised receipt absorbs an already applied additional refund without subtracting it again', () => {
  const first = updatedBalance();
  const later = laterRefund();
  const final = observation('final', {
    documentKind: 'updated',
    previousTotal: 30,
    recordedTotal: 25,
    revisionOf: 'gmail:update',
    timestamps: [eventTime('2024-01-04T17:00:00Z', 'received')],
    payments: [
      ...first.receipt.resolution.orderEvidence.payments,
      ...later.receipt.resolution.orderEvidence.payments,
    ],
  });
  const result = resolve([observation('original'), later, final, first]);
  assert.equal(result.netAmount, 25);
  assert.equal(result.confirmedRefundAmount, 15);
  assert.equal(result.events.filter((event) => event.kind === 'refund').length, 2);
});

test('unsupported adjustment ordering stays uncertain; arrival time or day-only/payment dates are insufficient', () => {
  for (const change of [
    'missing_reference',
    'day_only',
    'payment_time',
    'arrival_only',
    'anonymous_balance',
    'incomplete_balance',
  ]) {
    const update = updatedBalance();
    const later = laterRefund();
    const payment = later.receipt.resolution.orderEvidence.payments[0];
    if (change === 'missing_reference') delete payment.reference;
    if (change === 'day_only')
      payment.timestamp = { role: 'refund', raw: 'January 3, 2024', precision: 'day' };
    if (change === 'payment_time') payment.timestamp.role = 'payment';
    if (change === 'arrival_only') {
      delete payment.timestamp;
      later.receipt.resolution.orderEvidence.timestamps = [
        eventTime('2024-01-03T17:00:00Z', 'received'),
      ];
    }
    if (change === 'anonymous_balance')
      delete update.receipt.resolution.orderEvidence.payments[0].reference;
    if (change === 'incomplete_balance')
      update.receipt.resolution.orderEvidence.payments[0].amount = 8;
    const result = resolve([observation('original'), update, later]);
    assert.equal(result.netAmount, null, change);
    assert.equal(result.financialConfidence, 'conflicted', change);
  }
});

test('explicit adjustment chains and aliases are order-independent; cyclic links cannot establish a sequence', () => {
  const first = adjustment('refund-2', 5, { revisionOf: 'gmail:update' });
  const second = adjustment('refund-3', 5, { revisionOf: 'gmail:refund-2' });
  const result = resolve([observation('original'), updatedBalance(), second, first]);
  assert.equal(result.netAmount, 20);
  assert.equal(result.confirmedRefundAmount, 20);
  first.receipt.resolution.orderEvidence.revisionOf = 'gmail:refund-3';
  const cyclic = resolve([observation('original'), updatedBalance(), second, first]);
  assert.equal(cyclic.financialConfidence, 'conflicted');
  assert.equal(cyclic.netAmount, null);
});

test('later charge adjustments and excess refunds retain cancellation status and do not invent negative costs', () => {
  const canceled = observation('original', {
    documentKind: 'cancellation',
    fulfillment: 'canceled',
  });
  const update = updatedBalance();
  update.receipt.resolution.orderEvidence.fulfillment = 'canceled';
  const result = resolve([canceled, update, laterRefund()]);
  assert.equal(result.netAmount, 25);
  assert.equal(result.cancellationCharge, 25);
  assert.equal(result.fulfillment, 'canceled');
  const extra = adjustment('charge-adjustment', 5, {
    revisionOf: 'gmail:update',
    refundAmount: undefined,
    payments: [
      { kind: 'charge_adjustment', amount: 5, tender: 'card', reference: 'charge-adjustment-1' },
    ],
  });
  const increased = resolve([canceled, update, extra]);
  assert.equal(increased.netAmount, 35);
  assert.equal(increased.cancellationCharge, 35);
  assert.equal(increased.confirmedRefundAmount, 10);
  const excess = resolve([canceled, update, laterRefund(35)]);
  assert.equal(excess.netAmount, null);
  assert.equal(excess.cancellationCharge, null);
  assert.equal(excess.financialConfidence, 'conflicted');
});

test('different unreferenced refund amounts are not assumed to be additive installments', () => {
  const first = adjustment('one', 10, { payments: [] });
  const second = adjustment('two', 20, { payments: [] });
  const result = resolve([observation('original'), first, second]);
  assert.equal(result.netAmount, null);
  assert.equal(result.financialConfidence, 'conflicted');
  assert.ok(
    result.events
      .filter((event) => event.kind === 'refund')
      .every((event) => event.confidence === 'conflicted'),
  );
});

test('event-only reversal restores the balance without erasing the original refund', () => {
  const reversal = adjustment('reversal', 10, {
    refundAmount: undefined,
    payments: [
      { kind: 'refund_reversal', amount: 10, tender: 'provider_wallet', reference: 'reverse-1' },
    ],
  });
  const result = resolve([observation('original'), adjustment('refund-1', 10), reversal]);
  assert.equal(result.netAmount, 40);
  assert.equal(result.confirmedRefundAmount, 10);
  assert.equal(result.refundStatus, 'reversed');
});

test('excess refunds and reversals do not manufacture a negative cost or another charge', () => {
  for (const records of [
    [observation('original'), adjustment('refund-1', 50)],
    [
      observation('original'),
      adjustment('reversal', 10, {
        refundAmount: undefined,
        payments: [{ kind: 'refund_reversal', amount: 10, tender: 'card' }],
      }),
    ],
  ]) {
    const result = resolve(records);
    assert.equal(result.netAmount, null);
    assert.equal(result.financialConfidence, 'conflicted');
  }
});

test('an orphan adjustment retains its event without inventing an original charge or purchase', () => {
  const result = resolve([adjustment('refund-1', 10)]);
  assert.equal(result.kind, 'unlinked_adjustment');
  assert.equal(result.netAmount, null);
  assert.equal(result.originalCharge, null);
  assert.equal(result.events[0].kind, 'refund');
  assert.equal(result.events[0].amount, 10);
  assert.equal(result.refundStatus, 'confirmed_unclassified');
  assert.equal(result.refundConfidence, 'confirmed');
  assert.equal(result.confirmedRefundAmount, 10);
});

test('a known refund with an unknown original charge remains confirmed without a full/partial claim', () => {
  const original = observation('original', { recordedTotal: null, totalState: 'unavailable' });
  original.receipt.amountSpent = 0;
  const result = resolve([original, adjustment('refund-1', 10)]);
  assert.equal(result.kind, 'order');
  assert.equal(result.originalCharge, null);
  assert.equal(result.netAmount, null);
  assert.equal(result.financialConfidence, 'unknown');
  assert.equal(result.refundStatus, 'confirmed_unclassified');
  assert.equal(result.refundConfidence, 'confirmed');
  assert.equal(result.confirmedRefundAmount, 10);
  assert.equal(result.events.filter((event) => event.kind === 'charge').length, 0);
  const completed = resolve([observation('original'), adjustment('refund-1', 10)]);
  assert.equal(completed.refundStatus, 'partial');
  assert.equal(completed.netAmount, 30);
});

test('confirmed refund evidence does not erase an export zero or infer the missing original charge', () => {
  const exported = observation('export', { documentKind: 'export', recordedTotal: 0 });
  exported.receipt.dataSource = 'csv';
  exported.receipt.amountSpent = 0;
  exported.receipt.resolution.amountBasis = 'export_total';
  exported.receipt.items = [{ name: 'Pizza', quantity: 1, price: 25 }];
  const result = resolve([exported, adjustment('refund-1', 10)]);
  assert.equal(result.originalCharge, null);
  assert.equal(result.netAmount, 0);
  assert.equal(result.financialConfidence, 'inferred');
  assert.equal(result.refundStatus, 'confirmed_unclassified');
  assert.equal(result.confirmedRefundAmount, 10);
  assert.equal(result.estimatedRefundAmount, null);
  assert.equal(result.events.filter((event) => event.kind === 'charge').length, 0);
  for (const kind of ['refund_reversal', 'charge_adjustment']) {
    const later = adjustment('later', 5, {
      refundAmount: undefined,
      payments: [{ kind, amount: 5, tender: 'provider_wallet', reference: 'later-event' }],
    });
    const uncertain = resolve([exported, adjustment('refund-1', 10), later]);
    assert.equal(
      uncertain.netAmount,
      null,
      'a stale zero cannot conceal a possible restored charge',
    );
    assert.equal(uncertain.originalCharge, null);
    assert.equal(uncertain.confirmedRefundAmount, 10);
  }
});

test('a revised net balance does not invent a starting charge or refund size classification', () => {
  const original = observation('original', { recordedTotal: null, totalState: 'unavailable' });
  for (const net of [0, 5]) {
    const update = observation('update', {
      documentKind: 'updated',
      recordedTotal: net,
      revisionOf: 'gmail:original',
      payments: [{ kind: 'refund', amount: 10, tender: 'provider_wallet', reference: 'refund-1' }],
    });
    const result = resolve([original, update]);
    assert.equal(result.originalCharge, null);
    assert.equal(result.netAmount, net);
    assert.equal(result.confirmedRefundAmount, 10);
    assert.equal(result.refundStatus, 'confirmed_unclassified');
    assert.equal(result.refundConfidence, 'confirmed');
  }
});

test('an explicit full-refund notice confirms a zero export without a revised receipt total', () => {
  const exported = observation('export', { documentKind: 'export', recordedTotal: 0 });
  exported.receipt.dataSource = 'csv';
  exported.receipt.amountSpent = 0;
  exported.receipt.resolution.amountBasis = 'export_total';
  exported.receipt.items = [{ name: 'Pizza', quantity: 1, price: 25 }];
  const result = resolve([exported, observation('original'), adjustment('refund-1', 40)]);
  assert.equal(result.netAmount, 0);
  assert.equal(result.refundStatus, 'full');
  assert.equal(result.refundConfidence, 'confirmed');
  assert.equal(result.confirmedRefundAmount, 40);
  assert.equal(result.estimatedRefundAmount, null);
  assert.equal(result.events.filter((event) => event.kind === 'refund').length, 1);
});

test('partially refunded cancellation costs are reduced without creating a delivery', () => {
  const result = resolve([
    observation('cancel', { documentKind: 'cancellation', fulfillment: 'canceled' }),
    adjustment('refund-1', 10),
  ]);
  assert.equal(result.fulfillment, 'canceled');
  assert.equal(result.netAmount, 30);
  assert.equal(result.cancellationCharge, 30);
  assert.equal(result.confirmedRefundAmount, 10);
});

test('an event-only notice header cannot supply the day for an undated placement time', () => {
  const result = extractEmailOrderEvidence({
    text: 'January 10, 2024\nWe refunded CA$10.00 for your order.\nOrdered at 1:00 PM',
    total: null,
    timezone,
  });
  assert.equal(result.orderHeaderDay, undefined);
  assert.equal(result.timestamps.find((event) => event.role === 'placed').instant, undefined);
});

test('refund notices keep event amount, destination, identity and date separate from order balance', () => {
  const text =
    'Uber Eats\nJanuary 10, 2024\nWe have refunded you CA$10.00 to your Uber Cash for your order.\nRefund ID: refund-1\nRefund issued on January 10, 2024';
  const result = extractEmailOrderEvidence({ text, total: 10, timezone });
  assert.deepEqual(decodeOrderSourceEvidence(result), result);
  assert.equal(result.documentKind, 'refund');
  assert.equal(result.recordedTotal, null);
  assert.equal(result.orderHeaderDay, undefined);
  assert.equal(result.refundAmount, 10);
  assert.equal(result.payments[0].reference, 'refund-1');
  assert.equal(result.payments[0].tender, 'provider_wallet');
  assert.equal(result.payments[0].timestamp.role, 'refund');
  assert.equal(result.payments[0].timestamp.precision, 'day');
});

test('policy-3 Uber and DoorDash notices are accepted without a total; policy 2 stays unchanged', () => {
  for (const [provider, from] of [
    ['Uber Eats', 'Uber <noreply@uber.com>'],
    ['DoorDash', 'DoorDash <no-reply@doordash.com>'],
  ]) {
    const email = {
      from,
      subject: 'Your refund',
      body: `<p>${provider}</p><p>We refunded CA$10.00 to your ${provider === 'DoorDash' ? 'DoorDash credits' : 'Uber Cash'} for your order.</p><a href="https://${provider === 'DoorDash' ? 'www.doordash.com' : 'www.ubereats.com'}/orders/${orderId}">View order</a>`,
    };
    const result = new ReceiptExtractor({}, 3).extract(email);
    assert.equal(result.classification.isReceipt, true);
    assert.equal(result.data.total, null);
    assert.equal(result.data.orderId, orderId);
    assert.equal(result.data.currency, 'CAD');
    assert.equal(result.data.service, provider === 'DoorDash' ? 'DOORDASH' : 'UBER_EATS');
    assert.equal(new ReceiptExtractor({}, 2).extract(email).classification.isReceipt, false);
  }
});

test('refund offers, policies and lookalike senders do not enter the adjustment-specific classifier', () => {
  for (const [from, body] of [
    [
      'noreply@uber.com',
      'Uber Eats: We will refund CA$10.00 if there is an issue with your order.',
    ],
    ['noreply@uber.com', 'Your refund of CA$10.00 will be issued if your order is canceled.'],
    ['noreply@uber.com', 'If we refunded CA$10.00 for your order, your balance would change.'],
    ['noreply@uber.com.evil.example', 'We refunded CA$10.00 for your order.'],
    ['"support@uber.com" <sender@example.com>', 'We refunded CA$10.00 for your order.'],
  ])
    assert.equal(
      new ReceiptExtractor({}, 3).extract({ from, body, subject: 'Order support' }).classification
        .isReceipt,
      false,
    );
});
