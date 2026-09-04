const test = require('node:test');
const assert = require('node:assert/strict');

const { ImportJobRepository } = require('../dist/services/data/ImportJobRepository');

const persistedJob = {
  id: '67bce5bc-436e-4c4f-9c0f-93880b5ced9a',
  user_id: '57d0a1df-93ca-4ec3-a47c-6d9700340e18',
  kind: 'gmail_historical',
  trigger_type: 'user',
  status: 'pending_dispatch',
  phase: 'waiting_for_queue',
  progress: 0,
  result: null,
  error_code: null,
  error_message: null,
  attempts: 0,
  heartbeat_at: null,
  object_key: null,
  original_filename: null,
  content_type: null,
  content_length: null,
  export_provider: null,
  object_etag: null,
  submitted_content_type: null,
  submitted_content_length: null,
  import_generation: 1,
  checkpoint: {},
  created_at: '2026-09-03T12:00:00.000Z',
  queued_at: null,
  started_at: null,
  completed_at: null,
  expires_at: null,
  updated_at: '2026-09-03T12:00:00.000Z',
};

test('job creation casts a reused status parameter consistently for PostgreSQL', async () => {
  let insertSql = '';
  const executor = {
    query: async (sql) => {
      if (sql.includes('SELECT COUNT(*) AS count')) {
        return { rows: [{ count: '0' }], rowCount: 1 };
      }
      if (sql.includes("COUNT(*) FILTER")) {
        return { rows: [{ recent: '0', daily: '0', uploads: '0' }], rowCount: 1 };
      }
      if (sql.includes('SELECT import_generation')) {
        return { rows: [{ import_generation: '1' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO import_jobs')) {
        insertSql = sql;
        return { rows: [persistedJob], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  const database = {
    ...executor,
    withTransaction: async (operation) => operation(executor),
  };

  const repository = new ImportJobRepository(database);
  const created = await repository.create({
    userId: persistedJob.user_id,
    kind: 'gmail_historical',
    trigger: 'user',
  });

  assert.equal(created.status, 'pending_dispatch');
  assert.match(insertSql, /\$4::VARCHAR\(24\)/);
  assert.match(insertSql, /CASE WHEN \$4::VARCHAR\(24\)='awaiting_upload'/);
});
