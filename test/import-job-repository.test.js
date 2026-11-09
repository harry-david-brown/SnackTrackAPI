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

for (const provider of ['uber_eats', 'doordash']) {
  test(`allows the first submitted ${provider} upload independently of other import activity`, async () => {
    let providerLimitSql = '';
    let providerLimitValues = [];
    const exportJob = {
      ...persistedJob,
      kind: 'export_file',
      status: 'awaiting_upload',
      phase: 'awaiting_upload',
      object_key: `exports/${provider}/history.zip`,
      original_filename: 'history.zip',
      content_type: 'application/zip',
      content_length: 1024,
      export_provider: provider,
    };
    const executor = { query: async (sql, values = []) => {
      if (sql.includes('SELECT COUNT(*) AS count')) return { rows: [{ count: '0' }], rowCount: 1 };
      if (sql.includes('WITH submitted AS')) {
        providerLimitSql = sql;
        providerLimitValues = values;
        return { rows: [{ submitted_daily: '0', retry_at: null }], rowCount: 1 };
      }
      if (sql.includes('SELECT import_generation')) return { rows: [{ import_generation: '1' }], rowCount: 1 };
      if (sql.includes('INSERT INTO import_jobs')) return { rows: [exportJob], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    } };

    const created = await new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) }).create({
      userId: persistedJob.user_id,
      kind: 'export_file',
      trigger: 'user',
      awaitingUpload: true,
      exportProvider: provider,
    });

    assert.equal(created.exportProvider, provider);
    assert.equal(providerLimitValues[1], provider);
    assert.match(providerLimitSql, /export_provider=\$2/);
    assert.match(providerLimitSql, /submitted_content_length IS NOT NULL/);
    assert.match(providerLimitSql, /status IN \('pending_dispatch','queued','running','retrying','succeeded'\)/);
    assert.doesNotMatch(providerLimitSql, /gmail_historical|manual_tracking/);
  });
}

test('returns a provider-specific retry contract after three submitted imports in one day', async () => {
  let inserted = false;
  const retryAt = '2026-09-10T14:30:00.000Z';
  const executor = { query: async sql => {
    if (sql.includes('SELECT COUNT(*) AS count')) return { rows: [{ count: '0' }], rowCount: 1 };
    if (sql.includes('WITH submitted AS')) return { rows: [{ submitted_daily: '3', retry_at: retryAt }], rowCount: 1 };
    if (sql.includes('INSERT INTO import_jobs')) inserted = true;
    return { rows: [], rowCount: 0 };
  } };

  await assert.rejects(
    new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) }).create({
      userId: persistedJob.user_id,
      kind: 'export_file',
      trigger: 'user',
      awaitingUpload: true,
      exportProvider: 'uber_eats',
    }),
    error => error.code === 'EXPORT_UPLOAD_RATE_LIMITED'
      && error.details.provider === 'uber_eats'
      && error.details.retryAt === retryAt
      && /Come back tomorrow/.test(error.publicMessage),
  );
  assert.equal(inserted, false);
});

