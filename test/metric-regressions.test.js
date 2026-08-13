const test = require('node:test');
const assert = require('node:assert/strict');

const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { WrappedAnalyticsService } = require('../dist/services/analytics/WrappedAnalyticsService');
const { ReceiptService } = require('../dist/services/receipt/ReceiptService');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
const { ImportPreferencesRepository } = require('../dist/services/data/ImportPreferencesRepository');
const { PostgresService } = require('../dist/services/data/PostgresService');
const { AccountResetService } = require('../dist/services/data/AccountResetService');
const { isGmailReconnectError } = require('../dist/services/import/GmailImportService');
const { GmailConnectionHealthService } = require('../dist/services/email/GmailConnectionHealthService');
const { buildDashboardInsights } = require('../dist/services/analytics/DashboardInsightService');
const {
  getLocalDateKey,
  parseReceiptLocalDateTime,
} = require('../dist/utils/timezone');

test('timezone helpers preserve local calendar dates and receipt wall time', () => {
  assert.equal(
    getLocalDateKey(new Date('2023-12-10T05:30:00.000Z'), 'America/Toronto'),
    '2023-12-10'
  );
  assert.equal(
    parseReceiptLocalDateTime('Jul 23, 2026', '6:50 p.m.', 'America/Toronto').toISOString(),
    '2026-07-23T22:50:00.000Z'
  );
});

test('onboarding reset clears the Gmail import lifecycle explicitly', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };

  await new ImportPreferencesRepository(postgres).resetGmailImportStatus('user-id');

  const resetQuery = queries.find(({ sql }) => sql.includes("gmail_import_status = 'never_started'"));
  assert.ok(resetQuery);
  assert.match(resetQuery.sql, /gmail_import_updated_at = NOW\(\)/);
  assert.match(resetQuery.sql, /gmail_imported_count = 0/);
  assert.match(resetQuery.sql, /gmail_import_error_code = NULL/);
  assert.deepEqual(resetQuery.params, ['user-id']);
});

test('database event constraint permits the Gmail import reset audit event', async () => {
  const queries = [];
  const postgres = Object.create(PostgresService.prototype);
  postgres.query = async (sql) => {
    queries.push(sql);
    return { rows: [], rowCount: 0 };
  };

  await postgres.initializeTables();

  const createEventsTable = queries.find(sql => sql.includes('CREATE TABLE IF NOT EXISTS user_import_preference_events'));
  const replaceEventConstraint = queries.find(sql => sql.includes('DROP CONSTRAINT IF EXISTS user_import_preference_events_event_name_check'));
  assert.match(createEventsTable, /'gmail_import_reset'/);
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
  const postgres = { getClient: async () => client };
  const lock = {
    acquireLockWithWait: async (userId, timeoutMs) => {
      assert.equal(userId, 'user-id');
      assert.equal(timeoutMs, 300000);
      return true;
    },
    releaseLock: async () => { released = true; },
  };

  const result = await new AccountResetService(postgres, lock).resetForOnboarding('user-id');

  assert.deepEqual(result, { deletedReceipts: 257 });
  assert.equal(queries[0].sql, 'BEGIN');
  assert.match(queries[1].sql, /gmail_refresh_token = NULL/);
  assert.match(queries[1].sql, /gmail_connected = FALSE/);
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM receipts')));
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM gmail_sync_runs')));
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM user_import_preference_events')));
  assert.ok(queries.some(({ sql }) => sql.includes('DELETE FROM user_import_preferences')));
  assert.ok(queries.some(({ sql }) => sql.includes('INSERT INTO user_import_preferences')));
  assert.equal(queries.at(-1).sql, 'COMMIT');
  assert.equal(released, true);
});

