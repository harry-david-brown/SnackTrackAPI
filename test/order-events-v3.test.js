const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const {
  extractEmailOrderEvidence,
} = require('../dist/services/extraction/ReceiptOrderEvidenceExtractor');
const { extractLinkedProviderOrderId } = require('../dist/services/receipt/ReceiptProviderOrderIdentity');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const { decodeOrderSourceEvidence, decodeOrderOutcome } = require('../dist/models/OrderEvidence');
const { decodeResolution } = require('../dist/models/ReceiptResolution');
const {
  summarizeOrderMetrics,
  mostDeliveriesDay,
} = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const timezone = 'America/Toronto';

function email(record) {
  const evidence = extractEmailOrderEvidence({ text: record.text, total: record.total, timezone });
  return {
    id: record.id,
    receipt: {
      userId: 'fixture-user',
      dataSource: 'email',
      receiptType: 'uber_eats',
      restaurantName: record.merchant,
      orderDate: new Date(`${evidence.orderHeaderDay ?? '2023-12-10'}T17:00:00Z`),
      amountSpent: record.total,
      items: [],
      monetaryDetails: { currencyCode: 'CAD' },
      resolution: {
        version: 1,
        amountBasis: 'receipt_total',
        adjustments: [],
        issues: [],
        sourceMessageId: `gmail:${record.id}`,
        orderEvidence: evidence,
      },
    },
  };
}
async function scenario() {
  const result = await new CsvImportService().parseUberEatsCsv(
    Buffer.from(fixture.csv),
    'fixture-user',
    timezone,
    3,
  );
  return [
    ...result.receipts.map((receipt, i) => ({ id: `export-${i}`, receipt })),
    ...fixture.emails.map(email),
  ];
}
function reconcile(input) {
  return reconcileReceiptGroups(input, timezone, [], 3);
}
function outcome(input) {
  return resolveOrderOutcome(input);
}
function modify(source, id, evidence) {
  const copy = structuredClone(source);
  copy.id = id;
  copy.receipt.resolution.sourceMessageId = `gmail:${id}`;
  Object.assign(copy.receipt.resolution.orderEvidence, evidence);
  return copy;
}

