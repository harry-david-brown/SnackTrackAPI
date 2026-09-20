require('./helpers/legacyReceiptPolicy');
const test = require('node:test');
const assert = require('node:assert/strict');

const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { WrappedAnalyticsService } = require('../dist/services/analytics/WrappedAnalyticsService');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
const { resolveTrackingBaseline } = require('../dist/services/import/ImportLifecycleTypes');
const { GmailSyncRunRepository } = require('../dist/services/data/GmailSyncRunRepository');
const { ImportLifecycleRepository } = require('../dist/services/data/ImportLifecycleRepository');
const {
  ImportPreferencesQueryRepository,
} = require('../dist/services/data/ImportPreferencesQueryRepository');
const { AccountResetService } = require('../dist/services/data/AccountResetService');
const { ReceiptClearService } = require('../dist/services/account/ReceiptClearService');
const {
  filterReceiptsAfterExportCutoffs,
  isGmailReconnectError,
  resolveIncrementalGmailSearchAfter,
} = require('../dist/services/import/GmailImportService');
const {
  GmailConnectionHealthService,
} = require('../dist/services/email/GmailConnectionHealthService');
const {
  buildDashboardInsightCatalogue,
  buildDashboardInsightEdition,
} = require('../dist/services/analytics/dashboard');
const buildDashboardInsights = (...args) => buildDashboardInsightEdition(...args).insights;
const {
  calculateHypotheticalInvestment,
  HYPOTHETICAL_ANNUAL_RETURN_PERCENT,
} = require('../dist/services/analytics/shared/investment');
const { getLocalDateKey, parseReceiptLocalDateTime } = require('../dist/utils/timezone');
const {
  importLifecycleMigration,
} = require('../dist/services/data/migrations/003_import_lifecycle');

const transactional = (client, query = client.query) => ({
  query,
  withTransaction: async (operation) => {
    await client.query('BEGIN');
    try {
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release?.();
    }
  },
});
const noOpImportEvents = { record: async () => {} };

test('timezone helpers preserve local calendar dates and receipt wall time', () => {
  assert.equal(
    getLocalDateKey(new Date('2023-12-10T05:30:00.000Z'), 'America/Toronto'),
    '2023-12-10',
  );
  assert.equal(
    parseReceiptLocalDateTime('Jul 23, 2026', '6:50 p.m.', 'America/Toronto').toISOString(),
    '2026-07-23T22:50:00.000Z',
  );
});

test('tracking baseline accepts Gmail or any receipt-backed provider export', () => {
  assert.deepEqual(
    resolveTrackingBaseline({
      gmailBaselineCompletedAt: null,
      uberEatsExportCount: 10,
      doorDashExportCount: 5,
    }),
    { eligible: true, source: 'exports' },
  );
  assert.deepEqual(
    resolveTrackingBaseline({
      gmailBaselineCompletedAt: null,
      uberEatsExportCount: 10,
      doorDashExportCount: 0,
    }),
    { eligible: true, source: 'exports' },
  );
  assert.deepEqual(
    resolveTrackingBaseline({
      gmailBaselineCompletedAt: null,
      uberEatsExportCount: 0,
      doorDashExportCount: 0,
    }),
    { eligible: false, source: 'none' },
  );
  assert.deepEqual(
    resolveTrackingBaseline({
      gmailBaselineCompletedAt: '2026-08-01T00:00:00.000Z',
      uberEatsExportCount: 0,
      doorDashExportCount: 0,
    }),
    { eligible: true, source: 'gmail' },
  );
});

test('incremental Gmail search starts from the earliest provider cutoff with a lookback', () => {
  const initial = resolveIncrementalGmailSearchAfter({
    lastSuccessfulCheckAt: null,
    gmailBaselineCompletedAt: null,
    csvCutoffs: {
      uber_eats: new Date('2026-08-20T00:00:00.000Z'),
      doordash: new Date('2026-08-18T00:00:00.000Z'),
    },
  });
  assert.equal(initial.toISOString(), '2026-08-16T00:00:00.000Z');

  const subsequent = resolveIncrementalGmailSearchAfter({
    lastSuccessfulCheckAt: '2026-08-24T12:00:00.000Z',
    gmailBaselineCompletedAt: null,
    csvCutoffs: { uber_eats: new Date('2026-08-20T00:00:00.000Z') },
  });
  assert.equal(subsequent.toISOString(), '2026-08-22T12:00:00.000Z');
});

