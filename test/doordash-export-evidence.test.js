const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile, unlink, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { decodeOrderSourceEvidence } = require('../dist/models/OrderEvidence');
const { resolveOrderOutcome } = require('../dist/services/receipt/OrderFinancialResolver');
const {
  reconcileReceiptGroups,
  projectReconciledGroup,
} = require('../dist/services/receipt/ReceiptGroupReconciler');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const fixture = require('./fixtures/receipt-accuracy/doordash-source');
const timezone = 'America/Toronto';
const parse = (rows, policy = 3) =>
  new CsvImportService().parseDoorDashCsv(Buffer.from(fixture.csv(rows)), 'user', timezone, policy);

test('DoorDash subtotal export retains policy-3 source facts without inventing a final charge', async () => {
  const result = await parse();
  const receipt = result.receipts[0];
  const evidence = decodeOrderSourceEvidence(receipt.resolution.orderEvidence);
  assert.equal(evidence.documentKind, 'export');
  assert.equal(evidence.recordedTotal, null);
  assert.equal(evidence.totalState, 'unavailable');
  assert.equal(evidence.fulfillment, 'completed');
  assert.equal(receipt.monetaryDetails.subtotal, 76.8);
  assert.deepEqual(evidence.payments, []);
  assert.deepEqual(
    evidence.timestamps.map((t) => [t.role, t.precision]),
    [
      ['placed', 'second'],
      ['delivered', 'second'],
    ],
  );
  assert.equal(evidence.timestamps[0].instant, '2026-07-05T16:00:00.000Z');
  assert.equal(result.statusCounts.completed, 1);
  assert.equal(result.rejectedRecords, 0);
  assert.equal(receipt.resolution.orderEvidence.parserVersion, 3);
  assert.ok(receipt.resolution.rows.every((r) => !('DELIVERY_ADDRESS' in r)));
  const outcome = resolveOrderOutcome([{ id: 'source', receipt }]);
  assert.equal(outcome.netAmount, null);
  assert.equal(outcome.originalCharge, null);
  assert.equal(outcome.refundStatus, 'none_established');
});

test('a zero DoorDash subtotal is neither a zero final charge nor a probable refund', async () => {
  const receipt = (await parse([{ SUBTOTAL: '0.00', UNIT_PRICE: '0.00' }])).receipts[0];
  assert.equal(receipt.monetaryDetails.subtotal, 0);
  const outcome = resolveOrderOutcome([{ id: 'zero-subtotal', receipt }]);
  assert.equal(outcome.netAmount, null);
  assert.equal(outcome.refundStatus, 'none_established');
  assert.equal(outcome.confirmedRefundAmount, null);
  assert.equal(outcome.estimatedRefundAmount, null);
  assert.deepEqual(outcome.events, []);
});

test('DoorDash fulfillment remains unknown without a usable delivery record', async () => {
  for (const DELIVERY_TIME of ['', 'not a timestamp', '2026-07-05 11:45:00']) {
    const receipt = (await parse([{ DELIVERY_TIME }])).receipts[0];
    assert.equal(receipt.resolution.orderEvidence.fulfillment, 'unknown');
    assert.equal(receipt.deliveryTime, undefined);
    assert.equal(receipt.resolution.orderEvidence.timestamps.length, 1);
    assert.equal(receipt.resolution.rows[0].DELIVERY_TIME, DELIVERY_TIME);
  }
});

test('Grimaldi unique-day email/export pair combines email cost and export items through actual parsing', async () => {
  const exported = (await parse()).receipts[0];
  const extracted = await new ReceiptEmailBatchExtractor(
    new ReceiptExtractor({}, 3),
    { capture: async () => {} },
    10,
    Date.now,
    3,
  ).extract(
    [
      {
        userId: 'user',
        provider: 'gmail',
        providerMessageId: 'grimaldi-email',
        from: 'no-reply@doordash.com',
        to: 'redacted',
        subject: fixture.email.subject,
        receivedAt: new Date('2026-07-05T23:00:00Z'),
        body: fixture.email.body
          .split('\n')
          .map((line) => `<p>${line}</p>`)
          .join(''),
      },
    ],
    timezone,
    { userId: 'user', trigger: 'manual' },
  );
  assert.equal(extracted.supportedReceipts.length, 1, JSON.stringify(extracted.errors));
  assert.equal(extracted.supportedReceipts[0].monetaryDetails.subtotal, undefined);
  for (const sources of [
    [
      { id: 'export', receipt: exported },
      { id: 'email', receipt: extracted.supportedReceipts[0] },
    ],
    [
      { id: 'email', receipt: extracted.supportedReceipts[0] },
      { id: 'export', receipt: exported },
    ],
  ]) {
    const groups = reconcileReceiptGroups(sources, timezone, [], 3);
    assert.equal(groups.length, 1);
    const order = projectReconciledGroup(groups[0], 'canonical');
    assert.equal(order.resolution.reconciliation.method, 'unique_day');
    assert.equal(order.resolution.orderOutcome.netAmount, 61.39);
    assert.equal(order.resolution.orderOutcome.fulfillment, 'completed');
    assert.deepEqual(order.items, exported.items);
    assert.equal(order.monetaryDetails.currencyCode, 'USD');
  }
});

