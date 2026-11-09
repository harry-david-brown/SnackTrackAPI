const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const { AccountDeletionService } = require('../dist/services/account/AccountDeletionService');
const { ReceiptClearService } = require('../dist/services/account/ReceiptClearService');
const { AccountResetService } = require('../dist/services/data/AccountResetService');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { orderEventsMigration } = require('../dist/services/data/migrations/027_order_events');

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const userId = '11111111-1111-4111-8111-111111111111';
const email = 'lifecycle@example.test';
const lockHandle = {
  userId,
  ownerToken: 'owner',
  backend: 'memory',
  acquiredAt: 0,
  expiresAt: 1,
};
const lock = {
  acquireLockWithWait: async () => lockHandle,
  assertLockOwned: async () => {},
  releaseLock: async () => true,
};

const withTemporaryDatabase = async (label, operation) => {
  const schema = `lifecycle_${label}_${process.pid}_${randomBytes(6).toString('hex')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${schema}`,
  });
  try {
    await new MigrationRunner({ getClient: () => pool.connect() },
      migrations.some((m) => m.version === 27) ? migrations : [...migrations, orderEventsMigration]).run();
    await operation(pool);
  } finally {
    await pool.end();
    await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.end();
  }
};

const transactions = (pool) => ({
  withTransaction: async (operation) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
});

