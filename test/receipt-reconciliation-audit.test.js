const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildReceiptReconciliationAudit,
} = require('../dist/services/receipt/ReceiptReconciliationAudit');
const { ReceiptReconciliationStore } = require('../dist/services/data/ReceiptReconciliationStore');
const { parseReceiptAuditOptions } = require('../dist/scripts/receiptReconciliationAuditOptions');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const {
  decemberSourceObservations,
  decemberCanonicalOrders,
} = require('./helpers/order-events-fixture');
const timezone = 'America/Toronto';
const empty = () => ({ receipts: [], observations: [], coverage: [], timezone });
const store = () =>
  new ReceiptReconciliationStore(async () => {
    throw Error('Read only');
  }, 3);

test('saved-manifest audit selection cannot replace frozen policy or evidence inputs', () => {
  const account = '00112233-4455-6677-8899-aabbccddeeff';
  const manifest = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const parsed = parseReceiptAuditOptions([
    account.toUpperCase(),
    '--manifest',
    manifest.toUpperCase(),
    '--details',
  ]);
  assert.equal(parsed.userId, account);
  assert.equal(parsed.manifestId, manifest);
  assert.equal(parsed.details, true);
  for (const args of [
    [account, '--manifest'],
    [account, '--manifest', 'not-a-uuid'],
    [account, '--manifest', manifest, '--manifest', manifest],
    [account, '--manifest', manifest, '--policy', '3'],
    [account, '--staged-batches', manifest, '--manifest', manifest],
  ])
    assert.throws(() => parseReceiptAuditOptions(args));
});

test('saved-manifest report retains December evidence if staged details are unavailable', async () => {
  const after = store().plan({ ...empty(), observations: await decemberSourceObservations() });
  const frozen = JSON.stringify(after);
  const report = buildReceiptReconciliationAudit(empty(), after, [], true, 'manifest');
  assert.equal(report.after.orderMetrics.attempts, 5);
  assert.equal(report.after.orderMetrics.currencies[0].netSpend, 157.02);
  assert.equal(report.orders.flatMap((o) => o.evidence).length, 11);
  assert.ok(report.orders.flatMap((o) => o.evidence).every((o) => o.origin === 'manifest_source'));
  assert.match(report.limitations[0], /Saved immutable/);
  assert.doesNotMatch(report.limitations[0], /nothing has been published|IDs remain provisional/);
  assert.equal(JSON.stringify(after), frozen);
});

test('audit reconstructs December purchases, cancellation, refund and wallet flows without counting eleven documents', async () => {
  const observations = (await decemberSourceObservations()).map((o) => ({
    ...o,
    receiptId: `old-${o.id}`,
  }));
  const before = {
    ...empty(),
    observations,
    receipts: observations.map((o) => ({ ...o.receipt, id: o.receiptId })),
  };
  const frozen = JSON.stringify(before);
  const after = store().plan(before);
  const report = buildReceiptReconciliationAudit(before, after, [], true);
  assert.equal(JSON.stringify(before), frozen);
  assert.equal(report.before.projectionRecords, 11);
  assert.equal(report.before.orderMetrics.legacyOrders, 11);
  assert.equal(report.after.legacyProjectionTotals, undefined);
  assert.equal(report.after.projectionRecords, 5);
  assert.equal(report.after.sourceObservations, 11);
  assert.deepEqual(report.after.orderMetrics, summarizeOrderMetrics(after.receipts));
  const metrics = report.after.orderMetrics;
  assert.equal(metrics.attempts, 5);
  assert.equal(metrics.deliveries, 4);
  assert.equal(metrics.chargedCancellations, 1);
  assert.equal(metrics.fullyRefunded, 1);
  assert.equal(metrics.currencies[0].netSpend, 157.02);
  assert.equal(metrics.currencies[0].deliveredNetSpend, 113.76);
  assert.equal(metrics.currencies[0].cancellationCost, 43.26);
  assert.equal(metrics.currencies[0].confirmedRefundAmount, 22.48);
  assert.deepEqual(metrics.currencies[0].payments, [
    { tender: 'card', charges: 153.81, refunds: 0, refundReversals: 0 },
    { tender: 'provider_wallet', charges: 25.69, refunds: 22.48, refundReversals: 0 },
  ]);
  assert.equal(report.examples.length, 5);
  assert.equal(report.orders.flatMap((o) => o.evidence).length, 11);
  assert.ok(report.orders.every((o) => o.mergesPreviousRecords));
  assert.ok(report.lineage.every((o) => o.proposedReceiptIds.length === 1));
  assert.ok(report.limitations.some((text) => text.includes('Legacy outcomes')));
  for (const order of report.orders) {
    assert.equal(order.evidence.length, order.sourceObservationIds.length);
    assert.ok(order.evidence.every((o) => o.origin === 'stored'));
  }
});

