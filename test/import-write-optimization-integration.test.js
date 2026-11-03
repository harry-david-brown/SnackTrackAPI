const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { GmailUnitBudgetRepository } = require('../dist/services/data/GmailUnitBudgetRepository');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { Receipt } = require('../dist/models/Receipt');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test('batched projections preserve replay/rollback and concurrent quota reservations remain atomic',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' }, async () => {
    const schema = `import_writes_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const statements = [];
    const db = {
      query: (...args) => pool.query(...args),
      withTransaction: async (action) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const value = await action({ query: (sql, params) => {
            statements.push(sql);
            return client.query(sql, params);
          } });
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
    };
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const userId = randomUUID();
      await pool.query("INSERT INTO users(id,email,password) VALUES($1,$2,'test')", [userId, `${userId}@example.invalid`]);
      const receipts = Array.from({ length: 205 }, (_, index) => new Receipt(
        userId, [], 20, 'uber_eats', 'Example', new Date(Date.UTC(2025, 0, index + 1)),
        'email', undefined, `order-${index}`, undefined, { currencyCode: 'CAD' },
        { version: 1, amountBasis: 'receipt_total', receiptTotal: 20, adjustments: [], issues: [], sourceMessageId: `gmail:${index}` },
      ));
      const repo = new ReceiptRepository(db, 3);
      const allow = async () => {};
      await repo.upsertEmailReceipts(receipts, allow);
      assert.equal(statements.filter(sql => sql.startsWith('INSERT INTO receipts(')).length, 3);
      assert.equal(statements.filter(sql => sql.startsWith('INSERT INTO receipt_observations(')).length, 3);
      const snapshot = async () => {
        const result = {};
        for (const table of ['receipts', 'receipt_observations', 'receipt_order_events', 'receipt_order_event_observations']) {
          result[table] = (await pool.query(`SELECT * FROM ${table} WHERE user_id=$1 ORDER BY row_to_json(${table})::text`, [userId])).rows;
        }
        return result;
      };
      const before = await snapshot();
      assert.equal(before.receipts.length, 205);
      assert.equal(before.receipt_observations.length, 205);
      await repo.upsertEmailReceipts(receipts, allow);
      assert.deepEqual(await snapshot(), before);
      let guards = 0;
      const extra = { ...receipts[0], externalId: 'extra-order', orderDate: new Date('2030-01-01'), resolution: { ...receipts[0].resolution, sourceMessageId: 'gmail:extra' } };
      await assert.rejects(repo.upsertEmailReceipts([extra], async () => {
        if (++guards === 3) throw new Error('writer lock lost');
      }), /writer lock lost/);
      assert.deepEqual(await snapshot(), before);

      const clearQuota = () => pool.query('TRUNCATE gmail_api_project_day_budget,gmail_api_project_minute_budget,gmail_api_user_minute_budget,gmail_api_usage_minute');
      for (const window of ['projectDay', 'projectMinute', 'userMinute']) {
        await clearQuota();
        const limits = { projectDay: 10000, projectMinute: 10000, userMinute: 10000, [window]: 180 };
        const budget = new GmailUnitBudgetRepository(db, limits);
        const results = await Promise.allSettled(Array.from({ length: 10 }, () => budget.reserve(userId, 'onboarding_import', 'messages.get', 60)));
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
        for (const result of results.filter(result => result.status === 'rejected'))
          assert.equal(result.reason.code, 'GMAIL_UNIT_BUDGET_EXHAUSTED');
        for (const table of ['gmail_api_project_day_budget', 'gmail_api_project_minute_budget', 'gmail_api_user_minute_budget', 'gmail_api_usage_minute'])
          assert.equal(Number((await pool.query(`SELECT sum(units) AS units FROM ${table}`)).rows[0].units), 180);
        assert.equal(Number((await pool.query('SELECT sum(request_count) AS count FROM gmail_api_usage_minute')).rows[0].count), 3);
      }
      await clearQuota();
      const budget = new GmailUnitBudgetRepository(db, { projectDay: 1000, projectMinute: 1000, userMinute: 50 });
      await assert.rejects(budget.reserve(userId, 'onboarding_import', 'messages.get', 60), error => error.code === 'GMAIL_UNIT_BUDGET_EXHAUSTED');
      assert.equal(Number((await pool.query('SELECT count(*) AS count FROM gmail_api_project_day_budget')).rows[0].count), 0);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  });