test('December 10 parses five export attempts, including the charged cancellation and local ending time', async () => {
  const result = await new CsvImportService().parseUberEatsCsv(
    Buffer.from(fixture.csv),
    'fixture-user',
    timezone,
    3,
  );
  assert.equal(result.totalOrders, 5);
  assert.deepEqual(result.statusCounts, { completed: 4, canceled: 1 });
  const canceled = result.receipts[1];
  assert.equal(canceled.orderDate.toISOString(), '2023-12-10T06:20:36.000Z');
  assert.equal(canceled.deliveryTime, undefined);
  assert.equal(canceled.resolution.orderEvidence.timestamps[1].role, 'ended');
});
test('payments, refunds and header dates retain semantics; Uber Cash is not savings', () => {
  const parsed = fixture.emails.map(email);
  for (const o of parsed) {
    assert.equal(o.receipt.resolution.orderEvidence.orderHeaderDay, '2023-12-10');
    assert.equal(
      o.receipt.resolution.orderEvidence.timestamps.some((t) => t.role === 'placed'),
      false,
    );
    assert.deepEqual(
      decodeOrderSourceEvidence(o.receipt.resolution.orderEvidence),
      o.receipt.resolution.orderEvidence,
    );
  }
  const refund = parsed[1].receipt.resolution.orderEvidence;
  assert.equal(refund.previousTotal, 22.48);
  assert.equal(refund.recordedTotal, 0);
  assert.equal(refund.refundDestination, 'provider_wallet');
  assert.equal(refund.payments[1].kind, 'refund');
  assert.equal(refund.payments[1].timestamp.role, 'payment');
  assert.equal(refund.payments[1].timestamp.instant, '2023-12-10T06:44:00.000Z');
  const mcd = parsed[5].receipt.resolution.orderEvidence.payments;
  assert.deepEqual(
    mcd.map((p) => [p.tender, p.amount]),
    [
      ['provider_wallet', 6.22],
      ['card', 39.61],
    ],
  );
});
test('complete December 10 evidence resolves to five attempts, four deliveries and CAD157.02 net', async () => {
  const observations = await scenario();
  const groups = reconcile(observations);
  assert.equal(groups.length, 5);
  const projected = groups.map((g, i) => projectReconciledGroup(g, `canonical-${i}`));
  const outcomes = projected.map((r) => r.resolution.orderOutcome);
  assert.equal(outcomes.filter((o) => o.fulfillment === 'completed').length, 4);
  assert.equal(outcomes.filter((o) => o.fulfillment === 'canceled').length, 1);
  const sum = (values) => values.reduce((n, v) => n + Math.round(v * 100), 0) / 100;
  assert.equal(sum(outcomes.map((o) => o.netAmount)), 157.02);
  assert.equal(
    sum(outcomes.filter((o) => o.fulfillment === 'completed').map((o) => o.netAmount)),
    113.76,
  );
  assert.equal(sum(outcomes.map((o) => o.originalCharge)), 179.5);
  assert.equal(sum(outcomes.map((o) => o.confirmedRefundAmount ?? 0)), 22.48);
  const events = outcomes.flatMap((o) => o.events);
  assert.equal(
    sum(events.filter((e) => e.kind === 'charge' && e.tender === 'card').map((e) => e.amount)),
    153.81,
  );
  assert.equal(
    sum(
      events
        .filter((e) => e.kind === 'charge' && e.tender === 'provider_wallet')
        .map((e) => e.amount),
    ),
    25.69,
  );
  assert.equal(events.filter((e) => e.kind === 'refund').length, 1);
  assert.equal(events.find((e) => e.kind === 'refund').tender, 'provider_wallet');
  assert.equal(
    projected.find((r) => r.resolution.orderOutcome.refundStatus === 'full').items[0].name,
    'Medium',
  );
  for (const r of projected) {
    const persisted = JSON.parse(JSON.stringify(r.resolution));
    assert.deepEqual(decodeResolution(persisted), persisted);
  }
});
test('reconciliation and financial results are invariant to import order and reversed pages', async () => {
  const all = await scenario();
  const expected = reconcile(all);
  for (let shift = 0; shift < all.length; shift++) {
    const permutation = [...all.slice(shift), ...all.slice(0, shift)].reverse();
    assert.deepEqual(reconcile(permutation), expected);
  }
  const pizza = all.filter((o) => ['pizza-original', 'pizza-refund', 'export-0'].includes(o.id));
  const baseline = outcome(pizza);
  const forwarded = modify(
    pizza.find((o) => o.id === 'pizza-original'),
    'forwarded',
    {},
  );
  forwarded.receipt.resolution.sourceRevisionAt = '2026-09-12T12:00:00Z';
  const replay = outcome([...pizza, forwarded]);
  assert.equal(replay.netAmount, baseline.netAmount);
  assert.equal(replay.confirmedRefundAmount, 22.48);
  assert.equal(replay.events.filter((e) => e.kind === 'charge').length, 1);
});
test('zero export is probable, not confirmed, and never manufactures refund dollars from items', async () => {
  const all = await scenario();
  const zero = all[0];
  const inferred = outcome([zero]);
  assert.equal(inferred.refundStatus, 'probable_full');
  assert.equal(inferred.confirmedRefundAmount, null);
  assert.equal(inferred.estimatedRefundAmount, null);
  const withOriginal = outcome([zero, all.find((o) => o.id === 'pizza-original')]);
  assert.equal(withOriginal.netAmount, 0);
  assert.equal(withOriginal.estimatedRefundAmount, 22.48);
  assert.equal(withOriginal.confirmedRefundAmount, null);
  const promotion = modify(zero, 'free', { promotionExplainsZero: true });
  assert.equal(outcome([promotion]).refundStatus, 'none_established');
});
test('blank and invalid totals, non-completed zeros and item subtotals are not refunds', async () => {
  for (const [status, price, expectedState] of [
    ['canceled', '0.00', 'known'],
    ['failed', '17.37', 'known'],
    ['unfulfilled', '', 'blank'],
    ['completed', 'bad', 'invalid'],
  ]) {
    const row = [...fixture.rows[1]];
    row[4] = status;
    row[11] = price;
    const csv = [fixture.headers, row]
      .map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const parsed = await new CsvImportService().parseUberEatsCsv(
      Buffer.from(csv),
      'u',
      timezone,
      3,
    );
    assert.equal(parsed.success, true);
    assert.equal(parsed.receipts.length, 1);
    assert.equal(parsed.receipts[0].resolution.orderEvidence.totalState, expectedState);
    const resolved = outcome([{ id: 'x', receipt: parsed.receipts[0] }]);
    assert.equal(resolved.refundStatus, 'none_established');
    if (expectedState !== 'known') assert.equal(resolved.netAmount, null);
  }
  const zero = (await scenario())[0];
  zero.receipt.receiptType = 'doordash';
  zero.receipt.resolution.amountBasis = 'item_subtotal';
  assert.equal(outcome([zero]).refundStatus, 'none_established');
});
test('orphan refund is an adjustment, not a newly delivered order', () => {
  const refund = email(fixture.emails[1]);
  assert.equal(outcome([refund]).kind, 'unlinked_adjustment');
  assert.equal(reconcile([refund])[0].reason, 'unlinked_adjustment');
});
test('a unique same-day revised receipt enriches its export even if the original email is absent', async () => {
  const all = await scenario();
  const exported = all[2];
  const revision = modify(email(fixture.emails[1]), 'partial-update', {
    documentKind: 'updated',
    previousTotal: 22.48,
    recordedTotal: 18.47,
    payments: [],
    timestamps: [],
  });
  revision.receipt.amountSpent = 18.47;
  assert.equal(outcome([revision]).kind, 'unlinked_adjustment');
  const groups = reconcile([exported, revision]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].method, 'unique_day');
  const receipt = projectReconciledGroup(groups[0], 'canonical');
  assert.equal(receipt.amountSpent, 18.47);
  assert.equal(receipt.resolution.orderOutcome.confirmedRefundAmount, 4.01);
  assert.equal(receipt.resolution.orderOutcome.fulfillment, 'completed');
  assert.equal(receipt.items[0].name, 'Small');
});
test('a full-refund revision matches the unique order even when its export still shows the original charge', async () => {
  const all = await scenario();
  const exported = all[0];
  exported.receipt.amountSpent = 22.48;
  exported.receipt.resolution.orderEvidence.recordedTotal = 22.48;
  const groups = reconcile([exported, email(fixture.emails[1])]);
  assert.equal(groups.length, 1);
  const receipt = projectReconciledGroup(groups[0], 'canonical');
  assert.equal(receipt.resolution.orderOutcome.netAmount, 0);
  assert.equal(receipt.resolution.orderOutcome.confirmedRefundAmount, 22.48);
  assert.equal(receipt.resolution.orderOutcome.fulfillment, 'completed');
});