test('audit distinguishes unresolved orders, orphan adjustments, unknown prices and separate currencies', async () => {
  const base = (await decemberCanonicalOrders())[0];
  const copy = (id, kind, currency, netAmount) => {
    const r = structuredClone(base);
    r.id = id;
    r.dataSource = 'email';
    r.monetaryDetails.currencyCode = currency;
    r.resolution.orderOutcome.netAmount = netAmount;
    r.resolution.orderOutcome.financialConfidence = netAmount === null ? 'conflicted' : 'confirmed';
    r.resolution.orderOutcome.kind = kind === 'adjustment' ? 'unlinked_adjustment' : 'order';
    r.resolution.orderOutcome.events = [];
    r.resolution.reconciliation.status = kind === 'possible' ? 'unresolved' : 'standalone';
    r.resolution.reconciliation.reason = kind === 'possible' ? 'ambiguous' : undefined;
    return r;
  };
  const after = {
    ...empty(),
    receipts: [
      copy('known', 'order', 'CAD', 20),
      copy('possible', 'possible', 'CAD', 30),
      copy('orphan', 'adjustment', 'CAD', 0),
      copy('unknown', 'order', 'CAD', null),
      copy('usd', 'order', 'USD', 7),
    ],
  };
  const report = buildReceiptReconciliationAudit(empty(), after);
  assert.equal(report.after.projectionRecords, 5);
  assert.equal(report.after.orderMetrics.attempts, 3);
  assert.equal(report.after.orderMetrics.possibleAdditionalOrders, 1);
  assert.equal(report.after.orderMetrics.unlinkedAdjustments, 1);
  assert.equal(report.after.orderMetrics.currencies[0].netSpend, 20);
  assert.equal(report.after.orderMetrics.currencies[0].unknownPriceOrders, 1);
  assert.equal(report.after.orderMetrics.currencies[0].possibleAdditionalSpend, 30);
  assert.deepEqual(
    report.delta.currencies.map((c) => [c.currencyCode, c.knownNetSpend]),
    [
      ['CAD', 20],
      ['USD', 7],
    ],
  );
  assert.equal(report.reviewCandidates.find((r) => r.receiptId === 'unknown').netAmount, null);
  assert.equal(report.after.unresolvedReasons.ambiguous, 1);
});

test('audit keeps superseded, disabled, staged and legacy evidence distinguishable', async () => {
  const [source] = (await decemberSourceObservations()).filter(
    (o) => o.receipt.dataSource === 'email',
  );
  const current = { ...source, id: 'new', receiptId: 'order' };
  const previous = structuredClone(current);
  previous.id = 'old';
  delete previous.receipt.resolution.orderEvidence;
  const disabled = {
    ...structuredClone(previous),
    id: 'disabled',
    receiptId: undefined,
    associationEnabled: false,
  };
  const before = { ...empty(), observations: [previous, disabled] };
  const after = {
    ...empty(),
    observations: [previous, disabled, current],
    receipts: [{ ...current.receipt, id: 'order' }],
  };
  const batch = {
    id: 'batch',
    parserVersion: 3,
    provenance: { sourceKind: 'retained_email' },
    observations: [{ ...current, id: 'staged-id' }],
    coverage: [],
  };
  const report = buildReceiptReconciliationAudit(before, after, [batch], true);
  assert.deepEqual(report.after.sources[0], {
    provider: 'uber_eats',
    source: 'email',
    observations: 3,
    current: 1,
    superseded: 1,
    disabled: 1,
  });
  assert.equal(report.orders[0].evidence.find((o) => o.id === 'new').origin, 'staged');
  assert.equal(report.orders[0].evidence.find((o) => o.id === 'old').interpretation, 'superseded');
  assert.deepEqual(report.stagedBatches[0].observationIds, ['staged-id']);
  assert.deepEqual(report.stagedBatches[0].proposedObservationIds, ['new']);
  const legacyBefore = { ...empty(), receipts: [{ ...previous.receipt, id: 'legacy-order' }] };
  const legacyReport = buildReceiptReconciliationAudit(
    legacyBefore,
    store().plan(legacyBefore),
    [],
    true,
  );
  assert.equal(legacyReport.before.projectionsWithoutSourceObservations, 1);
  assert.equal(legacyReport.orders[0].evidence[0].origin, 'legacy_projection');
  assert.deepEqual(legacyReport.orders[0].previousReceiptIds, ['legacy-order']);
});

test('audit lineage exposes a late split and does not claim the retained ID means stable membership', async () => {
  const all = await decemberSourceObservations();
  const sources = all
    .filter((o) => o.receipt.dataSource === 'csv')
    .slice(0, 2)
    .map((o) => ({ ...o, receiptId: 'previous-merged' }));
  const before = {
    ...empty(),
    observations: sources,
    receipts: [{ ...sources[0].receipt, id: 'previous-merged' }],
  };
  const report = buildReceiptReconciliationAudit(before, store().plan(before), [], true);
  assert.equal(report.lineage[0].proposedReceiptIds.length, 2);
  assert.ok(report.orders.every((r) => r.splitsPreviousRecord));
  assert.equal(report.orders.filter((r) => r.receiptId === 'previous-merged').length, 1);
});

