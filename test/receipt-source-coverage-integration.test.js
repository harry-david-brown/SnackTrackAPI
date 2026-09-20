const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const {
  ImportSourceCoverageRepository,
} = require('../dist/services/data/ImportSourceCoverageRepository');
const {
  ImportPreferencesQueryRepository,
} = require('../dist/services/data/ImportPreferencesQueryRepository');
const { orderMetricEligibility } = require('../dist/services/analytics/shared/orderMetrics');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'source coverage counts canonical membership; adjustments cannot extend order dates or weekly activity',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_sources_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const db = { query: (...args) => pool.query(...args) };
    const repo = new ReceiptRepository(db, 3);
    const coverage = new ImportSourceCoverageRepository(db);
    const preferences = new ImportPreferencesQueryRepository(db);
    const userId = randomUUID(),
      otherId = randomUUID();
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      for (const id of [userId, otherId])
        await pool.query(
          `INSERT INTO users(id,email,password,timezone,gmail_connected,gmail_connection_mode,gmail_refresh_token)
         VALUES($1,$2,'test','America/Toronto',TRUE,'offline','fixture-only')`,
          [id, `${id}@example.invalid`],
        );
      const base = (await decemberCanonicalOrders())[0];
      const rows = [];
      const insert = async (changes = {}, outcome = {}) => {
        const receipt = structuredClone({ ...base, id: randomUUID(), userId, ...changes });
        if (receipt.resolution)
          receipt.resolution.orderOutcome = { ...receipt.resolution.orderOutcome, ...outcome };
        await pool.query(
          `INSERT INTO receipts(id,user_id,restaurant_name,items,amount_spent,order_date,receipt_type,data_source,currency_code,resolution)
          VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10::jsonb)`,
          [
            receipt.id,
            receipt.userId,
            receipt.restaurantName,
            JSON.stringify(receipt.items),
            receipt.amountSpent,
            receipt.orderDate,
            receipt.receiptType,
            receipt.dataSource,
            'CAD',
            JSON.stringify(receipt.resolution ?? null),
          ],
        );
        if (receipt.userId === userId) rows.push(receipt);
        return receipt;
      };
      assert.equal((await coverage.getForUser(userId)).hasEmailData, false);
      // A canonical combined record must not depend on which source supplies its label.
      const combined = await insert({
        dataSource: 'email',
        orderDate: new Date('2023-12-10T06:00Z'),
      });
      assert.equal(combined.resolution.reconciliation.status, 'merged');
      assert.equal((await coverage.getForUser(userId)).exportReceiptCount, 1);
      assert.deepEqual(await repo.getLatestCsvReceiptDates(userId), {
        uber_eats: combined.orderDate,
      });
      assert.equal((await preferences.getProviderExports(userId)).uber_eats.status, 'completed');
      assert.deepEqual(await preferences.getTrackingBaseline(userId), {
        eligible: true,
        source: 'exports',
      });
      // Detection of evidence does not grant monitoring consent.
      assert.deepEqual(await preferences.getEligibleTrackingUserIds(), []);
      await pool.query(
        `INSERT INTO user_import_preferences(user_id,ongoing_tracking_consent_state)
        VALUES($1,'granted')`,
        [userId],
      );
      assert.deepEqual(await preferences.getEligibleTrackingUserIds(), [userId]);
      assert.deepEqual(await preferences.getEligibleOutlookTrackingUserIds(), []);
      await insert({ userId: otherId, orderDate: new Date('2099-01-01T12:00Z') });
      const orphan = structuredClone(base.resolution);
      orphan.sources = ['email'];
      orphan.reconciliation.status = 'unresolved';
      await insert(
        { dataSource: 'email', resolution: orphan, orderDate: new Date('2098-01-01T12:00Z') },
        { kind: 'unlinked_adjustment', fulfillment: 'unknown', netAmount: null },
      );
      const savedCoverage = await coverage.getForUser(userId);
      assert.equal(savedCoverage.emailReceiptCount, 2); // retained orphan is evidence, not another purchase
      assert.equal(savedCoverage.exportReceiptCount, 1);
      assert.equal(
        savedCoverage.emailProviders.uberEats.latestOrderDate,
        combined.orderDate.toISOString(),
      );
      assert.equal(
        savedCoverage.exportProviders.uberEats.latestOrderDate,
        combined.orderDate.toISOString(),
      );
      assert.deepEqual(await repo.getLatestCsvReceiptDates(userId), {
        uber_eats: combined.orderDate,
      });
      // Detached/disabled raw evidence is retained but never counted as a serving record.
      await pool.query(
        `INSERT INTO receipt_observations(id,user_id,receipt_id,document_key,import_generation,parser_version,payload,association_enabled)
        VALUES($1,$2,NULL,'disabled-source',0,3,$3::jsonb,FALSE)`,
        [randomUUID(), userId, JSON.stringify(base)],
      );
      assert.deepEqual(await coverage.getForUser(userId), savedCoverage);
      const week = (
        await pool.query(
          `SELECT DATE_TRUNC('week', NOW() AT TIME ZONE 'America/Toronto')::date::text AS day`,
        )
      ).rows[0].day;
      // Asia/Tokyo Monday is still Sunday in Toronto; source-local day owns activity.
      const monday = new Date(`${week}T00:30:00+09:00`);
      const local = structuredClone(base.resolution);
      local.timestamp.timezone = 'Asia/Tokyo';
      const current = await insert({ orderDate: monday, resolution: local });
      await insert(
        { orderDate: monday, resolution: local },
        { kind: 'unlinked_adjustment', netAmount: null },
      );
      const possible = structuredClone(local);
      possible.reconciliation.status = 'unresolved';
      possible.sources = ['email'];
      await insert({ dataSource: 'email', orderDate: monday, resolution: possible });
      await insert({ orderDate: monday, resolution: local }, { fulfillment: 'canceled' });
      await insert(
        { orderDate: monday, resolution: local },
        {
          fulfillment: 'completed',
          refundStatus: 'full',
          refundConfidence: 'confirmed',
          netAmount: 0,
        },
      );
      // Missing source zone falls back to the supplied account zone; invalid zones are not guessed.
      const fallback = structuredClone(base.resolution);
      delete fallback.timestamp;
      await insert({ orderDate: new Date(`${week}T12:00Z`), resolution: fallback });
      const invalid = structuredClone(local);
      invalid.timestamp.timezone = 'invalid-zone';
      await insert({ orderDate: new Date(`${week}T12:00Z`), resolution: invalid });
      await insert({
        orderDate: new Date(`${week}T12:00Z`),
        resolution: null,
        dataSource: 'email',
      });
      const nextWeek = new Date(monday.getTime() + 7 * 86400000);
      await insert({ orderDate: nextWeek, resolution: local });
      const expected = rows.filter(
        (r) =>
          orderMetricEligibility(r).establishedAttempt &&
          r.orderDate?.getTime() === current.orderDate.getTime(),
      ).length;
      assert.equal(expected, 3); // completed, charged cancellation, delivered/refunded
      assert.equal(
        await preferences.getOrdersAddedThisWeek(userId, 'America/Toronto'),
        expected + 2,
      );
      assert.equal(await preferences.getOrdersAddedThisWeek(otherId, 'America/Toronto'), 0);
      const empty = await coverage.getForUser(randomUUID());
      assert.equal(empty.emailReceiptCount, 0);
      assert.equal(empty.exportProviders.uberEats.latestOrderDate, null);
      // An account with only a standalone refund has evidence but no observed order range.
      await pool.query('DELETE FROM receipts WHERE user_id=$1', [otherId]);
      await insert(
        { userId: otherId, dataSource: 'email', resolution: orphan },
        { kind: 'unlinked_adjustment' },
      );
      const refundOnly = await coverage.getForUser(otherId);
      assert.equal(refundOnly.hasEmailData, true);
      assert.equal(refundOnly.emailReceiptCount, 1);
      assert.equal(refundOnly.emailProviders.uberEats.earliestOrderDate, null);
      assert.deepEqual(await repo.getLatestCsvReceiptDates(otherId), {});
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