test('retry persistence verifies the running-to-retrying transition', async () => {
  let retrySql = '';
  const executor = {
    query: async (sql) => {
      if (sql.includes("status='retrying'")) {
        retrySql = sql;
        return { rows: [{ ...persistedJob, status: 'retrying', phase: 'retrying', error_code: 'GMAIL_RATE_LIMITED' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async operation => operation(executor) });

  await repository.retry(persistedJob.id, 'GMAIL_RATE_LIMITED', 'Please try again later.');

  assert.match(retrySql, /status='retrying'/);
  assert.match(retrySql, /heartbeat_at=NULL/);
  assert.match(retrySql, /status='running'/);
});

test('retry persistence rejects a lost state transition', async () => {
  const executor = { query: async () => ({ rows: [], rowCount: 0 }) };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async operation => operation(executor) });

  await assert.rejects(
    repository.retry(persistedJob.id, 'GMAIL_RATE_LIMITED', 'Please try again later.'),
    (error) => error.code === 'IMPORT_RETRY_STATE_CONFLICT',
  );
});

test('retry history stores allowlisted diagnostics with the failed attempt', async () => {
  const calls = [];
  const executor = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("status='retrying'")) return { rows: [{ ...persistedJob, status: 'retrying', phase: 'retrying', attempts: 2, error_code: 'GMAIL_RATE_LIMITED' }], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  } };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async operation => operation(executor) });
  await repository.retry(persistedJob.id, 'GMAIL_RATE_LIMITED', 'Try later', { status: 403, quotaMetric: 'gmail.googleapis.com/total_query_cost' });
  const event = calls.find(call => call.sql.includes('INSERT INTO import_job_events'));
  assert.ok(event);
  assert.equal(event.values[1], 'attempt_failed_retrying');
  assert.deepEqual(JSON.parse(event.values[7]), { status: 403, quotaMetric: 'gmail.googleapis.com/total_query_cost' });
});

test('rejects an idempotency key reused for a different journey context', async () => {
  const executor = { query: async (sql) => sql.includes('idempotency_key') ? { rows: [persistedJob], rowCount: 1 } : { rows: [], rowCount: 0 } };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async (operation) => operation(executor) });
  await assert.rejects(
    repository.create({ userId: persistedJob.user_id, kind: 'gmail_historical', trigger: 'user', journeyContext: 'post_onboarding', idempotencyKey: 'same-key' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});


for (const context of ['onboarding', 'post_onboarding']) for (const kind of ['gmail_historical', 'outlook_historical']) for (const consent of ['not_offered', 'granted', 'declined', 'revoked']) {
  test(`${context} ${kind} preserves the ${consent} Settings choice`, async () => {
    let storedConsent = consent;
    const executor = { query: async sql => {
      if (sql.includes('SELECT import_generation')) return { rows: [{ import_generation: 1 }], rowCount: 1 };
      if (sql.includes('INSERT INTO import_jobs')) return { rows: [{ ...persistedJob, journey_context: context }], rowCount: 1 };
      if (sql.includes('UPDATE user_import_preferences')) {
        assert.match(sql, /ongoing_tracking_consent_state='not_offered'/);
        if (storedConsent === 'not_offered') storedConsent = 'granted';
      }
      return { rows: [], rowCount: 0 };
    }};
    const repository = new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) });
    await repository.create({ userId: persistedJob.user_id, kind, trigger: 'user', journeyContext: context, automaticUpdates: true });
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

// Model the transaction boundary so no preference or dispatch can outlive a failed acceptance.
for (const failAt of [null, 'consent', 'dispatch']) {
  test(`job and consent commit together; failure at ${failAt ?? 'none'}`, async () => {
    let committed = { jobs: 0, consent: 'not_offered', dispatches: 0 };
    const database = {
      query: async () => { throw new Error('Acceptance escaped its transaction'); },
      withTransaction: async action => {
        const draft = { ...committed };
        const result = await action({ query: async sql => {
          if (sql.includes('SELECT import_generation')) return { rows: [{ import_generation: 1 }], rowCount: 1 };
          if (sql.includes('INSERT INTO import_jobs')) {
            draft.jobs++;
            return { rows: [{ ...persistedJob, journey_context: 'post_onboarding' }], rowCount: 1 };
          }
          if (sql.includes('UPDATE user_import_preferences')) {
            if (failAt === 'consent') throw new Error('Consent save failed');
            draft.consent = 'granted';
          }
          if (sql.includes('INSERT INTO import_job_outbox')) {
            if (failAt === 'dispatch') throw new Error('Dispatch save failed');
            draft.dispatches++;
          }
          return { rows: [], rowCount: 0 };
        } });
        committed = draft;
        return result;
      },
    };
    const acceptance = new ImportJobRepository(database).create({ userId: persistedJob.user_id, kind: 'outlook_historical', trigger: 'user', journeyContext: 'post_onboarding', automaticUpdates: true });
    if (failAt) {
      await assert.rejects(acceptance);
      assert.deepEqual(committed, { jobs: 0, consent: 'not_offered', dispatches: 0 });
    } else {
      await acceptance;
      assert.deepEqual(committed, { jobs: 1, consent: 'granted', dispatches: 1 });
    }
  });
}
test('idempotent retry returns the accepted job without changing a later opt-out', async () => {
  let writes = 0;
  const executor = { query: async sql => {
    if (/UPDATE|INSERT/.test(sql)) writes++;
    return sql.includes('idempotency_key') ? { rows: [{ ...persistedJob, journey_context: 'post_onboarding' }], rowCount: 1 } : { rows: [], rowCount: 0 };
  } };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) });
  const result = await repository.create({ userId: persistedJob.user_id, kind: 'gmail_historical', trigger: 'user', journeyContext: 'post_onboarding', automaticUpdates: true, idempotencyKey: 'accepted-earlier' });
  assert.equal(result.id, persistedJob.id);
  assert.equal(writes, 0);
});

