const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { orderEventsMigration } = require('../dist/services/data/migrations/027_order_events');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const {
  ImportSourceCoverageRepository,
} = require('../dist/services/data/ImportSourceCoverageRepository');
const {
  ReceiptReconciliationStore,
  evidenceFingerprint,
} = require('../dist/services/data/ReceiptReconciliationStore');
const {
  buildReceiptReconciliationAudit,
} = require('../dist/services/receipt/ReceiptReconciliationAudit');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'policy 3 PostgreSQL ingestion preserves all eleven sources, five orders, pagination, retries, rollback and manifests',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `order_events_test_${randomUUID().replaceAll('-', '')}`;
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
    const userId = randomUUID();
    try {
      await new MigrationRunner(
        { getClient: () => pool.connect() },
        migrations.some((m) => m.version === 27)
          ? migrations
          : [...migrations, orderEventsMigration],
      ).run();
      await pool.query(
        "INSERT INTO users(id,email,password,timezone) VALUES($1,'order-events-test@example.com','test','America/Toronto')",
        [userId],
      );
      const generation = Number(
        (await pool.query('SELECT import_generation FROM users WHERE id=$1', [userId])).rows[0]
          .import_generation,
      );
      const exported = await new CsvImportService().parseUberEatsCsv(
        Buffer.from(fixture.csv),
        userId,
        'America/Toronto',
        3,
      );
      const batch = await new ReceiptEmailBatchExtractor(
        new ReceiptExtractor({}, 3),
        { capture: async () => {} },
        10,
        Date.now,
        3,
      ).extract(
        fixture.emails.map((e) => ({
          userId,
          provider: 'gmail',
          providerMessageId: e.id,
          from: 'receipts@uber.com',
          to: 'redacted',
          subject: 'Your Uber Eats receipt',
          body: e.text
            .split('\n')
            .map((line) => `<p>${line}</p>`)
            .join(''),
          receivedAt: new Date('2023-12-11T17:00Z'),
        })),
        'America/Toronto',
        { userId, trigger: 'manual' },
      );
      const repo = new ReceiptRepository(db, 3),
        allow = async () => {};
      const sourceCount = async () =>
        Number(
          (await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [userId]))
            .rows[0].count,
        );
      const readOnlyInspect = (manifestId, account = userId) =>
        db.withTransaction(async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          const readOnlyPort = {
            query: (sql, params) => {
              assert.match(sql.trim(), /^SELECT\b/);
              assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE/i);
              return tx.query(sql, params);
            },
          };
          const inspector = new ReceiptReconciliationStore(async () => {
            throw Error('Inspection cannot write');
          }, 3);
          inspector.plan = () => {
            throw Error('Inspection must not reconcile again');
          };
          inspector.preview = () => {
            throw Error('Inspection must not substitute a new preview');
          };
          return inspector.inspectManifest(readOnlyPort, account, manifestId);
        });
      for (const [emailFirst, missingCourier] of [
        [true, false],
        [false, false],
        [true, true],
        [false, true],
      ]) {
        const receipts = structuredClone(batch.supportedReceipts);
        if (missingCourier) {
          for (const receipt of receipts) {
            const evidence = receipt.resolution.orderEvidence;
            if (evidence.courier) evidence.fulfillment = 'unknown';
            delete evidence.courier;
            if (evidence.documentKind === 'refund') {
              for (const payment of evidence.payments) {
                payment.timestamp.raw = 'December 10, 2023 1:44 AM';
                payment.timestamp.instant = '2023-12-10T01:44:00-05:00';
              }
            }
          }
        }
        await pool.query('DELETE FROM receipts WHERE user_id=$1', [userId]);
        await pool.query('DELETE FROM receipt_observations WHERE user_id=$1', [userId]);
        if (emailFirst) {
          for (const email of [...receipts].reverse())
            await repo.upsertEmailReceipts([email], allow);
          await repo.replaceProviderExport(userId, exported.receipts, allow);
        } else {
          await repo.replaceProviderExport(userId, [...exported.receipts].reverse(), allow);
          for (const email of receipts) await repo.upsertEmailReceipts([email], allow);
        }
        const records = await repo.findByUserId(userId);
        assert.equal(records.length, 5);
        assert.equal(await sourceCount(), 11);
        const coverage = await new ImportSourceCoverageRepository(db).getForUser(userId);
        assert.equal(coverage.emailReceiptCount, 5);
        assert.equal(coverage.exportReceiptCount, 5);
        assert.equal(coverage.emailProviders.uberEats.receiptCount, 5);
        assert.equal(coverage.exportProviders.uberEats.receiptCount, 5);
        assert.deepEqual(await repo.getLatestCsvReceiptDates(userId), {
          uber_eats: new Date(Math.max(...exported.receipts.map((r) => r.orderDate.getTime()))),
        });
        const metrics = summarizeOrderMetrics(records);
        assert.equal(metrics.deliveries, 4);
        assert.equal(metrics.canceled, 1);
        assert.equal(metrics.confirmedRefunds, 1);
        assert.equal(metrics.currencies[0].netSpend, 157.02);
        const events = records.flatMap((r) => r.resolution.orderOutcome.events);
        assert.equal(events.filter((event) => event.kind === 'charge').length, 6);
        assert.equal(events.filter((event) => event.kind === 'refund').length, 1);
        const refund = events.find((event) => event.kind === 'refund');
        assert.equal(refund.amount, 22.48);
        assert.equal(refund.tender, 'provider_wallet');
        assert.ok(records.every((r) => r.resolution.reconciliation.policyVersion === 3));
        const ids = records.map((r) => r.id).sort();
        const retry = await repo.upsertEmailReceipts(receipts, allow);
        assert.equal(retry.newOrders, 0);
        assert.equal(retry.updatedOrders, 0);
        await repo.replaceProviderExport(userId, exported.receipts, allow);
        assert.deepEqual((await repo.findByUserId(userId)).map((r) => r.id).sort(), ids);
        assert.equal(await sourceCount(), 11);
        const original = JSON.stringify(await repo.findByUserId(userId));
        const extra = structuredClone(receipts[0]);
        extra.resolution.sourceMessageId = 'gmail:additional';
        let guardCalls = 0;
        await assert.rejects(
          repo.upsertEmailReceipts([extra], async () => {
            if (++guardCalls === 3) throw Error('lost writer lock');
          }),
          /lost writer lock/,
        );
        assert.equal(JSON.stringify(await repo.findByUserId(userId)), original);
        assert.equal(await sourceCount(), 11);
      }
      const oldManifest = await new ReceiptRepository(db, 2).rebuildProjection(
        userId,
        generation,
        'prepare',
        allow,
      );
      await assert.rejects(
        repo.rebuildProjection(userId, generation, 'publish', allow, oldManifest.manifestId),
        /eligible repair manifest/,
      );
      const prepared = await repo.rebuildProjection(userId, generation, 'prepare', allow);
      await repo.rebuildProjection(userId, generation, 'publish', allow, prepared.manifestId);
      assert.equal(
        (await repo.rebuildProjection(userId, generation, 'publish', allow, prepared.manifestId))
          .changed,
        0,
      );
      await repo.rebuildProjection(userId, generation, 'rollback', allow, prepared.manifestId);
      assert.equal(
        (await repo.rebuildProjection(userId, generation, 'rollback', allow, prepared.manifestId))
          .changed,
        0,
      );
      assert.equal(await sourceCount(), 11);
      const stale = await repo.rebuildProjection(userId, generation, 'prepare', allow);
      const extra = structuredClone(batch.supportedReceipts[0]);
      extra.resolution.sourceMessageId = 'gmail:intervening';
      await repo.upsertEmailReceipts([extra], allow);
      const staleInspection = await readOnlyInspect(stale.manifestId);
      assert.ok(staleInspection.context.validation.issues.includes('REPAIR_EVIDENCE_CHANGED'));
      assert.equal(staleInspection.after.observations.length, 11);
      await assert.rejects(
        repo.rebuildProjection(userId, generation, 'publish', allow, stale.manifestId),
        /evidence changed/,
      );

      // Repair acquisition is separate from publication: stage the same evidence against an
      // empty account without changing its history, source coverage or event projections.
      await pool.query('DELETE FROM receipts WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM receipt_observations WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM receipt_import_batches WHERE user_id=$1', [userId]);
      const provenance = {
        sourceKind: 'provider_export',
        provider: 'uber_eats',
        sourceLabel: 'Redacted Uber test export',
        acquiredAt: '2026-09-12T00:00:00Z',
        successfulCompletion: true,
        rejectedRecords: 0,
        declaredCoverage: [
          { start: '2023-12-01T05:00:00Z', end: '2023-12-10T04:59:59Z' },
          { start: '2023-12-10T05:00:00Z', end: '2023-12-11T04:59:59Z' },
          { start: '2023-12-20T05:00:00Z', end: '2023-12-22T04:59:59Z' },
        ],
      };
      const csvStage = await repo.stageRepairSources(
        userId,
        generation,
        exported.receipts,
        provenance,
        allow,
      );
      assert.deepEqual(
        await repo.stageRepairSources(
          userId,
          generation,
          [...exported.receipts].reverse(),
          provenance,
          allow,
        ),
        csvStage,
      );
      const emailStage = await repo.stageRepairSources(
        userId,
        generation,
        batch.supportedReceipts,
        {
          ...provenance,
          sourceKind: 'retained_email',
          sourceLabel: 'Redacted screenshot transcriptions',
          declaredCoverage: undefined,
        },
        allow,
      );
      const stageIds = [csvStage.batchId, emailStage.batchId];
      const readOnlyPreview = (ids = [], account = userId, policy = 3) =>
        db.withTransaction(async (tx) => {
          await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
          assert.equal(
            (await tx.query('SHOW transaction_read_only')).rows[0].transaction_read_only,
            'on',
          );
          const readOnlyPort = {
            query: (sql, params) => {
              assert.match(sql.trim(), /^SELECT\b/);
              assert.doesNotMatch(sql, /FOR UPDATE|FOR SHARE/i);
              return tx.query(sql, params);
            },
          };
          return new ReceiptReconciliationStore(async () => {
            throw Error('Preview cannot write');
          }, policy).preview(readOnlyPort, account, ids);
        });
      const stagedPreview = await readOnlyPreview(stageIds);
      assert.equal(stagedPreview.context.importGeneration, generation);
      assert.equal(stagedPreview.context.servingPolicyVersion, 3);
      assert.equal(stagedPreview.context.proposedPolicyVersion, 3);
      assert.equal(
        stagedPreview.context.beforeFingerprint,
        evidenceFingerprint(stagedPreview.before),
      );
      assert.equal(
        stagedPreview.context.proposedFingerprint,
        evidenceFingerprint(stagedPreview.after),
      );
      const audit = buildReceiptReconciliationAudit(
        stagedPreview.before,
        stagedPreview.after,
        stagedPreview.stagedBatches,
        true,
      );
      assert.equal(audit.after.orderMetrics.attempts, 5);
      assert.equal(audit.after.orderMetrics.deliveries, 4);
      assert.equal(audit.after.orderMetrics.currencies[0].netSpend, 157.02);
      assert.equal(audit.orders.flatMap((r) => r.evidence).length, 11);
      assert.ok(audit.orders.flatMap((r) => r.evidence).every((o) => o.origin === 'staged'));
      assert.equal(audit.after.coverage.length, 3, 'declared coverage gaps are preserved');
      const repeatedPreview = await readOnlyPreview([...stageIds].reverse());
      assert.equal(
        repeatedPreview.context.beforeFingerprint,
        stagedPreview.context.beforeFingerprint,
      );
      assert.equal(
        repeatedPreview.context.stagedFingerprint,
        stagedPreview.context.stagedFingerprint,
      );
      assert.equal(
        repeatedPreview.context.projectionRevision,
        stagedPreview.context.projectionRevision,
      );
      assert.deepEqual(
        summarizeOrderMetrics(repeatedPreview.after.receipts),
        audit.after.orderMetrics,
      );
      const otherAccount = randomUUID();
      await pool.query(
        "INSERT INTO users(id,email,password) VALUES($1,'other-preview@example.com','test')",
        [otherAccount],
      );
      await assert.rejects(readOnlyPreview(stageIds, otherAccount), /missing or has a different/);
      await assert.rejects(readOnlyPreview(stageIds, userId, 2), /require policy 3/);
      await assert.rejects(readOnlyPreview([], randomUUID()), /no longer exists/);
      assert.equal((await repo.findByUserId(userId)).length, 0);
      assert.equal(await sourceCount(), 0);
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM receipt_import_batches WHERE user_id=$1', [
              userId,
            ])
          ).rows[0].count,
        ),
        0,
      );
      await assert.rejects(
        repo.stageRepairSources(userId, generation - 1, exported.receipts, provenance, allow),
        /generation is stale/,
      );
      await assert.rejects(
        repo.stageRepairSources(
          userId,
          generation,
          [{ ...exported.receipts[0], userId: randomUUID() }],
          provenance,
          allow,
        ),
        /must belong/,
      );
      const expiredBatch = randomUUID();
      await pool.query(
        `INSERT INTO receipt_repair_source_batches(id,user_id,import_generation,parser_version,fingerprint,provenance,expires_at)
        SELECT $2,user_id,import_generation,parser_version,repeat('f',64),provenance,NOW()-INTERVAL '1 second'
        FROM receipt_repair_source_batches WHERE id=$1`,
        [csvStage.batchId, expiredBatch],
      );
      await assert.rejects(
        repo.rebuildProjection(userId, generation, 'prepare', allow, undefined, [expiredBatch]),
        /source expired/,
      );
      await assert.rejects(readOnlyPreview([expiredBatch]), /source expired/);
      await assert.rejects(
        pool.query("UPDATE receipt_repair_source_batches SET provenance='{}' WHERE id=$1", [
          csvStage.batchId,
        ]),
        /immutable/,
      );
      await assert.rejects(
        pool.query("UPDATE receipt_repair_source_observations SET payload='{}' WHERE batch_id=$1", [
          csvStage.batchId,
        ]),
        /immutable/,
      );
      const stagedRepair = await repo.rebuildProjection(
        userId,
        generation,
        'prepare',
        allow,
        undefined,
        stageIds,
      );
      assert.equal(stagedRepair.orders, 5);
      assert.equal(await sourceCount(), 0);
      const preparedManifest = (
        await pool.query(
          'SELECT before_fingerprint,staged_fingerprint,after_state FROM receipt_repair_manifests WHERE user_id=$1 AND id=$2',
          [userId, stagedRepair.manifestId],
        )
      ).rows[0];
      assert.equal(preparedManifest.before_fingerprint, stagedPreview.context.beforeFingerprint);
      assert.equal(preparedManifest.staged_fingerprint, stagedPreview.context.stagedFingerprint);
      const inspected = await readOnlyInspect(stagedRepair.manifestId);
      assert.equal(inspected.context.mode, 'saved_manifest');
      assert.equal(inspected.context.status, 'prepared');
      assert.equal(inspected.context.provisionalIds, false);
      assert.deepEqual(JSON.parse(JSON.stringify(inspected.after)), preparedManifest.after_state);
      assert.equal(inspected.context.currentFingerprint, inspected.context.beforeFingerprint);
      assert.equal(inspected.context.proposedPolicyVersion, 3);
      assert.equal(inspected.context.servingPolicyVersion, 3);
      assert.deepEqual(inspected.context.validation.issues, []);
      assert.deepEqual(inspected.context.validation.sourceIssues, []);
      assert.equal(inspected.context.validation.action, 'publish');
      assert.equal(inspected.context.stagedDetailsAvailable, true);
      const savedAudit = buildReceiptReconciliationAudit(
        inspected.before,
        inspected.after,
        inspected.stagedBatches,
        true,
        'manifest',
      );
      assert.equal(savedAudit.after.orderMetrics.attempts, 5);
      assert.equal(savedAudit.after.orderMetrics.deliveries, 4);
      assert.equal(savedAudit.after.orderMetrics.currencies[0].netSpend, 157.02);
      assert.equal(savedAudit.orders.flatMap((o) => o.evidence).length, 11);
      assert.ok(savedAudit.orders.flatMap((o) => o.evidence).every((o) => o.origin === 'staged'));
      assert.equal((await repo.findByUserId(userId)).length, 0);
      await assert.rejects(
        readOnlyInspect(stagedRepair.manifestId, otherAccount),
        (e) => e.code === 'NOT_FOUND',
      );
      await assert.rejects(readOnlyInspect(randomUUID()), (e) => e.code === 'NOT_FOUND');
      const membership = (receipts) =>
        receipts
          .map((r) => ({
            observations: [...r.resolution.reconciliation.observationIds].sort(),
            outcome: r.resolution.orderOutcome,
            total: r.amountSpent,
          }))
          .sort((a, b) => a.observations.join().localeCompare(b.observations.join()));
      assert.deepEqual(
        membership(preparedManifest.after_state.receipts),
        membership(stagedPreview.after.receipts),
        'preview and immutable manifest agree on evidence, financial outcome and amount',
      );
      await assert.rejects(
        pool.query("UPDATE receipt_repair_manifests SET after_state='{}' WHERE id=$1", [
          stagedRepair.manifestId,
        ]),
        /immutable/,
      );
      const expiredManifest = randomUUID();
      await pool.query(
        `INSERT INTO receipt_repair_manifests(id,user_id,import_generation,policy_version,before_fingerprint,before_state,after_state,parser_version,staged_batch_ids,staged_fingerprint,expires_at)
        SELECT $2,user_id,import_generation,policy_version,before_fingerprint,before_state,after_state,parser_version,staged_batch_ids,staged_fingerprint,NOW()-INTERVAL '1 second'
        FROM receipt_repair_manifests WHERE id=$1`,
        [stagedRepair.manifestId, expiredManifest],
      );
      await assert.rejects(
        repo.rebuildProjection(userId, generation, 'publish', allow, expiredManifest),
        /manifest expired/,
      );
      const expiredInspection = await readOnlyInspect(expiredManifest);
      assert.ok(expiredInspection.context.validation.issues.includes('REPAIR_MANIFEST_EXPIRED'));
      assert.deepEqual(expiredInspection.after, inspected.after);
      let repairGuard = 0;
      await assert.rejects(
        repo.rebuildProjection(
          userId,
          generation,
          'publish',
          async () => {
            if (++repairGuard === 3) throw new Error('repair lost writer lock');
          },
          stagedRepair.manifestId,
        ),
        /lost writer lock/,
      );
      assert.equal(await sourceCount(), 0);
      assert.equal((await repo.findByUserId(userId)).length, 0);
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM receipt_import_batches WHERE user_id=$1', [
              userId,
            ])
          ).rows[0].count,
        ),
        0,
      );
      await repo.rebuildProjection(userId, generation, 'publish', allow, stagedRepair.manifestId);
      const publishedIds = (await repo.findByUserId(userId)).map((r) => r.id).sort();
      const publishedInspection = await readOnlyInspect(stagedRepair.manifestId);
      assert.equal(publishedInspection.context.status, 'published');
      assert.equal(publishedInspection.context.validation.action, 'rollback');
      assert.equal(
        publishedInspection.context.currentFingerprint,
        publishedInspection.context.lastCommittedFingerprint,
      );
      assert.deepEqual(
        publishedInspection.after,
        inspected.after,
        'publication must not rewrite the reviewed proposal',
      );
      assert.equal(publishedIds.length, 5);
      assert.equal(await sourceCount(), 11);
      const events = (
        await pool.query(
          'SELECT kind,amount,occurred_at,payload FROM receipt_order_events WHERE user_id=$1',
          [userId],
        )
      ).rows;
      assert.equal(events.length, 7);
      assert.equal(
        Math.round(
          events.filter((e) => e.kind === 'charge').reduce((sum, e) => sum + Number(e.amount), 0) *
            100,
        ),
        17950,
      );
      assert.equal(events.find((e) => e.kind === 'refund').amount, '22.48');
      assert.equal(events.find((e) => e.kind === 'refund').occurred_at, null);
      assert.equal(events.find((e) => e.kind === 'refund').payload.tender, 'provider_wallet');
      const projected = (
        await pool.query(
          'SELECT order_fulfillment,order_net_amount FROM receipts WHERE user_id=$1',
          [userId],
        )
      ).rows;
      assert.equal(projected.filter((r) => r.order_fulfillment === 'completed').length, 4);
      assert.equal(
        Math.round(projected.reduce((sum, r) => sum + Number(r.order_net_amount), 0) * 100),
        15702,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM receipt_import_batches WHERE user_id=$1 AND association_enabled',
              [userId],
            )
          ).rows[0].count,
        ),
        3,
      );
      const source = (
        await pool.query('SELECT id FROM receipt_observations WHERE user_id=$1 LIMIT 1', [userId])
      ).rows[0];
      await assert.rejects(
        pool.query(
          'UPDATE receipt_observations SET payload=payload || \'{"amountSpent":999}\'::jsonb WHERE id=$1',
          [source.id],
        ),
        /immutable/,
      );
      await repo.rebuildProjection(userId, generation, 'rollback', allow, stagedRepair.manifestId);
      const rolledBackInspection = await readOnlyInspect(stagedRepair.manifestId);
      assert.equal(rolledBackInspection.context.status, 'rolled_back');
      assert.equal(rolledBackInspection.context.validation.action, null);
      assert.equal(
        rolledBackInspection.context.currentFingerprint,
        rolledBackInspection.context.lastCommittedFingerprint,
      );
      assert.deepEqual(
        rolledBackInspection.after,
        inspected.after,
        'rollback must not replace the original proposal with current History',
      );
      assert.equal((await repo.findByUserId(userId)).length, 0);
      assert.equal(await sourceCount(), 11, 'rollback preserves acquired evidence');
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM receipt_observations WHERE user_id=$1 AND NOT association_enabled AND receipt_id IS NULL AND last_receipt_id IS NOT NULL',
              [userId],
            )
          ).rows[0].count,
        ),
        11,
      );
      assert.equal(
        Number(
          (await pool.query('SELECT count(*) FROM receipt_order_events WHERE user_id=$1', [userId]))
            .rows[0].count,
        ),
        0,
      );
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM receipt_import_batches WHERE user_id=$1 AND association_enabled',
              [userId],
            )
          ).rows[0].count,
        ),
        0,
      );
      assert.equal(
        (
          await repo.rebuildProjection(
            userId,
            generation,
            'rollback',
            allow,
            stagedRepair.manifestId,
          )
        ).changed,
        0,
      );
      await repo.upsertEmailReceipts(batch.supportedReceipts, allow);
      assert.equal(
        (await repo.findByUserId(userId)).length,
        0,
        'ordinary retry cannot reactivate rolled-back evidence',
      );
      const inactivePreview = await readOnlyPreview();
      assert.equal(inactivePreview.after.receipts.length, 0);
      const reactivationPreview = await readOnlyPreview(stageIds);
      assert.deepEqual(reactivationPreview.after.receipts.map((r) => r.id).sort(), publishedIds);
      const reactivationAudit = buildReceiptReconciliationAudit(
        reactivationPreview.before,
        reactivationPreview.after,
        reactivationPreview.stagedBatches,
        true,
      );
      assert.equal(
        reactivationAudit.before.sources.reduce((n, s) => n + s.disabled, 0),
        11,
      );
      assert.equal(
        reactivationAudit.after.sourceObservations,
        11,
        'staged copies reuse existing immutable observations',
      );
      assert.ok(
        reactivationAudit.orders
          .flatMap((r) => r.evidence)
          .every((o) => o.origin === 'stored' && o.stagedBatchIds.length === 1),
      );
      assert.equal(
        (await repo.findByUserId(userId)).length,
        0,
        'preview does not reactivate canonical records',
      );
      const reactivated = await repo.rebuildProjection(
        userId,
        generation,
        'prepare',
        allow,
        undefined,
        stageIds,
      );
      await repo.rebuildProjection(userId, generation, 'publish', allow, reactivated.manifestId);
      assert.deepEqual(
        (await repo.findByUserId(userId)).map((r) => r.id).sort(),
        publishedIds,
        'explicit reactivation keeps stable canonical IDs',
      );
      assert.equal(await sourceCount(), 11);
      // Reprocessing must correct old parsed facts, not treat a second interpretation
      // of the same message as another independent receipt revision.
      await pool.query('DELETE FROM receipts WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM receipt_observations WHERE user_id=$1', [userId]);
      await pool.query('DELETE FROM receipt_import_batches WHERE user_id=$1', [userId]);
      const legacyRepo = new ReceiptRepository(db, 2);
      const legacyExport = await new CsvImportService().parseUberEatsCsv(
        Buffer.from(fixture.csv),
        userId,
        'America/Toronto',
        2,
      );
      const legacyEmails = await new ReceiptEmailBatchExtractor(
        new ReceiptExtractor({}, 2),
        { capture: async () => {} },
        10,
        Date.now,
        2,
      ).extract(
        fixture.emails.map((e) => ({
          userId,
          provider: 'gmail',
          providerMessageId: e.id,
          from: 'receipts@uber.com',
          to: 'redacted',
          subject: 'Your Uber Eats receipt',
          body: e.text
            .split('\n')
            .map((line) => `<p>${line}</p>`)
            .join(''),
          receivedAt: new Date('2023-12-11T17:00Z'),
        })),
        'America/Toronto',
        { userId, trigger: 'manual' },
      );
      await legacyRepo.replaceProviderExport(userId, legacyExport.receipts, allow);
      await legacyRepo.upsertEmailReceipts(legacyEmails.supportedReceipts, allow);
      const legacyRecords = await repo.findByUserId(userId);
      const expectedOrder = [...legacyRecords]
        .sort((a, b) => b.orderDate.getTime() - a.orderDate.getTime() || b.id.localeCompare(a.id))
        .map((r) => r.id);
      assert.deepEqual(
        legacyRecords.map((r) => r.id),
        expectedOrder,
        'equal-time receipts have a stable canonical tie-breaker',
      );
      const pageIds = [];
      for (let offset = 0; offset < legacyRecords.length; offset++) {
        const page = await repo.findPage({ userId }, 1, offset);
        pageIds.push(...page.receipts.map((receipt) => receipt.id));
      }
      assert.deepEqual(
        pageIds,
        expectedOrder,
        'pagination cannot repeat or skip equal-time receipts',
      );
      const legacyProjection = JSON.stringify(legacyRecords);
      const legacySourceCount = await sourceCount();
      const reparsed = await repo.rebuildProjection(
        userId,
        generation,
        'prepare',
        allow,
        undefined,
        stageIds,
      );
      assert.equal(
        reparsed.orders,
        5,
        're-parsed source interpretations are not independent purchases',
      );
      await repo.rebuildProjection(userId, generation, 'publish', allow, reparsed.manifestId);
      const mixedMetrics = summarizeOrderMetrics(await repo.findByUserId(userId));
      assert.equal(mixedMetrics.currencies[0].netSpend, 157.02);
      assert.equal(mixedMetrics.confirmedRefunds, 1);
      assert.equal(
        await sourceCount(),
        legacySourceCount + 11,
        'both parser generations remain retained',
      );
      await repo.rebuildProjection(userId, generation, 'rollback', allow, reparsed.manifestId);
      assert.equal(JSON.stringify(await repo.findByUserId(userId)), legacyProjection);
      assert.equal(await sourceCount(), legacySourceCount + 11);
      const missingSource = await repo.rebuildProjection(
        userId,
        generation,
        'prepare',
        allow,
        undefined,
        stageIds,
      );
      const intactSourceInspection = await readOnlyInspect(missingSource.manifestId);
      await pool.query(
        'DELETE FROM receipt_repair_source_observations WHERE id=(SELECT id FROM receipt_repair_source_observations WHERE batch_id=$1 LIMIT 1)',
        [emailStage.batchId],
      );
      await assert.rejects(
        repo.rebuildProjection(userId, generation, 'publish', allow, missingSource.manifestId),
        /Staged evidence changed/,
      );
      const missingSourceInspection = await readOnlyInspect(missingSource.manifestId);
      assert.equal(missingSourceInspection.context.stagedDetailsAvailable, false);
      assert.ok(
        missingSourceInspection.context.validation.sourceIssues.includes('REPAIR_SOURCE_CHANGED'),
      );
      assert.ok(
        missingSourceInspection.context.validation.issues.includes('REPAIR_SOURCE_CHANGED'),
      );
      assert.deepEqual(missingSourceInspection.after, intactSourceInspection.after);
      assert.equal(
        summarizeOrderMetrics(missingSourceInspection.after.receipts).currencies[0].netSpend,
        157.02,
      );
      const savedBefore = buildReceiptReconciliationAudit(
        missingSourceInspection.before,
        missingSourceInspection.after,
        [],
        true,
        'manifest',
      );
      assert.equal(
        savedBefore.originalOrders.length,
        missingSourceInspection.before.receipts.length,
      );
      assert.deepEqual(
        savedBefore.originalOrders.map((r) => r.recordedProjectionAmount),
        missingSourceInspection.before.receipts.map((r) => r.amountSpent),
      );
      assert.equal(JSON.stringify(await repo.findByUserId(userId)), legacyProjection);
      await pool.query('UPDATE users SET import_generation=import_generation+1 WHERE id=$1', [
        userId,
      ]);
      assert.ok(
        (await readOnlyInspect(missingSource.manifestId)).context.validation.issues.includes(
          'REPAIR_GENERATION_STALE',
        ),
      );
      // Real provider-neutral extraction and persistence: two later, separately
      // identified refund installments revise one older order across Gmail/Outlook.
      const adjustmentUser = randomUUID();
      await pool.query(
        "INSERT INTO users(id,email,password,timezone) VALUES($1,'adjustment-test@example.com','test','America/Toronto')",
        [adjustmentUser],
      );
      const providerOrderId = randomUUID();
      const link = `<a href="https://www.ubereats.com/orders/${providerOrderId}">View order</a>`;
      const messages = [
        {
          provider: 'gmail',
          providerMessageId: 'original',
          receivedAt: new Date('2023-12-11T17:00Z'),
          body: `<p>Uber Eats</p><p>Total CA$40.00</p><p>December 10, 2023</p><p>Here's your receipt from Pizza Place (Bank Street).</p><p>Delivered by Courier</p>${link}`,
        },
        {
          provider: 'microsoft',
          providerMessageId: 'refund-one',
          receivedAt: new Date('2024-01-10T17:00Z'),
          body: `<p>Uber Eats</p><p>We refunded CA$10.00 to your Uber Cash for your order.</p><p>Refund ID: refund-one</p><p>Refund issued on January 10, 2024</p>${link}`,
        },
        {
          provider: 'gmail',
          providerMessageId: 'refund-two',
          receivedAt: new Date('2024-01-11T17:00Z'),
          body: `<p>Uber Eats</p><p>We refunded CA$10.00 to your Uber Cash for your order.</p><p>Refund ID: refund-two</p><p>Refund issued on January 11, 2024 12:00 PM</p>${link}`,
        },
        {
          provider: 'gmail',
          providerMessageId: 'updated-balance',
          receivedAt: new Date('2024-01-10T20:00Z'),
          body: `<p>Uber Eats</p><p>Total CA$30.00</p><p>December 10, 2023</p><p>We updated your receipt for Pizza Place (Bank Street).</p><p>Previous Total CA$40.00</p><p>New Total CA$30.00</p><p>Payments</p><p>Uber Cash -CA$10.00</p><p>Refund ID: refund-one</p><p>Switch Payment Method</p>${link}`,
        },
        {
          provider: 'microsoft',
          providerMessageId: 'final-balance',
          receivedAt: new Date('2024-01-11T18:00Z'),
          body: `<p>Uber Eats</p><p>Total CA$20.00</p><p>December 10, 2023</p><p>We updated your receipt for Pizza Place (Bank Street).</p><p>Previous Total CA$30.00</p><p>New Total CA$20.00</p><p>Payments</p><p>Uber Cash -CA$10.00</p><p>Refund ID: refund-one</p><p>Uber Cash -CA$10.00</p><p>Refund ID: refund-two</p><p>Switch Payment Method</p>${link}`,
        },
      ];
      const adjustmentBatch = await new ReceiptEmailBatchExtractor(
        new ReceiptExtractor({}, 3),
        { capture: async () => {} },
        10,
        Date.now,
        3,
      ).extract(
        messages.map((message) => ({
          ...message,
          userId: adjustmentUser,
          from: 'receipts@uber.com',
          to: 'redacted',
          subject: 'Your order',
        })),
        'America/Toronto',
        { userId: adjustmentUser, trigger: 'manual' },
      );
      assert.deepEqual(adjustmentBatch.errors, []);
      assert.equal(adjustmentBatch.supportedReceipts.length, 5);
      await repo.upsertEmailReceipts([adjustmentBatch.supportedReceipts[1]], allow);
      let adjusted = await repo.findByUserId(adjustmentUser);
      assert.equal(adjusted.length, 1);
      assert.equal(adjusted[0].resolution.orderOutcome.kind, 'unlinked_adjustment');
      assert.equal(adjusted[0].resolution.orderOutcome.netAmount, null);
      await repo.upsertEmailReceipts([adjustmentBatch.supportedReceipts[0]], allow);
      adjusted = await repo.findByUserId(adjustmentUser);
      assert.equal(adjusted.length, 1);
      assert.equal(adjusted[0].amountSpent, 30);
      const stableOrderId = adjusted[0].id;
      await repo.upsertEmailReceipts([adjustmentBatch.supportedReceipts[3]], allow);
      adjusted = await repo.findByUserId(adjustmentUser);
      assert.equal(
        adjusted[0].amountSpent,
        30,
        'the first revised receipt includes the already seen refund',
      );
      await repo.upsertEmailReceipts([adjustmentBatch.supportedReceipts[2]], allow);
      adjusted = await repo.findByUserId(adjustmentUser);
      assert.equal(
        adjusted[0].amountSpent,
        20,
        'a distinct later refund updates the revised balance',
      );
      assert.equal(adjusted[0].resolution.orderOutcome.confirmedRefundAmount, 20);
      await repo.upsertEmailReceipts([adjustmentBatch.supportedReceipts[4]], allow);
      await repo.upsertEmailReceipts([...adjustmentBatch.supportedReceipts].reverse(), allow);
      adjusted = await repo.findByUserId(adjustmentUser);
      assert.equal(adjusted.length, 1);
      assert.equal(adjusted[0].id, stableOrderId);
      assert.equal(adjusted[0].orderDate.toISOString().slice(0, 10), '2023-12-10');
      assert.equal(adjusted[0].amountSpent, 20);
      assert.equal(adjusted[0].resolution.orderOutcome.confirmedRefundAmount, 20);
      assert.equal(summarizeOrderMetrics(adjusted).attempts, 1);
      assert.equal(summarizeOrderMetrics(adjusted).deliveries, 1);
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
              adjustmentUser,
            ])
          ).rows[0].count,
        ),
        5,
      );
      assert.equal(
        Number(
          (
            await pool.query('SELECT count(*) FROM receipt_order_events WHERE user_id=$1', [
              adjustmentUser,
            ])
          ).rows[0].count,
        ),
        3,
      );

      // A revised receipt is still useful if the original message was never
      // acquired. Match the purchase by its unique merchant/day, not its payment
      // time or the stale export balance, in either import order.
      for (const emailFirst of [true, false]) {
        for (const newTotal of [40, 0]) {
          const revisionUser = randomUUID();
          await pool.query(
            "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
            [revisionUser, `revision-${revisionUser}@example.com`],
          );
          const metroExport = structuredClone(exported.receipts[3]);
          metroExport.userId = revisionUser;
          assert.match(metroExport.restaurantName, /Metro/);
          const refund = (48.46 - newTotal).toFixed(2);
          const revisedBatch = await new ReceiptEmailBatchExtractor(
            new ReceiptExtractor({}, 3),
            { capture: async () => {} },
            10,
            Date.now,
            3,
          ).extract(
            [
              {
                userId: revisionUser,
                provider: 'gmail',
                providerMessageId: 'revised-without-original',
                receivedAt: new Date('2023-12-12T17:00Z'),
                from: 'receipts@uber.com',
                to: 'redacted',
                subject: 'Your updated Uber Eats receipt',
                body: `<p>Uber Eats</p><p>Total CA$${newTotal.toFixed(2)}</p><p>December 10, 2023</p><p>We updated your receipt for Metro (2515 Bank Street Ottawa).</p><p>Your refund has been applied.</p><p>Previous Total CA$48.46</p><p>New Total CA$${newTotal.toFixed(2)}</p><p>Payments</p><p>Uber Cash -CA$${refund}</p><p>Switch Payment Method</p>`,
              },
            ],
            'America/Toronto',
            { userId: revisionUser, trigger: 'manual' },
          );
          assert.deepEqual(revisedBatch.errors, []);
          assert.equal(revisedBatch.supportedReceipts.length, 1);
          assert.equal(revisedBatch.supportedReceipts[0].externalId, undefined);
          if (emailFirst) {
            await repo.upsertEmailReceipts(revisedBatch.supportedReceipts, allow);
            const orphan = await repo.findByUserId(revisionUser);
            assert.equal(orphan[0].resolution.orderOutcome.kind, 'unlinked_adjustment');
            assert.equal(summarizeOrderMetrics(orphan).attempts, 0);
            await repo.replaceProviderExport(revisionUser, [metroExport], allow);
          } else {
            await repo.replaceProviderExport(revisionUser, [metroExport], allow);
            await repo.upsertEmailReceipts(revisedBatch.supportedReceipts, allow);
          }
          const combined = await repo.findByUserId(revisionUser);
          assert.equal(combined.length, 1);
          assert.equal(combined[0].resolution.reconciliation.method, 'unique_day');
          assert.equal(combined[0].amountSpent, newTotal);
          assert.equal(combined[0].resolution.orderOutcome.netAmount, newTotal);
          assert.equal(combined[0].resolution.orderOutcome.confirmedRefundAmount, Number(refund));
          assert.equal(combined[0].resolution.orderOutcome.fulfillment, 'completed');
          assert.deepEqual(combined[0].items, metroExport.items);
          assert.equal(summarizeOrderMetrics(combined).attempts, 1);
          assert.equal(summarizeOrderMetrics(combined).deliveries, 1);
          await repo.upsertEmailReceipts(revisedBatch.supportedReceipts, allow);
          await repo.replaceProviderExport(revisionUser, [metroExport], allow);
          assert.equal((await repo.findByUserId(revisionUser))[0].id, combined[0].id);
          assert.equal(
            Number(
              (
                await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
                  revisionUser,
                ])
              ).rows[0].count,
            ),
            2,
            'retries preserve exactly the two immutable source observations',
          );

          const laterExport = structuredClone(metroExport);
          laterExport.externalId = `second-${randomUUID()}`;
          laterExport.orderDate = new Date('2023-12-10T23:00:00Z');
          laterExport.deliveryTime = new Date('2023-12-10T23:30:00Z');
          laterExport.amountSpent = 30;
          laterExport.resolution.orderEvidence.recordedTotal = 30;
          laterExport.resolution.orderEvidence.timestamps = [];
          await repo.replaceProviderExport(revisionUser, [laterExport, metroExport], allow);
          const reconsidered = await repo.findByUserId(revisionUser);
          assert.equal(
            reconsidered.length,
            3,
            'later same-day evidence reopens the inferred match',
          );
          assert.equal(summarizeOrderMetrics(reconsidered).attempts, 2);
          assert.equal(summarizeOrderMetrics(reconsidered).unlinkedAdjustments, 1);
          assert.ok(
            reconsidered.every((receipt) => receipt.resolution.reconciliation.status !== 'merged'),
          );
          assert.equal(
            Number(
              (
                await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
                  revisionUser,
                ])
              ).rows[0].count,
            ),
            3,
            'splitting an inferred match preserves all source evidence',
          );
        }
      }
    } finally {
      await pool.end();
      // This identifier was generated above and contains only the test prefix and hex.
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
