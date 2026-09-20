const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const {
  AdministratorQueryRepository,
} = require('../dist/services/admin/AdministratorQueryRepository');
const { summarizeAdminReceipts } = require('../dist/services/admin/AdminReceiptSummary');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'administrator SQL and API domain agree for December, uncertain evidence, currencies and empty pages',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `admin_receipts_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const all = [];
    const scoped = new Map();
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const repository = new AdministratorQueryRepository(pool);
      const empty = await repository.getDatabaseStatistics();
      assert.deepEqual(empty.database.receiptSummary, summarizeAdminReceipts([]));
      assert.equal(empty.database.totalAmountAllUsers, 0);
      assert.deepEqual(await repository.listUsers(5, 0), { users: [], total: 0 });
      const december = await decemberCanonicalOrders();
      async function insert(receipts) {
        const userId = randomUUID();
        await pool.query(
          "INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test','America/Toronto')",
          [userId, `${userId}@example.test`],
        );
        for (const r of receipts)
          await pool.query(
            'INSERT INTO receipts(id,user_id,receipt_type,data_source,restaurant_name,amount_spent,items,order_date,delivery_time,currency_code,resolution) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)',
            [
              randomUUID(),
              userId,
              r.receiptType,
              r.dataSource,
              r.restaurantName,
              r.amountSpent,
              JSON.stringify(r.items),
              r.orderDate,
              r.deliveryTime,
              r.monetaryDetails?.currencyCode ?? null,
              JSON.stringify(r.resolution ?? null),
            ],
          );
        scoped.set(userId, receipts);
        all.push(...receipts);
        const report = await repository.getReceiptReport(userId);
        assert.deepEqual(report.summary, summarizeAdminReceipts(receipts));
        const expectedSources = [];
        for (const source of ['csv', 'email'])
          for (const provider of ['doordash', 'uber_eats']) {
            const members = receipts.filter(
              (r) =>
                r.receiptType === provider &&
                (r.dataSource === source || r.resolution?.sources?.includes(source)),
            );
            if (!members.length) continue;
            const summary = summarizeAdminReceipts(members);
            expectedSources.push({
              dataSource: source,
              receiptType: provider,
              count: members.length,
              establishedOrders: summary.attempts,
              unresolvedCount: summary.possibleAdditionalOrders,
            });
          }
        assert.deepEqual(report.sources, expectedSources);
        return userId;
      }
      const targetId = await insert(december);
      const target = await repository.getReceiptReport(targetId);
      assert.equal(target.summary.attempts, 5);
      assert.equal(target.summary.deliveries, 4);
      assert.equal(target.summary.currencies[0].netSpend, 157.02);
      assert.deepEqual(
        target.sources.map((s) => s.count),
        [5, 5],
      );
      const mutations = [
        [
          'unknown price',
          (r) => {
            r.resolution.orderOutcome.netAmount = null;
          },
        ],
        [
          'conflicted price',
          (r) => {
            r.resolution.orderOutcome.financialConfidence = 'conflicted';
          },
        ],
        [
          'possible duplicate',
          (r) => {
            r.resolution.reconciliation.status = 'unresolved';
          },
        ],
        [
          'orphan refund',
          (r) => {
            r.resolution.orderOutcome.kind = 'unlinked_adjustment';
          },
        ],
        [
          'legacy',
          (r) => {
            delete r.resolution.orderOutcome;
          },
        ],
        [
          'subtotal only',
          (r) => {
            delete r.resolution.orderOutcome;
            r.resolution.amountBasis = 'item_subtotal';
          },
        ],
        [
          'no resolution',
          (r) => {
            delete r.resolution;
          },
        ],
        [
          'unknown currency',
          (r) => {
            delete r.monetaryDetails.currencyCode;
          },
        ],
        [
          'mixed currencies',
          (r) => {
            r.monetaryDetails.currencyCode = 'USD';
          },
        ],
        [
          'unclassified refund',
          (r) =>
            Object.assign(r.resolution.orderOutcome, {
              refundStatus: 'confirmed_unclassified',
              refundConfidence: 'confirmed',
              confirmedRefundAmount: null,
            }),
        ],
        [
          'partial refund',
          (r) =>
            Object.assign(r.resolution.orderOutcome, {
              refundStatus: 'partial',
              refundConfidence: 'confirmed',
              confirmedRefundAmount: 5,
            }),
        ],
        [
          'reversed refund',
          (r) =>
            Object.assign(r.resolution.orderOutcome, {
              refundStatus: 'reversed',
              refundConfidence: 'confirmed',
              confirmedRefundAmount: 0,
            }),
        ],
        [
          'probable refund',
          (r) =>
            Object.assign(r.resolution.orderOutcome, {
              refundStatus: 'probable_full',
              refundConfidence: 'inferred',
              estimatedRefundAmount: 25,
              financialConfidence: 'inferred',
              netAmount: 0,
            }),
        ],
        [
          'failed',
          (r) => {
            r.resolution.orderOutcome.fulfillment = 'failed';
          },
        ],
        [
          'unfulfilled',
          (r) => {
            r.resolution.orderOutcome.fulfillment = 'unfulfilled';
          },
        ],
        [
          'zero cancellation',
          (r) =>
            Object.assign(r.resolution.orderOutcome, { fulfillment: 'canceled', netAmount: 0 }),
        ],
      ];
      const base = december.find(
        (r) => r.resolution.orderOutcome.fulfillment === 'completed' && r.amountSpent > 0,
      );
      for (const [name, mutate] of mutations) {
        const changed = structuredClone(base);
        mutate(changed);
        try {
          await insert([changed, structuredClone(base)]);
        } catch (error) {
          error.message = `${name}: ${error.message}`;
          throw error;
        }
      }
      await insert([]);
      const report = await repository.getDatabaseStatistics();
      assert.deepEqual(report.database.receiptSummary, summarizeAdminReceipts(all));
      assert.equal(report.database.totalReceipts, all.length);
      assert.equal(report.database.totalUsers, scoped.size);
      assert.equal(report.database.totalAmountAllUsers, null);
      assert.equal(report.database.averageReceiptAmount, null);
      assert.equal(report.database.currencyCode, null);
      const page = await repository.listUsers(100, 0);
      assert.equal(page.total, scoped.size);
      assert.equal(page.users.length, scoped.size);
      for (const user of page.users) {
        assert.deepEqual(user.receiptSummary, summarizeAdminReceipts(scoped.get(user.id)));
        assert.equal(user.receiptCount, scoped.get(user.id).length);
      }
      const user = page.users.find((u) => u.id === targetId);
      assert.equal(user.totalSpent, 157.02);
      assert.equal(user.currencyCode, 'CAD');
      assert.deepEqual(await repository.listUsers(2, 100), { users: [], total: scoped.size });
      const first = await repository.listUsers(2, 0),
        second = await repository.listUsers(2, 2);
      assert.equal(new Set([...first.users, ...second.users].map((u) => u.id)).size, 4);
      assert.equal(JSON.stringify(page).includes('observationIds'), false);
      assert.equal(JSON.stringify(page).includes('payments'), false);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
