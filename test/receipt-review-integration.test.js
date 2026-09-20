const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const {
  ReceiptReconciliationStore,
  evidenceFingerprint,
} = require('../dist/services/data/ReceiptReconciliationStore');
const { ReceiptRebuildService } = require('../dist/services/receipt/ReceiptRebuildService');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const { activeReceiptReviews } = require('../dist/services/receipt/ReceiptReviewDecisions');
const {
  buildReceiptReconciliationAudit,
} = require('../dist/services/receipt/ReceiptReconciliationAudit');
const { decemberSourceObservations } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'review drafts, publish, reimport, supersession and rollback preserve December evidence transactionally',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_reviews_${randomUUID().replaceAll('-', '')}`;
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
    const allow = async () => {};
    const repo = new ReceiptRepository(db, 3);
    const store = new ReceiptReconciliationStore(async () => {
      throw new Error('Inspection cannot write');
    }, 3);
    const load = (userId) => db.withTransaction((tx) => store.load(tx, userId));
    let invalidations = 0;
    const service = new ReceiptRebuildService(
      repo,
      {
        invalidateAllUserCaches: async () => {
          invalidations++;
        },
      },
      { assertLockOwned: allow },
    );
    const userId = randomUUID();
    const lock = { userId };
    const snapshotSources = (snapshot) =>
      snapshot.observations.map((source) => ({ id: source.id, receipt: source.receipt }));
    try {
      // Also verifies upgrade from an existing schema with immutable, unbound audit rows.
      await new MigrationRunner(
        { getClient: () => pool.connect() },
        migrations.filter((m) => m.version <= 30),
      ).run();
      await pool.query(
        "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
        [userId, `${userId}@example.com`],
      );
      const generation = Number(
        (await pool.query('SELECT import_generation FROM users WHERE id=$1', [userId])).rows[0]
          .import_generation,
      );
      const legacyReview = randomUUID();
      await pool.query(
        `INSERT INTO receipt_association_reviews(id,user_id,import_generation,decision,observation_ids,reason,reviewer)
        VALUES($1,$2,$3,'keep_separate',$4,'Historical unbound audit','fixture-reviewer')`,
        [legacyReview, userId, generation, [randomUUID(), randomUUID()]],
      );
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const sources = await decemberSourceObservations();
      sources.forEach((source) => {
        source.receipt.userId = userId;
      });
      const exported = sources
        .filter((source) => source.receipt.dataSource === 'csv')
        .map((source) => source.receipt);
      const emails = sources
        .filter((source) => source.receipt.dataSource === 'email')
        .map((source) => source.receipt);
      await repo.replaceProviderExport(userId, exported, allow);
      await repo.upsertEmailReceipts(emails, allow);
      const before = await load(userId);
      const source = (name) =>
        before.observations.find((o) => o.receipt.resolution?.sourceMessageId === `gmail:${name}`);
      const zero = before.observations.find(
        (o) => o.receipt.dataSource === 'csv' && o.receipt.amountSpent === 0,
      );
      const merge = {
        id: randomUUID(),
        decision: 'merge',
        observationIds: [zero.id, source('pizza-original').id],
        reason: 'Reviewed December screenshot and export',
        reviewer: 'fixture-reviewer',
      };
      const prepare = (changes, actor = userId, actorGeneration = generation) =>
        service.executeWithLock(
          actor,
          actorGeneration,
          'prepare',
          { userId: actor },
          undefined,
          [],
          changes,
        );
      const prepared = await prepare([merge]);
      assert.equal(invalidations, 0);
      assert.deepEqual(
        await load(userId),
        before,
        'draft leaves receipts, events and published decisions unchanged',
      );
      const inspection = await db.withTransaction((tx) =>
        store.inspectManifest(tx, userId, prepared.manifestId),
      );
      assert.equal(inspection.after.reviews.length, 2);
      assert.equal(activeReceiptReviews(inspection.after.reviews)[0].id, merge.id);
      const audit = buildReceiptReconciliationAudit(
        inspection.before,
        inspection.after,
        [],
        true,
        'manifest',
      );
      assert.equal(
        audit.reviewHistory.find((review) => review.id === merge.id).includedInOriginalSnapshot,
        false,
      );
      assert.equal(
        audit.reviewHistory.find((review) => review.id === merge.id).tipInProposedSnapshot,
        true,
      );
      let guardCalls = 0;
      await assert.rejects(
        repo.rebuildProjection(
          userId,
          generation,
          'publish',
          async () => {
            if (++guardCalls === 3) throw new Error('writer fence lost');
          },
          prepared.manifestId,
        ),
        /writer fence lost/,
      );
      assert.deepEqual(
        await load(userId),
        before,
        'transaction failure cannot publish a review alone',
      );
      await service.executeWithLock(userId, generation, 'publish', lock, prepared.manifestId);
      assert.equal(invalidations, 1);
      const published = await load(userId);
      assert.equal(published.receipts.length, 5);
      assert.deepEqual(snapshotSources(published), snapshotSources(before));
      assert.equal(published.reviews.length, 2);
      assert.equal(summarizeOrderMetrics(published.receipts).currencies[0].netSpend, 157.02);
      await service.executeWithLock(userId, generation, 'publish', lock, prepared.manifestId);
      assert.deepEqual(await load(userId), published, 'publication retry is idempotent');
      const oldPolicy = new ReceiptRepository(db, 2);
      await assert.rejects(oldPolicy.upsertEmailReceipts(emails, allow), {
        code: 'REPAIR_POLICY_STALE',
      });
      await repo.upsertEmailReceipts([...emails].reverse(), allow);
      await repo.replaceProviderExport(userId, [...exported].reverse(), allow);
      assert.deepEqual(
        await load(userId),
        published,
        'reimports keep published membership and canonical references',
      );
      await assert.rejects(
        pool.query("UPDATE receipt_association_reviews SET reason='changed' WHERE id=$1", [
          merge.id,
        ]),
        /immutable/,
      );
      await assert.rejects(prepare([{ ...merge, reason: 'Different review under same ID' }]), {
        code: 'RECEIPT_REVIEW_IDEMPOTENCY_CONFLICT',
      });
      await assert.rejects(
        prepare([{ ...merge, id: randomUUID().toUpperCase(), decision: 'keep_separate' }]),
        {
          code: 'RECEIPT_REVIEW_CONFLICT',
        },
      );

      const separate = {
        ...merge,
        id: randomUUID(),
        decision: 'keep_separate',
        supersedesId: merge.id,
        reason: 'Synthetic reversal for rollback verification',
      };
      const second = await prepare([separate]);
      await service.executeWithLock(userId, generation, 'publish', lock, second.manifestId);
      const separated = await load(userId);
      assert.equal(separated.receipts.length, 6);
      assert.equal(activeReceiptReviews(separated.reviews)[0].id, separate.id);
      await service.executeWithLock(userId, generation, 'rollback', lock, second.manifestId);
      const restored = await load(userId);
      assert.deepEqual(restored.receipts, published.receipts);
      assert.deepEqual(restored.observations, published.observations);
      assert.equal(
        restored.reviews.length,
        4,
        'rollback appends a compensating merge and retains both decisions',
      );
      assert.equal(activeReceiptReviews(restored.reviews)[0].decision, 'merge');
      await service.executeWithLock(userId, generation, 'rollback', lock, second.manifestId);
      assert.deepEqual(
        await load(userId),
        restored,
        'rollback retry cannot append another reversal',
      );
      await repo.upsertEmailReceipts(emails, allow);
      const reimported = await load(userId);
      assert.equal(reimported.receipts.length, 5);
      assert.equal(summarizeOrderMetrics(reimported.receipts).currencies[0].netSpend, 157.02);
      assert.deepEqual(
        reimported.receipts.map((r) => r.id),
        published.receipts.map((r) => r.id),
      );
      assert.deepEqual(snapshotSources(reimported), snapshotSources(before));
      const revoke = {
        id: randomUUID(),
        decision: 'revoke',
        supersedesId: activeReceiptReviews(reimported.reviews)[0].id,
        reason: 'Return to inferred associations',
        reviewer: 'fixture-reviewer',
      };
      const stale = await prepare([revoke]);
      const additional = structuredClone(emails[0]);
      additional.resolution.sourceMessageId = 'gmail:newly-arrived-document';
      await repo.upsertEmailReceipts([additional], allow);
      const withAdditional = await load(userId);
      await assert.rejects(
        service.executeWithLock(userId, generation, 'publish', lock, stale.manifestId),
        { code: 'REPAIR_EVIDENCE_CHANGED' },
      );
      assert.deepEqual(
        await load(userId),
        withAdditional,
        'stale draft cannot change active decisions',
      );
      await assert.rejects(prepare([revoke], userId, generation + 1), {
        code: 'REPAIR_GENERATION_STALE',
      });
      await assert.rejects(
        service.executeWithLock(
          userId,
          generation,
          'prepare',
          { userId: randomUUID() },
          undefined,
          [],
          [revoke],
        ),
        { code: 'REPAIR_LOCK_SCOPE_MISMATCH' },
      );
      await assert.rejects(
        service.executeWithLock(
          userId,
          generation,
          'publish',
          lock,
          prepared.manifestId,
          [],
          [revoke],
        ),
        { code: 'REPAIR_MANIFEST_REQUIRED' },
      );
      assert.equal(evidenceFingerprint(await load(userId)), evidenceFingerprint(withAdditional));
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