test('dashboard insights use local time and keep email-only cards free of export details', () => {
  const receipts = [
    new Receipt('user-id', [], 12, ReceiptType.UBER_EATS, 'Night Kitchen', new Date('2026-08-08T03:30:00.000Z'), DataSource.EMAIL),
    new Receipt('user-id', [], 18, ReceiptType.UBER_EATS, 'Night Kitchen', new Date('2026-08-15T03:45:00.000Z'), DataSource.EMAIL),
    new Receipt('user-id', [], 24, ReceiptType.UBER_EATS, 'Other Place', new Date('2026-08-22T03:15:00.000Z'), DataSource.EMAIL),
  ];

  const insights = buildDashboardInsights(receipts, 'America/Toronto', 'user-id', new Date('2026-08-11T12:00:00.000Z'));
  assert.equal(insights[0].id, 'top-restaurants');
  assert.ok(insights.some(insight => insight.id === 'favorite-day' && insight.headline === 'Friday'));
  assert.ok(insights.some(insight => insight.id === 'peak-hunger-hour' && insight.headline === '11 PM'));
  assert.equal(insights.filter(insight => insight.locked).length <= 1, true);
  assert.equal(insights.some(insight => insight.id === 'most-ordered-meal' || insight.id === 'worst-order'), false);
  if (insights.some(insight => insight.locked)) assert.equal(insights.at(-1).locked, true);

  const lockedCounts = [];
  for (let week = 0; week < 12; week++) {
    const cards = buildDashboardInsights(receipts, 'America/Toronto', 'user-id', new Date(Date.UTC(2026, 7, 11 + (week * 7))));
    lockedCounts.push(cards.filter(card => card.locked).length);
    assert.equal(cards[0].locked === true, false);
  }
  assert.ok(lockedCounts.some(count => count === 0), 'locked previews should not appear every week');
  assert.ok(lockedCounts.some(count => count === 1), 'locked previews should appear occasionally');
});

test('dashboard insights unlock item and delivery cards only when export receipts support them', () => {
  const receipts = [
    new Receipt('user-id', [{ name: 'Spicy Bowl', quantity: 1, price: 14 }], 22, ReceiptType.UBER_EATS, 'Test Kitchen', new Date('2026-08-01T22:00:00.000Z'), DataSource.CSV, new Date('2026-08-01T22:35:00.000Z')),
    new Receipt('user-id', [{ name: 'Spicy Bowl', quantity: 2, price: 14 }], 42, ReceiptType.UBER_EATS, 'Test Kitchen', new Date('2026-08-02T22:00:00.000Z'), DataSource.CSV, new Date('2026-08-02T23:05:00.000Z')),
    new Receipt('user-id', [{ name: 'Fries', quantity: 1, price: 6 }], 16, ReceiptType.UBER_EATS, 'Other Place', new Date('2026-08-03T22:00:00.000Z'), DataSource.CSV, new Date('2026-08-03T22:25:00.000Z')),
  ];

  const first = buildDashboardInsights(receipts, 'America/Toronto', 'user-id', new Date('2026-08-11T12:00:00.000Z'));
  const second = buildDashboardInsights(receipts, 'America/Toronto', 'user-id', new Date('2026-08-12T12:00:00.000Z'));
  assert.deepEqual(second, first, 'the carousel should remain stable during the same weekly rotation');
  assert.equal(first.some(insight => insight.locked), false);
  assert.equal(first.length <= 6, true);

  const rotatingIds = new Set();
  for (let week = 0; week < 12; week++) {
    const cards = buildDashboardInsights(receipts, 'America/Toronto', 'user-id', new Date(Date.UTC(2026, 7, 11 + (week * 7))));
    cards.forEach(card => rotatingIds.add(card.id));
    const worstOrder = cards.find(card => card.id === 'worst-order');
    if (worstOrder) assert.ok(worstOrder.items.length > 0);
    const favoriteMeal = cards.find(card => card.id === 'most-ordered-meal');
    if (favoriteMeal) assert.equal(favoriteMeal.headline, 'Spicy Bowl');
    const longestWait = cards.find(card => card.id === 'longest-wait');
    if (longestWait) assert.equal(longestWait.value, 65);
  }
  assert.equal(rotatingIds.has('most-ordered-meal'), true);
  assert.equal(rotatingIds.has('worst-order'), true);
  assert.equal(rotatingIds.has('longest-wait'), true);
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
  const csv = Buffer.from([
    'City_Name,Restaurant_Name,Request_Time_Local,Final_Delivery_Time_Local,Order_Status,Item_Name,Item_quantity,Customizations,Customization_Cost_Local,Special_Instructions,Item_Price,Order_Price,Currency',
    'Toronto,Test Kitchen,2025-09-16T18:30:13.000Z,2025-09-16T19:08:24.000Z,completed,Burger,2,,,,33.98,31.19,CAD',
    'Toronto,Test Kitchen,2025-09-16T18:30:13.000Z,2025-09-16T19:08:24.000Z,completed,Fries,1,,,,6.99,31.19,CAD',
  ].join('\n'));
  const service = new CsvImportService({});
  const result = await service.parseUberEatsCsv(csv, 'user-id', 'America/Toronto');

  assert.equal(result.totalReceipts, 1);
  assert.equal(result.totalAmount, 31.19);
  assert.equal(result.receipts[0].orderDate.toISOString(), '2025-09-16T22:30:13.000Z');
  assert.equal(result.receipts[0].items[0].price, 16.99);
  assert.equal(
    Math.round((result.receipts[0].deliveryTime - result.receipts[0].orderDate) / 60000),
    38
  );
});