test('ready transition and notification outbox share one transaction and stale cycles stay silent', async () => {
  for (const transitioned of [true, false]) {
    const statements = [];
    let insideTransaction = false;
    const readyRow = { ...persistedJob, kind: 'export_ready_check', trigger_type: 'scheduler',
      status: 'running', export_provider: 'doordash', checkpoint: { requestId: '98bb78e4-3b64-4daa-b1c4-d0bb8df09128' } };
    const query = async (sql, params) => {
      statements.push({ sql, params, insideTransaction });
      if (sql.includes("SET status='file_ready'")) return { rows: transitioned ? [{ request_id: readyRow.checkpoint.requestId }] : [], rowCount: transitioned ? 1 : 0 };
      if (sql.includes('UPDATE import_jobs j SET status=$2')) return { rows: [{ ...readyRow, status: 'succeeded', result: JSON.parse(params[3]) }], rowCount: 1 };
      if (sql.startsWith('SELECT ')) return { rows: [readyRow], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    };
    const repository = new ImportJobRepository({ query, withTransaction: async action => {
      insideTransaction = true;
      try { return await action({ query }); } finally { insideTransaction = false; }
    } });
    const job = await repository.findById(readyRow.id);
    await repository.succeed(job, { exportReadyDetected: true });
    const transition = statements.find(entry => entry.sql.includes("SET status='file_ready'"));
    assert.equal(transition.insideTransaction, true);
    assert.match(transition.sql, /p.request_id=\$3::uuid/);
    assert.match(transition.sql, /u.import_generation=\$4/);
    assert.match(transition.sql, /p.alert_consent='granted'/);
    const notification = statements.find(entry => entry.sql.includes('INSERT INTO import_job_outbox'));
    assert.equal(Boolean(notification), transitioned);
    if (notification) assert.equal(notification.insideTransaction, true);
    const finished = statements.find(entry => entry.sql.includes('UPDATE import_jobs j SET status=$2'));
    assert.equal(JSON.parse(finished.params[3]).exportReadyDetected, transitioned);
  }
});

test('claim and stale recovery retain atomic source-state and generation guards', async () => {
  const statements = [];
  const executor = { query: async sql => { statements.push(sql); return { rows: [], rowCount: 0 }; } };
  const repository = new ImportJobRepository({ ...executor, withTransaction: async action => action(executor) });
  await repository.claimForRun(persistedJob.id);
  const claim = statements.find(sql => sql.includes("SET status='running'"));
  assert.match(claim, /j.import_generation=u.import_generation/);
  assert.match(claim, /j.status IN \('pending_dispatch','queued','running','retrying'\)/);
  statements.length = 0;
  await repository.recoverStaleJobs();
  assert.match(statements[0], /status IN \('queued','running','retrying'\)/);
  assert.match(statements[0], /COALESCE\(heartbeat_at,queued_at,updated_at\) </);
});
