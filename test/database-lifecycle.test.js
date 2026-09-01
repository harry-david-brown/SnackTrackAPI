const test = require('node:test');
const assert = require('node:assert/strict');

const { MigrationRunner, migrationChecksum } = require('../dist/services/data/MigrationRunner');
const { DatabaseHealthService } = require('../dist/services/data/DatabaseHealthService');
const { PostgresService } = require('../dist/services/data/PostgresService');
const { ShutdownCoordinator, ShutdownError } = require('../dist/services/core/ShutdownCoordinator');

const migrationOne = {
  version: 1,
  name: 'create_example',
  statements: ['CREATE TABLE example (id INTEGER PRIMARY KEY)'],
};
const migrationTwo = {
  version: 2,
  name: 'add_example_name',
  statements: ['ALTER TABLE example ADD COLUMN name TEXT'],
};

const migrationClient = ({ history = [], failStatement } = {}) => {
  const calls = [];
  let released = false;
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql === 'SELECT version, name, checksum FROM schema_migrations ORDER BY version') {
        return { rows: history, rowCount: history.length };
      }
      if (sql === failStatement) throw new Error('migration statement failed');
      return { rows: [], rowCount: 0 };
    },
    release: () => {
      released = true;
    },
  };
  return { client, calls, wasReleased: () => released };
};

test('migration runner serializes startup, applies versions in order, and records checksums', async () => {
  const fake = migrationClient();
  const runner = new MigrationRunner({ getClient: async () => fake.client }, [
    migrationOne,
    migrationTwo,
  ]);

  const result = await runner.run();

  assert.deepEqual(result, { applied: [1, 2], alreadyApplied: [] });
  assert.equal(fake.calls[0].sql, 'SELECT pg_advisory_lock($1)');
  assert.equal(fake.calls.filter(({ sql }) => sql === 'BEGIN').length, 2);
  assert.equal(fake.calls.filter(({ sql }) => sql === 'COMMIT').length, 2);
  const records = fake.calls.filter(({ sql }) => sql.includes('INSERT INTO schema_migrations'));
  assert.deepEqual(
    records.map(({ params }) => params.slice(0, 2)),
    [
      [1, 'create_example'],
      [2, 'add_example_name'],
    ],
  );
  assert.equal(records[0].params[2], migrationChecksum(migrationOne));
  assert.equal(fake.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1)');
  assert.equal(fake.wasReleased(), true);
});

test('migration runner skips immutable applied versions and rejects checksum drift', async () => {
  const applied = {
    version: 1,
    name: migrationOne.name,
    checksum: migrationChecksum(migrationOne),
  };
  const matching = migrationClient({ history: [applied] });
  const matchingResult = await new MigrationRunner({ getClient: async () => matching.client }, [
    migrationOne,
  ]).run();
  assert.deepEqual(matchingResult, { applied: [], alreadyApplied: [1] });
  assert.equal(
    matching.calls.some(({ sql }) => sql === migrationOne.statements[0]),
    false,
  );

  const drifted = migrationClient({ history: [{ ...applied, checksum: '0'.repeat(64) }] });
  await assert.rejects(
    new MigrationRunner({ getClient: async () => drifted.client }, [migrationOne]).run(),
    (error) =>
      error.code === 'DATABASE_ERROR' && /immutable migration registry/.test(error.message),
  );
  assert.equal(
    drifted.calls.some(({ sql }) => sql === 'BEGIN'),
    false,
  );
  assert.equal(drifted.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1)');
});

