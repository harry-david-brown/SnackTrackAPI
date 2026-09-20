const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const {
  matchesReceiptOutcome,
  RECEIPT_OUTCOME_FILTERS,
} = require('../dist/services/receipt/ReceiptHistoryFilters');
const {
  orderMetricEligibility,
  summarizeOrderMetrics,
} = require('../dist/services/analytics/shared/orderMetrics');
const { getLocalDateKey } = require('../dist/utils/timezone');
const { mapReceiptPageResponse } = require('../dist/http/mappers/receiptResponse');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'PostgreSQL History filters match canonical outcomes, local days, net costs and scoped pagination',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_history_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const userId = randomUUID(),
      otherId = randomUUID();
    const repo = new ReceiptRepository({ query: (...args) => pool.query(...args) }, 3);
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      for (const id of [userId, otherId])
        await pool.query(
          "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
          [id, `${id}@example.invalid`],
        );
      const receipts = (await decemberCanonicalOrders()).map((r) => ({
        ...r,
        userId,
        id: randomUUID(),
      }));
      const base = receipts[4];
      const add = (name, outcome = {}, extra = {}) => {
        const receipt = {
          ...structuredClone(base),
          id: randomUUID(),
          restaurantName: name,
          ...extra,
        };
        receipt.resolution.orderOutcome = { ...receipt.resolution.orderOutcome, ...outcome };
        receipts.push(receipt);
        return receipt;
      };
      add(
        'Amount-less refund',
        {
          netAmount: null,
          originalCharge: 40,
          confirmedRefundAmount: null,
          refundStatus: 'confirmed_unclassified',
          refundConfidence: 'confirmed',
          financialConfidence: 'unknown',
        },
        { amountSpent: 0 },
      );
      add(
        'Possible refund',
        {
          netAmount: 0,
          refundStatus: 'probable_full',
          refundConfidence: 'inferred',
          financialConfidence: 'inferred',
        },
        { amountSpent: 0 },
      );
      add(
        'Unexplained zero',
        { netAmount: 0, refundStatus: 'zero_unexplained', financialConfidence: 'inferred' },
        { amountSpent: 0 },
      );
      add('Orphan adjustment', {
        kind: 'unlinked_adjustment',
        netAmount: null,
        refundStatus: 'confirmed_unclassified',
        refundConfidence: 'confirmed',
      });
      const possible = add('Possible additional', {}, { dataSource: 'email' });
      possible.resolution.reconciliation.status = 'unresolved';
      const disputedExport = add('Disputed export document', {}, { dataSource: 'csv' });
      disputedExport.resolution.reconciliation.status = 'unresolved';
      disputedExport.resolution.reconciliation.reason = 'identity_conflict';
      add('Failed', { fulfillment: 'failed', netAmount: 17.37, financialConfidence: 'inferred' });
      add('Unfulfilled', {
        fulfillment: 'unfulfilled',
        netAmount: 0,
        financialConfidence: 'inferred',
      });
      add('Conflict', { financialConfidence: 'conflicted', netAmount: 999 }, { amountSpent: 999 });
      const legacy = add('Legacy value', {}, { amountSpent: 12.5 });
      delete legacy.resolution;
      const subtotal = add('Legacy subtotal', {}, { amountSpent: 80 });
      delete subtotal.resolution.orderOutcome;
      subtotal.resolution.amountBasis = 'item_subtotal';
      const traveler = add('Travel', {}, { orderDate: new Date('2023-12-09T16:30:00Z') });
      traveler.resolution.timestamp.timezone = 'Asia/Tokyo';
      add('Late evening', {}, { orderDate: new Date('2023-12-11T04:59:00Z') });
      add('Next midnight', {}, { orderDate: new Date('2023-12-11T05:00:00Z') });
      const fallback = add('Account timezone', {}, { orderDate: new Date('2023-12-11T03:00:00Z') });
      delete fallback.resolution.timestamp;
      const invalidZone = add('Unknown timezone');
      invalidZone.resolution.timestamp.timezone = 'invalid-zone';
      for (const clock of [
        '2024-03-10T05:01:00Z',
        '2024-03-11T03:59:00Z',
        '2023-11-05T05:30:00Z',
        '2023-11-05T06:30:00Z',
      ])
        add(`DST ${clock}`, {}, { orderDate: new Date(clock) });
      add('Dollar price', { netAmount: 61.39 }, { monetaryDetails: { currencyCode: 'USD' } });
      add('Unknown currency', {}, { monetaryDetails: { currencyCode: 'UNKNOWN' } });
      const literal = add('Pizza 100%_\\Kitchen');
      const insert = async (r, owner = userId) =>
        pool.query(
          `INSERT INTO receipts(id,user_id,restaurant_name,items,amount_spent,order_date,receipt_type,data_source,currency_code,resolution)
       VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            r.id,
            owner,
            r.restaurantName,
            JSON.stringify(r.items),
            r.amountSpent,
            r.orderDate,
            r.receiptType,
            r.dataSource,
            r.monetaryDetails?.currencyCode,
            JSON.stringify(r.resolution ?? null),
          ],
        );
      for (const r of receipts) await insert(r);
      await insert({ ...base, id: randomUUID() }, otherId);
      const all = await repo.findPage({ userId }, 1000, 0);
      assert.equal(all.total, receipts.length);
      assert.equal(
        all.receipts.every((r) => r.userId === userId),
        true,
      );
      const byId = (values) => values.map((r) => r.id).sort();
      for (const outcome of RECEIPT_OUTCOME_FILTERS) {
        const page = await repo.findPage({ userId, outcome }, 1000, 0);
        const expected = receipts.filter((r) => matchesReceiptOutcome(r, outcome));
        assert.equal(page.total, expected.length, outcome);
        assert.deepEqual(byId(page.receipts), byId(expected), outcome);
      }
      const summary = summarizeOrderMetrics(receipts);
      assert.equal(
        (await repo.findPage({ userId, outcome: 'delivered' }, 1000, 0)).total,
        summary.deliveries,
      );
      assert.equal(
        (await repo.findPage({ userId, outcome: 'refunded' }, 1000, 0)).total,
        summary.confirmedRefunds,
      );
      const zero = await repo.findPage({ userId, maxAmount: 0 }, 1000, 0);
      assert.deepEqual(
        byId(zero.receipts),
        byId(
          receipts.filter(
            (r) =>
              !orderMetricEligibility(r).unlinkedAdjustment &&
              orderMetricEligibility(r).netAmount === 0,
          ),
        ),
      );
      const usd = await repo.findPage(
        { userId, currencyCode: 'USD', minAmount: 60, maxAmount: 62 },
        1000,
        0,
      );
      assert.equal(usd.total, 1);
      assert.equal(usd.receipts[0].restaurantName, 'Dollar price');
      assert.equal((await repo.findPage({ userId, currencyCode: 'UNKNOWN' }, 1000, 0)).total, 1);
      for (const day of ['2023-12-10', '2024-03-10', '2023-11-05']) {
        const expected = receipts.filter(
          (r) =>
            !orderMetricEligibility(r).unlinkedAdjustment &&
            getLocalDateKey(r.orderDate, r.resolution?.timestamp?.timezone ?? 'America/Toronto') ===
              day,
        );
        const page = await repo.findPage({ userId, startDay: day, endDay: day }, 1000, 0);
        assert.deepEqual(byId(page.receipts), byId(expected), day);
        const dto = mapReceiptPageResponse(page.receipts, page.total, 1, 1000, page.timezone);
        assert.equal(
          dto.items.every((r) => r.orderDay === day),
          true,
          day,
        );
      }
      assert.equal(
        (await repo.findPage({ userId, restaurantName: '100%_\\' }, 1000, 0)).receipts[0].id,
        literal.id,
      );
      assert.equal(
        (
          await repo.findPage(
            {
              userId,
              startDate: new Date('2023-12-11T04:59Z'),
              endDate: new Date('2023-12-11T04:59Z'),
            },
            1000,
            0,
          )
        ).receipts[0].restaurantName,
        'Late evening',
      );
      const pagedIds = [];
      for (let offset = 0; offset < receipts.length; offset += 3) {
        const page = await repo.findPage({ userId }, 3, offset);
        assert.equal(page.total, receipts.length);
        pagedIds.push(...page.receipts.map((r) => r.id));
      }
      assert.deepEqual(
        pagedIds,
        all.receipts.map((r) => r.id),
      );
      const beyond = await repo.findPage({ userId }, 3, receipts.length + 10);
      assert.equal(beyond.total, receipts.length);
      assert.equal(beyond.receipts.length, 0);
      assert.equal((await repo.findPage({ userId: randomUUID() }, 3, 0)).total, 0);
      await pool.query("UPDATE users SET timezone='Asia/Tokyo' WHERE id=$1", [userId]);
      const changed = await repo.findPage(
        { userId, startDay: '2023-12-11', endDay: '2023-12-11' },
        1000,
        0,
      );
      assert.equal(
        changed.receipts.some((r) => r.id === fallback.id),
        true,
      );
      assert.equal(
        changed.receipts.some((r) => r.id === traveler.id),
        false,
      );
      assert.equal(changed.timezone, 'Asia/Tokyo');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