test('wrapped metrics use the local weekday and only count real single-item data', async () => {
  const rows = [
    {
      id: '1', userId: 'user-id', restaurantName: 'Coffee Shop',
      orderDate: new Date('2023-12-10T05:30:00.000Z'), amountSpent: '12.00',
      items: [{ name: 'Latte', quantity: 2, price: 5 }],
      receiptType: 'uber_eats', dataSource: 'csv', deliveryTime: null,
    },
    {
      id: '2', userId: 'user-id', restaurantName: 'Email Only',
      orderDate: new Date('2023-12-10T12:00:00.000Z'), amountSpent: '10.00',
      items: [], receiptType: 'uber_eats', dataSource: 'email', deliveryTime: null,
    },
    {
      id: '3', userId: 'user-id', restaurantName: 'Snack Shop',
      orderDate: new Date('2023-12-10T23:00:00.000Z'), amountSpent: '9.00',
      items: [{ name: 'Cookie', quantity: 1, price: 9 }],
      receiptType: 'uber_eats', dataSource: 'csv', deliveryTime: null,
    },
  ];
  const pool = {
    query: async (sql) => {
      if (sql.includes('SELECT timezone')) return { rows: [{ timezone: 'America/Toronto' }] };
      if (sql.includes('WITH per_user')) return { rows: [] };
      return { rows };
    },
  };
  const analytics = await new WrappedAnalyticsService(pool).calculateWrappedAnalytics('user-id');

  assert.equal(analytics.shame.laziestDay.date, '2023-12-10');
  assert.equal(analytics.shame.laziestDay.dayOfWeek, 'Sunday');
  assert.equal(analytics.shame.singleItemOrders.count, 1);
  assert.equal(analytics.flex.coffeeAddiction.totalSpent, 10);
  assert.equal(analytics.flex.coffeeAddiction.averagePrice, 5);
  assert.equal(analytics.comparative.couldHaveBought, undefined);
  assert.equal(analytics.comparative.costPerMeal, undefined);
});