test('revised receipts without originals can disambiguate multiple exports by final balance, not payment times', async () => {
  const all = await scenario();
  const exported = all[2];
  const other = structuredClone(exported);
  other.id = 'other-export';
  other.receipt.orderDate = new Date('2023-12-10T22:00Z');
  other.receipt.resolution.orderEvidence.recordedTotal = 30;
  other.receipt.amountSpent = 30;
  const revision = modify(email(fixture.emails[1]), 'partial-update', {
    documentKind: 'updated',
    previousTotal: 22.48,
    recordedTotal: 19.47,
    payments: [],
    timestamps: [],
  });
  revision.receipt.amountSpent = 19.47;
  const groups = reconcile([other, revision, exported]);
  assert.equal(groups.length, 2);
  const matched = groups.find((group) => group.observations.some((o) => o.id === revision.id));
  assert.equal(matched.method, 'final_amount');
  assert.deepEqual(matched.observations.map((o) => o.id).sort(), ['export-2', 'partial-update']);
});
test('a revised date-only receipt cannot use its storage date as a manufactured time match', async () => {
  const all = await scenario();
  const exported = all[2];
  const other = structuredClone(exported);
  other.id = 'other-export';
  other.receipt.orderDate = new Date('2023-12-10T23:00Z');
  other.receipt.deliveryTime = new Date('2023-12-10T23:30Z');
  other.receipt.resolution.orderEvidence.timestamps = [];
  const revision = modify(email(fixture.emails[1]), 'partial-update', {
    documentKind: 'updated',
    previousTotal: 22.48,
    recordedTotal: 18.47,
    payments: [],
    timestamps: [],
  });
  revision.receipt.amountSpent = 18.47;
  revision.receipt.orderDate = new Date('2023-12-10T07:00Z');
  const groups = reconcile([other, revision, exported]);
  assert.equal(groups.length, 3);
  assert.ok(groups.every((group) => group.method !== 'time'));
});
test('unique revision families require corroboration and do not bridge conflicting identities', () => {
  const original = email(fixture.emails[0]),
    refund = email(fixture.emails[1]);
  assert.equal(reconcile([original, refund]).length, 1);
  const competing = modify(original, 'second-purchase', {});
  assert.equal(reconcile([original, competing, refund]).length, 3);
  original.receipt.externalId = 'order-a';
  refund.receipt.externalId = 'order-b';
  assert.equal(reconcile([original, refund]).length, 2);
});
test('December 10 refund families survive omitted courier text and differently formatted payment timestamps', async () => {
  const all = await scenario();
  const original = all.find((o) => o.id === 'pizza-original');
  const refund = all.find((o) => o.id === 'pizza-refund');
  delete original.receipt.resolution.orderEvidence.courier;
  delete refund.receipt.resolution.orderEvidence.courier;
  for (const payment of refund.receipt.resolution.orderEvidence.payments) {
    payment.timestamp.raw = 'December 10, 2023 1:44 AM';
    payment.timestamp.instant = '2023-12-10T01:44:00-05:00';
  }
  const groups = reconcile(all);
  assert.equal(groups.length, 5);
  const returned = groups.find((g) => g.observations.some((o) => o.id === 'pizza-refund'));
  assert.deepEqual(returned.observations.map((o) => o.id).sort(), [
    'export-0',
    'pizza-original',
    'pizza-refund',
  ]);
  const projected = groups.map((g, i) => projectReconciledGroup(g, `canonical-${i}`));
  const metrics = summarizeOrderMetrics(projected);
  assert.equal(metrics.currencies[0].netSpend, 157.02);
  assert.equal(metrics.confirmedRefunds, 1);
  const financial = projected.find((r) => r.resolution.orderOutcome.refundStatus === 'full')
    .resolution.orderOutcome;
  assert.equal(financial.events.filter((e) => e.kind === 'charge').length, 1);
  assert.equal(financial.events.filter((e) => e.kind === 'refund').length, 1);
  assert.deepEqual(reconcile([...all].reverse()), groups);
});
test('payment corroboration preserves ambiguity between equal purchases and rejects day-only or conflicting instants', () => {
  const original = email(fixture.emails[0]);
  const refund = email(fixture.emails[1]);
  delete original.receipt.resolution.orderEvidence.courier;
  delete refund.receipt.resolution.orderEvidence.courier;
  const secondOriginal = modify(original, 'second-original', {});
  assert.equal(reconcile([original, secondOriginal, refund]).length, 3);

  const changedTime = structuredClone(refund);
  changedTime.receipt.resolution.orderEvidence.payments[0].timestamp.instant =
    '2023-12-10T18:44:00.000Z';
  assert.equal(
    reconcile([original, changedTime]).length,
    2,
    'identical raw text cannot override differing interpreted instants',
  );

  const dayOnlyOriginal = structuredClone(original);
  const dayOnlyRefund = structuredClone(refund);
  for (const source of [dayOnlyOriginal, dayOnlyRefund]) {
    source.receipt.resolution.orderEvidence.payments[0].timestamp = {
      raw: 'December 10, 2023',
      role: 'payment',
      precision: 'day',
    };
  }
  assert.equal(
    reconcile([dayOnlyOriginal, dayOnlyRefund]).length,
    2,
    'a shared payment day alone does not identify a revision',
  );
});
test('partial refund chains do not double-subtract revised totals; competing revisions require review', () => {
  const original = modify(email(fixture.emails[0]), 'original', {
    recordedTotal: 40,
    payments: [],
  });
  const one = modify(original, 'one', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 30,
    revisionOf: 'original',
  });
  const two = modify(one, 'two', { previousTotal: 30, recordedTotal: 20, revisionOf: 'one' });
  const resolved = outcome([two, original, one]);
  assert.equal(resolved.netAmount, 20);
  assert.equal(resolved.originalCharge, 40);
  assert.equal(resolved.confirmedRefundAmount, 20);
  assert.equal(resolved.refundStatus, 'partial');
  const competing = modify(one, 'competing', { recordedTotal: 25 });
  assert.equal(outcome([original, one, competing]).financialConfidence, 'conflicted');
});
test('explicit refund reversal is a distinct event, not a second charge or negative refund', () => {
  const original = modify(email(fixture.emails[0]), 'original', {
    recordedTotal: 40,
    payments: [],
  });
  const refund = modify(original, 'refund', {
    documentKind: 'updated',
    previousTotal: 40,
    recordedTotal: 0,
    revisionOf: 'original',
  });
  const reversal = modify(refund, 'reversal', {
    previousTotal: 0,
    recordedTotal: 40,
    revisionOf: 'refund',
    payments: [{ kind: 'refund_reversal', amount: 40, tender: 'card', reference: 'reversal-1' }],
  });
  const result = outcome([reversal, original, refund]);
  assert.equal(result.netAmount, 40);
  assert.equal(result.confirmedRefundAmount, 40);
  assert.equal(result.events.filter((e) => e.kind === 'refund_reversal').length, 1);
  assert.equal(result.events.filter((e) => e.kind === 'charge_adjustment').length, 0);
  assert.equal(result.refundStatus, 'reversed');
});
test('provider links extract only scoped order IDs, never tracking UUIDs or secrets', () => {
  const id = '12345678-1234-1234-1234-123456789012';
  assert.equal(
    extractLinkedProviderOrderId(
      `<a href="https://www.ubereats.com/orders/${id}?secret=not-retained">order</a>`,
      'uber_eats',
    ),
    id,
  );
  assert.equal(
    extractLinkedProviderOrderId(
      `<a href="https://uber.com.evil.example/orders/${id}">order</a>`,
      'uber_eats',
    ),
    undefined,
  );
  assert.equal(
    extractLinkedProviderOrderId(
      `<a href="https://uber.com/tracking/${id}">track</a>`,
      'uber_eats',
    ),
    undefined,
  );
});
test('runtime evidence decoders reject fake zeros, invalid dates and payment data', () => {
  const evidence = email(fixture.emails[0]).receipt.resolution.orderEvidence;
  for (const override of [
    { totalState: 'blank' },
    { recordedTotal: -1 },
    { orderHeaderDay: '2023-02-30' },
    {
      payments: [
        { kind: 'charge', amount: 22.48, tender: 'card', cardLastFour: '4111111111111111' },
      ],
    },
  ])
    assert.throws(() => decodeOrderSourceEvidence({ ...evidence, ...override }));
  assert.throws(() => decodeOrderOutcome({ version: 4 }));
});

