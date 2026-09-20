const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { MailboxContentGuard } = require('../dist/services/mailbox/MailboxContentGuard');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

for (const setup of ['fresh', 'existing'])
  test(
    `${setup}: unclassified refunds retain evidence and become classified when the original balance arrives`,
    { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
    async () => {
      const schema = `unclassified_refunds_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      const clients = { getClient: () => pool.connect() };
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
        const legacyUser = randomUUID(),
          legacyReceipt = randomUUID();
        let before;
        if (setup === 'existing') {
          await new MigrationRunner(
            clients,
            migrations.filter((m) => m.version < 30),
          ).run();
          await pool.query(
            "INSERT INTO users(id,email,password) VALUES($1,'legacy@example.com','test')",
            [legacyUser],
          );
          await pool.query(
            "INSERT INTO receipts(id,user_id,receipt_type,data_source,amount_spent,items) VALUES($1,$2,'uber_eats','csv',10,'[]')",
            [legacyReceipt, legacyUser],
          );
          await pool.query(
            "INSERT INTO receipt_observations(id,user_id,receipt_id,document_key,import_generation,parser_version,payload) VALUES($1,$2,$3,'retained-legacy',1,2,'{\"amountSpent\":10}')",
            [randomUUID(), legacyUser, legacyReceipt],
          );
          before = (
            await pool.query(
              'SELECT payload,parser_version,created_at FROM receipt_observations WHERE user_id=$1',
              [legacyUser],
            )
          ).rows;
        }
        const migration = await new MigrationRunner(clients, migrations).run();
        assert.ok(migration.applied.includes(30));
        assert.deepEqual((await new MigrationRunner(clients, migrations).run()).applied, []);
        if (before) {
          assert.deepEqual(
            (
              await pool.query(
                'SELECT payload,parser_version,created_at FROM receipt_observations WHERE user_id=$1',
                [legacyUser],
              )
            ).rows,
            before,
          );
          const unchanged = (
            await pool.query('SELECT amount_spent,order_refund_status FROM receipts WHERE id=$1', [
              legacyReceipt,
            ])
          ).rows[0];
          assert.equal(Number(unchanged.amount_spent), 10);
          assert.equal(unchanged.order_refund_status, null);
        }
        const repo = new ReceiptRepository(db, 3),
          allow = async () => {};
        for (const emailFirst of [true, false]) {
          for (const total of [null, 0]) {
            for (const refundAmount of [10, null]) {
              const userId = randomUUID(),
                providerOrderId = randomUUID();
              await pool.query(
                "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
                [userId, `${userId}@example.com`],
              );
              const parsed = await new CsvImportService().parseUberEatsCsv(
                Buffer.from(fixture.csv),
                userId,
                'America/Toronto',
                3,
              );
              const exported = parsed.receipts[3];
              exported.externalId = providerOrderId;
              exported.amountSpent = total ?? 0;
              exported.resolution.orderEvidence.recordedTotal = total;
              exported.resolution.orderEvidence.totalState = total === null ? 'blank' : 'known';
              const extractor = new ReceiptEmailBatchExtractor(
                new ReceiptExtractor({}, 3),
                { capture: async () => {} },
                10,
                Date.now,
                3,
              );
              const extract = async (id, body) =>
                extractor.extract(
                  [
                    {
                      userId,
                      provider: emailFirst ? 'gmail' : 'microsoft',
                      providerMessageId: id,
                      from: 'receipts@uber.com',
                      to: 'redacted',
                      subject: 'Your order',
                      receivedAt: new Date('2024-01-10T17:00:00Z'),
                      body: new MailboxContentGuard(3).acceptBody(
                        `${body}<a href="https://www.ubereats.com/orders/${providerOrderId}?access_token=not-retained">View order</a>`,
                        { accepted: true, authentication: 'pass' },
                      ).body,
                    },
                  ],
                  'America/Toronto',
                  { userId, trigger: 'manual' },
                );
              const refund = await extract(
                'refund',
                refundAmount === null
                  ? '<p>Uber Eats</p><p>Your refund has been applied to your Uber Cash for your order.</p><p>Refund ID: refund-one</p>'
                  : '<p>Uber Eats</p><p>We refunded CA$10.00 to your Uber Cash for your order.</p><p>Refund ID: refund-one</p>',
              );
              assert.deepEqual(refund.errors, []);
              assert.equal(refund.supportedReceipts.length, 1);
              if (emailFirst) {
                await repo.upsertEmailReceipts(refund.supportedReceipts, allow);
                const orphan = await repo.findByUserId(userId);
                assert.equal(
                  orphan[0].resolution.orderOutcome.refundStatus,
                  'confirmed_unclassified',
                );
                assert.equal(summarizeOrderMetrics(orphan).attempts, 0);
                await repo.replaceProviderExport(userId, [exported], allow);
              } else {
                await repo.replaceProviderExport(userId, [exported], allow);
                await repo.upsertEmailReceipts(refund.supportedReceipts, allow);
              }
              let records = await repo.findByUserId(userId);
              assert.equal(records.length, 1);
              const id = records[0].id;
              const metrics = summarizeOrderMetrics(records);
              assert.equal(metrics.attempts, 1);
              assert.equal(metrics.deliveries, 1);
              assert.equal(metrics.confirmedRefunds, 1);
              assert.equal(metrics.unclassifiedRefunds, 1);
              assert.equal(metrics.likelyRefunds, 0);
              assert.equal(records[0].resolution.orderOutcome.netAmount, total);
              assert.equal(records[0].resolution.orderOutcome.originalCharge, null);
              assert.equal(metrics.currencies[0].confirmedRefundAmount, refundAmount ?? 0);
              assert.equal(
                metrics.currencies[0].confirmedRefundsWithUnknownAmount,
                refundAmount === null ? 1 : 0,
              );
              assert.equal(records[0].resolution.orderOutcome.confirmedRefundAmount, refundAmount);
              const stored = (
                await pool.query(
                  'SELECT order_refund_status,order_net_amount FROM receipts WHERE id=$1',
                  [id],
                )
              ).rows[0];
              assert.equal(stored.order_refund_status, 'confirmed_unclassified');
              assert.equal(
                stored.order_net_amount === null ? null : Number(stored.order_net_amount),
                total,
              );
              await assert.rejects(
                pool.query(
                  "UPDATE receipts SET resolution=jsonb_set(resolution,'{orderOutcome,refundStatus}','\"made_up\"') WHERE id=$1",
                  [id],
                ),
                /receipt_order_refund_status_check/,
              );
              await repo.upsertEmailReceipts(refund.supportedReceipts, allow);
              await repo.replaceProviderExport(userId, [exported], allow);
              records = await repo.findByUserId(userId);
              assert.equal(records[0].id, id);
              assert.equal(
                Number(
                  (
                    await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
                      userId,
                    ])
                  ).rows[0].count,
                ),
                2,
              );
              if (refundAmount === null) {
                const retained = (
                  await pool.query('SELECT payload FROM receipt_observations WHERE user_id=$1', [
                    userId,
                  ])
                ).rows.find((o) => o.payload.resolution?.orderEvidence?.refundConfirmed);
                assert.equal(retained.payload.resolution.orderEvidence.refundConfirmed, true);
                assert.equal(
                  retained.payload.resolution.orderEvidence.refundReference,
                  'refund-one',
                );
                assert.equal(retained.payload.resolution.orderEvidence.refundAmount, undefined);
                assert.equal(retained.payload.resolution.orderEvidence.recordedTotal, null);
                assert.equal(
                  Number(
                    (
                      await pool.query(
                        'SELECT count(*) FROM receipt_order_events WHERE user_id=$1 AND kind=$2',
                        [userId, 'refund'],
                      )
                    ).rows[0].count,
                  ),
                  0,
                );
              }
              if (total === null) {
                const original = await extract(
                  'original',
                  "<p>Uber Eats</p><p>Total CA$40.00</p><p>December 10, 2023</p><p>Here's your receipt from Metro (2515 Bank Street Ottawa).</p>",
                );
                await repo.upsertEmailReceipts(original.supportedReceipts, allow);
                records = await repo.findByUserId(userId);
                assert.equal(records.length, 1);
                assert.equal(records[0].id, id);
                assert.equal(
                  records[0].resolution.orderOutcome.netAmount,
                  refundAmount === null ? null : 30,
                );
                assert.equal(
                  records[0].resolution.orderOutcome.refundStatus,
                  refundAmount === null ? 'confirmed_unclassified' : 'partial',
                );
                assert.equal(
                  summarizeOrderMetrics(records).unclassifiedRefunds,
                  refundAmount === null ? 1 : 0,
                );
                assert.equal(
                  summarizeOrderMetrics(records).partiallyRefunded,
                  refundAmount === null ? 0 : 1,
                );
                assert.equal(
                  Number(
                    (
                      await pool.query(
                        'SELECT count(*) FROM receipt_observations WHERE user_id=$1',
                        [userId],
                      )
                    ).rows[0].count,
                  ),
                  3,
                );
                if (refundAmount === null) {
                  const revised = await extract(
                    'revised',
                    '<p>Uber Eats</p><p>We updated your receipt for Metro (2515 Bank Street Ottawa).</p><p>Your refund has been applied.</p><p>Previous Total CA$40.00</p><p>New Total CA$30.00</p>',
                  );
                  assert.equal(revised.supportedReceipts.length, 1);
                  await repo.upsertEmailReceipts(revised.supportedReceipts, allow);
                  records = await repo.findByUserId(userId);
                  assert.equal(records.length, 1);
                  assert.equal(records[0].id, id);
                  assert.equal(records[0].resolution.orderOutcome.netAmount, 30);
                  assert.equal(records[0].resolution.orderOutcome.confirmedRefundAmount, 10);
                  assert.equal(summarizeOrderMetrics(records).partiallyRefunded, 1);
                  assert.equal(
                    summarizeOrderMetrics(records).currencies[0].confirmedRefundsWithUnknownAmount,
                    0,
                  );
                  await repo.upsertEmailReceipts(revised.supportedReceipts, allow);
                  assert.equal(
                    Number(
                      (
                        await pool.query(
                          'SELECT count(*) FROM receipt_observations WHERE user_id=$1',
                          [userId],
                        )
                      ).rows[0].count,
                    ),
                    4,
                  );
                }
              }
            }
          }
        }
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  );