test('DoorDash policy-2 parsing remains available without relabeling old observations', async () => {
  const receipt = (await parse(undefined, 2)).receipts[0];
  assert.equal(receipt.resolution.orderEvidence, undefined);
  assert.equal(receipt.amountSpent, 76.8);
});

test('missing item subtotal stays unavailable while explicit item prices and quantities survive', async () => {
  const receipt = (
    await parse([
      { SUBTOTAL: '' },
      { ITEM: 'Drink', UNIT_PRICE: '2.00', QUANTITY: '2', SUBTOTAL: '4.00' },
    ])
  ).receipts[0];
  assert.equal(receipt.monetaryDetails.subtotal, undefined);
  assert.equal(receipt.resolution.reconstructedSubtotal, undefined);
  assert.equal(receipt.items.length, 2);
  assert.equal(receipt.items[1].price, 2);
  assert.equal(receipt.items[1].quantity, 2);
  assert.equal(receipt.resolution.orderEvidence.recordedTotal, null);
  assert.ok(receipt.resolution.orderEvidence.issues.includes('Item subtotal is incomplete'));
  await assert.rejects(parse([{ UNIT_PRICE: '' }]), /malformed/);
});

test('date-only and repeated DST wall times cannot create a precise interval', async () => {
  for (const [CREATED_AT, DELIVERY_TIME] of [
    ['2026-07-05', '2026-07-05'],
    ['2025-11-02 01:10:00', '2025-11-02 01:45:00'],
  ]) {
    const receipt = (await parse([{ CREATED_AT, DELIVERY_TIME }])).receipts[0];
    assert.equal(receipt.resolution.timestamp.precision, 'day');
    assert.ok(receipt.resolution.orderEvidence.timestamps.every((t) => !t.instant));
    assert.equal(receipt.deliveryTime, undefined);
    assert.equal(receipt.resolution.orderEvidence.fulfillment, 'completed');
  }
});

test('DoorDash timestamps honor real offsets, minute precision and daylight-saving changes', async () => {
  const rows = [
    { CREATED_AT: '2025-03-09T01:45:00-05:00', DELIVERY_TIME: '2025-03-09T03:15:00-04:00' },
    { CREATED_AT: '2025-11-02T01:10:00-04:00', DELIVERY_TIME: '2025-11-02T01:45:00-05:00' },
    { CREATED_AT: '2026-07-05 12:00', DELIVERY_TIME: '2026-07-05 12:45' },
    { CREATED_AT: '2026-07-05T23:30:00Z', DELIVERY_TIME: '2026-07-06T00:15:00Z' },
  ];
  const expectedMinutes = [30, 95, 45, 45];
  for (const [index, row] of rows.entries()) {
    const receipt = (await parse([row])).receipts[0];
    assert.equal((receipt.deliveryTime - receipt.orderDate) / 60000, expectedMinutes[index]);
    assert.equal(
      receipt.resolution.orderEvidence.timestamps[0].precision,
      index === 2 ? 'minute' : 'second',
    );
  }
});

test('non-hour daylight-saving folds retain uncertainty rather than inventing an exact time', async () => {
  const result = await new CsvImportService().parseDoorDashCsv(
    Buffer.from(
      fixture.csv([{ CREATED_AT: '2025-04-06 01:35:00', DELIVERY_TIME: '2025-04-06 01:55:00' }]),
    ),
    'user',
    'Australia/Lord_Howe',
    3,
  );
  assert.equal(result.receipts.length, 1);
  assert.equal(result.receipts[0].resolution.timestamp.precision, 'day');
  assert.ok(result.receipts[0].resolution.orderEvidence.timestamps.every((t) => !t.instant));
});

