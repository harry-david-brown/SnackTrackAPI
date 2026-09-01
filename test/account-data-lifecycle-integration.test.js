const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const { AccountDeletionService } = require('../dist/services/account/AccountDeletionService');
const { ReceiptClearService } = require('../dist/services/account/ReceiptClearService');
const { AccountResetService } = require('../dist/services/data/AccountResetService');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');

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
    await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
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
       gmail_baseline_completed_at, ongoing_tracking_consent_state, tracking_status
     ) VALUES ($1, 'granted', 'completed', NOW(), 'granted', 'active')`,
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
      const service = new AccountDeletionService(
        transactions(pool),
        { invalidateAllUserCaches: async () => {} },
        { invalidate: () => {} },
        { revokeRefreshToken: async () => {} },
        lock,
      );

      assert.deepEqual(await service.deleteAccount(userId, 'refresh-token'), { deleted: true });
      for (const table of [
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
      const service = new ReceiptClearService(
        transactions(pool),
        { invalidateAllUserCaches: async () => {} },
        lock,
      );

      assert.deepEqual(await service.clearReceipts(userId), { deletedReceipts: 2 });
      assert.equal(await count(pool, 'users'), 1);
      assert.equal(await count(pool, 'oauth_accounts'), 1);
      assert.equal(await count(pool, 'receipts'), 0);
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
              ongoing_tracking_consent_state, tracking_status
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
        },
      ]);
    });
  },
);
