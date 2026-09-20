const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const {
  receiptProjectionRevisionMigration,
} = require('../dist/services/data/migrations/028_receipt_projection_revision');
const { UserRepository } = require('../dist/services/data/UserRepository');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { GetUserSummaryService } = require('../dist/services/user/GetUserSummaryService');
const { WrappedAnalyticsService } = require('../dist/services/analytics/WrappedAnalyticsService');
const {
  WrappedAnalyticsQueryRepository,
} = require('../dist/services/analytics/WrappedAnalyticsQueryRepository');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const enabled = {
  skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured',
  timeout: 15000,
};

async function isolated(run) {
  const schema = `receipt_projection_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: databaseUrl });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({
    connectionString: databaseUrl,
    options: `-c search_path=${schema} -c statement_timeout=5000`,
  });
  try {
    await run(pool);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
}
const registry = [...migrations.filter((m) => m.version < 28), receiptProjectionRevisionMigration];
const migrate = (pool, list = registry) =>
  new MigrationRunner({ getClient: () => pool.connect() }, list).run();
const revision = async (db, user) =>
  (
    await db.query('SELECT receipt_projection_revision::text AS revision FROM users WHERE id=$1', [
      user,
    ])
  ).rows[0]?.revision;
async function insertUser(db) {
  const id = randomUUID();
  await db.query("INSERT INTO users(id,email,password) VALUES($1,$2,'test')", [
    id,
    `${id}@example.test`,
  ]);
  return id;
}
async function insertReceipt(db, user, amount = 10) {
  const id = randomUUID();
  await db.query(
    "INSERT INTO receipts(id,user_id,receipt_type,data_source,amount_spent,items) VALUES($1,$2,'uber_eats','csv',$3,'[]')",
    [id, user, amount],
  );
  return id;
}

test(
  'projection revision migration preserves legacy values and scopes insert/update/delete/profile/reset revisions to the same transaction',
  enabled,
  async () =>
    isolated(async (pool) => {
      await migrate(
        pool,
        registry.filter((m) => m.version < 28),
      );
      const user = await insertUser(pool),
        other = await insertUser(pool);
      const existing = await insertReceipt(pool, user);
      const before = (await pool.query('SELECT * FROM receipts WHERE id=$1', [existing])).rows[0];
      assert.deepEqual((await migrate(pool)).applied, [28]);
      assert.deepEqual((await migrate(pool)).applied, []);
      assert.deepEqual(
        (await pool.query('SELECT * FROM receipts WHERE id=$1', [existing])).rows[0],
        before,
      );
      assert.equal(await revision(pool, user), '0');
      await pool.query('UPDATE receipts SET amount_spent=12 WHERE id=$1', [existing]);
      const updated = await revision(pool, user);
      assert.notEqual(updated, '0');
      assert.equal(await revision(pool, other), '0');
      await pool.query('UPDATE receipts SET amount_spent=15 WHERE id=$1', [randomUUID()]);
      assert.equal(
        await revision(pool, user),
        updated,
        'a zero-row statement changes no account revision',
      );
      const tx = await pool.connect();
      try {
        await tx.query('BEGIN');
        await insertReceipt(tx, user);
        const inside = await revision(tx, user);
        assert.notEqual(inside, updated);
        await insertReceipt(tx, user);
        await tx.query("UPDATE users SET timezone='Asia/Tokyo' WHERE id=$1", [user]);
        assert.equal(
          await revision(tx, user),
          inside,
          'one revision per transaction, not every row/statement',
        );
        assert.equal(await revision(pool, user), updated, 'uncommitted versions are invisible');
        await tx.query('ROLLBACK');
        assert.equal(await revision(pool, user), updated);
        assert.equal(
          (await pool.query('SELECT COUNT(*)::int AS count FROM receipts WHERE user_id=$1', [user]))
            .rows[0].count,
          1,
        );
      } finally {
        await tx.query('ROLLBACK');
        tx.release();
      }
      await pool.query('UPDATE receipts SET user_id=$1 WHERE id=$2', [other, existing]);
      const moved = await revision(pool, other);
      assert.notEqual(moved, '0');
      assert.notEqual(await revision(pool, user), updated);
      await pool.query('DELETE FROM receipts WHERE id=$1', [existing]);
      assert.notEqual(await revision(pool, other), moved);
      const empty = await revision(pool, user);
      await pool.query('UPDATE users SET import_generation=import_generation+1 WHERE id=$1', [
        user,
      ]);
      assert.notEqual(
        await revision(pool, user),
        empty,
        'reset still fences old work when receipts are already empty',
      );
      const reset = await revision(pool, user);
      await pool.query("UPDATE users SET timezone='Asia/Tokyo' WHERE id=$1", [user]);
      assert.notEqual(await revision(pool, user), reset);
      const zoned = await revision(pool, user);
      await pool.query('UPDATE users SET timezone=timezone WHERE id=$1', [user]);
      assert.equal(await revision(pool, user), zoned);
      await pool.query('UPDATE users SET email=$2 WHERE id=$1', [
        user,
        `${randomUUID()}@example.test`,
      ]);
      assert.notEqual(await revision(pool, user), zoned);
      await insertReceipt(pool, user);
      await pool.query('DELETE FROM users WHERE id=$1', [user]);
      assert.equal(
        await revision(pool, user),
        undefined,
        'account cascade does not resurrect or block the deleted identity',
      );
    }),
);

test(
  'fresh-schema revisions serialize concurrent receipt commits and also fence a full receipt truncate',
  enabled,
  async () =>
    isolated(async (pool) => {
      await migrate(pool);
      const user = await insertUser(pool),
        other = await insertUser(pool);
      const existing = await insertReceipt(pool, user);
      const a = await pool.connect(),
        b = await pool.connect();
      let second;
      try {
        await a.query('BEGIN');
        await b.query('BEGIN');
        await insertReceipt(a, user);
        const first = await revision(a, user);
        const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        second = b.query('UPDATE receipts SET amount_spent=20 WHERE id=$1', [existing]);
        // Observe the actual database lock, not just a locally pending promise.
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked = (
            await pool.query('SELECT cardinality(pg_blocking_pids($1))>0 AS blocked', [pid])
          ).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(blocked, true);
        await a.query('COMMIT');
        await second;
        second = undefined;
        assert.equal(await revision(pool, user), first);
        await b.query('COMMIT');
        assert.notEqual(
          await revision(pool, user),
          first,
          'second commit has a distinct visible projection revision',
        );
      } finally {
        await a.query('ROLLBACK');
        if (second) await second.catch(() => {});
        await b.query('ROLLBACK');
        a.release();
        b.release();
      }
      const before = await revision(pool, user);
      await pool.query('TRUNCATE receipts CASCADE');
      assert.notEqual(await revision(pool, user), before);
      assert.notEqual(await revision(pool, other), '0');
    }),
);

test(
  'real repository Summary and recap reads bypass an older in-flight result and retained cache after committed changes and clear',
  enabled,
  async () =>
    isolated(async (pool) => {
      await migrate(pool);
      const userId = await insertUser(pool);
      await pool.query("UPDATE users SET timezone='America/Toronto' WHERE id=$1", [userId]);
      const receipts = await decemberCanonicalOrders();
      for (const r of receipts) {
        r.id = randomUUID();
        r.userId = userId;
        await pool.query(
          'INSERT INTO receipts(id,user_id,receipt_type,data_source,restaurant_name,amount_spent,items,order_date,delivery_time,currency_code,resolution) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)',
          [
            r.id,
            userId,
            r.receiptType,
            r.dataSource,
            r.restaurantName,
            r.amountSpent,
            JSON.stringify(r.items),
            r.orderDate,
            r.deliveryTime,
            r.monetaryDetails.currencyCode,
            JSON.stringify(r.resolution),
          ],
        );
      }
      const entries = new Map();
      let resume,
        enter,
        first = true;
      const entered = new Promise((resolve) => {
        enter = resolve;
      });
      const waiting = new Promise((resolve) => {
        resume = resolve;
      });
      const wrapped = new WrappedAnalyticsService(new WrappedAnalyticsQueryRepository(pool));
      const service = new GetUserSummaryService(
        new UserRepository(pool),
        new ReceiptRepository(pool),
        {
          calculateWrappedAnalytics: async (id, snapshot) => {
            if (first) {
              first = false;
              enter();
              await waiting;
            }
            return wrapped.calculateWrappedAnalytics(id, snapshot);
          },
        },
        {
          getUserSummary: async (key) => entries.get(key),
          cacheUserSummary: async (key, value) => entries.set(key, value),
          invalidateAllUserCaches: async () => {},
        },
      );
      const execute = () => service.execute({ userId, includeWrapped: true });
      const old = execute();
      try {
        await entered;
        const removed = receipts.find((r) => r.resolution.orderOutcome.fulfillment === 'canceled');
        await pool.query('DELETE FROM receipts WHERE user_id=$1 AND id=$2', [userId, removed.id]);
        let timer;
        const fresh = await Promise.race([
          execute(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error('fresh database revision joined stale single flight')),
              2000,
            );
          }),
        ]).finally(() => clearTimeout(timer));
        assert.equal(fresh.statistics.totalReceipts, 4);
        assert.equal(fresh.statistics.totalSpent, 113.76);
        assert.equal(fresh.wrappedAnalytics.orderMetrics.attempts, 4);
        resume();
        assert.equal((await old).statistics.totalReceipts, 5);
        assert.equal(entries.size, 1, 'superseded response did not publish');
        assert.equal(await execute(), fresh);
        const tx = await pool.connect();
        try {
          await tx.query('BEGIN');
          await tx.query('UPDATE users SET import_generation=import_generation+1 WHERE id=$1', [
            userId,
          ]);
          await tx.query('DELETE FROM receipts WHERE user_id=$1', [userId]);
          await tx.query('COMMIT');
        } finally {
          await tx.query('ROLLBACK');
          tx.release();
        }
        const cleared = await execute();
        assert.equal(cleared.statistics.totalSpent, 0);
        assert.equal(cleared.statistics.totalReceipts, 0);
        assert.equal(cleared.wrappedAnalytics.coverage.orderCount, 0);
        assert.equal(
          entries.size,
          2,
          'retained older cache cannot be served even when invalidation failed',
        );
      } finally {
        resume();
        await old;
      }
    }),
);