test('detected and provider-specific file imports preserve the selected DoorDash evidence policy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'doordash-evidence-'));
  const path = join(directory, 'orders.csv');
  try {
    const service = new CsvImportService();
    const contents = Buffer.from(fixture.csv());
    await writeFile(path, contents);
    for (const policy of [2, 3]) {
      const results = await Promise.all([
        service.parseCsvFile(contents, 'user', timezone, policy),
        service.parseCsvPath(path, 'user', timezone, policy),
        service.parseCsvPathForProvider(path, 'doordash', 'user', timezone, policy),
      ]);
      for (const result of results) {
        assert.equal(result.receipts.length, 1);
        assert.equal(
          result.receipts[0].resolution.orderEvidence?.parserVersion,
          policy === 3 ? 3 : undefined,
        );
        assert.equal(result.receipts[0].monetaryDetails.subtotal, 76.8);
      }
    }
  } finally {
    await unlink(path);
    await rmdir(directory);
  }
});

test('rejected calendar/currency evidence contributes to incomplete parsing counts', async () => {
  for (const row of [
    { CREATED_AT: '2026-02-30T12:00:00Z' },
    { CREATED_AT: '2025-03-09 02:30:00' },
    { CREATED_AT: '2026-07-05T25:00:00Z' },
  ]) {
    const result = await parse([row]);
    assert.equal(result.receipts.length, 0);
    assert.equal(result.rejectedRecords, 1);
    assert.equal(result.success, false);
  }
  const result = await parse([
    { DELIVERY_ADDRESS: 'Redacted, USA' },
    { DELIVERY_ADDRESS: 'Redacted, Canada' },
  ]);
  assert.equal(result.receipts.length, 0);
  assert.equal(result.rejectedRecords, 2);
  assert.equal(result.success, false);
});

test('currency resolution considers all item rows independently of row order', async () => {
  const rows = [{ DELIVERY_ADDRESS: '' }, { ITEM: 'Drink', DELIVERY_ADDRESS: 'Redacted, USA' }];
  for (const selected of [rows, [...rows].reverse()]) {
    const receipt = (await parse(selected)).receipts[0];
    assert.equal(receipt.monetaryDetails.currencyCode, 'USD');
    assert.equal(receipt.monetaryDetails.subtotal, 153.6);
    assert.equal(receipt.items.length, 2);
    assert.ok(receipt.resolution.rows.every((r) => !('DELIVERY_ADDRESS' in r)));
  }
});

test('distinct export groups sharing a placement time are not collapsed, but equivalent offsets are copies', async () => {
  const exported = (
    await parse([
      { CREATED_AT: '2026-07-05T12:00:00Z', DELIVERY_TIME: '2026-07-05T12:45:00Z' },
      { CREATED_AT: '2026-07-05T12:00:00Z', DELIVERY_TIME: '2026-07-05T13:15:00Z' },
    ])
  ).receipts;
  assert.equal(exported.length, 2);
  const copies = (
    await parse([
      { CREATED_AT: '2026-07-05T12:00:00+00:00', DELIVERY_TIME: '2026-07-05T12:45:00+00:00' },
    ])
  ).receipts;
  const sources = [...exported, ...copies].map((receipt, index) => ({
    id: `export-${index}`,
    receipt,
  }));
  const groups = reconcileReceiptGroups(sources, timezone, [], 3);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((g) => g.observations.length).sort(), [1, 2]);
});

test('coarse export placement spans the whole local day instead of forcing a time-only pair', async () => {
  const exports = (
    await parse([
      { CREATED_AT: '2026-07-05', DELIVERY_TIME: '2026-07-05 12:45:00' },
      { CREATED_AT: '2026-07-05', DELIVERY_TIME: '2026-07-05 18:45:00' },
    ])
  ).receipts;
  const email = {
    userId: 'user',
    dataSource: 'email',
    receiptType: 'doordash',
    restaurantName: fixture.base.STORE_NAME,
    orderDate: new Date('2026-07-06T00:00Z'),
    amountSpent: 66,
    items: [],
    monetaryDetails: { currencyCode: 'USD' },
    resolution: {
      version: 1,
      amountBasis: 'receipt_total',
      adjustments: [],
      issues: [],
      sourceMessageId: 'gmail:coarse',
      orderEvidence: {
        version: 1,
        parserVersion: 3,
        documentKind: 'original',
        fulfillment: 'unknown',
        recordedTotal: 66,
        totalState: 'known',
        payments: [],
        issues: [],
        orderHeaderDay: '2026-07-05',
        timestamps: [
          { role: 'placed', precision: 'minute', raw: '8:00 PM', instant: '2026-07-06T00:00:00Z' },
        ],
      },
    },
  };
  const groups = reconcileReceiptGroups(
    [
      ...exports.map((receipt, i) => ({ id: `export-${i}`, receipt })),
      { id: 'email', receipt: email },
    ],
    timezone,
    [],
    3,
  );
  assert.equal(groups.length, 3);
  assert.equal(
    groups.find((g) => g.observations.some((o) => o.id === 'email')).reason,
    'ambiguous',
  );
});