test('scheduled tracking eligibility accepts Gmail or either receipt-backed provider export', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [] };
    },
  };
  await new ImportPreferencesQueryRepository(postgres).getEligibleTrackingUserIds(25);
  const eligibilityQuery = queries[0];
  assert.match(eligibilityQuery.sql, /gmail_baseline_completed_at IS NOT NULL/);
  assert.match(eligibilityQuery.sql, /receipt_type = 'uber_eats'/);
  assert.match(eligibilityQuery.sql, /receipt_type = 'doordash'/);
  assert.deepEqual(eligibilityQuery.params, [25]);
});

test('onboarding reset clears the Gmail import lifecycle explicitly', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const postgres = transactional(client, client.query);

  await new GmailSyncRunRepository(postgres, noOpImportEvents).resetGmailImportStatus('user-id');

  const resetQuery = queries.find(({ sql }) =>
    sql.includes("gmail_import_status = 'never_started'"),
  );
  assert.ok(resetQuery);
  assert.match(resetQuery.sql, /gmail_import_updated_at = NOW\(\)/);
  assert.match(resetQuery.sql, /gmail_imported_count = 0/);
  assert.match(resetQuery.sql, /gmail_import_error_code = NULL/);
  assert.deepEqual(resetQuery.params, ['user-id']);
});

test('manual and background Gmail runs update separate lifecycle fields', async () => {
  const queries = [];
  const query = async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO gmail_sync_runs'))
      return { rows: [{ id: 'run-id' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const client = { query, release: () => {} };
  const postgres = transactional(client, query);
  const repository = new GmailSyncRunRepository(postgres, noOpImportEvents);

  await repository.startSyncRun('user-id', 'manual');
  const manualUpdate = queries.find(({ sql }) => sql.includes("gmail_import_status = 'importing'"));
  assert.ok(manualUpdate);

  queries.length = 0;
  await repository.startSyncRun('user-id', 'background');
  const backgroundUpdate = queries.find(({ sql }) => sql.includes('last_check_attempt_at = NOW()'));
  assert.ok(backgroundUpdate);
  assert.doesNotMatch(backgroundUpdate.sql, /gmail_import_status/);

  queries.length = 0;
  await repository.completeSyncRun(
    'run-id',
    'user-id',
    'success',
    {
      emailsScanned: 0,
      receiptsProcessed: 0,
      newOrders: 0,
      updatedOrders: 0,
      unchangedOrders: 0,
    },
    'background',
  );
  const completionUpdate = queries.find(({ sql }) =>
    sql.includes('last_successful_check_at = NOW()'),
  );
  assert.ok(completionUpdate);
  assert.match(completionUpdate.sql, /tracking_status = CASE/);
  assert.match(completionUpdate.sql, /THEN 'active'/);
  assert.doesNotMatch(completionUpdate.sql, /gmail_import_status/);

  queries.length = 0;
  await repository.failSyncRun('run-id', 'user-id', 'GMAIL_SYNC_FAILED', 'background');
  const failureUpdate = queries.find(({ sql }) => sql.includes('last_tracking_error_at = NOW()'));
  assert.ok(failureUpdate);
  assert.match(failureUpdate.sql, /THEN 'error'/);
  assert.doesNotMatch(failureUpdate.sql, /gmail_import_status/);
});

test('first ongoing consent enters setup instead of claiming tracking is active', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT user_id')) return { rows: [{ user_id: 'user-id' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  await new ImportLifecycleRepository(postgres, noOpImportEvents).setOngoingTrackingConsent(
    'user-id',
    'granted',
    'consent-v2',
  );
  const consentUpdate = queries.find(({ sql }) =>
    sql.includes('ongoing_tracking_consent_state = $2'),
  );
  assert.ok(consentUpdate);
  assert.match(consentUpdate.sql, /last_successful_check_at IS NULL THEN 'setting_up'/);
  assert.deepEqual(consentUpdate.params, ['user-id', 'granted', 'consent-v2']);
});

test('clearing receipts prevents a granted tracking consent from remaining active', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: sql.includes('DELETE FROM receipts') ? 4 : 1 };
    },
    release: () => {},
  };
  const postgres = transactional(client);
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => {},
    releaseLock: async () => true,
  };
  const cache = { invalidateAllUserCaches: async () => {} };
  await new ReceiptClearService(postgres, cache, lock).clearReceipts('user-id');
  const preferenceUpdate = queries.find(({ sql }) =>
    sql.includes("gmail_import_status = 'never_started'"),
  );
  assert.ok(preferenceUpdate);
  assert.match(preferenceUpdate.sql, /tracking_status = 'inactive'/);
});

