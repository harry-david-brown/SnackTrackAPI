const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { orderEventsMigration } = require('../dist/services/data/migrations/027_order_events');
const { ReceiptRepository } = require('../dist/services/data/ReceiptRepository');
const { Receipt } = require('../dist/models/Receipt');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const userId = 'b593ed60-2c4e-465d-ab66-03eb18400001';
function observations() {
  const date = new Date('2025-08-06T13:48:00Z');
  const exported = new Receipt(
    userId,
    [
      { name: 'Sandwich', quantity: 2, price: 6.59 },
      { name: 'Hash Brown', quantity: 1, price: 2.69 },
    ],
    19.87,
    'uber_eats',
    'Example Branch',
    date,
    'csv',
    new Date('2025-08-06T14:15:00Z'),
    undefined,
    undefined,
    { currencyCode: 'CAD' },
    {
      version: 1,
      amountBasis: 'export_total',
      exportedTotal: 19.87,
      reconstructedSubtotal: 15.87,
      adjustments: [],
      issues: [],
    },
  );
  const email = new Receipt(
    userId,
    [],
    21.86,
    'uber_eats',
    'Example Branch',
    date,
    'email',
    undefined,
    'order-id',
    undefined,
    { currencyCode: 'CAD' },
    {
      version: 1,
      amountBasis: 'receipt_total',
      receiptTotal: 21.86,
      sourceMessageId: 'gmail:1',
      sourceRevisionAt: '2025-08-06T14:16:00Z',
      adjustments: [],
      issues: [],
    },
  );
  return { exported, email };
}

test(
  'PostgreSQL preserves paired observations, revisions, rollback and late matching',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = 'receipt_test_' + randomUUID().replaceAll('-', '');
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
      await new MigrationRunner({ getClient: () => pool.connect() },
        migrations.some((m) => m.version === 27) ? migrations : [...migrations, orderEventsMigration]).run();
      await pool.query(
        "INSERT INTO users(id,email,password) VALUES($1,'receipt-test@example.com','test')",
        [userId],
      );
      const repo = new ReceiptRepository(db, 2), // Legacy source/revision characterization.
        allow = async () => {};
      const count = async () =>
        Number(
          (await pool.query('SELECT COUNT(*) AS count FROM receipt_observations')).rows[0].count,
        );
      for (const emailFirst of [true, false]) {
        await pool.query('DELETE FROM receipts');
        await pool.query('DELETE FROM receipt_observations');
        const { email, exported } = observations();
        if (emailFirst) await repo.upsertEmailReceipts([email], allow);
        else await repo.replaceProviderExport(userId, [exported], allow);
        const id = (await repo.findByUserId(userId))[0].id;
        if (emailFirst) await repo.replaceProviderExport(userId, [exported], allow);
        else await repo.upsertEmailReceipts([email], allow);
        const records = await repo.findByUserId(userId);
        assert.equal(records.length, 1);
        assert.equal(records[0].id, id);
        assert.equal(records[0].resolution.checkoutDifference.amount, 5.99);
        assert.equal(await count(), 2);
        await repo.replaceProviderExport(userId, [exported], allow);
        assert.deepEqual(await repo.upsertEmailReceipts([email], allow), {
          newOrders: 0,
          updatedOrders: 0,
          unchangedOrders: 1,
          unresolvedOrders: 0,
        });
        assert.equal(await count(), 2);
        const revised = {
          ...email,
          amountSpent: 18,
          resolution: {
            ...email.resolution,
            receiptTotal: 18,
            sourceMessageId: 'gmail:2',
            sourceRevisionAt: '2025-08-07T12:00:00Z',
          },
        };
        let guards = 0;
        await assert.rejects(
          repo.upsertEmailReceipts([revised], async () => {
            if (++guards === 3) throw Error('stale generation');
          }),
          /stale generation/,
        );
        assert.equal(await count(), 2);
        assert.equal((await repo.findByUserId(userId))[0].amountSpent, 21.86);
        await repo.upsertEmailReceipts([revised], allow);
        assert.equal(await count(), 3);
        assert.equal(
          (await repo.findByUserId(userId))[0].resolution.checkoutDifference.amount,
          2.13,
        );
      }
      await pool.query('DELETE FROM receipts');
      await pool.query('DELETE FROM receipt_observations');
      const { email, exported } = observations();
      await repo.upsertEmailReceipts([{ ...email, restaurantName: 'Unknown Branch' }], allow);
      const id = (await repo.findByUserId(userId))[0].id;
      await repo.replaceProviderExport(userId, [exported], allow);
      assert.equal((await repo.findByUserId(userId)).length, 2);
      await repo.upsertEmailReceipts(
        [
          {
            ...email,
            resolution: {
              ...email.resolution,
              sourceMessageId: 'gmail:2',
              sourceRevisionAt: '2025-08-07T12:00:00Z',
            },
          },
        ],
        allow,
      );
      const records = await repo.findByUserId(userId);
      assert.equal(records.length, 1);
      assert.equal(records[0].id, id);
      assert.equal(await count(), 3);
      assert.equal(records[0].resolution.checkoutDifference.amount, 5.99);
      assert.deepEqual(records[0].resolution.sources, ['csv', 'email']);
      // Restore separate projections to exercise a real association repair and rollback.
      await pool.query('DELETE FROM receipts');
      await pool.query('DELETE FROM receipt_observations');
      const first = {
        ...email,
        orderDate: new Date('2025-08-06T06:00:00Z'),
        externalId: undefined,
      };
      await repo.upsertEmailReceipts([first], allow);
      await repo.replaceProviderExport(userId, [exported], allow);
      assert.equal((await repo.findByUserId(userId)).length, 1);
      const late = {
        ...first,
        orderDate: new Date('2025-08-06T07:00:00Z'),
        resolution: { ...first.resolution, sourceMessageId: 'gmail:late' },
      };
      await repo.upsertEmailReceipts([late], allow);
      assert.equal(
        (await repo.findByUserId(userId)).length,
        3,
        'later evidence splits the inferred pair',
      );
      assert.equal(await count(), 3, 'split retains every source');
      const generation = Number(
        (await pool.query('SELECT import_generation FROM users WHERE id=$1', [userId])).rows[0]
          .import_generation,
      );
      const beforeRepair = await repo.findByUserId(userId);
      const prepared = await repo.rebuildProjection(userId, generation, 'prepare', allow);
      assert.equal(prepared.mode, 'prepare');
      await assert.rejects(repo.rebuildProjection(userId, generation, 'publish', allow), /explicit repair manifest/);
      await repo.rebuildProjection(userId, generation, 'publish', allow, prepared.manifestId);
      assert.equal(
        (await repo.rebuildProjection(userId, generation, 'publish', allow, prepared.manifestId)).changed,
        0,
        'publish retry is idempotent',
      );
      await repo.rebuildProjection(userId, generation, 'rollback', allow, prepared.manifestId);
      assert.equal(
        (await repo.rebuildProjection(userId, generation, 'rollback', allow, prepared.manifestId)).changed,
        0,
        'rollback retry is idempotent',
      );
      assert.deepEqual(await repo.findByUserId(userId), beforeRepair);
      const stale = await repo.rebuildProjection(userId, generation, 'prepare', allow);
      await repo.upsertEmailReceipts([{ ...late, amountSpent: 17 }], allow);
      await assert.rejects(repo.rebuildProjection(userId, generation, 'publish', allow, stale.manifestId), /changed/);
      await assert.rejects(
        repo.rebuildProjection(userId, generation + 1, 'prepare', allow),
        /stale/,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
