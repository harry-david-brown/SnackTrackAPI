const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { ORDER_COMPARISON_PROFILES_SQL } = require('../dist/services/analytics/OrderComparisonSql');
const {
  buildOrderComparisonProfile,
} = require('../dist/services/analytics/shared/orderComparisons');
const {
  WrappedAnalyticsQueryRepository,
} = require('../dist/services/analytics/WrappedAnalyticsQueryRepository');
const { WrappedAnalyticsService } = require('../dist/services/analytics/WrappedAnalyticsService');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;

test(
  'PostgreSQL comparison profiles match canonical domain policy, rank independent cohorts and honor the target snapshot',
  { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' },
  async () => {
    const schema = `order_comparisons_${randomUUID().replaceAll('-', '')}`;
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
    const users = new Map();
    try {
      await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
      const december = await decemberCanonicalOrders();
      async function insertUser(receipts, zone = 'America/Toronto') {
        const id = randomUUID();
        await pool.query("INSERT INTO users(id,email,password,timezone) VALUES($1,$2,'test',$3)", [
          id,
          `${id}@example.test`,
          zone,
        ]);
        const copy = structuredClone(receipts).map((r) => ({ ...r, id: randomUUID(), userId: id }));
        for (const r of copy)
          await pool.query(
            'INSERT INTO receipts(id,user_id,receipt_type,data_source,restaurant_name,amount_spent,items,order_date,delivery_time,currency_code,resolution) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11::jsonb)',
            [
              r.id,
              id,
              r.receiptType,
              r.dataSource,
              r.restaurantName,
              r.amountSpent,
              JSON.stringify(r.items),
              r.orderDate,
              r.deliveryTime,
              r.monetaryDetails?.currencyCode,
              JSON.stringify(r.resolution),
            ],
          );
        users.set(id, { receipts: copy, timezone: zone });
        return id;
      }
      const targetId = await insertUser(december);
      const base = december.find(
        (r) => r.resolution.orderOutcome.fulfillment === 'completed' && r.amountSpent > 0,
      );
      const paid = (amount, clock = '2023-12-10T17:00:00Z') => {
        const r = structuredClone(base);
        r.amountSpent = amount;
        r.orderDate = new Date(clock);
        Object.assign(r.resolution.orderOutcome, {
          netAmount: amount,
          originalCharge: amount,
          financialConfidence: 'confirmed',
          events: [],
        });
        return r;
      };
      // Enough synthetic peers to exercise real standings; no real account is queried by the test.
      for (let i = 0; i < 100; i++) await insertUser([paid(10), paid(10), paid(10)]);
      const cases = [
        [
          'date-only',
          (rs) =>
            rs.forEach((r) => {
              r.resolution.timestamp.precision = 'day';
            }),
        ],
        [
          'payment-time',
          (rs) =>
            rs.forEach((r) => {
              r.resolution.timestamp.role = 'receipt';
            }),
        ],
        [
          'unknown-cost',
          (rs) => {
            rs[0].resolution.orderOutcome.netAmount = null;
          },
        ],
        [
          'conflicted-cost',
          (rs) => {
            rs[0].resolution.orderOutcome.financialConfidence = 'conflicted';
          },
        ],
        [
          'legacy',
          (rs) => {
            delete rs[0].resolution.orderOutcome;
          },
        ],
        [
          'unknown-fulfillment',
          (rs) => {
            rs[0].resolution.orderOutcome.fulfillment = 'unknown';
          },
        ],
        [
          'unresolved-original',
          (rs) => {
            rs[0].dataSource = 'email';
            rs[0].resolution.reconciliation.status = 'unresolved';
          },
        ],
        [
          'unlinked-adjustment',
          (rs) => {
            rs[0].resolution.orderOutcome.kind = 'unlinked_adjustment';
          },
        ],
        [
          'disputed-export',
          (rs) => {
            rs[0].dataSource = 'csv';
            rs[0].resolution.reconciliation.status = 'unresolved';
            rs[0].resolution.reconciliation.reason = 'identity_conflict';
          },
        ],
        [
          'mixed-currency',
          (rs) => {
            rs[0].monetaryDetails.currencyCode = 'USD';
          },
        ],
        [
          'unknown-currency',
          (rs) =>
            rs.forEach((r) => {
              r.monetaryDetails.currencyCode = 'UNKNOWN';
            }),
        ],
        [
          'inferred-zero',
          (rs) => {
            Object.assign(rs[0].resolution.orderOutcome, {
              netAmount: 0,
              financialConfidence: 'inferred',
              refundStatus: 'probable_full',
              refundConfidence: 'inferred',
            });
          },
        ],
        [
          'positive-failed',
          (rs) => {
            Object.assign(rs[0].resolution.orderOutcome, {
              fulfillment: 'failed',
              financialConfidence: 'inferred',
            });
          },
        ],
        [
          'unfulfilled',
          (rs) => {
            rs[0].resolution.orderOutcome.fulfillment = 'unfulfilled';
          },
        ],
        [
          'travel',
          (rs) =>
            rs.forEach((r) => {
              r.resolution.timestamp.timezone = 'Asia/Tokyo';
            }),
        ],
        [
          'invalid-event-zone',
          (rs) =>
            rs.forEach((r) => {
              r.resolution.timestamp.timezone = 'not-a-timezone';
            }),
        ],
        [
          'missing-date',
          (rs) => {
            rs[0].orderDate = null;
          },
        ],
        [
          'DST',
          (rs) => {
            rs[0].orderDate = new Date('2023-11-05T05:30:00Z');
            rs[1].orderDate = new Date('2023-11-05T06:30:00Z');
          },
        ],
      ];
      for (const [, mutate] of cases) {
        const rs = [paid(10), paid(10), paid(10)];
        mutate(rs);
        await insertUser(rs);
      }
      const fractionalTargets = [];
      for (const [night, total] of [
        [1, 3],
        [2, 6],
        [5, 6],
        [10, 12],
      ]) {
        fractionalTargets.push(
          await insertUser(
            Array.from({ length: total }, (_, i) =>
              paid(10, i < night ? '2023-12-10T06:00:00Z' : '2023-12-10T17:00:00Z'),
            ),
          ),
        );
      }
      const rows = (await pool.query(ORDER_COMPARISON_PROFILES_SQL)).rows;
      assert.equal(rows.length, users.size);
      for (const row of rows) {
        const user = users.get(row.user_id);
        const actual = {
          currencyCode: row.currency_code,
          netSpend: row.net_spend === null ? null : Number(row.net_spend),
          pricedOrders: row.priced_orders,
          estimatedNetCost: row.estimated_net_cost,
          deliveries: row.deliveries,
          timedDeliveries: row.timed_deliveries,
          nightOwlShare: row.night_owl_share === null ? null : Number(row.night_owl_share),
        };
        assert.deepEqual(actual, buildOrderComparisonProfile(user.receipts, user.timezone));
      }
      const repository = new WrappedAnalyticsQueryRepository(pool);
      const target = buildOrderComparisonProfile(users.get(targetId).receipts, 'America/Toronto');
      const profileList = [...users.values()].map((u) =>
        buildOrderComparisonProfile(u.receipts, u.timezone),
      );
      const expectedRank = (key, eligible) => {
        const values = profileList.filter(eligible).map((p) => p[key]);
        return {
          lowerCount: values.filter((v) => v < target[key]).length,
          sampleSize: values.length,
        };
      };
      const expected = {
        policyVersion: 3,
        currencyCode: 'CAD',
        estimatedNetCost: true,
        totalSpent: expectedRank(
          'netSpend',
          (p) => p.currencyCode === 'CAD' && p.netSpend !== null && p.pricedOrders >= 3,
        ),
        orderCount: expectedRank('deliveries', (p) => p.deliveries !== null && p.deliveries >= 3),
        nightOwl: expectedRank(
          'nightOwlShare',
          (p) => p.nightOwlShare !== null && p.timedDeliveries >= 3,
        ),
      };
      assert.deepEqual(await repository.getPercentileRanks(targetId, 3, target), expected);
      for (const id of fractionalTargets) {
        const fractionalTarget = buildOrderComparisonProfile(
          users.get(id).receipts,
          'America/Toronto',
        );
        const values = profileList
          .filter((p) => p.nightOwlShare !== null && p.timedDeliveries >= 3)
          .map((p) => p.nightOwlShare);
        assert.deepEqual(
          (await repository.getPercentileRanks(id, 3, fractionalTarget)).nightOwl,
          {
            lowerCount: values.filter((v) => v < fractionalTarget.nightOwlShare).length,
            sampleSize: values.length,
          },
          `Equivalent fractions must tie: ${fractionalTarget.nightOwlShare}`,
        );
      }
      // Simulate an import after the Summary receipt read. The comparison must still describe that snapshot.
      await pool.query(
        "UPDATE receipts SET resolution=jsonb_set(resolution,'{orderOutcome,netAmount}','99999'::jsonb) WHERE user_id=$1",
        [targetId],
      );
      assert.deepEqual(await repository.getPercentileRanks(targetId, 3, target), expected);
      const wrapped = await new WrappedAnalyticsService(repository).calculateWrappedAnalytics(
        targetId,
        users.get(targetId),
      );
      assert.equal(wrapped.orderMetrics.currencies[0].netSpend, 157.02);
      assert.equal(wrapped.percentiles.policyVersion, 3);
      assert.equal(wrapped.percentiles.totalSpent.sampleSize, expected.totalSpent.sampleSize);
      assert.equal(wrapped.percentiles.nightOwl.sampleSize, expected.nightOwl.sampleSize);
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