test('provider export failures update only the selected lifecycle and preserve receipt rows', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };

  await new ImportLifecycleRepository(postgres, noOpImportEvents).setExportStatus(
    'user-id',
    'doordash',
    'failed',
    'EXPORT_IMPORT_FAILED',
  );

  const statusUpdate = queries.find(({ sql }) =>
    sql.includes('user_export_provider_preferences provider_preferences'),
  );
  assert.ok(statusUpdate);
  assert.match(statusUpdate.sql, /SET status = \$3::VARCHAR\(32\)/);
  assert.match(statusUpdate.sql, /WHERE user_id = \$1 AND provider = \$2::VARCHAR\(24\)/);
  assert.equal(
    queries.some(({ sql }) => /DELETE FROM receipts/i.test(sql)),
    false,
  );
  assert.deepEqual(statusUpdate.params, [
    'user-id',
    'doordash',
    'failed',
    'EXPORT_IMPORT_FAILED',
    null,
  ]);
});

test('database event constraint permits the Gmail import reset audit event', async () => {
  const replaceEventConstraint = importLifecycleMigration.statements.find((sql) =>
    sql.includes('ADD CONSTRAINT user_import_preference_events_event_name_check'),
  );
  assert.match(replaceEventConstraint, /'gmail_import_reset'/);
});

test('onboarding account reset waits for imports and restores fresh import state atomically', async () => {
  const queries = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('UPDATE users SET')) return { rowCount: 1, rows: [] };
      if (sql.includes('DELETE FROM receipts')) return { rowCount: 257, rows: [] };
      return { rowCount: 1, rows: [] };
    },
    release: () => {},
  };
  const postgres = transactional(client);
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async (userId, timeoutMs) => {
      assert.equal(userId, 'user-id');
      assert.equal(timeoutMs, 300000);
      return lockHandle;
    },
    assertLockOwned: async () => {},
    releaseLock: async () => {
      released = true;
    },
  };
  const cache = { invalidateAllUserCaches: async () => {} };
  const connectionHealth = { invalidate: () => {} };

  const result = await new AccountResetService(
    postgres,
    cache,
    connectionHealth,
    lock,
  ).resetForOnboarding('user-id');

  assert.deepEqual(result, { deletedReceipts: 257 });
  assert.equal(queries[0].sql, 'BEGIN');
  assert.match(queries[1].sql, /gmail_refresh_token = NULL/);
  assert.match(queries[1].sql, /gmail_connected = FALSE/);
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM receipts')));
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM gmail_sync_runs')));
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM user_import_preference_events')));
  assert.ok(
    queries.some(({ sql }) => sql.includes('DELETE FROM user_export_provider_preferences')),
  );
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM user_import_preferences')));
  assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO user_import_preferences')));
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(released, true);
});