const seedAllData = async (pool) => {
  await pool.query(
    `INSERT INTO users (
       id, email, password, email_verified, timezone,
       gmail_refresh_token, gmail_access_token, gmail_connected,
       gmail_email, gmail_scopes, gmail_connection_mode
     ) VALUES ($1, $2, 'hash', TRUE, 'America/Toronto',
       'gmail-refresh', 'gmail-access', TRUE, $2,
       ARRAY['https://www.googleapis.com/auth/gmail.readonly'], 'offline')`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO verification_codes (email, code_hash, code_type, expires_at)
     VALUES ($1, 'hash', 'email_verification', NOW() + INTERVAL '1 hour')`,
    [email],
  );
  await pool.query(
    `INSERT INTO oauth_accounts (user_id, provider, provider_user_id, email)
     VALUES ($1, 'apple', 'provider-user', $2)`,
    [userId, email],
  );
  await pool.query(
    `INSERT INTO user_import_preferences (
       user_id, monitoring_consent_state, gmail_import_status,
       gmail_baseline_completed_at, ongoing_tracking_consent_state, tracking_status, automatic_updates_offer_seen_at
     ) VALUES ($1, 'granted', 'completed', NOW(), 'granted', 'active', NOW())`,
    [userId],
  );
  await pool.query(
    `INSERT INTO user_export_provider_preferences (user_id, provider, status)
     VALUES ($1, 'uber_eats', 'completed'), ($1, 'doordash', 'completed')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO user_import_preference_events (user_id, event_name)
     VALUES ($1, 'monitoring_consent_granted')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO gmail_sync_runs (user_id, trigger_type, outcome)
     VALUES ($1, 'manual', 'success')`,
    [userId],
  );
  await pool.query(
    `INSERT INTO receipts (
       id, user_id, receipt_type, data_source, restaurant_name, amount_spent, items
     ) VALUES
       ('22222222-2222-4222-8222-222222222222', $1, 'uber_eats', 'email', 'Email Cafe', 10, '[]'),
       ('33333333-3333-4333-8333-333333333333', $1, 'doordash', 'csv', 'Export Cafe', 20, '[]')`,
    [userId],
  );
};

const seedReconciliation = async (pool) => {
  await pool.query("INSERT INTO receipt_import_batches(id,user_id,provider,observed_start,observed_end,accepted_orders) VALUES('batch',$1,'doordash',NOW(),NOW(),1)",[userId]);
  await pool.query("INSERT INTO receipt_repair_manifests(id,user_id,import_generation,policy_version,before_fingerprint,before_state,after_state) VALUES('44444444-4444-4444-8444-444444444444',$1,0,2,'fingerprint','{}','{}')",[userId]);
  await pool.query("INSERT INTO receipt_reconciliation_lineage(id,user_id,old_receipt_id,new_receipt_id,policy_version) VALUES('55555555-5555-4555-8555-555555555555',$1,'22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333',2)",[userId]);
  await pool.query(`INSERT INTO receipt_observations(id,user_id,receipt_id,document_key,import_generation,parser_version,payload,association_enabled)
    VALUES('66666666-6666-4666-8666-666666666666',$1,'22222222-2222-4222-8222-222222222222','source-1',1,3,'{}',true),
      ('77777777-7777-4777-8777-777777777777',$1,NULL,'source-2',1,3,'{}',false)`, [userId]);
  await pool.query(`INSERT INTO receipt_order_events(user_id,receipt_id,event_key,kind,amount,currency_code,confidence,payload)
    VALUES($1,'22222222-2222-4222-8222-222222222222','charge','charge',10,'CAD','confirmed','{}')`, [userId]);
  await pool.query(`INSERT INTO receipt_order_event_observations(user_id,receipt_id,event_key,observation_id)
    VALUES($1,'22222222-2222-4222-8222-222222222222','charge','66666666-6666-4666-8666-666666666666')`, [userId]);
  await pool.query(`INSERT INTO receipt_repair_source_batches(id,user_id,import_generation,parser_version,fingerprint,provenance)
    VALUES('88888888-8888-4888-8888-888888888888',$1,1,3,repeat('a',64),'{}')`, [userId]);
  await pool.query(`INSERT INTO receipt_repair_source_observations(id,user_id,batch_id,document_key,payload)
    VALUES('99999999-9999-4999-8999-999999999999',$1,'88888888-8888-4888-8888-888888888888',repeat('b',64),'{}')`, [userId]);
  await pool.query(`INSERT INTO receipt_association_reviews(id,user_id,import_generation,decision,observation_ids,reason,reviewer)
    VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$1,1,'keep_separate',ARRAY['66666666-6666-4666-8666-666666666666','77777777-7777-4777-8777-777777777777']::uuid[],'test','test operator')`, [userId]);
  await pool.query(`INSERT INTO receipt_association_reviews(id,user_id,import_generation,decision,observation_ids,supersedes_id,reason,reviewer)
    VALUES('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',$1,1,'revoke','{}','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','test revoke','test operator')`, [userId]);
};
const reconciliationTables=['receipt_import_batches','receipt_repair_manifests','receipt_reconciliation_lineage',
  'receipt_observations','receipt_order_events','receipt_order_event_observations',
  'receipt_repair_source_batches','receipt_repair_source_observations','receipt_association_reviews'];
const count = async (pool, table) =>
  (await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count;

test(
  'account deletion removes every relational source and email-keyed verification record',
  {
    skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
  },
  async () => {
    await withTemporaryDatabase('delete', async (pool) => {
      await seedAllData(pool);
      await seedReconciliation(pool);
      const service = new AccountDeletionService(
        transactions(pool),
        { invalidateAllUserCaches: async () => {} },
        { invalidate: () => {} },
        { revokeRefreshToken: async () => {} },
        lock,
      );

      assert.deepEqual(await service.deleteAccount(userId, 'refresh-token'), { deleted: true });
      for (const table of [
        ...reconciliationTables,
        'users',
        'receipts',
        'oauth_accounts',
        'user_import_preferences',
        'user_export_provider_preferences',
        'user_import_preference_events',
        'gmail_sync_runs',
        'verification_codes',
      ])
        assert.equal(await count(pool, table), 0, `${table} should be empty`);

      assert.deepEqual(await service.deleteAccount(userId), { deleted: true });
    });
  },
);

test(
  'receipt clear removes both sources while preserving identity, connection, consent, and audit',
  {
    skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
  },
  async () => {
    await withTemporaryDatabase('clear', async (pool) => {
      await seedAllData(pool);
      await seedReconciliation(pool);
      const service = new ReceiptClearService(
        transactions(pool),
        { invalidateAllUserCaches: async () => {} },
        lock,
      );

      assert.deepEqual(await service.clearReceipts(userId), { deletedReceipts: 2 });
      assert.equal(await count(pool, 'users'), 1);
      assert.equal(await count(pool, 'oauth_accounts'), 1);
      assert.equal(await count(pool, 'receipts'), 0);
      for(const table of reconciliationTables)assert.equal(await count(pool,table),0);
      assert.equal(await count(pool, 'gmail_sync_runs'), 0);
      assert.equal(await count(pool, 'user_import_preference_events'), 1);
      const preferences = (
        await pool.query(
          `SELECT monitoring_consent_state, ongoing_tracking_consent_state,
              gmail_import_status, gmail_baseline_completed_at, tracking_status
       FROM user_import_preferences WHERE user_id = $1`,
          [userId],
        )
      ).rows[0];
      assert.deepEqual(preferences, {
        monitoring_consent_state: 'granted',
        ongoing_tracking_consent_state: 'granted',
        gmail_import_status: 'never_started',
        gmail_baseline_completed_at: null,
        tracking_status: 'inactive',
      });
      const providerStatuses = (
        await pool.query(
          `SELECT provider, status FROM user_export_provider_preferences
       WHERE user_id = $1 ORDER BY provider`,
          [userId],
        )
      ).rows;
      assert.deepEqual(providerStatuses, [
        { provider: 'doordash', status: 'not_started' },
        { provider: 'uber_eats', status: 'not_started' },
      ]);
    });
  },
);

test(
  'onboarding reset preserves login identity while restoring fresh import state',
  {
    skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
  },
  async () => {
    await withTemporaryDatabase('reset', async (pool) => {
      await seedAllData(pool);
      await seedReconciliation(pool);
      const service = new AccountResetService(
        transactions(pool),
        { invalidateAllUserCaches: async () => {} },
        { invalidate: () => {} },
        lock,
      );

      assert.deepEqual(await service.resetForOnboarding(userId), { deletedReceipts: 2 });
      assert.equal(await count(pool, 'users'), 1);
      assert.equal(await count(pool, 'oauth_accounts'), 1);
      assert.equal(await count(pool, 'verification_codes'), 1);
      for (const table of [
        ...reconciliationTables,
        'receipts',
        'user_export_provider_preferences',
        'user_import_preference_events',
        'gmail_sync_runs',
      ])
        assert.equal(await count(pool, table), 0, `${table} should be empty`);
      const user = (
        await pool.query(
          `SELECT email, password, email_verified, timezone, gmail_connected,
              gmail_refresh_token, gmail_access_token, gmail_connection_mode
       FROM users WHERE id = $1`,
          [userId],
        )
      ).rows[0];
      assert.deepEqual(user, {
        email,
        password: 'hash',
        email_verified: true,
        timezone: 'America/Toronto',
        gmail_connected: false,
        gmail_refresh_token: null,
        gmail_access_token: null,
        gmail_connection_mode: 'none',
      });
      const preferences = (
        await pool.query(
          `SELECT monitoring_consent_state, gmail_import_status,
              ongoing_tracking_consent_state, tracking_status, automatic_updates_offer_seen_at
       FROM user_import_preferences WHERE user_id = $1`,
          [userId],
        )
      ).rows;
      assert.deepEqual(preferences, [
        {
          monitoring_consent_state: 'not_offered',
          gmail_import_status: 'never_started',
          ongoing_tracking_consent_state: 'not_offered',
          tracking_status: 'inactive',
          automatic_updates_offer_seen_at: null,
        },
      ]);
    });
  },
);

const { AccountDeletionRequestRepository } = require('../dist/services/data/AccountDeletionRequestRepository');
const { AccountDeletionRequestService } = require('../dist/services/account/AccountDeletionRequestService');
const { ImportJobRepository } = require('../dist/services/data/ImportJobRepository');

test('durable deletion cancels work, blocks admission, and resumes after restart without stealing the writer lock', {
  skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
}, async () => {
  await withTemporaryDatabase('durable_delete', async (pool) => {
    await seedAllData(pool);
    const database = { ...transactions(pool), query: pool.query.bind(pool) };
    const jobs = new ImportJobRepository(database);
    const job = await jobs.create({ userId, kind: 'gmail_historical', trigger: 'user', idempotencyKey: 'history' });
    await jobs.claimForRun(job.id);
    const initialGeneration = (await pool.query('SELECT import_generation FROM users WHERE id=$1', [userId])).rows[0].import_generation;
    let writerRunning = true;
    let released = 0;
    const finalizer = new AccountDeletionService(database,
      { invalidateAllUserCaches: async () => {} }, { invalidate() {} }, { revokeRefreshToken: async () => {} },
      { ...lock, acquireLockWithWait: async (_id, wait) => {
        assert.equal(wait, 0);
        return writerRunning ? null : lockHandle;
      }, releaseLock: async () => { released++; return true; } });
    const repository = new AccountDeletionRequestRepository(database);
    const service = new AccountDeletionRequestService(repository, finalizer, { warn() {} });
    assert.equal((await service.request(userId)).status, 'pending');
    await service.request(userId);
    assert.equal(await count(pool, 'account_deletion_requests'), 1);
    const pendingUser = (await pool.query('SELECT import_generation,deletion_requested_at FROM users WHERE id=$1', [userId])).rows[0];
    assert.equal(Number(pendingUser.import_generation), Number(initialGeneration) + 1);
    assert.ok(pendingUser.deletion_requested_at);
    assert.equal((await jobs.findById(job.id)).status, 'cancelled');
    assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM import_job_outbox WHERE published_at IS NULL')).rows[0].n, 0);
    assert.equal(await jobs.claimForRun(job.id), null);
    for (const idempotencyKey of ['history', 'new-import']) {
      await assert.rejects(jobs.create({ userId, kind: 'gmail_historical', trigger: 'user', idempotencyKey }),
        error => error.code === 'ACCOUNT_DELETION_PENDING');
    }
    await service.processPending();
    assert.equal(await count(pool, 'users'), 1);
    assert.equal(await count(pool, 'receipts'), 2);
    assert.equal(released, 0, 'must not release the import owner’s lock');
    assert.equal((await pool.query('SELECT attempts FROM account_deletion_requests')).rows[0].attempts, 1);
    writerRunning = false;
    await pool.query('UPDATE account_deletion_requests SET next_attempt_at=NOW()');
    // New service/repository instances model a restart; no in-memory request state is needed.
    const resumed = new AccountDeletionRequestService(new AccountDeletionRequestRepository(database), finalizer, { warn() {} });
    await resumed.processPending();
    assert.equal(await count(pool, 'users'), 0);
    assert.equal(await count(pool, 'receipts'), 0);
    assert.equal(await count(pool, 'import_jobs'), 0);
    assert.equal(await count(pool, 'account_deletion_requests'), 0);
    assert.equal(released, 1);
    await resumed.processPending();
    assert.equal(released, 1);
  });
});

test('failed deletion acceptance rolls back its fence and cancellations together', {
  skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
}, async () => {
  await withTemporaryDatabase('delete_rollback', async (pool) => {
    await seedAllData(pool);
    const database = { ...transactions(pool), query: pool.query.bind(pool) };
    const jobs = new ImportJobRepository(database);
    const job = await jobs.create({ userId, kind: 'outlook_historical', trigger: 'user' });
    await pool.query(`CREATE FUNCTION reject_deletion_outbox_update() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'injected failure'; END; $$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER reject_deletion_outbox_update BEFORE UPDATE ON import_job_outbox
      FOR EACH ROW EXECUTE FUNCTION reject_deletion_outbox_update()`);
    await assert.rejects(new AccountDeletionRequestRepository(database).request(userId), /injected failure/);
    assert.equal(await count(pool, 'account_deletion_requests'), 0);
    assert.equal((await pool.query('SELECT deletion_requested_at FROM users WHERE id=$1', [userId])).rows[0].deletion_requested_at, null);
    assert.equal((await jobs.findById(job.id)).status, 'pending_dispatch');
  });
});
