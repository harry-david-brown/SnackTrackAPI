const test = require('node:test');
const assert = require('node:assert/strict');

const { ImportJobRepository } = require('../dist/services/data/ImportJobRepository');

const persistedJob = {
  id: '67bce5bc-436e-4c4f-9c0f-93880b5ced9a',
  user_id: '57d0a1df-93ca-4ec3-a47c-6d9700340e18',
  kind: 'gmail_historical',
  trigger_type: 'user',
  journey_context: 'legacy',
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
  assert.match(insertSql, /\$5::VARCHAR\(24\)/);
  assert.match(insertSql, /CASE WHEN \$5::VARCHAR\(24\)='awaiting_upload'/);
});

test('rejects an idempotency key reused for a different journey context', async () => {
  const executor = { query: async (sql) => sql.includes('idempotency_key') ? { rows: [persistedJob], rowCount: 1 } : { rows: [], rowCount: 0 } };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async (operation) => operation(executor) });
  await assert.rejects(
    repository.create({ userId: persistedJob.user_id, kind: 'gmail_historical', trigger: 'user', journeyContext: 'post_onboarding', idempotencyKey: 'same-key' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});


for (const consent of ['not_offered', 'granted', 'declined', 'revoked']) {
  test(`onboarding auto imports preserve the ${consent} Settings choice`, async () => {
    let storedConsent = consent;
    const executor = { query: async sql => {
      if (sql.includes('SELECT import_generation')) return { rows: [{ import_generation: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO import_jobs')) return { rows: [{ ...persistedJob, journey_context: 'onboarding' }], rowCount: 1 };
      if (sql.includes('UPDATE user_import_preferences')) {
        assert.match(sql, /ongoing_tracking_consent_state='not_offered'/);
        if (storedConsent === 'not_offered') storedConsent = 'granted';
      }
      return { rows: [], rowCount: 0 };
    }};
    const repository = new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) });
    await repository.create({ userId: persistedJob.user_id, kind: 'gmail_historical', trigger: 'user', journeyContext: 'onboarding', automaticUpdates: true });
    assert.equal(storedConsent, consent === 'not_offered' ? 'granted' : consent);
  });
}

test('legacy onboarding imports do not grant automatic updates without the new disclosed choice', async () => {
  const executor = { query: async sql => {
    assert.equal(sql.includes('UPDATE user_import_preferences'), false);
    if (sql.includes('SELECT import_generation')) return { rows: [{ import_generation: 1 }], rowCount: 1 };
    if (sql.includes('INSERT INTO import_jobs')) return { rows: [{ ...persistedJob, journey_context: 'onboarding' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }};
  await new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) }).create({ userId: persistedJob.user_id, kind: 'gmail_historical', trigger: 'user', journeyContext: 'onboarding' });
});