test('all December 10 metric cohorts agree and cancellation items cannot drive delivery stories', async () => {
  const projected = reconcile(await scenario()).map((g, i) => projectReconciledGroup(g, `id-${i}`));
  const metrics = summarizeOrderMetrics(projected);
  assert.equal(metrics.attempts, 5);
  assert.equal(metrics.deliveries, 4);
  assert.equal(metrics.canceled, 1);
  assert.equal(metrics.chargedCancellations, 1);
  assert.equal(metrics.confirmedRefunds, 1);
  assert.equal(metrics.fullyRefunded, 1);
  assert.equal(metrics.currencies[0].netSpend, 157.02);
  assert.equal(metrics.currencies[0].cancellationCost, 43.26);
  assert.equal(metrics.currencies[0].confirmedRefundAmount, 22.48);
  const ranking = mostDeliveriesDay(projected, timezone);
  assert.equal(ranking.status, 'available');
  assert.equal(ranking.deliveries, 4);
  assert.equal(ranking.spending[0].netSpend, 113.76);
  const possible = structuredClone(projected.find((r) => r.amountSpent === 19.47));
  possible.dataSource = 'email';
  possible.resolution.reconciliation.status = 'unresolved';
  possible.orderDate = new Date('2024-01-01T17:00Z');
  const uncertain = summarizeOrderMetrics([...projected, possible]);
  assert.equal(uncertain.attempts, 5);
  assert.equal(uncertain.possibleAdditionalOrders, 1);
  assert.equal(uncertain.currencies[0].netSpend, 157.02);
  assert.equal(uncertain.currencies[0].possibleAdditionalSpend, 19.47);
  assert.deepEqual(mostDeliveriesDay([...projected, possible], timezone), {
    status: 'matching',
    reason: 'unresolved_orders',
  });
});

