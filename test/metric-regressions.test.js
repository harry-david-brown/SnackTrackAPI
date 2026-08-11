const test = require('node:test');
const assert = require('node:assert/strict');

const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { WrappedAnalyticsService } = require('../dist/services/analytics/WrappedAnalyticsService');
const { ReceiptService } = require('../dist/services/receipt/ReceiptService');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
const { ImportPreferencesRepository } = require('../dist/services/data/ImportPreferencesRepository');
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