test('dashboard insights use local time and keep email-only cards free of export details', () => {
  const receipts = [
    new Receipt(
      'user-id',
      [],
      12,
      ReceiptType.UBER_EATS,
      'Night Kitchen',
      new Date('2026-08-08T03:30:00.000Z'),
      DataSource.EMAIL,
    ),
    new Receipt(
      'user-id',
      [],
      18,
      ReceiptType.UBER_EATS,
      'Night Kitchen',
      new Date('2026-08-15T03:45:00.000Z'),
      DataSource.EMAIL,
    ),
    new Receipt(
      'user-id',
      [],
      24,
      ReceiptType.UBER_EATS,
      'Other Place',
      new Date('2026-08-22T03:15:00.000Z'),
      DataSource.EMAIL,
    ),
  ];

  const insights = buildDashboardInsights(
    receipts,
    'America/Toronto',
    'user-id',
    new Date('2026-08-11T12:00:00.000Z'),
  );
  assert.ok(
    insights.some((insight) => insight.id === 'favorite-day' && insight.headline === 'Friday'),
  );
  assert.ok(
    insights.some((insight) => insight.id === 'peak-hunger-hour' && insight.headline === '11 PM'),
  );
  assert.equal(insights.filter((insight) => insight.presentation === 'locked').length, 1);
  assert.equal(
    insights.some(
      (insight) => insight.id === 'most-ordered-meal' || insight.id === 'detailed-biggest-order',
    ),
    false,
  );
  assert.notEqual(insights[0]?.presentation, 'locked');

  const lockedCounts = [];
  for (let day = 0; day < 12; day++) {
    const cards = buildDashboardInsights(
      receipts,
      'America/Toronto',
      'user-id',
      new Date(Date.UTC(2026, 7, 11 + day)),
    );
    lockedCounts.push(cards.filter((card) => card.presentation === 'locked').length);
    assert.notEqual(cards[0]?.presentation, 'locked');
  }
  assert.ok(
    lockedCounts.every((count) => count === 1),
    'every Gmail-only daily edition reserves one locked preview',
  );
});

test('dashboard insights unlock item and delivery cards only when export receipts support them', () => {
  const receipts = [
    new Receipt(
      'user-id',
      [{ name: 'Spicy Bowl', quantity: 1, price: 14 }],
      22,
      ReceiptType.UBER_EATS,
      'Test Kitchen',
      new Date('2026-08-01T22:00:00.000Z'),
      DataSource.CSV,
      new Date('2026-08-01T22:35:00.000Z'),
    ),
    new Receipt(
      'user-id',
      [{ name: 'Spicy Bowl', quantity: 2, price: 14 }],
      42,
      ReceiptType.UBER_EATS,
      'Test Kitchen',
      new Date('2026-08-02T22:00:00.000Z'),
      DataSource.CSV,
      new Date('2026-08-02T23:05:00.000Z'),
    ),
    new Receipt(
      'user-id',
      [{ name: 'Fries', quantity: 1, price: 6 }],
      16,
      ReceiptType.UBER_EATS,
      'Other Place',
      new Date('2026-08-03T22:00:00.000Z'),
      DataSource.CSV,
      new Date('2026-08-03T22:25:00.000Z'),
    ),
  ];

  const first = buildDashboardInsights(
    receipts,
    'America/Toronto',
    'user-id',
    new Date('2026-08-11T12:00:00.000Z'),
  );
  const second = buildDashboardInsights(
    receipts,
    'America/Toronto',
    'user-id',
    new Date('2026-08-11T20:00:00.000Z'),
  );
  assert.deepEqual(second, first, 'the carousel should remain stable during the same local day');
  assert.equal(
    first.some((insight) => insight.presentation === 'locked'),
    false,
  );
  assert.equal(first.length <= 7, true);

  for (let day = 0; day < 30; day++) {
    const cards = buildDashboardInsights(
      receipts,
      'America/Toronto',
      'user-id',
      new Date(Date.UTC(2026, 7, 11 + day)),
    );
    assert.equal(
      cards.some((card) => card.presentation === 'locked'),
      false,
    );
    assert.equal(cards.length <= 7, true);
  }
  const catalogue = new Map(
    buildDashboardInsightCatalogue(
      receipts,
      'America/Toronto',
      new Date('2026-08-11T12:00:00.000Z'),
    ).eligible.map((candidate) => [candidate.insight.id, candidate.insight]),
  );
  assert.equal(catalogue.get('most-ordered-meal').headline, 'Spicy Bowl');
  assert.ok(catalogue.get('detailed-biggest-order').order.items.length > 0);
  assert.equal(
    catalogue.get('longest-delivery').value,
    65,
    'the record remains eligible even when a related delivery card wins selection',
  );
});

