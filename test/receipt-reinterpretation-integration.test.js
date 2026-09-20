const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const { decemberSourceObservations } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'reinterpreted December evidence stays five orders across imports, retries, transactional repair and rollback',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_reinterpret_${randomUUID().replaceAll('-', '')}`;
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
    const sourceRows = async (userId) =>
      (
        await pool.query(
          'SELECT id,payload,parser_version,created_at FROM receipt_observations WHERE user_id=$1 ORDER BY id',
          [userId],
        )
      ).rows;
    const setup = async (provider) => {
      const userId = randomUUID();
      await pool.query(
        "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
        [userId, `${userId}@example.com`],
      );
      const sources = await decemberSourceObservations();
      for (const o of sources) {
        o.receipt.userId = userId;
        if (o.receipt.resolution.sourceMessageId)
          o.receipt.resolution.sourceMessageId = o.receipt.resolution.sourceMessageId.replace(
            'gmail:',
            `${provider}:`,
          );
      }
      const exported = sources.filter((o) => o.receipt.dataSource === 'csv').map((o) => o.receipt);
      const emails = sources.filter((o) => o.receipt.dataSource === 'email').map((o) => o.receipt);
      // Synthetic earlier parser interpretation of the exact retained December rows:
      // local wall times were incorrectly read as UTC. No source row is changed.
      const legacy = structuredClone(exported);
      for (const receipt of legacy) {
        delete receipt.resolution.orderEvidence;
        receipt.orderDate = new Date(receipt.orderDate.getTime() - 5 * 3600000);
        if (receipt.deliveryTime)
          receipt.deliveryTime = new Date(receipt.deliveryTime.getTime() - 5 * 3600000);
        receipt.resolution.rows.reverse();
      }
      const generation = Number(
        (await pool.query('SELECT import_generation FROM users WHERE id=$1', [userId])).rows[0]
          .import_generation,
      );
      return { userId, generation, exported, emails, legacy };
    };
    const assertDecember = async (userId) => {
      const records = await repo.findByUserId(userId);
      assert.equal(records.length, 5);
      const metrics = summarizeOrderMetrics(records);
      assert.equal(metrics.deliveries, 4);
      assert.equal(metrics.canceled, 1);
      assert.equal(metrics.confirmedRefunds, 1);
      assert.equal(metrics.currencies[0].netSpend, 157.02);
      const events = records.flatMap((r) => r.resolution.orderOutcome.events);
      assert.equal(events.filter((e) => e.kind === 'charge').length, 6);
      const refunds = events.filter((e) => e.kind === 'refund');
      assert.equal(refunds.length, 1);
      assert.equal(refunds[0].amount, 22.48);
      assert.equal(refunds[0].tender, 'provider_wallet');
      assert.equal((await sourceRows(userId)).length, 16);
      assert.equal(
        new Set(records.flatMap((r) => r.resolution.reconciliation.observationIds)).size,
        16,
      );
      return records;
    };
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      for (const provider of ['gmail', 'microsoft']) {
        for (const legacyFirst of [true, false]) {
          const { userId, exported, emails, legacy } = await setup(provider);
          if (legacyFirst) {
            await repo.replaceProviderExport(userId, legacy, allow);
            const before = await sourceRows(userId);
            const beforeOrders = await repo.findByUserId(userId);
            let guardCalls = 0;
            await assert.rejects(
              repo.replaceProviderExport(userId, exported, async () => {
                if (++guardCalls === 3) throw Error('writer generation changed');
              }),
              /writer generation changed/,
            );
            assert.deepEqual(await sourceRows(userId), before);
            assert.deepEqual(await repo.findByUserId(userId), beforeOrders);
          }
          for (const email of [...emails].reverse()) await repo.upsertEmailReceipts([email], allow);
          await repo.replaceProviderExport(userId, [...exported].reverse(), allow);
          const currentIds = (await repo.findByUserId(userId)).map((r) => r.id).sort();
          if (!legacyFirst) await repo.replaceProviderExport(userId, legacy, allow);
          const orders = await assertDecember(userId);
          assert.deepEqual(
            orders.map((r) => r.id).sort(),
            currentIds,
            'later old interpretations do not replace canonical IDs',
          );
          const beforeRetry = await sourceRows(userId);
          await repo.replaceProviderExport(userId, [...legacy, ...exported].reverse(), allow);
          const result = await repo.upsertEmailReceipts(emails, allow);
          assert.equal(result.newOrders, 0);
          assert.equal(result.updatedOrders, 0);
          assert.deepEqual(
            await sourceRows(userId),
            beforeRetry,
            'all source payloads remain immutable',
          );
          assert.deepEqual(await assertDecember(userId), orders);
        }
      }
      // The same group policy repairs saved associations, without acquiring documents.
      const { userId, generation, exported, emails, legacy } = await setup('gmail');
      const oldRepo = new ReceiptRepository(db, 2);
      await oldRepo.replaceProviderExport(userId, [...legacy, ...exported], allow);
      for (const email of emails) await oldRepo.upsertEmailReceipts([email], allow);
      const original = await oldRepo.findByUserId(userId);
      const evidence = await sourceRows(userId);
      const manifest = await repo.rebuildProjection(userId, generation, 'prepare', allow);
      assert.equal(manifest.orders, 5);
      assert.deepEqual(
        await repo.findByUserId(userId),
        original,
        'preparation never changes serving orders',
      );
      await repo.rebuildProjection(userId, generation, 'publish', allow, manifest.manifestId);
      await assertDecember(userId);
      assert.deepEqual(await sourceRows(userId), evidence);
      await repo.rebuildProjection(userId, generation, 'rollback', allow, manifest.manifestId);
      assert.deepEqual(await oldRepo.findByUserId(userId), original);
      assert.deepEqual(await sourceRows(userId), evidence);

      // A later refund can explicitly reference the stored ID of an old parser's
      // intermediate receipt. Reprocessing that receipt must not break the chain.
      const chainAccount = await setup('gmail');
      const purchase = chainAccount.emails.find((r) => r.amountSpent === 22.48);
      purchase.externalId = randomUUID();
      const oldEdit = structuredClone(purchase);
      oldEdit.resolution.sourceMessageId = 'gmail:intermediate';
      delete oldEdit.resolution.orderEvidence;
      await repo.upsertEmailReceipts([purchase, oldEdit], allow);
      const storedOld = (await sourceRows(chainAccount.userId)).find(
        (o) => o.payload.resolution.sourceMessageId === 'gmail:intermediate',
      );
      const updated = structuredClone(oldEdit);
      updated.amountSpent = 10;
      updated.resolution.orderEvidence = {
        ...structuredClone(purchase.resolution.orderEvidence),
        documentKind: 'updated',
        recordedTotal: 10,
        previousTotal: 22.48,
        revisionOf: purchase.resolution.sourceMessageId,
        refundConfirmed: true,
        timestamps: [],
        payments: [],
      };
      const refunded = structuredClone(updated);
      refunded.amountSpent = 0;
      refunded.resolution.sourceMessageId = 'gmail:final';
      Object.assign(refunded.resolution.orderEvidence, {
        documentKind: 'refund',
        recordedTotal: 0,
        previousTotal: 10,
        revisionOf: storedOld.id,
      });
      await repo.upsertEmailReceipts([refunded], allow);
      await repo.upsertEmailReceipts([updated], allow);
      const chainOrders = await repo.findByUserId(chainAccount.userId);
      assert.equal(chainOrders.length, 1);
      assert.equal(chainOrders[0].resolution.orderOutcome.netAmount, 0);
      assert.equal(chainOrders[0].resolution.orderOutcome.confirmedRefundAmount, 22.48);
      assert.equal(chainOrders[0].resolution.orderOutcome.refundStatus, 'full');
      assert.ok(
        !chainOrders[0].resolution.orderOutcome.financialObservationIds.includes(storedOld.id),
      );
      assert.equal((await sourceRows(chainAccount.userId)).length, 4);
      await repo.upsertEmailReceipts([oldEdit, updated, refunded], allow);
      assert.deepEqual(await repo.findByUserId(chainAccount.userId), chainOrders);

      for (const dataSource of ['email', 'csv']) {
        const account = await setup('gmail');
        const anchors = [account.exported[1], account.exported[2]];
        anchors.forEach((r) => {
          r.externalId = randomUUID();
        });
        const suspect =
          dataSource === 'email'
            ? account.emails.find((r) => r.amountSpent === 22.48)
            : account.exported[0];
        suspect.externalId = anchors[0].externalId;
        const conflicting = structuredClone(suspect);
        conflicting.externalId = anchors[1].externalId;
        const previousRepo = new ReceiptRepository(db, 2);
        await previousRepo.replaceProviderExport(account.userId, anchors, allow);
        const anchorIds = (await previousRepo.findByUserId(account.userId)).map((r) => r.id).sort();
        if (dataSource === 'email')
          await previousRepo.upsertEmailReceipts([suspect, conflicting], allow);
        else
          await previousRepo.replaceProviderExport(account.userId, [suspect, conflicting], allow);
        const beforeRepair = await previousRepo.findByUserId(account.userId);
        const retained = await sourceRows(account.userId);
        const repair = await repo.rebuildProjection(
          account.userId,
          account.generation,
          'prepare',
          allow,
        );
        assert.equal(repair.orders, 3);
        assert.deepEqual(await repo.findByUserId(account.userId), beforeRepair);
        await repo.rebuildProjection(
          account.userId,
          account.generation,
          'publish',
          allow,
          repair.manifestId,
        );
        const assertDispute = async () => {
          const orders = await repo.findByUserId(account.userId);
          assert.equal(orders.length, 3);
          const established = orders.filter(
            (r) => r.resolution.reconciliation.status !== 'unresolved',
          );
          assert.deepEqual(
            established.map((r) => r.id).sort(),
            anchorIds,
            `${dataSource} preserves established references`,
          );
          const disputed = orders.find((r) => r.resolution.reconciliation.status === 'unresolved');
          assert.equal(disputed.externalId, undefined);
          assert.equal(disputed.resolution.reconciliation.reason, 'identity_conflict');
          assert.equal(disputed.resolution.reconciliation.observationIds.length, 2);
          const metrics = summarizeOrderMetrics(orders);
          assert.equal(metrics.attempts, 2);
          assert.equal(metrics.deliveries, 1);
          assert.equal(metrics.canceled, 1);
          assert.equal(metrics.possibleAdditionalOrders, 1);
          assert.equal(metrics.currencies[0].netSpend, 62.73);
          assert.equal(
            (await repo.findPage({ userId: account.userId, outcome: 'needs_review' }, 100, 0))
              .total,
            1,
          );
          assert.equal(
            (await repo.findPage({ userId: account.userId, outcome: 'delivered' }, 100, 0)).total,
            1,
          );
          assert.deepEqual(await sourceRows(account.userId), retained);
        };
        await assertDispute();
        await repo.rebuildProjection(
          account.userId,
          account.generation,
          'rollback',
          allow,
          repair.manifestId,
        );
        assert.deepEqual(await repo.findByUserId(account.userId), beforeRepair);
        if (dataSource === 'email') await repo.upsertEmailReceipts([conflicting, suspect], allow);
        else await repo.replaceProviderExport(account.userId, [conflicting, suspect], allow);
        await assertDispute();
      }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