test('multiple same-restaurant purchases match by unique final amounts despite unknown time provenance', async () => {
  const all = await scenario();
  const a = all[2],
    b = structuredClone(a);
  b.id = 'other-export';
  b.receipt.orderDate = new Date('2023-12-10T07:00Z');
  b.receipt.amountSpent = 25;
  b.receipt.resolution.orderEvidence.recordedTotal = 25;
  const emailA = all.find((o) => o.id === 'pizza-small'),
    emailB = modify(emailA, 'email-b', { recordedTotal: 25, timestamps: [], payments: [] });
  emailA.receipt.resolution.orderEvidence.timestamps = [];
  const groups = reconcile([emailB, b, emailA, a]);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.method === 'final_amount'));
  const collision = modify(emailB, 'collision', {});
  const revised = reconcile([emailB, b, emailA, a, collision]);
  assert.equal(revised.filter((g) => g.method === 'final_amount').length, 1);
  assert.equal(revised.length, 4, 'the unmatched remainder must not be forced together');
});

test('broad time windows require independent uniqueness and preserve date-only ambiguity', async () => {
  const all = await scenario();
  const a = all[2],
    b = structuredClone(a);
  b.id = 'late-export';
  a.receipt.orderDate = new Date('2023-12-10T07:00Z');
  a.receipt.deliveryTime = new Date('2023-12-10T08:00Z');
  a.receipt.resolution.orderEvidence.timestamps = [];
  b.receipt.orderDate = new Date('2023-12-10T22:00Z');
  b.receipt.deliveryTime = new Date('2023-12-10T23:00Z');
  b.receipt.resolution.orderEvidence.timestamps = [];
  const e = modify(
    all.find((o) => o.id === 'pizza-small'),
    'delayed',
    {
      recordedTotal: 18,
      payments: [],
      timestamps: [
        {
          role: 'delivered',
          precision: 'minute',
          raw: 'December 10, 2023 6:30 AM',
          instant: '2023-12-10T11:30:00Z',
        },
      ],
    },
  );
  assert.equal(
    reconcile([a, b, e]).find((g) => g.observations.some((o) => o.id === 'delayed')).method,
    'time',
  );
  e.receipt.resolution.orderEvidence.timestamps = [];
  e.receipt.resolution.timestamp = { precision: 'day', raw: '2023-12-10' };
  assert.equal(reconcile([a, b, e]).length, 3);
});

