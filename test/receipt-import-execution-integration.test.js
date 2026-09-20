const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const {
  ReceiptImportPersistenceService,
} = require('../dist/services/import/ReceiptImportPersistenceService');
const {
  ReceiptEmailBatchExtractor,
} = require('../dist/services/import/ReceiptEmailBatchExtractor');
const { ReceiptExtractor } = require('../dist/services/extraction/ReceiptExtractor');
const { GmailImportService } = require('../dist/services/import/GmailImportService');
const { OutlookImportService } = require('../dist/services/import/OutlookImportService');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { CsvImportUseCase } = require('../dist/services/import/CsvImportUseCase');
const { summarizeOrderMetrics } = require('../dist/services/analytics/shared/orderMetrics');
const fixture = require('./fixtures/receipt-accuracy/december-10-2023');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'durable Gmail/Outlook and export use cases reconcile December accurately across retries and import order',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `receipt_execution_test_${randomUUID().replaceAll('-', '')}`;
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
      for (const provider of ['gmail', 'microsoft'])
        for (const emailFirst of [true, false]) {
          const user = { id: randomUUID(), timezone: 'America/Toronto' };
          const mailboxJob = randomUUID(),
            exportJob = randomUUID();
          await pool.query(
            "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test',$3)",
            [user.id, `${user.id}@example.test`, user.timezone],
          );
          for (const [id, kind] of [
            [mailboxJob, provider === 'gmail' ? 'gmail_historical' : 'outlook_historical'],
            [exportJob, 'export_file'],
          ])
            await pool.query(
              "INSERT INTO import_jobs(id,user_id,kind,trigger_type,status,import_generation) SELECT $1,id,$3,'user','failed',import_generation FROM users WHERE id=$2",
              [id, user.id, kind],
            );
          // Model the shared writer protocol: only one operation for this account runs at once.
          const activateOnlyJob = async (id) =>
            db.withTransaction(async (tx) => {
              await tx.query(
                "UPDATE import_jobs SET status='succeeded' WHERE user_id=$1 AND id<>$2 AND status='running'",
                [user.id, id],
              );
              await tx.query("UPDATE import_jobs SET status='running' WHERE user_id=$1 AND id=$2", [
                user.id,
                id,
              ]);
            });
          const lock = { userId: user.id };
          const locks = { assertLockOwned: async (received) => assert.equal(received, lock) };
          const repo = new ReceiptRepository(db);
          let cacheCalls = 0,
            completedCounts;
          const cache = {
            invalidateAllUserCaches: async (id) => {
              assert.equal(id, user.id);
              // The callback sees committed observations from its separate database connection.
              assert.ok(
                Number(
                  (
                    await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
                      id,
                    ])
                  ).rows[0].count,
                ) > 0,
              );
              cacheCalls++;
            },
          };
          const persistence = new ReceiptImportPersistenceService(repo, cache, locks, repo);
          const extraction = new ReceiptEmailBatchExtractor(
            new ReceiptExtractor(),
            { capture: async () => {} },
            10,
            Date.now,
          );
          const messages = fixture.emails.map((email) => ({
            userId: user.id,
            provider,
            providerMessageId: email.id,
            from: 'receipts@uber.com',
            to: 'redacted',
            subject: 'Your Uber Eats receipt',
            receivedAt: new Date('2023-12-11T17:00Z'),
            body: email.text
              .split('\n')
              .map((line) => `<p>${line}</p>`)
              .join(''),
          }));
          let interrupt = true,
            saved = {},
            acquisitions = 0;
          const acquire = async (_user, _trigger, cursor) => {
            acquisitions++;
            const start = cursor ? Number(cursor) : 0;
            return {
              exportCutoffs: {},
              pages: (async function* () {
                for (let index = start; index < messages.length; index++) {
                  yield {
                    messages: [messages[index]],
                    matchedCount: 1,
                    nextCursor: index + 1 < messages.length ? String(index + 1) : null,
                  };
                  if (interrupt) {
                    interrupt = false;
                    throw new Error('Transient provider failure after committed page');
                  }
                }
              })(),
            };
          };
          const complete = async (_run, _id, _status, counts) => {
            completedCounts = counts;
          };
          const gmail = new GmailImportService(
            { acquire },
            extraction,
            persistence,
            { start: async () => 'run', complete, fail: async () => {} },
            undefined,
          );
          const outlook = new OutlookImportService(
            { acquire },
            extraction,
            persistence,
            {
              startSyncRun: async () => 'run',
              completeSyncRun: complete,
              failSyncRun: async () => {},
            },
            {},
            {},
            undefined,
          );
          const mailboxImport =
            provider === 'gmail'
              ? gmail.importFromGmail.bind(gmail)
              : outlook.importFromOutlook.bind(outlook);
          const runMail = async (...args) => {
            await activateOnlyJob(mailboxJob);
            return mailboxImport(...args);
          };
          const execution = () => ({
            accountingJobId: mailboxJob,
            checkpoint: saved,
            save: async (checkpoint) => {
              saved = checkpoint;
              await pool.query('UPDATE import_jobs SET checkpoint=$2::jsonb WHERE id=$1', [
                mailboxJob,
                JSON.stringify(checkpoint),
              ]);
            },
          });
          const csv = new CsvImportUseCase(
            new CsvImportService(),
            repo,
            { findById: async () => user },
            { setExportStatus: async () => true },
            cache,
            locks,
            repo,
          );
          const runExport = async (jobId = exportJob) => {
            await activateOnlyJob(jobId);
            return csv.executeWithLock(
              {
                userId: user.id,
                provider: 'uber_eats',
                fileType: 'csv',
                csvBuffer: Buffer.from(fixture.csv),
                jobId,
                accountingJobId: jobId,
              },
              lock,
            );
          };
          if (!emailFirst) {
            const result = await runExport();
            assert.equal(result.receiptOutcome.newOrders, 5);
            assert.equal(result.receiptOutcome.cancellationsRecovered, 1);
          }
          const interrupted = await runMail(user, lock, 'manual', execution());
          assert.equal(interrupted.success, false);
          saved = (await pool.query('SELECT checkpoint FROM import_jobs WHERE id=$1', [mailboxJob]))
            .rows[0].checkpoint;
          assert.equal(saved.receiptPolicyVersion, 3);
          assert.equal(saved.accountingJobId, mailboxJob);
          assert.equal(saved.cursor, '1');
          const resumed = await runMail(user, lock, 'manual', execution());
          assert.equal(
            resumed.success,
            true,
            JSON.stringify({
              provider,
              emailFirst,
              errorCode: resumed.errorCode,
              errors: resumed.errors,
            }),
          );
          assert.equal(resumed.receiptOutcome.sourceDocuments, 6);
          assert.deepEqual(completedCounts.receiptOutcome, resumed.receiptOutcome);
          const beforeRetry = acquisitions;
          const retry = await runMail(user, lock, 'manual', execution());
          assert.equal(
            retry.success,
            true,
            JSON.stringify({ errorCode: retry.errorCode, errors: retry.errors }),
          );
          assert.equal(
            acquisitions,
            beforeRetry,
            'a compatible completed checkpoint does not reacquire mail',
          );
          if (emailFirst) await runExport();
          const records = await repo.findByUserId(user.id);
          const metrics = summarizeOrderMetrics(records);
          assert.equal(records.length, 5);
          assert.equal(metrics.attempts, 5);
          assert.equal(metrics.deliveries, 4);
          assert.equal(metrics.chargedCancellations, 1);
          assert.equal(metrics.fullyRefunded, 1);
          assert.equal(metrics.currencies[0].netSpend, 157.02);
          assert.equal(metrics.currencies[0].confirmedRefundAmount, 22.48);
          assert.deepEqual(metrics.currencies[0].payments, [
            { tender: 'card', charges: 153.81, refunds: 0, refundReversals: 0 },
            { tender: 'provider_wallet', charges: 25.69, refunds: 22.48, refundReversals: 0 },
          ]);
          assert.ok(cacheCalls >= 7);
          const stableIds = records.map((r) => r.id).sort();
          // A later reimport is a new durable operation, not a reopened completed job.
          const reimportJob = randomUUID();
          await pool.query(
            "INSERT INTO import_jobs(id,user_id,kind,trigger_type,status,import_generation) SELECT $1,id,'export_file','user','failed',import_generation FROM users WHERE id=$2",
            [reimportJob, user.id],
          );
          const reimport = await runExport(reimportJob);
          assert.equal(reimport.receiptOutcome.newOrders, 0);
          assert.equal(reimport.receiptOutcome.updatedOrders, 0);
          assert.deepEqual((await repo.findByUserId(user.id)).map((r) => r.id).sort(), stableIds);
          assert.equal(
            Number(
              (
                await pool.query('SELECT count(*) FROM receipt_observations WHERE user_id=$1', [
                  user.id,
                ])
              ).rows[0].count,
            ),
            11,
          );
          const old = { ...saved };
          delete old.receiptPolicyVersion;
          delete old.accountingJobId;
          await assert.rejects(
            mailboxImport(user, lock, 'manual', { ...execution(), checkpoint: old }),
            (e) => e.code === 'IMPORT_CHECKPOINT_INVALID',
          );
          assert.equal(acquisitions, beforeRetry);
          assert.deepEqual(summarizeOrderMetrics(await repo.findByUserId(user.id)), metrics);
        }
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
