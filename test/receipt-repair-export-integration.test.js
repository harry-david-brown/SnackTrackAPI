const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const {
  ReceiptRepairAccountRepository,
} = require('../dist/services/data/ReceiptRepairAccountRepository');
const {
  ReceiptRepairSourceAcquisition,
} = require('../dist/services/receipt/ReceiptRepairSourceAcquisition');
const { ReceiptRepairSourceStore } = require('../dist/services/data/ReceiptRepairSourceStore');
const { ReceiptReconciliationStore } = require('../dist/services/data/ReceiptReconciliationStore');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ZipExtractor } = require('../dist/services/import/ZipExtractor');
const { RetainedExportReader } = require('../dist/services/import/RetainedExportReader');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const storedZip = require('./helpers/retainedExportZip');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'retained-export acquisition previews read-only, stages idempotently and fences account changes transactionally',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_acquisition_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const directory = await fs.mkdtemp(join(tmpdir(), 'receipt-acquisition-test-'));
    const path = join(directory, 'retained.zip');
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
    const userId = randomUUID(),
      acquiredAt = '2026-09-13T12:00:00.000Z';
    const lock = { userId, backend: 'redis', ownerToken: 'isolated-test' };
    let onAcquire = async () => {},
      onGuard = async () => {},
      releases = 0;
    const locks = {
      acquireLock: async (id) => {
        assert.equal(id, userId);
        await onAcquire();
        return lock;
      },
      assertLockOwned: async (actual) => {
        assert.equal(actual, lock);
        await onGuard();
      },
      releaseLock: async (actual) => {
        assert.equal(actual, lock);
        releases++;
        return true;
      },
    };
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const inserted = await pool.query(
        "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto') RETURNING import_generation",
        [userId, `${userId}@example.test`],
      );
      const generation = Number(inserted.rows[0].import_generation);
      await fs.writeFile(path, storedZip([['export/Eats/user_orders-0.csv', fixture.csv]]));
      const repo = new ReceiptRepository(db, 3);
      const service = new ReceiptRepairSourceAcquisition(
        new ReceiptRepairAccountRepository(db),
        new RetainedExportReader(new CsvImportService(), new ZipExtractor()),
        repo,
        locks,
      );
      const input = { sourceKind:'provider_export', userId, provider: 'uber_eats', path, acquiredAt };
      const pristine = async () => {
        for (const table of [
          'receipts',
          'receipt_observations',
          'receipt_import_batches',
          'receipt_order_events',
          'import_jobs',
        ])
          assert.equal(
            Number(
              (await pool.query(`SELECT count(*) FROM ${table} WHERE user_id=$1`, [userId])).rows[0]
                .count,
            ),
            0,
            table,
          );
      };
      const stagedCount = async () =>
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM receipt_repair_source_batches WHERE user_id=$1',
              [userId],
            )
          ).rows[0].count,
        );
      const preview = await service.execute(input);
      assert.equal(preview.orderMetrics.attempts, 5);
      assert.equal(preview.orderMetrics.deliveries, 4);
      assert.equal(preview.orderMetrics.canceled, 1);
      assert.equal(preview.orderMetrics.likelyRefunds, 1);
      assert.equal(preview.orderMetrics.confirmedRefunds, 0);
      assert.equal(preview.orderMetrics.currencies[0].netSpend, 157.02);
      await pristine();
      assert.equal(await stagedCount(), 0);
      const stageInput = {
        ...input,
        stage: { expectedGeneration: generation, expectedFingerprint: preview.fingerprint },
      };
      const staged = await service.execute(stageInput);
      const again = await service.execute(stageInput);
      assert.deepEqual(again.staged, staged.staged);
      assert.equal(releases, 2);
      assert.equal(await stagedCount(), 1);
      await pristine();
      const read = await db.withTransaction(async (tx) => {
        await tx.query('SET TRANSACTION READ ONLY');
        return new ReceiptRepairSourceStore().load(tx, userId, generation, [staged.staged.batchId]);
      });
      assert.deepEqual(read.batches[0].provenance.artifact, preview.artifact);
      assert.equal(read.batches[0].provenance.parsingTimezone, 'America/Toronto');
      assert.equal(read.batches[0].observations.length, 5);
      assert.equal(read.batches[0].coverage[0].quality, 'observed');
      assert.equal(read.batches[0].coverage[0].incomplete, false);
      await assert.rejects(
        pool.query("UPDATE receipt_repair_source_batches SET provenance='{}'::jsonb WHERE id=$1", [
          staged.staged.batchId,
        ]),
        /immutable/,
      );

      // These mutations affect only this generated test account. They happen after preview
      // validation to prove the database admission fence, not merely the service's first read.
      onAcquire = () =>
        pool.query("UPDATE users SET timezone='America/Chicago' WHERE id=$1", [userId]);
      await assert.rejects(
        service.execute(stageInput),
        (e) => e.code === 'REPAIR_TIMEZONE_CHANGED',
      );
      await pool.query("UPDATE users SET timezone='America/Toronto' WHERE id=$1", [userId]);
      onAcquire = () =>
        pool.query('UPDATE users SET import_generation=import_generation+1 WHERE id=$1', [userId]);
      await assert.rejects(
        service.execute(stageInput),
        (e) => e.code === 'REPAIR_GENERATION_STALE',
      );
      await pool.query('UPDATE users SET import_generation=$2 WHERE id=$1', [userId, generation]);
      onAcquire = async () => {};
      const nextInput = { ...input, acquiredAt: '2026-09-13T12:01:00.000Z' };
      const nextPreview = await service.execute(nextInput);
      let guardCalls = 0;
      onGuard = async () => {
        if (++guardCalls === 2) throw Error('Lost writer lease after insertion');
      };
      await assert.rejects(
        service.execute({
          ...nextInput,
          stage: { expectedGeneration: generation, expectedFingerprint: nextPreview.fingerprint },
        }),
        /Lost writer lease/,
      );
      onGuard = async () => {};
      assert.equal(await stagedCount(), 1, 'failed staged insertion rolled back');
      assert.equal(releases, 5);
      await pristine();

      // Exercise the real CLI preview with logging enabled and Redis deliberately unreachable.
      // Preview must never initialize the lock connection or publish/store a source batch.
      const url = new URL(databaseUrl);
      url.searchParams.set('options', `-c search_path=${schema}`);
      const env = {
        ...process.env,
        DATABASE_URL: url.toString(),
        LOG_LEVEL: 'info',
        LOGTAIL_TOKEN: '',
        REDIS_URL: 'redis://127.0.0.1:1',
        QUEUE_REDIS_URL: 'redis://127.0.0.1:1',
      };
      const args = [
        'dist/scripts/receipt-repair-export.js',
        userId,
        'uber_eats',
        path,
        '--acquired-at',
        acquiredAt,
      ];
      const output = execFileSync(process.execPath, args, {
        encoding: 'utf8',
        env,
        timeout: 15000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const cli = JSON.parse(output);
      assert.equal(cli.fingerprint, preview.fingerprint);
      assert.equal(cli.mode, 'preview');
      assert.equal(output.includes(path), false);
      assert.throws(
        () =>
          execFileSync(
            process.execPath,
            [
              ...args,
              '--stage',
              '--expected-generation',
              String(generation),
              '--expected-fingerprint',
              'f'.repeat(64),
            ],
            { encoding: 'utf8', env, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] },
          ),
        (error) => error.status === 1 && /REPAIR_PREVIEW_CHANGED/.test(error.stderr),
      );
      assert.equal(await stagedCount(), 1);
      await pristine();

      // Acquisition feeds the same reviewed manifest machinery, not a second repair algorithm.
      const manifest = await repo.rebuildProjection(
        userId,
        generation,
        'prepare',
        async () => {},
        undefined,
        [staged.staged.batchId],
      );
      const inspected = await db.withTransaction(async (tx) => {
        await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        return new ReceiptReconciliationStore(() => {
          throw Error('Cannot write in inspection');
        }, 3).inspectManifest(tx, userId, manifest.manifestId);
      });
      assert.deepEqual(inspected.stagedBatches[0].provenance.artifact, preview.artifact);
      assert.equal(inspected.after.receipts.length, 5);
      await repo.rebuildProjection(
        userId,
        generation,
        'publish',
        async () => {},
        manifest.manifestId,
      );
      assert.equal((await repo.findByUserId(userId)).length, 5);
      await repo.rebuildProjection(
        userId,
        generation,
        'rollback',
        async () => {},
        manifest.manifestId,
      );
      assert.equal((await repo.findByUserId(userId)).length, 0);
      assert.equal(
        Number(
          (
            await pool.query(
              'SELECT count(*) FROM receipt_observations WHERE user_id=$1 AND NOT association_enabled',
              [userId],
            )
          ).rows[0].count,
        ),
        5,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