test('known currency and fulfillment conflicts prevent final-amount and unique-day fallback', async () => {
  const all = await scenario();
  const x = all[2],
    e = all.find((o) => o.id === 'pizza-small');
  e.receipt.monetaryDetails.currencyCode = 'USD';
  assert.equal(reconcile([x, e]).length, 2);
  e.receipt.monetaryDetails.currencyCode = 'CAD';
  e.receipt.resolution.orderEvidence.fulfillment = 'canceled';
  assert.equal(reconcile([x, e]).length, 2);
  x.receipt.externalId = e.receipt.externalId = 'shared';
  const result = reconcile([x, e]);
  assert.equal(result.length, 1);
  assert.equal(
    projectReconciledGroup(result[0], 'one').resolution.orderOutcome.fulfillmentConfidence,
    'conflicted',
  );
});

for (const missingCourier of [false, true])
  test(`real extraction-to-batch pipeline preserves December 10 families, complete branch names and payment dates (missing courier: ${missingCourier})`, async () => {
    const extractor = new ReceiptEmailBatchExtractor(
      new ReceiptExtractor({}, 3),
      { capture: async () => {} },
      10,
      Date.now,
      3,
    );
    const batch = await extractor.extract(
      fixture.emails.map((e) => ({
        userId: 'fixture-user',
        provider: 'gmail',
        providerMessageId: e.id,
        from: 'receipts@uber.com',
        to: 'redacted',
        subject: 'Your Uber Eats receipt',
        body: (missingCourier
          ? e.text
              .replace(/\nDelivered by[^\n]*/g, '')
              .replaceAll(
                '12/10/23 1:44 AM',
                e.id === 'pizza-refund' ? 'December 10, 2023 1:44 AM' : '12/10/23 1:44 AM',
              )
          : e.text
        )
          .split('\n')
          .map((line) => `<p>${line}</p>`)
          .join(''),
        receivedAt: new Date('2023-12-11T17:00Z'),
      })),
      timezone,
      { userId: 'fixture-user', trigger: 'manual' },
    );
    assert.deepEqual(batch.errors, []);
    assert.equal(batch.supportedReceipts.length, 6);
    assert.ok(
      batch.supportedReceipts.every(
        (r) => r.orderDate.toISOString() === '2023-12-10T17:00:00.000Z',
      ),
    );
    assert.ok(
      batch.supportedReceipts
        .slice(0, 4)
        .every((r) => r.restaurantName === 'Pizza Pizza (1717 Bank St.)'),
    );
    assert.ok(
      batch.supportedReceipts.every(
        (r) =>
          r.resolution.timestamp.role === 'receipt' && r.resolution.timestamp.precision === 'day',
      ),
    );
    const all = await scenario();
    const input = [
      ...all.filter((o) => o.receipt.dataSource === 'csv'),
      ...batch.supportedReceipts.map((receipt, i) => ({ id: `message-${i}`, receipt })),
    ];
    const metrics = summarizeOrderMetrics(
      reconcile(input).map((g, i) => projectReconciledGroup(g, `canonical-${i}`)),
    );
    assert.equal(metrics.attempts, 5);
    assert.equal(metrics.deliveries, 4);
    assert.equal(metrics.currencies[0].netSpend, 157.02);
  });

