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
const { ReceiptReconciliationStore } = require('../dist/services/data/ReceiptReconciliationStore');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { CsvImportUseCase } = require('../dist/services/import/CsvImportUseCase');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/doordash-source');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const timezone = 'America/Toronto';
const allow = async () => {};

test(
  'DoorDash import and reviewed repair preserve email pricing, export details and revisable membership in PostgreSQL',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `doordash_reconciliation_test_${randomUUID().replaceAll('-', '')}`;
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
    const csv = new CsvImportService();
    const extraction = new ReceiptEmailBatchExtractor(
      new ReceiptExtractor({}, 3),
      { capture: async () => {} },
      10,
      Date.now,
      3,
    );
    const emailFor = async (
      userId,
      provider = 'gmail',
      messageId = 'grimaldi',
      amount = '61.39',
    ) => {
      const result = await extraction.extract(
        [
          {
            userId,
            provider,
            providerMessageId: messageId,
            from: 'no-reply@doordash.com',
            to: 'redacted',
            subject: fixture.email.subject,
            receivedAt: new Date('2026-07-06T01:00Z'),
            body: fixture.email.body
              .replace('61.39', amount)
              .split('\n')
              .map((line) => `<p>${line}</p>`)
              .join(''),
          },
        ],
        timezone,
        { userId, trigger: 'manual' },
      );
      assert.equal(result.supportedReceipts.length, 1, JSON.stringify(result.errors));
      return result.supportedReceipts[0];
    };
    const newUser = async () => {
      const id = randomUUID();
      const { rows } = await pool.query(
        "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test',$3) RETURNING import_generation",
        [id, `${id}@example.test`, timezone],
      );
      return { id, timezone, generation: Number(rows[0].import_generation) };
    };
    const sourcesFor = async (userId) =>
      (
        await pool.query(
          'SELECT id, payload, association_enabled FROM receipt_observations WHERE user_id=$1 ORDER BY id',
          [userId],
        )
      ).rows;
    const assertMerged = (records) => {
      assert.equal(records.length, 1);
      const order = records[0];
      assert.equal(order.amountSpent, 61.39);
      assert.equal(order.monetaryDetails.currencyCode, 'USD');
      assert.equal(order.monetaryDetails.subtotal, 76.8);
      assert.equal(order.items.length, 1);
      assert.equal(order.items[0].name, fixture.base.ITEM);
      assert.equal(order.deliveryTime.toISOString(), '2026-07-05T16:45:00.000Z');
      assert.equal(order.resolution.reconciliation.status, 'merged');
      const metrics = summarizeOrderMetrics(records);
      assert.equal(metrics.attempts, 1);
      assert.equal(metrics.deliveries, 1);
      assert.equal(metrics.confirmedRefunds, 0);
      assert.equal(metrics.likelyRefunds, 0);
      assert.equal(metrics.currencies[0].netSpend, 61.39);
      assert.equal(metrics.currencies[0].unknownPriceOrders, 0);
    };
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const repo = new ReceiptRepository(db, 3);
      for (const provider of ['gmail', 'microsoft'])
        for (const emailFirst of [true, false]) {
          const user = await newUser();
          const email = await emailFor(user.id, provider);
          const lock = { userId: user.id };
          let cacheCalls = 0;
          const operation = new CsvImportUseCase(
            csv,
            repo,
            { findById: async () => user },
            { setExportStatus: async () => true },
            {
              invalidateAllUserCaches: async (id) => {
                assert.equal(id, user.id);
                assert.ok(
                  (await sourcesFor(id)).length > 0,
                  'cache invalidation sees committed sources',
                );
                cacheCalls++;
              },
            },
            { assertLockOwned: async (handle) => assert.equal(handle, lock) },
            repo,
            3,
          );
          const runExport = async () => {
            const jobId = randomUUID();
            await pool.query(
              "INSERT INTO import_jobs(id,user_id,kind,trigger_type,status,import_generation) SELECT $1,id,'export_file','user','running',import_generation FROM users WHERE id=$2",
              [jobId, user.id],
            );
            const result = await operation.executeWithLock(
              {
                userId: user.id,
                provider: 'doordash',
                fileType: 'csv',
                jobId,
                accountingJobId: jobId,
                csvBuffer: Buffer.from(fixture.csv()),
              },
              lock,
            );
            await pool.query("UPDATE import_jobs SET status='succeeded' WHERE id=$1", [jobId]);
            return result;
          };
          if (emailFirst) await repo.upsertEmailReceipts([email], allow);
          const imported = await runExport();
          if (!emailFirst) {
            assert.equal(
              imported.totalAmount,
              null,
              'the item subtotal is not reported as paid spending',
            );
            assert.equal(imported.receiptOutcome.currencies[0].unpricedOrders, 1);
            await repo.upsertEmailReceipts([email], allow);
          } else {
            assert.equal(imported.totalAmount, 61.39);
            assert.equal(imported.receiptOutcome.newOrders, 0);
            assert.equal(imported.receiptOutcome.updatedOrders, 1);
          }
          const records = await repo.findByUserId(user.id);
          assertMerged(records);
          const id = records[0].id;
          const originalSources = await sourcesFor(user.id);
          assert.equal(originalSources.length, 2);
          const exportSource = originalSources.find((s) => s.payload.dataSource === 'csv');
          assert.equal(exportSource.payload.resolution.orderEvidence.recordedTotal, null);
          assert.equal(exportSource.payload.monetaryDetails.subtotal, 76.8);
          const coverage = await new ImportSourceCoverageRepository(db).getForUser(user.id);
          assert.equal(coverage.emailReceiptCount, 1);
          assert.equal(coverage.exportReceiptCount, 1);
          await repo.upsertEmailReceipts([email], allow);
          const reimported = await runExport();
          assert.equal(reimported.receiptOutcome.newOrders, 0);
          assert.equal(reimported.receiptOutcome.unchangedOrders, 1);
          assert.equal(reimported.totalAmount, 61.39);
          assertMerged(await repo.findByUserId(user.id));
          assert.equal((await repo.findByUserId(user.id))[0].id, id);
          assert.deepEqual(await sourcesFor(user.id), originalSources);
          assert.equal(cacheCalls, 2);

          // Later evidence must undo a no-longer-unique inference, even if export clocks differ.
          const secondEmail = await emailFor(user.id, provider, 'second-purchase', '60.39');
          await repo.upsertEmailReceipts([secondEmail], allow);
          const secondExport = await csv.parseDoorDashCsv(
            Buffer.from(
              fixture.csv([
                {},
                { CREATED_AT: '2026-07-05 18:00:00', DELIVERY_TIME: '2026-07-05 18:45:00' },
              ]),
            ),
            user.id,
            timezone,
            3,
          );
          await repo.replaceProviderExport(user.id, secondExport.receipts, allow);
          const split = await repo.findByUserId(user.id);
          const splitMetrics = summarizeOrderMetrics(split);
          assert.equal(split.length, 4, 'date-only emails cannot choose between the two purchases');
          assert.equal(splitMetrics.attempts, 2);
          assert.equal(splitMetrics.possibleAdditionalOrders, 2);
          assert.equal(splitMetrics.currencies[0].netSpend, 0);
          assert.equal(splitMetrics.currencies[0].unknownPriceOrders, 2);
          assert.equal(splitMetrics.currencies[0].possibleAdditionalSpend, 121.78);
          assert.equal((await sourcesFor(user.id)).length, 4);
          assert.ok(
            split.some((r) => r.id === id),
            'the old reference remains traceable',
          );
        }

      // A retained policy-2 interpretation is not overwritten by the policy-3 repair.
      const user = await newUser();
      const oldExport = await csv.parseDoorDashCsv(
        Buffer.from(fixture.csv()),
        user.id,
        timezone,
        2,
      );
      await new ReceiptRepository(db, 2).replaceProviderExport(user.id, oldExport.receipts, allow);
      const before = await repo.findByUserId(user.id);
      const oldSources = await sourcesFor(user.id);
      const exported = await csv.parseDoorDashCsv(Buffer.from(fixture.csv()), user.id, timezone, 3);
      const provenance = {
        sourceKind: 'provider_export',
        provider: 'doordash',
        sourceLabel: 'Synthetic Grimaldi subtotal export',
        acquiredAt: new Date().toISOString(),
        successfulCompletion: exported.success,
        rejectedRecords: exported.rejectedRecords,
      };
      const csvStage = await repo.stageRepairSources(
        user.id,
        user.generation,
        exported.receipts,
        provenance,
        allow,
      );
      const emailStage = await repo.stageRepairSources(
        user.id,
        user.generation,
        [await emailFor(user.id)],
        {
          ...provenance,
          sourceKind: 'retained_email',
          sourceLabel: 'Redacted email transcription',
        },
        allow,
      );
      assert.deepEqual(await repo.findByUserId(user.id), before, 'staging does not change history');
      assert.deepEqual(await sourcesFor(user.id), oldSources);
      const manifest = await repo.rebuildProjection(
        user.id,
        user.generation,
        'prepare',
        allow,
        undefined,
        [csvStage.batchId, emailStage.batchId],
      );
      const saved = await db.withTransaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return new ReceiptReconciliationStore(() => {
          throw Error('Inspection cannot write');
        }, 3).inspectManifest(tx, user.id, manifest.manifestId);
      });
      assert.equal(saved.before.receipts[0].amountSpent, 76.8);
      assertMerged(saved.after.receipts);
      assert.deepEqual(saved.context.validation.issues, ['REPAIR_POLICY_NOT_SERVING']);
      await repo.rebuildProjection(user.id, user.generation, 'publish', allow, manifest.manifestId);
      const published = await repo.findByUserId(user.id);
      assertMerged(published);
      assert.equal(published[0].id, before[0].id);
      const publishedSources = await sourcesFor(user.id);
      assert.equal(publishedSources.length, 3);
      assert.deepEqual(
        publishedSources.find((s) => s.id === oldSources[0].id).payload,
        oldSources[0].payload,
      );
      await repo.rebuildProjection(
        user.id,
        user.generation,
        'rollback',
        allow,
        manifest.manifestId,
      );
      assert.deepEqual(await repo.findByUserId(user.id), before);
      const rolledBack = await sourcesFor(user.id);
      assert.equal(rolledBack.length, 3, 'rollback retains acquired evidence');
      assert.equal(rolledBack.filter((s) => s.association_enabled).length, 1);
      assert.deepEqual(
        rolledBack.map((s) => s.payload),
        publishedSources.map((s) => s.payload),
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
