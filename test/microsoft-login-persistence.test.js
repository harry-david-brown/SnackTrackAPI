const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, randomBytes } = require('node:crypto');
const { Pool } = require('pg');

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-thirty-two-characters';

const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const {
  MicrosoftLoginAttemptRepository,
} = require('../dist/services/data/MicrosoftLoginAttemptRepository');
const { OtpService } = require('../dist/services/OtpService');

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

const withDatabase = async (operation) => {
  const schema = `microsoft_login_test_${process.pid}_${randomBytes(6).toString('hex')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${schema}`,
  });
  const database = {
    query: (sql, params) => pool.query(sql, params),
    withTransaction: async (callback) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({ query: (sql, params) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
  try {
    await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
    await operation(database);
  } finally {
    await pool.end();
    await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.end();
  }
};

test(
  'attempt-scoped OTP completion creates one linked user atomically and rejects replay',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    await withDatabase(async (database) => {
      const attempts = new MicrosoftLoginAttemptRepository(database);
      const codes = new OtpService(database, () => 123456);
      const attemptToken = 'private-attempt-token';
      const attemptId = '11111111-1111-4111-8111-111111111111';
      const providerUserId = 'tenant:object';
      const email = 'person@example.com';
      await attempts.create(
        attemptId,
        createHash('sha256').update(attemptToken).digest('hex'),
        createHash('sha256').update('nonce').digest('hex'),
        new Date(Date.now() + 10 * 60 * 1000),
      );
      await attempts.requireEmailVerification(attemptId, providerUserId, email);
      await attempts.setVerificationEmail(attemptId, email);
      await codes.storeScopedOTP(attemptId, email, 'provider_login');

      assert.equal(
        await codes.consumeScopedOTP(
          attemptId,
          email,
          '000000',
          'provider_login',
          async () => assert.fail('invalid code must not mutate the account'),
        ),
        'invalid',
      );
      assert.equal((await database.query('SELECT id FROM users')).rowCount, 0);

      let completedUser;
      assert.equal(
        await codes.consumeScopedOTP(
          attemptId,
          email,
          '123456',
          'provider_login',
          async (transaction) => {
            completedUser = await attempts.completeWithExecutor(
              attemptId,
              providerUserId,
              email,
              transaction,
            );
          },
        ),
        'consumed',
      );
      assert.equal(completedUser.email, email);
      assert.equal(completedUser.emailVerified, true);
      assert.equal((await database.query('SELECT id FROM users')).rowCount, 1);
      const link = await database.query(
        `SELECT provider, provider_user_id, access_token, refresh_token
         FROM oauth_accounts`,
      );
      assert.deepEqual(link.rows, [
        {
          provider: 'microsoft',
          provider_user_id: providerUserId,
          access_token: null,
          refresh_token: null,
        },
      ]);
      await assert.rejects(
        attempts.complete(attemptId, providerUserId, email),
        (error) => error.code === 'MICROSOFT_ATTEMPT_EXPIRED',
      );
    });
  },
);

test(
  'unused Microsoft email creates an unverified account while an existing email requires proof',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    await withDatabase(async (database) => {
      const attempts = new MicrosoftLoginAttemptRepository(database);
      const email = 'person@example.com';
      const firstAttemptId = '22222222-2222-4222-8222-222222222222';
      await attempts.create(
        firstAttemptId,
        createHash('sha256').update('first-attempt-token').digest('hex'),
        createHash('sha256').update('first-nonce').digest('hex'),
        new Date(Date.now() + 10 * 60 * 1000),
      );

      const user = await attempts.completeUnverifiedNewAccount(
        firstAttemptId,
        'tenant:first-object',
        email,
      );
      assert.equal(user.email, email);
      assert.equal(user.emailVerified, false);
      assert.equal((await database.query('SELECT id FROM users')).rowCount, 1);
      assert.equal((await database.query('SELECT id FROM oauth_accounts')).rowCount, 1);
      await assert.rejects(
        attempts.completeUnverifiedNewAccount(firstAttemptId, 'tenant:first-object', email),
        (error) => error.code === 'MICROSOFT_ATTEMPT_EXPIRED',
      );

      const collisionAttemptId = '33333333-3333-4333-8333-333333333333';
      await attempts.create(
        collisionAttemptId,
        createHash('sha256').update('collision-attempt-token').digest('hex'),
        createHash('sha256').update('collision-nonce').digest('hex'),
        new Date(Date.now() + 10 * 60 * 1000),
      );
      const collision = await attempts.completeUnverifiedNewAccount(
        collisionAttemptId,
        'tenant:second-object',
        email,
      );
      assert.equal(collision, undefined);
      assert.equal((await database.query('SELECT id FROM users')).rowCount, 1);
      assert.equal((await database.query('SELECT id FROM oauth_accounts')).rowCount, 1);
    });
  },
);