test('email extraction prefers the Uber order header and infers Canadian dollars', () => {
  const html = `
    <div>Uber Receipts Thu, Jul 23, 2026 at 8:50 PM</div>
    <div>Jul 23, 2026</div><div>6:50 p.m.</div>
    <div>Thanks for tipping</div>
    <div>Here's your receipt for Test Kitchen.</div>
    <div>Total $63.56</div><div>Uber Portier Canada Inc.</div>
  `;
  const result = new ReceiptExtractor().extract({
    body: html,
    subject: 'Your Thursday evening order with Uber Eats',
    from: 'Uber Receipts <noreply@uber.com>',
  });

  assert.equal(result.data.orderDate, 'Jul 23, 2026');
  assert.equal(result.data.orderTime, '6:50 p.m.');
  assert.equal(result.data.currency, 'CAD');
  assert.equal(result.data.total, 63.56);
});

test('Uber local timestamps and line-item quantity prices are parsed consistently', async () => {
  const csv = Buffer.from(
    [
      'City_Name,Restaurant_Name,Request_Time_Local,Final_Delivery_Time_Local,Order_Status,Item_Name,Item_quantity,Customizations,Customization_Cost_Local,Special_Instructions,Item_Price,Order_Price,Currency',
      'Toronto,Test Kitchen,2025-09-16T18:30:13.000Z,2025-09-16T19:08:24.000Z,completed,Burger,2,"Creamy Garlic, Blackened Ranch",,,33.98,31.19,CAD',
      'Toronto,Test Kitchen,2025-09-16T18:30:13.000Z,2025-09-16T19:08:24.000Z,completed,Fries,1,,,,6.99,31.19,CAD',
    ].join('\n'),
  );
  const service = new CsvImportService();
  const result = await service.parseUberEatsCsv(csv, 'user-id', 'America/Toronto');

  assert.equal(result.totalReceipts, 1);
  assert.equal(result.totalAmount, 31.19);
  assert.equal(result.receipts[0].orderDate.toISOString(), '2025-09-16T22:30:13.000Z');
  assert.equal(result.receipts[0].items[0].price, 16.99);
  assert.deepEqual(result.receipts[0].items[0].customizations, [
    'Blackened Ranch',
    'Creamy Garlic',
  ]);
  assert.equal(
    Math.round((result.receipts[0].deliveryTime - result.receipts[0].orderDate) / 60000),
    38,
  );
});

test('wrapped metrics use the local weekday and only count real single-item data', async () => {
  const rows = [
    {
      id: '1',
      userId: 'user-id',
      restaurantName: 'Coffee Shop',
      orderDate: new Date('2023-12-10T05:30:00.000Z'),
      amountSpent: '12.00',
      items: [{ name: 'Latte', quantity: 2, price: 5 }],
      receiptType: 'uber_eats',
      dataSource: 'csv',
      deliveryTime: null,
    },
    {
      id: '2',
      userId: 'user-id',
      restaurantName: 'Email Only',
      orderDate: new Date('2023-12-10T12:00:00.000Z'),
      amountSpent: '10.00',
      items: [],
      receiptType: 'uber_eats',
      dataSource: 'email',
      deliveryTime: null,
    },
    {
      id: '3',
      userId: 'user-id',
      restaurantName: 'Pizza Pizza',
      orderDate: new Date('2023-12-10T23:00:00.000Z'),
      amountSpent: '9.00',
      items: [{ name: 'Small', quantity: 1, price: 9 }],
      receiptType: 'uber_eats',
      dataSource: 'csv',
      deliveryTime: null,
    },
    {
      id: '4',
      userId: 'user-id',
      restaurantName: 'Breakfast Shop',
      orderDate: new Date('2023-12-11T12:00:00.000Z'),
      amountSpent: '11.00',
      items: [{
        name: 'Breakfast Special',
        quantity: 1,
        price: 11,
        evidence: {
          rawName: 'Breakfast Special',
          configuredName: 'Breakfast Special',
          baseLineTotal: 11,
          configuredLineTotal: 11,
          modifierTotal: 0,
          method: 'complementary_modifiers',
          sourceRows: [1, 2],
          alternatives: [],
          components: [{ name: 'Hash Brown', quantity: 1, role: 'side' }],
        },
      }],
      receiptType: 'uber_eats',
      dataSource: 'csv',
      deliveryTime: null,
    },
    {
      id: '5',
      userId: 'user-id',
      restaurantName: "McDonald's",
      orderDate: new Date('2023-12-12T12:00:00.000Z'),
      amountSpent: '15.00',
      items: [{ name: 'Quarter Pounder Extra Value Meal', quantity: 1, price: 15 }],
      receiptType: 'uber_eats',
      dataSource: 'csv',
      deliveryTime: null,
    },
  ];
  const queries = {
    getUserTimezone: async () => 'America/Toronto',
    getUserReceipts: async () =>
      rows.map((row) => ({
        ...row,
        amountSpent: Number(row.amountSpent),
      })),
    getPercentileRanks: async () => null,
  };
  const analytics = await new WrappedAnalyticsService(queries).calculateWrappedAnalytics('user-id');

  assert.equal(analytics.shame.laziestDay.date, '2023-12-10');
  assert.equal(analytics.shame.laziestDay.dayOfWeek, 'Sunday');
  assert.equal(analytics.shame.singleItemOrders.count, 1);
  assert.equal(analytics.shame.singleItemOrders.totalSpent, 9);
  assert.equal(analytics.shame.singleItemOrders.mostCommon, 'Small pizza (1 times)');
  assert.equal(analytics.flex.coffeeAddiction.totalSpent, 10);
  assert.equal(analytics.flex.coffeeAddiction.averagePrice, 5);
  assert.equal(analytics.comparative.couldHaveBought, undefined);
  assert.equal(analytics.comparative.costPerMeal, undefined);
});

