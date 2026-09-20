const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { orderEventsMigration } = require('../dist/services/data/migrations/027_order_events');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'order event migration preserves existing source facts and enforces ownership and immutability',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `order_event_migration_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const user = randomUUID(),
      other = randomUUID(),
      receipt = randomUUID(),
      observation = randomUUID();
    try {
      const clients = { getClient: () => pool.connect() };
      const prior = migrations.filter((m) => m.version < 27);
      await new MigrationRunner(clients, prior).run();
      await pool.query(
        "INSERT INTO users(id,email,password) VALUES($1,'existing@example.test','test'),($2,'other@example.test','test')",
        [user, other],
      );
      await pool.query(
        "INSERT INTO receipts(id,user_id,receipt_type,data_source,restaurant_name,amount_spent,items) VALUES($1,$2,'uber_eats','csv','Existing cafe',10,'[]')",
        [receipt, user],
      );
      await pool.query(
        "INSERT INTO receipt_observations(id,user_id,receipt_id,document_key,import_generation,parser_version,payload) VALUES($1,$2,$3,'existing',1,2,'{\"amountSpent\":10}')",
        [observation, user, receipt],
      );
      const before = (
        await pool.query(
          'SELECT payload,parser_version,created_at FROM receipt_observations WHERE id=$1',
          [observation],
        )
      ).rows[0];
      assert.deepEqual(
        (await new MigrationRunner(clients, [...prior, orderEventsMigration]).run()).applied,
        [27],
      );
      assert.deepEqual(
        (await new MigrationRunner(clients, [...prior, orderEventsMigration]).run()).applied,
        [],
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT payload,parser_version,created_at FROM receipt_observations WHERE id=$1',
            [observation],
          )
        ).rows[0],
        before,
      );
      const row = (
        await pool.query(
          'SELECT amount_spent,order_fulfillment,order_net_amount FROM receipts WHERE id=$1',
          [receipt],
        )
      ).rows[0];
      assert.equal(Number(row.amount_spent), 10);
      assert.equal(row.order_fulfillment, null);
      assert.equal(
        row.order_net_amount,
        null,
        'legacy values remain unknown, not newly invented outcomes',
      );
      await assert.rejects(
        pool.query('UPDATE receipt_observations SET parser_version=3 WHERE id=$1', [observation]),
        /immutable/,
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO receipt_observations(id,user_id,receipt_id,document_key,import_generation,parser_version,payload) VALUES($1,$2,$3,'cross-user',1,3,'{}')",
          [randomUUID(), other, receipt],
        ),
        /receipt_observation_owner_check/,
      );
      await assert.rejects(
        pool.query(
          "INSERT INTO receipt_order_events(user_id,receipt_id,event_key,kind,amount,currency_code,confidence,payload) VALUES($1,$2,'cross-user','charge',10,'CAD','confirmed','{}')",
          [other, receipt],
        ),
        /foreign key/,
      );
      await pool.query(
        "INSERT INTO receipt_import_batches(id,user_id,provider,observed_start,observed_end,accepted_orders) VALUES('existing',$1,'uber_eats',NOW(),NOW(),1)",
        [user],
      );
      await assert.rejects(
        pool.query(
          "UPDATE receipt_import_batches SET accepted_orders=2 WHERE user_id=$1 AND id='existing'",
          [user],
        ),
        /immutable/,
      );
      await pool.query(
        'UPDATE receipt_import_batches SET association_enabled=false WHERE user_id=$1',
        [user],
      );
      await pool.query('DELETE FROM receipts WHERE id=$1', [receipt]);
      assert.equal(
        (await pool.query('SELECT receipt_id FROM receipt_observations WHERE id=$1', [observation]))
          .rows[0].receipt_id,
        null,
      );
      assert.deepEqual(
        (
          await pool.query(
            'SELECT payload,parser_version,created_at FROM receipt_observations WHERE id=$1',
            [observation],
          )
        ).rows[0],
        before,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
