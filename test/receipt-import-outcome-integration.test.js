const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const {
  receiptImportOutcomesMigration,
} = require('../dist/services/data/migrations/029_receipt_import_outcomes');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { GmailSyncRunRepository } = require('../dist/services/data/GmailSyncRunRepository');
const { MailboxSyncRunRepository } = require('../dist/services/data/MailboxSyncRunRepository');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

for (const setup of ['fresh', 'existing'])
  test(
    `${setup}: import outcomes survive cursor loss, retries, late revisions and reset generations`,
    { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
    async () => {
      const schema = `receipt_import_outcomes_${randomUUID().replaceAll('-', '')}`;
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`CREATE SCHEMA ${schema}`);
      const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
      let failAfterAccountingWrite = false;
      const db = {
        query: (...args) => pool.query(...args),
        withTransaction: async (action) => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const executor = {
              query: async (...args) => {
                const result = await client.query(...args);
                if (
                  failAfterAccountingWrite &&
                  args[0].startsWith('UPDATE import_jobs SET receipt_outcome_state=')
                )
                  throw new Error('simulated failure after ledger write');
                return result;
              },
            };
            const result = await action(executor);
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
      const repo = new ReceiptRepository(db, 3);
      const userId = randomUUID(),
        otherId = randomUUID();
      let jobId = randomUUID();
      const allow = async () => {};
      const state = async () =>
        (await pool.query('SELECT receipt_outcome_state FROM import_jobs WHERE id=$1', [jobId]))
          .rows[0].receipt_outcome_state;
      try {
        // Representative existing schema/job: adding accounting cannot alter its status or cursor.
        const allMigrations = [
          ...migrations.filter((m) => m.version < 29),
          receiptImportOutcomesMigration,
        ];
        await new MigrationRunner(
          { getClient: () => pool.connect() },
          setup === 'fresh' ? allMigrations : migrations.filter((m) => m.version < 29),
        ).run();
        for (const id of [userId, otherId])
          await pool.query(
            "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
            [id, `${id}@example.com`],
          );
        await pool.query(
          "INSERT INTO import_jobs(id,user_id,kind,trigger_type,status,import_generation,checkpoint) VALUES($1,$2,'gmail_historical','user','running',1,'{}')",
          [jobId, userId],
        );
        await new MigrationRunner({ getClient: () => pool.connect() }, allMigrations).run();
        await new MigrationRunner({ getClient: () => pool.connect() }, allMigrations).run();
        assert.equal(await state(), null);
        await assert.rejects(
          pool.query("UPDATE import_jobs SET receipt_outcome_state='{}'::jsonb WHERE id=$1", [
            jobId,
          ]),
          /check constraint/,
        );

        const batch = await new ReceiptEmailBatchExtractor(
          new ReceiptExtractor({}, 3),
          { capture: async () => {} },
          10,
          Date.now,
          3,
        ).extract(
          fixture.emails.slice(0, 2).map((email) => ({
            userId,
            provider: 'gmail',
            providerMessageId: email.id,
            from: 'receipts@uber.com',
            to: 'redacted',
            subject: 'Your Uber Eats receipt',
            receivedAt: new Date('2023-12-11T17:00Z'),
            body: email.text
              .split('\n')
              .map((line) => `<p>${line}</p>`)
              .join(''),
          })),
          'America/Toronto',
          { userId, trigger: 'manual' },
        );
        assert.deepEqual(batch.errors, []);
        const [original, refund] = batch.supportedReceipts;
        assert.equal((await repo.getImportOutcome(userId, jobId, allow)).ordersProcessed, 0);

        await repo.upsertEmailReceipts([original], allow, { jobId, scope: 'gmail' });
        const firstState = await state();
        const first = await repo.getImportOutcome(userId, jobId, allow);
        assert.equal(first.newOrders, 1);
        assert.equal(first.updatedOrders, 0);
        assert.equal(first.sourceDocuments, 1);
        assert.deepEqual(
          (await pool.query('SELECT checkpoint FROM import_jobs WHERE id=$1', [jobId])).rows[0]
            .checkpoint,
          {},
          'a cursor failure cannot erase committed accounting',
        );
        await repo.upsertEmailReceipts([original], allow, { jobId, scope: 'gmail' });
        assert.deepEqual(await repo.getImportOutcome(userId, jobId, allow), first);
        assert.deepEqual(await state(), firstState);

        failAfterAccountingWrite = true;
        await assert.rejects(
          repo.upsertEmailReceipts([refund], allow, { jobId, scope: 'gmail' }),
          /simulated failure/,
        );
        failAfterAccountingWrite = false;
        assert.deepEqual(await state(), firstState);
        assert.deepEqual(await repo.getImportOutcome(userId, jobId, allow), first);
        assert.equal(
          Number(
            (
              await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
                userId,
              ])
            ).rows[0].count,
          ),
          1,
        );

        await pool.query("UPDATE import_jobs SET status='retrying' WHERE id=$1", [jobId]);
        await repo.upsertEmailReceipts([refund], allow, { jobId, scope: 'microsoft' });
        const final = await repo.getImportOutcome(userId, jobId, allow);
        assert.equal(final.newOrders, 1);
        assert.equal(final.updatedOrders, 0);
        assert.equal(final.ordersProcessed, 1);
        assert.equal(final.sourceDocuments, 2);
        assert.equal(final.adjustedOrders, 1);
        assert.equal(final.currencies[0].netAmount, 0);
        const microsoft = await repo.getImportOutcome(userId, jobId, allow, 'microsoft');
        assert.equal(
          microsoft.newOrders,
          0,
          'the second provider starts from the already-saved first-provider purchase',
        );
        assert.equal(microsoft.updatedOrders, 1);
        assert.equal(microsoft.sourceDocuments, 1);
        assert.equal(
          (await repo.getImportOutcome(userId, jobId, allow, 'export')).ordersProcessed,
          0,
        );
        await repo.upsertEmailReceipts([refund], allow, { jobId, scope: 'microsoft' });
        await repo.upsertEmailReceipts([original], allow, { jobId, scope: 'gmail' });
        assert.deepEqual(await repo.getImportOutcome(userId, jobId, allow), final);
        assert.deepEqual(await repo.getImportOutcome(userId, jobId, allow, 'microsoft'), microsoft);

        // A retry after lifecycle completion must not append another successful sync run.
        for (const [table, syncs, scopedOutcome] of [
          ['gmail_sync_runs', new GmailSyncRunRepository(db, { record: async () => {} }), final],
          ['mailbox_sync_runs', new MailboxSyncRunRepository(db), microsoft],
        ]) {
          const counts = {
            emailsScanned: 2,
            receiptsProcessed: 2,
            supportedReceiptsFound: 2,
            exportCoveredReceipts: 0,
            eligibleReceipts: 2,
            deduplicatedReceipts: 2,
            newOrders: scopedOutcome.newOrders,
            updatedOrders: scopedOutcome.updatedOrders,
            unchangedOrders: scopedOutcome.unchangedOrders,
            rejectedMessages: 0,
            decodedBytesExamined: 0,
            receiptOutcome: scopedOutcome,
          };
          const run = await syncs.startSyncRun(userId, 'manual', jobId);
          await syncs.completeSyncRun(run, userId, 'success', counts, 'manual');
          assert.equal(await syncs.startSyncRun(userId, 'manual', jobId), run);
          await syncs.completeSyncRun(run, userId, 'success', counts, 'manual');
          const rows = (
            await pool.query(
              `SELECT new_orders,updated_orders,receipt_outcome FROM ${table} WHERE user_id=$1 AND import_job_id=$2`,
              [userId, jobId],
            )
          ).rows;
          assert.equal(rows.length, 1);
          assert.equal(rows[0].new_orders, scopedOutcome.newOrders);
          assert.equal(rows[0].updated_orders, scopedOutcome.updatedOrders);
          assert.deepEqual(rows[0].receipt_outcome, scopedOutcome);
          await assert.rejects(
            syncs.startSyncRun(otherId, 'manual', jobId),
            (error) => error.code === 'IMPORT_OUTCOME_STALE',
          );
        }

        const foreign = { ...original, userId: otherId };
        await assert.rejects(
          repo.upsertEmailReceipts([foreign], allow, { jobId, scope: 'gmail' }),
          (error) => error.code === 'IMPORT_OUTCOME_STALE',
        );
        assert.equal((await repo.findByUserId(otherId)).length, 0);
        await assert.rejects(
          pool.query(
            "UPDATE import_jobs SET receipt_outcome_state=jsonb_set(receipt_outcome_state,'{baseline}','[{}]') WHERE id=$1",
            [jobId],
          ),
          /baseline is immutable/,
        );
        await assert.rejects(
          pool.query('UPDATE import_jobs SET receipt_outcome_state=NULL WHERE id=$1', [jobId]),
          /baseline cannot be cleared/,
        );
        await assert.rejects(
          pool.query(
            "UPDATE import_jobs SET receipt_outcome_state=jsonb_set(receipt_outcome_state,'{scopes,microsoft,baseline}','[]') WHERE id=$1",
            [jobId],
          ),
          /phase baseline is immutable/,
        );

        await pool.query("UPDATE import_jobs SET status='failed' WHERE id=$1", [jobId]);
        assert.ok(await state(), 'a recoverable failed job retains its original baseline');
        await assert.rejects(pool.query('UPDATE import_jobs SET receipt_outcome_state=NULL WHERE id=$1', [jobId]), /baseline cannot be cleared/);
        await pool.query("UPDATE import_jobs SET status='running' WHERE id=$1", [jobId]);
        assert.deepEqual(await repo.getImportOutcome(userId, jobId, allow), final);
        await pool.query("UPDATE import_jobs SET status='succeeded',result=$2::jsonb WHERE id=$1", [
          jobId,
          JSON.stringify({ receiptOutcome: final }),
        ]);
        assert.equal(
          await state(),
          null,
          'terminal success retains the compact result, not membership tracking',
        );
        assert.deepEqual(
          (await pool.query('SELECT result FROM import_jobs WHERE id=$1', [jobId])).rows[0].result
            .receiptOutcome,
          final,
        );

        // A new import of the same documents reports one unchanged order.
        jobId = randomUUID();
        await pool.query(
          "INSERT INTO import_jobs(id,user_id,kind,trigger_type,status,import_generation) VALUES($1,$2,'gmail_historical','user','running',1)",
          [jobId, userId],
        );
        await repo.upsertEmailReceipts([original, refund], allow, { jobId, scope: 'gmail' });
        const repeated = await repo.getImportOutcome(userId, jobId, allow);
        assert.equal(repeated.newOrders, 0);
        assert.equal(repeated.updatedOrders, 0);
        assert.equal(repeated.unchangedOrders, 1);
        await pool.query("UPDATE import_jobs SET status='failed' WHERE id=$1", [jobId]);
        await pool.query('UPDATE users SET import_generation=import_generation+1 WHERE id=$1', [
          userId,
        ]);
        assert.equal(
          await state(),
          null,
          'clear/reset must also remove failed-job membership snapshots',
        );
        await pool.query("UPDATE import_jobs SET status='running' WHERE id=$1", [jobId]);
        await assert.rejects(
          repo.getImportOutcome(userId, jobId, allow),
          (error) => error.code === 'IMPORT_OUTCOME_STALE',
        );
        await pool.query('DELETE FROM users WHERE id=$1', [userId]);
        assert.equal(
          Number(
            (await pool.query('SELECT count(*) FROM import_jobs WHERE id=$1', [jobId])).rows[0]
              .count,
          ),
          0,
        );
      } finally {
        await pool.end();
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    },
  );