test('refund-policy footer text does not turn an ordinary receipt into a refund notice', () => {
  const receipt = extractEmailOrderEvidence({
    text: fixture.emails[0].text + '\nRead our refund and canceled order policies.',
    total: 22.48,
  });
  assert.equal(receipt.documentKind, 'original');
});

test('a missing header permits adjacent-day matching only with independent monetary evidence', async () => {
  const all = await scenario();
  const x = all[2],
    e = all.find((o) => o.id === 'pizza-small');
  delete e.receipt.resolution.orderEvidence.orderHeaderDay;
  e.receipt.orderDate = new Date('2023-12-11T05:10:00Z');
  e.receipt.resolution.timestamp = { precision: 'received', raw: '2023-12-11T05:10:00Z' };
  e.receipt.resolution.orderEvidence.timestamps = [
    {
      role: 'received',
      precision: 'second',
      raw: '2023-12-11T05:10:00Z',
      instant: '2023-12-11T05:10:00Z',
    },
  ];
  assert.equal(reconcile([x, e])[0].method, 'final_amount');
  e.receipt.resolution.orderEvidence.recordedTotal = 18;
  assert.equal(reconcile([x, e]).length, 2);
  e.receipt.resolution.orderEvidence.recordedTotal = 19.47;
  e.receipt.resolution.orderEvidence.orderHeaderDay = '2023-12-11';
  assert.equal(
    reconcile([x, e]).length,
    2,
    'an explicit disagreeing order day cannot be overridden by the amount',
  );
});
