const test = require('node:test');
const assert = require('node:assert/strict');

const {
  AdministratorQueryRepository,
} = require('../dist/services/admin/AdministratorQueryRepository');
const { AdministratorService } = require('../dist/services/admin/AdministratorService');
const {
  MonitoringQueryRepository,
} = require('../dist/services/monitoring/MonitoringQueryRepository');
const { MonitoringService } = require('../dist/services/monitoring/MonitoringService');
const {
  optionalQueryString,
  parseQueryInteger,
  requireUuid,
} = require('../dist/http/validation/requestValues');

const queryResult = (rows) => ({ rows, rowCount: rows.length });

const explainRow = ({
  nodeType = 'Index Scan',
  indexName = 'idx_receipts_user_id',
  executionTime = 2,
  planningTime = 1,
  rows = 3,
} = {}) => ({
  'QUERY PLAN': [
    {
      Plan: {
        'Node Type': nodeType,
        'Index Name': indexName,
        'Actual Rows': rows,
      },
      'Execution Time': executionTime,
      'Planning Time': planningTime,
    },
  ],
});

test('shared request-value boundary rejects ambiguous query values and malformed identifiers', () => {
  assert.equal(optionalQueryString('  info  ', 'level'), 'info');
  assert.equal(parseQueryInteger(undefined, 'limit', { defaultValue: 50 }), 50);
  assert.equal(parseQueryInteger('1000', 'limit', { minimum: 1, maximum: 1000 }), 1000);
  assert.equal(
    requireUuid('11111111-1111-7111-8111-111111111111', 'userId'),
    '11111111-1111-7111-8111-111111111111',
  );
  assert.throws(
    () => optionalQueryString(['info', 'debug'], 'level'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => parseQueryInteger('2x', 'limit', { minimum: 1 }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.throws(
    () => requireUuid('not-a-uuid', 'userId'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('administrator user listing uses one paginated aggregate query instead of per-user receipt reads', async () => {
  const calls = [];
  const repository = new AdministratorQueryRepository({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return queryResult([
        {
          id: '11111111-1111-4111-8111-111111111111',
          email: 'account@example.com',
          email_verified: true,
          timezone: 'America/Toronto',
          created_at: new Date('2026-08-01T00:00:00.000Z'),
          receipt_count: '4',
          total_spent: '42.75',
          last_receipt_date: '2026-08-20T12:00:00.000Z',
          total_users: '7',
        },
      ]);
    },
  });
  const service = new AdministratorService(repository);

  const result = await service.listUsers(25, 0);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /LEFT JOIN receipts/);
  assert.match(calls[0].sql, /COUNT\(r\.id\)/);
  assert.deepEqual(calls[0].params, [25, 0]);
  assert.equal(result.users[0].receiptCount, 4);
  assert.equal(result.users[0].totalSpent, 42.75);
  assert.deepEqual(result.pagination, {
    total: 7,
    limit: 25,
    offset: 0,
    hasMore: true,
  });
});

test('administrator user listing still reports total count for an empty page', async () => {
  let call = 0;
  const repository = new AdministratorQueryRepository({
    query: async () => {
      call += 1;
      return call === 1 ? queryResult([]) : queryResult([{ count: '3' }]);
    },
  });

  const result = await repository.listUsers(25, 100);

  assert.equal(call, 2);
  assert.equal(result.total, 3);
  assert.deepEqual(result.users, []);
});

test('administrator statistics adapter validates and maps aggregate database rows', async () => {
  const responses = [
    queryResult([
      {
        total_users: '5',
        total_receipts: '12',
        users_with_receipts: '4',
        total_amount: '155.50',
        average_amount: '12.9583',
      },
    ]),
    queryResult([{ tablename: 'receipts', size: '128 kB' }]),
    queryResult([
      { table_name: 'users', recent_count: '2' },
      { table_name: 'receipts', recent_count: 6 },
    ]),
  ];
  let call = 0;
  const repository = new AdministratorQueryRepository({
    query: async () => responses[call++],
  });
  const service = new AdministratorService(repository, () => new Date('2026-08-31T12:00:00.000Z'));

  const result = await service.getDatabaseStatistics();

  assert.equal(result.database.totalUsers, 5);
  assert.equal(result.database.totalAmountAllUsers, 155.5);
  assert.deepEqual(result.tableSizes, [{ table: 'receipts', size: '128 kB' }]);
  assert.equal(result.recentActivity[1].recentCount, 6);
  assert.deepEqual(result.health, {
    status: 'HEALTHY',
    timestamp: '2026-08-31T12:00:00.000Z',
  });
});

test('administrator adapter rejects malformed database enum-like fields', async () => {
  const responses = [
    queryResult([
      {
        total_users: 1,
        total_receipts: 0,
        users_with_receipts: 0,
        total_amount: 0,
        average_amount: 0,
      },
    ]),
    queryResult([]),
    queryResult([{ table_name: 'secrets', recent_count: 1 }]),
  ];
  let call = 0;
  const repository = new AdministratorQueryRepository({
    query: async () => responses[call++],
  });

  await assert.rejects(
    repository.getDatabaseStatistics(),
    (error) => error.code === 'DATABASE_ERROR' && /table_name/.test(error.message),
  );
});

test('monitoring optimization adapter validates catalog rows and derives applied status', async () => {
  const responses = [
    queryResult([
      {
        tablename: 'receipts',
        total_size: '192 kB',
        table_size: '128 kB',
        indexes_size: '64 kB',
        row_count: '20',
      },
    ]),
    queryResult([
      {
        indexname: 'idx_receipts_items_gin',
        indexdef: 'CREATE INDEX ...',
        index_scans: '4',
        tuples_read: '8',
        tuples_fetched: '7',
      },
    ]),
    queryResult([
      {
        indexname: 'idx_receipts_items_gin',
        optimization_type: 'GIN index on JSONB items',
      },
    ]),
    queryResult([{ column_name: 'year', data_type: 'integer' }]),
    queryResult([
      {
        indexname: 'idx_receipts_items_gin',
        index_scans: '4',
        tuples_read: '8',
        index_size: '64 kB',
      },
    ]),
  ];
  let call = 0;
  const repository = new MonitoringQueryRepository({
    query: async () => responses[call++],
  });

  const result = await repository.getDatabaseOptimizationStatus();

  assert.equal(result.tables[0].rowCount, 20);
  assert.equal(result.optimizations.status.ginIndex, true);
  assert.equal(result.optimizations.status.yearColumn, true);
  assert.equal(result.receiptsIndexes[0].tuplesFetched, 7);
});

test('monitoring query-performance operation resolves a user and summarizes typed plans', async () => {
  const calls = [];
  const postgres = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT DISTINCT user_id/.test(sql)) {
        return queryResult([{ user_id: '11111111-1111-4111-8111-111111111111' }]);
      }
      if (/SELECT id FROM users/.test(sql)) {
        return queryResult([{ id: '11111111-1111-4111-8111-111111111111' }]);
      }
      if (/items @>/.test(sql)) {
        return queryResult([explainRow({ indexName: 'idx_receipts_items_gin' })]);
      }
      return queryResult([explainRow()]);
    },
  };
  let time = Date.parse('2026-08-31T12:00:00.000Z');
  const repository = new MonitoringQueryRepository(postgres, () => time++);
  const service = new MonitoringService(repository);

  const result = await service.getQueryPerformance();

  assert.equal(calls.length, 6);
  assert.equal(result.tests.length, 4);
  assert.equal(result.summary.totalTests, 4);
  assert.equal(result.summary.testsWithIndexes, 4);
  assert.equal(result.summary.averageExecutionTime, 1);
  assert.equal(result.tests[3].ginIndexUsed, true);
  assert.equal(result.userId, '11111111-1111-4111-8111-111111111111');
});

test('monitoring operation preserves not-found semantics before running diagnostics', async () => {
  const repository = new MonitoringQueryRepository({
    query: async () => queryResult([]),
  });
  const service = new MonitoringService(repository);

  await assert.rejects(service.getQueryPerformance(), (error) => error.code === 'NOT_FOUND');
});