test('audit day examples use event timezone and date-only order text, not payment or account day', async () => {
  const base = (await decemberCanonicalOrders())[0];
  const travel = structuredClone(base);
  travel.orderDate = new Date('2023-12-11T07:30Z');
  travel.resolution.timestamp = {
    raw: '2023-12-10T23:30:00',
    timezone: 'America/Los_Angeles',
    role: 'placed',
    convention: 'local',
    precision: 'minute',
  };
  travel.dataSource = 'csv';
  const email = structuredClone(base);
  email.id = 'date-only';
  email.dataSource = 'email';
  email.orderDate = new Date('2023-12-12T07:30Z');
  email.resolution.orderEvidence.orderHeaderDay = '2023-12-10';
  const report = buildReceiptReconciliationAudit(empty(), {
    ...empty(),
    receipts: [travel, email],
  });
  assert.equal(report.examples.length, 2);
  assert.ok(report.examples.every((r) => r.localDay === '2023-12-10'));
});

test('audit CLI requires an exact account, explicit proposed policy and validated staged batches', () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const batch = 'abcdefab-abcd-abcd-abcd-abcdefabcdef';
  assert.equal(parseReceiptAuditOptions([id]).policyVersion, 3);
  assert.deepEqual(
    parseReceiptAuditOptions([id, '--details', '--staged-batches', batch, '--policy', '3']),
    {
      userId: id,
      details: true,
      policyVersion: 3,
      stagedBatchIds: [batch],
    },
  );
  for (const args of [
    [],
    ['-'.repeat(36)],
    [id, '--policy', '4'],
    [id, '--details', '--details'],
    [id, '--unknown'],
    [id, '--policy', '2', '--staged-batches', batch],
    [id, '--policy', '3', '--staged-batches', `${batch},${batch.toUpperCase()}`],
    [id, '--policy', '3', '--staged-batches'],
    [id, '--policy'],
  ])
    assert.throws(() => parseReceiptAuditOptions(args));
});

test('July 5 Grimaldi subtotal/email pair is one USD purchase with export items and email cost', () => {
  const common = {
    userId: 'fixture-user',
    receiptType: 'doordash',
    restaurantName: 'Grimaldi’s Garden City',
    orderDate: new Date('2026-07-05T16:00Z'),
    monetaryDetails: { currencyCode: 'USD' },
  };
  const sourceEvidence = {
    version: 1,
    parserVersion: 3,
    fulfillment: 'completed',
    timestamps: [],
    payments: [],
    issues: [],
  };
  const exported = {
    ...common,
    dataSource: 'csv',
    amountSpent: 76.8,
    items: [{ name: 'Pizza', quantity: 1, price: 76.8 }],
    monetaryDetails: { ...common.monetaryDetails, subtotal: 76.8 },
    resolution: {
      version: 1,
      amountBasis: 'item_subtotal',
      adjustments: [],
      issues: [],
      orderEvidence: {
        ...sourceEvidence,
        documentKind: 'export',
        recordedTotal: null,
        totalState: 'unavailable',
      },
    },
  };
  const email = {
    ...common,
    dataSource: 'email',
    amountSpent: 61.39,
    items: [],
    orderDate: new Date('2026-07-05T23:00Z'),
    resolution: {
      version: 1,
      amountBasis: 'receipt_total',
      adjustments: [],
      issues: [],
      sourceMessageId: 'gmail:grimaldi',
      orderEvidence: {
        ...sourceEvidence,
        documentKind: 'original',
        orderHeaderDay: '2026-07-05',
        recordedTotal: 61.39,
        totalState: 'known',
      },
    },
  };
  const before = {
    ...empty(),
    receipts: [
      { ...exported, id: 'export-order' },
      { ...email, id: 'email-order' },
    ],
    observations: [
      { id: 'export-observation', receiptId: 'export-order', receipt: exported },
      { id: 'email-observation', receiptId: 'email-order', receipt: email },
    ],
  };
  const report = buildReceiptReconciliationAudit(before, store().plan(before), [], true);
  assert.equal(report.examples.length, 1);
  assert.equal(report.after.orderMetrics.attempts, 1);
  assert.equal(report.after.orderMetrics.currencies[0].currencyCode, 'USD');
  assert.equal(report.after.orderMetrics.currencies[0].netSpend, 61.39);
  assert.equal(report.examples[0].items[0].name, 'Pizza');
  assert.equal(report.examples[0].reconciliation.method, 'unique_day');
  const evidence = report.examples[0].evidence;
  assert.equal(evidence.find((o) => o.source === 'csv').recordedAmount, null);
  assert.equal(evidence.find((o) => o.source === 'csv').subtotal, 76.8);
  assert.equal(evidence.find((o) => o.source === 'email').recordedAmount, 61.39);
});
