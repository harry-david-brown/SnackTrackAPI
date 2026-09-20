const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'scoped refunds survive real imports, retries and prepare/publish/rollback without invented money',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_scope_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const db = {
      query: (...args) => pool.query(...args),
      withTransaction: async (action) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await action(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const repo = new ReceiptRepository(db, 3),
        allow = async () => {};
      for (const scope of ['full', 'partial'])
        for (const emailFirst of [true, false]) {
          const userId = randomUUID(),
            orderId = randomUUID();
          await pool.query(
            `INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')`,
            [userId, `${userId}@example.invalid`],
          );
          const generation = Number(
            (await pool.query('SELECT import_generation FROM users WHERE id=$1', [userId])).rows[0]
              .import_generation,
          );
          const parsed = await new CsvImportService().parseUberEatsCsv(
            Buffer.from(fixture.csv),
            userId,
            'America/Toronto',
            3,
          );
          const exported = parsed.receipts[3];
          exported.externalId = orderId;
          exported.amountSpent = 40;
          exported.resolution.orderEvidence.recordedTotal = 40;
          const batch = await new ReceiptEmailBatchExtractor(
            new ReceiptExtractor({}, 3),
            { capture: async () => {} },
            10,
            Date.now,
            3,
          ).extract(
            [
              {
                userId,
                provider: emailFirst ? 'gmail' : 'microsoft',
                providerMessageId: 'scoped-refund',
                from: 'receipts@uber.com',
                to: 'redacted',
                subject: 'Your refund',
                receivedAt: new Date('2024-01-10T17:00Z'),
                body: `<p>Uber Eats</p><p>Your order has been ${scope === 'full' ? 'fully' : 'partially'} refunded.</p><a href="https://www.ubereats.com/orders/${orderId}">View order</a>`,
              },
            ],
            'America/Toronto',
            { userId, trigger: 'manual' },
          );
          assert.deepEqual(batch.errors, []);
          assert.equal(batch.supportedReceipts.length, 1);
          if (emailFirst) {
            await repo.upsertEmailReceipts(batch.supportedReceipts, allow);
            const orphan = await repo.findByUserId(userId);
            assert.equal(orphan[0].resolution.orderOutcome.refundStatus, scope);
            assert.equal(summarizeOrderMetrics(orphan).attempts, 0);
            await repo.replaceProviderExport(userId, [exported], allow);
          } else {
            await repo.replaceProviderExport(userId, [exported], allow);
            await repo.upsertEmailReceipts(batch.supportedReceipts, allow);
          }
          const records = await repo.findByUserId(userId);
          assert.equal(records.length, 1);
          const record = records[0];
          const outcome = record.resolution.orderOutcome;
          assert.equal(outcome.refundStatus, scope);
          assert.equal(outcome.refundConfidence, 'confirmed');
          assert.equal(outcome.netAmount, null);
          assert.equal(outcome.confirmedRefundAmount, null);
          assert.equal(outcome.originalCharge, 40);
          assert.equal(outcome.events.filter((e) => e.kind === 'refund').length, 0);
          const metrics = summarizeOrderMetrics(records);
          assert.equal(metrics.attempts, 1);
          assert.equal(metrics.confirmedRefunds, 1);
          assert.equal(metrics.fullyRefunded, scope === 'full' ? 1 : 0);
          assert.equal(metrics.partiallyRefunded, scope === 'partial' ? 1 : 0);
          assert.equal(metrics.currencies[0].unknownPriceOrders, 1);
          const sources = async () =>
            (
              await pool.query(
                'SELECT id,payload,receipt_id FROM receipt_observations WHERE user_id=$1 ORDER BY id',
                [userId],
              )
            ).rows;
          const before = await sources();
          assert.equal(before.length, 2);
          const email = before.find((s) => s.payload.dataSource === 'email');
          assert.equal(email.payload.resolution.orderEvidence.refundScope, scope);
          assert.equal(email.payload.resolution.orderEvidence.refundAmount, undefined);
          assert.equal(email.payload.resolution.orderEvidence.recordedTotal, null);
          const retry = await repo.upsertEmailReceipts(batch.supportedReceipts, allow);
          assert.equal(retry.newOrders, 0);
          assert.equal(retry.updatedOrders, 0);
          assert.deepEqual(await sources(), before);
          const prepared = await repo.rebuildProjection(userId, generation, 'prepare', allow);
          await repo.rebuildProjection(userId, generation, 'publish', allow, prepared.manifestId);
          assert.equal((await repo.findByUserId(userId))[0].id, record.id);
          await repo.rebuildProjection(userId, generation, 'rollback', allow, prepared.manifestId);
          assert.deepEqual(await sources(), before);
          assert.deepEqual((await repo.findByUserId(userId))[0].resolution.orderOutcome, outcome);
          const stored = (
            await pool.query(
              'SELECT order_refund_status,order_net_amount FROM receipts WHERE id=$1',
              [record.id],
            )
          ).rows[0];
          assert.equal(stored.order_refund_status, scope);
          assert.equal(stored.order_net_amount, null);
          assert.equal(
            Number(
              (
                await pool.query(
                  "SELECT count(*) FROM receipt_order_events WHERE user_id=$1 AND kind='refund'",
                  [userId],
                )
              ).rows[0].count,
            ),
            0,
          );
          const pending = await repo.rebuildProjection(userId, generation, 'prepare', allow);
          const conflicting = await new ReceiptEmailBatchExtractor(
            new ReceiptExtractor({}, 3),
            { capture: async () => {} },
            10,
            Date.now,
            3,
          ).extract(
            [
              {
                userId,
                provider: 'gmail',
                providerMessageId: 'revised-scope',
                from: 'receipts@uber.com',
                to: 'redacted',
                subject: 'Updated receipt',
                receivedAt: new Date('2024-01-11T17:00Z'),
                body: `<p>Uber Eats</p><p>We updated your receipt.</p><p>Your order has been fully refunded.</p><p>Previous Total CA$40.00</p><p>New Total CA$30.00</p><a href="https://www.ubereats.com/orders/${orderId}">View order</a>`,
              },
            ],
            'America/Toronto',
            { userId, trigger: 'manual' },
          );
          assert.deepEqual(conflicting.errors, []);
          await repo.upsertEmailReceipts(conflicting.supportedReceipts, allow);
          await assert.rejects(
            repo.rebuildProjection(userId, generation, 'publish', allow, pending.manifestId),
            /evidence changed/,
          );
          const current = await repo.findByUserId(userId);
          assert.equal(current.length, 1);
          assert.equal(current[0].resolution.orderOutcome.refundStatus, 'conflicted');
          assert.equal(current[0].resolution.orderOutcome.refundConfidence, 'confirmed');
          assert.equal(current[0].resolution.orderOutcome.netAmount, 30);
          assert.equal(summarizeOrderMetrics(current).unclassifiedRefunds, 1);
          assert.equal((await repo.findPage({ userId, outcome: 'needs_review' }, 10, 0)).total, 1);
          assert.equal((await repo.findPage({ userId, outcome: 'refunded' }, 10, 0)).total, 1);
          assert.equal((await repo.findPage({ userId, outcome: 'unknown_cost' }, 10, 0)).total, 0);
          assert.equal((await sources()).length, 3);
        }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