test('incremental Gmail upsert distinguishes new, updated, and unchanged orders', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (sql.includes('SELECT source_identity')) {
        return {
          rows: [{
            source_identity: 'external:order-1', amount_spent: '10.00',
            restaurant_name: 'Test Kitchen', order_date: new Date('2026-08-01T22:00:00.000Z'),
            receipt_type: 'uber_eats', items: [],
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const unchanged = new Receipt(
    'user-id', [], 10, ReceiptType.UBER_EATS, 'Test Kitchen',
    new Date('2026-08-01T22:00:00.000Z'), DataSource.EMAIL, undefined, 'order-1'
  );
  const fresh = new Receipt(
    'user-id', [], 15, ReceiptType.UBER_EATS, 'New Place',
    new Date('2026-08-02T22:00:00.000Z'), DataSource.EMAIL, undefined, 'order-2'
  );
  const result = await new ReceiptService(postgres).upsertEmailReceipts([unchanged, fresh]);
  assert.deepEqual(result, { newOrders: 1, updatedOrders: 0, unchangedOrders: 1 });
  assert.ok(queries.some(query => query.sql.includes('ON CONFLICT (user_id, data_source, source_identity)')));
});

test('orders-added-this-week uses a user-local PostgreSQL week boundary', async () => {
  let captured;
  const postgres = {
    query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ count: 2 }] };
    },
  };
  const count = await new ImportPreferencesRepository(postgres)
    .getOrdersAddedThisWeek('user-id', 'America/Toronto');
  assert.equal(count, 2);
  assert.match(captured.sql, /DATE_TRUNC\('week', NOW\(\) AT TIME ZONE \$2\)/);
  assert.deepEqual(captured.params, ['user-id', 'America/Toronto']);
});

test('export replacement preserves Gmail orders newer than the export cutoff', async () => {
  const queries = [];
  const client = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const postgres = { getClient: async () => client };
  const receipt = new Receipt(
    'user-id', [], 20, ReceiptType.UBER_EATS, 'Export Place',
    new Date('2026-08-01T22:00:00.000Z'), DataSource.CSV
  );

  await new CsvImportService(postgres).importReceipts([receipt], 'user-id');

  const replacement = queries.find(query => query.sql.includes('DELETE FROM receipts'));
  assert.match(replacement.sql, /data_source = 'csv'/);
  assert.match(replacement.sql, /data_source = 'email' AND order_date <= \$2/);
  assert.equal(replacement.params[1].toISOString(), '2026-08-01T22:00:00.000Z');
  assert.equal(queries[0].sql, 'BEGIN');
  assert.equal(queries.at(-1).sql, 'COMMIT');
});

test('Google invalid_grant errors require Gmail reconnection', () => {
  assert.equal(isGmailReconnectError(new Error('invalid_grant')), true);
  assert.equal(isGmailReconnectError({ response: { data: { error: 'invalid_grant' } } }), true);
  assert.equal(isGmailReconnectError(new Error('socket timeout')), false);
});

test('Gmail health validation is cached but import preflight can force a fresh check', async () => {
  const postgres = { query: async () => ({ rows: [], rowCount: 1 }) };
  const health = new GmailConnectionHealthService(postgres);
  let validations = 0;
  health.gmail.validateConnection = async () => { validations += 1; };
  const user = {
    id: 'user-id', email: 'user@example.com', gmailConnected: true,
    gmailRefreshToken: 'refresh-token', gmailConnectionMode: 'offline',
  };

  assert.equal((await health.validate(user)).status, 'valid');
  assert.equal((await health.validate(user)).status, 'valid');
  assert.equal(validations, 1);
  assert.equal((await health.validate(user, true)).status, 'valid');
  assert.equal(validations, 2);
});

test('proactive Gmail validation marks rejected grants for reconnection', async () => {
  const queries = [];
  const postgres = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };
  const health = new GmailConnectionHealthService(postgres);
  health.gmail.validateConnection = async () => { throw new Error('invalid_grant'); };
  const result = await health.validate({
    id: 'user-id', email: 'user@example.com', gmailConnected: true,
    gmailRefreshToken: 'rejected-token', gmailConnectionMode: 'offline',
  });

  assert.equal(result.status, 'reconnect_required');
  assert.ok(queries.some(query => query.sql.includes('gmail_refresh_token = NULL')));
});