test('failed migrations roll back, remain unrecorded, and release the advisory lock', async () => {
  const fake = migrationClient({ failStatement: migrationOne.statements[0] });
  const runner = new MigrationRunner({ getClient: async () => fake.client }, [migrationOne]);

  await assert.rejects(
    runner.run(),
    (error) => error.code === 'DATABASE_ERROR' && /Migration 1/.test(error.message),
  );
  assert.equal(
    fake.calls.some(({ sql }) => sql === 'ROLLBACK'),
    true,
  );
  assert.equal(
    fake.calls.some(({ sql }) => sql.includes('INSERT INTO schema_migrations')),
    false,
  );
  assert.equal(fake.calls.at(-1).sql, 'SELECT pg_advisory_unlock($1)');
  assert.equal(fake.wasReleased(), true);
});

test('database health adapter owns connected, slow, and unavailable readiness policy', async () => {
  const pool = { totalCount: 2, idleCount: 1, waitingCount: 0 };
  let time = 100;
  const connected = new DatabaseHealthService(
    {
      query: async () => ({ rows: [], rowCount: 0 }),
      getPoolStats: () => pool,
    },
    1000,
    () => (time += 10),
  );
  assert.deepEqual(await connected.check(), {
    status: 'connected',
    healthy: true,
    latencyMs: 10,
    pool,
  });

  time = 0;
  const slow = new DatabaseHealthService(
    {
      query: async () => {
        time = 1500;
        return { rows: [], rowCount: 0 };
      },
      getPoolStats: () => pool,
    },
    1000,
    () => time,
  );
  assert.equal((await slow.check()).status, 'slow');

  const down = new DatabaseHealthService({
    query: async () => {
      throw new Error('connection refused');
    },
    getPoolStats: () => pool,
  });
  assert.deepEqual(await down.check(), {
    status: 'down',
    healthy: false,
    latencyMs: null,
    pool,
    errorCode: 'DATABASE_UNAVAILABLE',
  });
});

test('PostgreSQL adapter scopes commit, rollback, release, and close exactly once', async () => {
  const calls = [];
  let ends = 0;
  const client = {
    query: async (sql) => {
      calls.push(sql);
      return { rows: [], rowCount: 0 };
    },
    release: () => calls.push('RELEASE'),
  };
  const pool = {
    on: () => {},
    connect: async () => client,
    end: async () => {
      ends += 1;
    },
    totalCount: 1,
    idleCount: 1,
    waitingCount: 0,
  };
  const postgres = new PostgresService(
    {
      connectionString: 'postgres://test',
      useSsl: false,
      maxConnections: 1,
    },
    () => pool,
  );

  await postgres.withTransaction(async (transaction) => {
    await transaction.query('SELECT success');
  });
  await assert.rejects(
    postgres.withTransaction(async (transaction) => {
      await transaction.query('SELECT failure');
      throw new Error('operation failed');
    }),
    /operation failed/,
  );
  await Promise.all([postgres.close(), postgres.close()]);

  assert.deepEqual(calls, [
    'BEGIN',
    'SELECT success',
    'COMMIT',
    'RELEASE',
    'BEGIN',
    'SELECT failure',
    'ROLLBACK',
    'RELEASE',
  ]);
  assert.equal(ends, 1);
});

test('shutdown coordinator closes every resource in order and only once', async () => {
  const closes = [];
  const coordinator = new ShutdownCoordinator([
    { name: 'timer', close: () => closes.push('timer') },
    { name: 'http', close: async () => closes.push('http') },
    { name: 'redis', close: async () => closes.push('redis') },
    { name: 'postgres', close: async () => closes.push('postgres') },
  ]);

  await Promise.all([coordinator.close(), coordinator.close(), coordinator.close()]);

  assert.deepEqual(closes, ['timer', 'http', 'redis', 'postgres']);
});

test('shutdown coordinator attempts later resources after one close fails', async () => {
  const closes = [];
  const coordinator = new ShutdownCoordinator([
    {
      name: 'http',
      close: () => {
        closes.push('http');
        throw new Error('close failed');
      },
    },
    { name: 'database', close: () => closes.push('database') },
  ]);

  await assert.rejects(coordinator.close(), ShutdownError);
  assert.deepEqual(closes, ['http', 'database']);
});
