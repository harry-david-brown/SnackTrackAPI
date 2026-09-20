const test = require('node:test');
const assert = require('node:assert/strict');
const {
  summarizeAdminReceipts,
  decodeAdminReceiptSummary,
  decodeAdminReceiptSources,
  adminReceiptScalarCost,
} = require('../dist/services/admin/AdminReceiptSummary');
const {
  AdministratorQueryRepository,
} = require('../dist/services/admin/AdministratorQueryRepository');
const { AdminManagementService } = require('../dist/services/admin/AdminManagementService');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const fixture = require('./fixtures/analytics/order-event-metrics.json');

test('administrator totals use the December canonical purchases, including wallet cost and refund once', async () => {
  const summary = summarizeAdminReceipts(await decemberCanonicalOrders());
  const expected = {
    ...fixture.metrics,
    receiptRecords: 5,
    currencies: fixture.metrics.currencies.map(({ payments, ...c }) => c),
  };
  assert.deepEqual(summary, expected);
  assert.deepEqual(decodeAdminReceiptSummary(summary), expected);
  assert.deepEqual(adminReceiptScalarCost(summary), {
    total: 157.02,
    average: 31.4,
    currencyCode: 'CAD',
  });
  const poisoned = structuredClone(summary);
  poisoned.reviewNotes = 'private';
  poisoned.currencies[0].payments = [{ secret: 'private' }];
  assert.deepEqual(decodeAdminReceiptSummary(poisoned), expected);
});

test('administrator summaries retain uncertainty and never mix currencies in deprecated scalars', () => {
  for (const receipts of [
    [
      { amountSpent: 5, currencyCode: 'CAD' },
      { amountSpent: 8, currencyCode: 'USD' },
    ],
    [{ amountSpent: 10 }],
    [{ amountSpent: 20, currencyCode: 'CAD', resolution: { amountBasis: 'item_subtotal' } }],
    [
      {
        amountSpent: 20,
        currencyCode: 'CAD',
        resolution: { reconciliation: { status: 'unresolved' } },
      },
    ],
    [
      {
        amountSpent: 0,
        currencyCode: 'CAD',
        resolution: { orderOutcome: { kind: 'unlinked_adjustment' } },
      },
    ],
  ]) {
    const summary = summarizeAdminReceipts(receipts);
    assert.deepEqual(adminReceiptScalarCost(summary), {
      total: null,
      average: null,
      currencyCode: null,
    });
    assert.deepEqual(decodeAdminReceiptSummary(summary), summary);
  }
  assert.deepEqual(adminReceiptScalarCost(summarizeAdminReceipts([])), {
    total: 0,
    average: 0,
    currencyCode: null,
  });
});

test('administrator source counts represent overlapping canonical membership, not summed documents', () => {
  const sources = ['email', 'csv'].map((dataSource) => ({
    dataSource,
    receiptType: 'uber_eats',
    count: 5,
    establishedOrders: 5,
    unresolvedCount: 0,
    observationIds: ['private'],
  }));
  const decoded = decodeAdminReceiptSources(sources);
  assert.equal(decoded.length, 2);
  assert.equal(decoded[0].count, 5);
  assert.equal(JSON.stringify(decoded).includes('private'), false);
  for (const malformed of [
    null,
    [...sources, sources[0]],
    [{ ...sources[0], count: '5' }],
    [{ ...sources[0], unresolvedCount: 1 }],
    [{ ...sources[0], receiptType: 'unknown' }],
  ])
    assert.throws(
      () => decodeAdminReceiptSources(malformed),
      (e) => e.code === 'DATABASE_ERROR',
    );
});

test('malformed administrator metrics fail rather than falling back to zero', () => {
  const valid = summarizeAdminReceipts([{ amountSpent: 10, currencyCode: 'CAD' }]);
  for (const mutate of [
    (s) => {
      s.attempts = '1';
    },
    (s) => {
      s.policyVersion = 2;
    },
    (s) => {
      s.receiptRecords = 9;
    },
    (s) => {
      s.deliveries = 1;
    },
    (s) => {
      s.currencies.push(s.currencies[0]);
    },
    (s) => {
      s.currencies[0].netSpend = NaN;
    },
    (s) => {
      s.currencies[0].netSpend = -1;
    },
    (s) => {
      s.currencies[0].netSpend = 1.111;
    },
    (s) => {
      s.currencies[0].pricedOrders = null;
    },
    (s) => {
      s.currencies[0].currencyCode = 'money';
    },
  ]) {
    const value = structuredClone(valid);
    mutate(value);
    assert.throws(
      () => decodeAdminReceiptSummary(value),
      (e) => e.code === 'DATABASE_ERROR',
    );
  }
});

test('account receipt report binds scope, redacts private fields and propagates query failures', async () => {
  const summary = summarizeAdminReceipts([]);
  const calls = [];
  const repository = new AdministratorQueryRepository({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ receipt_summary: summary, receipt_sources: [] }] };
    },
  });
  assert.deepEqual(await repository.getReceiptReport('11111111-1111-4111-8111-111111111111'), {
    summary,
    sources: [],
  });
  assert.deepEqual(calls[0].params, ['11111111-1111-4111-8111-111111111111']);
  assert.match(calls[0].sql, /WHERE r.user_id=\$1::uuid/);
  const failing = new AdministratorQueryRepository({
    query: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(failing.getReceiptReport('account'), /offline/);
});

test('account detail uses one canonical receipt report and never sums overlapping sources', async () => {
  const summary = summarizeAdminReceipts(await decemberCanonicalOrders());
  const sources = ['email', 'csv'].map((dataSource) => ({
    dataSource,
    receiptType: 'uber_eats',
    count: 5,
    establishedOrders: 5,
    unresolvedCount: 0,
  }));
  const scopes = [];
  let queryCount = 0;
  const service = new AdminManagementService(
    {
      query: async () => ({
        rows:
          queryCount++ === 0
            ? [{ id: 'account', email: 'test@example.test', timezone: 'America/Toronto' }]
            : [],
      }),
    },
    {},
    { get: async () => ({ allowForwardedReceipts: false }) },
    {},
    {},
    {
      getReceiptReport: async (id) => {
        scopes.push(id);
        return { summary, sources };
      },
    },
  );
  const detail = await service.getUser('account');
  assert.deepEqual(scopes, ['account']);
  assert.equal(detail.receiptSummary.receiptRecords, 5);
  assert.equal(detail.receiptSummary.attempts, 5);
  assert.deepEqual(detail.receiptSources, sources);
  assert.equal(detail.testScenarios, undefined);
});