test('incremental Gmail upsert distinguishes new, updated, and unchanged orders', async () => {
  const postgres = require('./helpers/receiptDatabase').database();
  const unchanged = new Receipt(
    'user-id',
    [],
    10,
    ReceiptType.UBER_EATS,
    'Test Kitchen',
    new Date('2026-08-01T22:00:00.000Z'),
    DataSource.EMAIL,
    undefined,
    'order-1',
  );
  const fresh = new Receipt(
    'user-id',
    [],
    15,
    ReceiptType.UBER_EATS,
    'New Place',
    new Date('2026-08-02T22:00:00.000Z'),
    DataSource.EMAIL,
    undefined,
    'order-2',
  );
  const repository = new ReceiptRepository(postgres);
  await repository.upsertEmailReceipts([unchanged],async()=>{});
  const result = await repository.upsertEmailReceipts(
    [unchanged, fresh],
    async () => {},
  );
  assert.deepEqual(result, { newOrders: 1, updatedOrders: 0, unchangedOrders: 1, unresolvedOrders:0 });
  assert.equal(postgres.state.observations.length,2);
});

test('orders-added-this-week uses a user-local PostgreSQL week boundary', async () => {
  let captured;
  const postgres = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ count: 2 }] };
    },
  };
  const count = await new ImportPreferencesQueryRepository(postgres).getOrdersAddedThisWeek(
    'user-id',
    'America/Toronto',
  );
  assert.equal(count, 2);
  assert.match(captured.sql, /DATE_TRUNC\('week', NOW\(\) AT TIME ZONE \$2\)/);
  assert.match(captured.sql, /order_date IS NOT NULL/);
  assert.match(captured.sql, /order_date AT TIME ZONE z.name\)::date >=/);
  assert.match(captured.sql, /order_date AT TIME ZONE z.name\)::date </);
  assert.match(captured.sql, /unlinked_adjustment/);
  assert.doesNotMatch(captured.sql, /first_seen_at/);
  assert.deepEqual(captured.params, ['user-id', 'America/Toronto']);
});

test('shared investment math compounds each order from its own timestamp at the disclosed fixed rate', () => {
  assert.equal(HYPOTHETICAL_ANNUAL_RETURN_PERCENT, 7);
  const asOf = new Date('2026-01-01T00:00:00.000Z');
  const result = calculateHypotheticalInvestment(
    [
      { amount: 100, occurredAt: new Date('2025-01-01T00:00:00.000Z') },
      { amount: 100, occurredAt: new Date('2025-07-01T00:00:00.000Z') },
      { amount: 100, occurredAt: new Date('2027-01-01T00:00:00.000Z') },
    ],
    asOf,
  );
  assert.equal(result.contributed, 300);
  assert.ok(result.futureValue > 310 && result.futureValue < 311, `received ${result.futureValue}`);
  assert.equal(result.gains, result.futureValue - result.contributed);
});

