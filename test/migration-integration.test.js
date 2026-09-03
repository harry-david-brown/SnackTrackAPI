const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { Pool } = require('pg');

const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

const withTemporarySchema = async (label, operation) => {
  const suffix = randomBytes(6).toString('hex');
  const schema = `migration_test_${label}_${process.pid}_${suffix}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${schema}`,
  });
  try {
    await operation(pool, schema);
  } finally {
    await pool.end();
    await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.end();
  }
};

test(
  'ordered migrations build an empty schema and are idempotent',
  {
    skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
  },
  async () => {
    await withTemporarySchema('empty', async (pool) => {
      const runner = new MigrationRunner({ getClient: () => pool.connect() }, migrations);
      const first = await runner.run();
      const second = await runner.run();

      assert.deepEqual(
        first.applied,
        migrations.map(({ version }) => version),
      );
      assert.deepEqual(second.applied, []);
      assert.deepEqual(
        second.alreadyApplied,
        migrations.map(({ version }) => version),
      );

      const history = await pool.query(
        'SELECT version, name FROM schema_migrations ORDER BY version',
      );
      assert.deepEqual(
        history.rows,
        migrations.map(({ version, name }) => ({ version, name })),
      );
      const tables = await pool.query(
        `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()`,
      );
      const names = new Set(tables.rows.map(({ table_name }) => table_name));
      for (const expected of [
        'users',
        'receipts',
        'verification_codes',
        'oauth_accounts',
        'oauth_login_attempts',
        'user_import_preferences',
        'user_export_provider_preferences',
        'user_import_preference_events',
        'gmail_sync_runs',
      ])
        assert.equal(names.has(expected), true, `${expected} should exist`);
      const guidanceColumns = await pool.query(
        `SELECT table_name, column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND ((table_name = 'user_import_preferences' AND column_name = 'initial_setup_deferred_until')
             OR (table_name = 'user_export_provider_preferences' AND column_name = 'relevance'))`,
      );
      assert.equal(guidanceColumns.rowCount, 2);
      const checkpointColumn = await pool.query(
        `SELECT data_type, column_default, is_nullable FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'import_jobs' AND column_name = 'checkpoint'`,
      );
      assert.equal(checkpointColumn.rowCount, 1);
      assert.equal(checkpointColumn.rows[0].data_type, 'jsonb');
      assert.equal(checkpointColumn.rows[0].is_nullable, 'NO');
    });
  },
);

test(
  'ordered migrations upgrade a representative legacy schema without losing data',
  {
    skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
  },
  async () => {
    await withTemporarySchema('legacy', async (pool) => {
      await pool.query(`CREATE TABLE users (
      id UUID PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
      await pool.query(`CREATE TABLE receipts (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      receipt_type VARCHAR(50) NOT NULL DEFAULT 'unknown',
      data_source VARCHAR(20) NOT NULL DEFAULT 'csv',
      restaurant_name VARCHAR(255),
      order_date TIMESTAMP,
      amount_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
      items TEXT[],
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
      await pool.query(`CREATE TABLE user_import_preferences (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      export_status VARCHAR(40) NOT NULL DEFAULT 'not_started'
    )`);
      const userId = '11111111-1111-4111-8111-111111111111';
      const receiptId = '22222222-2222-4222-8222-222222222222';
      await pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        userId,
        'legacy@example.com',
      ]);
      await pool.query(
        `INSERT INTO receipts (
        id, user_id, receipt_type, data_source, restaurant_name,
        order_date, amount_spent, items, created_at
       ) VALUES ($1, $2, 'uber_eats', 'email', 'Legacy Kitchen',
         '2025-06-10 18:30:00', 24.50, ARRAY['Burger', 'Fries'], '2025-06-10 18:31:00')`,
        [receiptId, userId],
      );
      await pool.query(
        `INSERT INTO user_import_preferences (user_id, export_status)
       VALUES ($1, 'file_ready')`,
        [userId],
      );

      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();

      const receipt = await pool.query(
        `SELECT items, pg_typeof(items)::TEXT AS items_type,
              year, source_identity, order_date
       FROM receipts WHERE id = $1`,
        [receiptId],
      );
      assert.deepEqual(receipt.rows[0].items, ['Burger', 'Fries']);
      assert.equal(receipt.rows[0].items_type, 'jsonb');
      assert.equal(receipt.rows[0].year, 2025);
      assert.match(receipt.rows[0].source_identity, /^fallback:legacy kitchen\|/);

      const orderDateType = await pool.query(
        `SELECT data_type FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'receipts' AND column_name = 'order_date'`,
      );
      assert.equal(orderDateType.rows[0].data_type, 'timestamp with time zone');
      const provider = await pool.query(
        `SELECT provider, status FROM user_export_provider_preferences
       WHERE user_id = $1`,
        [userId],
      );
      assert.deepEqual(provider.rows, [{ provider: 'uber_eats', status: 'file_ready' }]);
      await pool.query(
        `UPDATE user_export_provider_preferences SET relevance = 'not_used'
         WHERE user_id = $1 AND provider = 'uber_eats'`,
        [userId],
      );
      await pool.query(`UPDATE receipts SET receipt_type = 'uber_eats' WHERE id = $1`, [receiptId]);
      assert.equal(
        (await pool.query(
          `SELECT relevance FROM user_export_provider_preferences
           WHERE user_id = $1 AND provider = 'uber_eats'`,
          [userId],
        )).rows[0].relevance,
        'unknown',
      );
      const removedLegacyColumns = await pool.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'user_import_preferences'
           AND column_name IN ('export_status', 'export_requested_at', 'export_updated_at')`,
      );
      assert.deepEqual(removedLegacyColumns.rows, []);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM users')).rows[0].count, 1);
    });
  },
);
