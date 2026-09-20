const test = require('node:test');
const assert = require('node:assert/strict');
const { ImportTestScenarioRepository } = require('../dist/services/data/ImportTestScenarioRepository');

test('enables the per-user Gmail delay and records an administrator audit', async () => {
  const calls = [];
  const executor = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM users')) return { rows: [{ id: params[0] }], rowCount: 1 };
      if (sql.includes('SELECT enabled,reason,updated_at')) return { rows: [{ enabled: true, reason: 'Exercise background navigation', updated_at: new Date(1_000) }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const repository = new ImportTestScenarioRepository({ ...executor, withTransaction: async action => action(executor) });
  const result = await repository.setGmailLongRunning({
    userId: '00000000-0000-4000-8000-000000000001', enabled: true,
    reason: 'Exercise background navigation', actorAdminId: '00000000-0000-4000-8000-000000000002',
  });
  assert.equal(result.gmailLongRunning, true);
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO user_import_test_scenarios')));
  assert.ok(calls.some(call => call.sql.includes('INSERT INTO admin_audit_events') && call.params.includes('import_test.gmail_long_running_enabled')));
});

test('moves an enabled Gmail import into one durable six-minute delay', async () => {
  const resumeAt = new Date(Date.now() + 360_000);
  const calls = [];
  const executor = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM import_test_scenario_runs')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM user_import_test_scenarios')) return { rows: [{ enabled: true }], rowCount: 1 };
      if (sql.includes('INSERT INTO import_test_scenario_runs')) return { rows: [{ resume_at: resumeAt }], rowCount: 1 };
      if (sql.includes("UPDATE import_jobs SET status='retrying'")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
  const repository = new ImportTestScenarioRepository({ ...executor, withTransaction: async action => action(executor) });
  assert.equal((await repository.delayGmailImportIfEnabled('job-id', 'user-id')).toISOString(), resumeAt.toISOString());
  assert.ok(calls.some(sql => sql.includes("phase='simulated_long_running'")));
});

test('resumes a previously delayed Gmail import only once', async () => {
  const calls = [];
  const executor = {
    query: async (sql) => {
      calls.push(sql);
      if (sql.includes('FROM import_test_scenario_runs')) return { rows: [{ resume_at: new Date(1_000), resumed_at: null, pending: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  };
  const repository = new ImportTestScenarioRepository({ ...executor, withTransaction: async action => action(executor) });
  assert.equal(await repository.delayGmailImportIfEnabled('job-id', 'user-id'), null);
  assert.ok(calls.some(sql => sql.includes('SET resumed_at=NOW()')));
  assert.ok(!calls.some(sql => sql.includes("UPDATE import_jobs SET status='retrying'")));
});