test('export enrichment preserves existing receipt evidence', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if(sql.startsWith('SELECT timezone'))return {rows:[{timezone:'America/Toronto'}]};
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const postgres = transactional(client);
  const receipt = new Receipt(
    'user-id',
    [],
    20,
    ReceiptType.UBER_EATS,
    'Export Place',
    new Date('2026-08-01T22:00:00.000Z'),
    DataSource.CSV,
  );

  await new ReceiptRepository(postgres).replaceProviderExport('user-id', [receipt], async () => {});

  const pruned = queries.find(query => query.sql.includes('DELETE FROM receipts'));
  assert.match(pruned.sql,/NOT \(id=ANY/);
  assert.equal(pruned.params[1].length,1,'retain the canonical order when pruning old projections');
  const insert = queries.find(query => query.sql.includes('INSERT INTO receipts('));
  assert.equal(insert.params[1], 'user-id');
  assert.equal(insert.params[2], ReceiptType.UBER_EATS);
  assert.ok(queries.some(query => query.sql.includes('INSERT INTO receipt_observations')));
  assert.equal(queries[0].sql, 'BEGIN');
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('export cutoffs retain overlap for field-level enrichment', () => {
  const uberBeforeDoorDashCutoff = new Receipt(
    'user-id',
    [],
    20,
    ReceiptType.UBER_EATS,
    'Uber Place',
    new Date('2026-06-01T12:00:00.000Z'),
    DataSource.EMAIL,
  );
  const doorDashCoveredByExport = new Receipt(
    'user-id',
    [],
    25,
    ReceiptType.DOORDASH,
    'DoorDash Place',
    new Date('2026-06-01T12:00:00.000Z'),
    DataSource.EMAIL,
  );
  const doorDashNewerThanExport = new Receipt(
    'user-id',
    [],
    30,
    ReceiptType.DOORDASH,
    'New DoorDash Place',
    new Date('2026-08-02T12:00:00.000Z'),
    DataSource.EMAIL,
  );

  const filtered = filterReceiptsAfterExportCutoffs(
    [uberBeforeDoorDashCutoff, doorDashCoveredByExport, doorDashNewerThanExport],
    { [ReceiptType.DOORDASH]: new Date('2026-08-01T12:00:00.000Z') },
  );

  assert.deepEqual(filtered, [uberBeforeDoorDashCutoff, doorDashCoveredByExport, doorDashNewerThanExport]);
});

test('Google invalid_grant errors require Gmail reconnection', () => {
  assert.equal(isGmailReconnectError(new Error('invalid_grant')), true);
  assert.equal(isGmailReconnectError({ response: { data: { error: 'invalid_grant' } } }), true);
  assert.equal(isGmailReconnectError(new Error('socket timeout')), false);
});

test('Gmail health validation is cached but import preflight can force a fresh check', async () => {
  let validations = 0;
  const gmail = {
    validateConnection: async () => {
      validations += 1;
    },
  };
  const users = { markGmailReconnectRequired: async () => {} };
  const preferences = { markTrackingReconnectRequired: async () => {} };
  const health = new GmailConnectionHealthService(gmail, users, preferences);
  const user = {
    id: 'user-id',
    email: 'user@example.com',
    gmailConnected: true,
    gmailRefreshToken: 'refresh-token',
    gmailConnectionMode: 'offline',
  };

  assert.equal((await health.validate(user)).status, 'valid');
  assert.equal((await health.validate(user)).status, 'valid');
  assert.equal(validations, 1);
  assert.equal((await health.validate(user, true)).status, 'valid');
  assert.equal(validations, 2);
});

test('proactive Gmail validation marks rejected grants for reconnection', async () => {
  let markedReconnect = false;
  const gmail = {
    validateConnection: async () => {
      throw new Error('invalid_grant');
    },
  };
  const users = {
    markGmailReconnectRequired: async () => {
      markedReconnect = true;
    },
  };
  const preferences = { markTrackingReconnectRequired: async () => {} };
  const health = new GmailConnectionHealthService(gmail, users, preferences);
  const result = await health.validate({
    id: 'user-id',
    email: 'user@example.com',
    gmailConnected: true,
    gmailRefreshToken: 'rejected-token',
    gmailConnectionMode: 'offline',
  });

  assert.equal(result.status, 'reconnect_required');
  assert.equal(markedReconnect, true);
});
