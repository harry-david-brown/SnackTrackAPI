const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ImportPreferencesQueryRepository,
} = require('../dist/services/data/ImportPreferencesQueryRepository');

const userId = '00000000-0000-4000-8000-000000000001';

const validPreferenceRow = (overrides = {}) => ({
  user_id: userId,
  monitoring_consent_state: 'not_offered',
  monitoring_consent_version: null,
  monitoring_consented_at: null,
  monitoring_revoked_at: null,
  gmail_import_status: 'never_started',
  gmail_import_updated_at: null,
  gmail_imported_count: 0,
  gmail_import_error_code: null,
  gmail_baseline_completed_at: null,
  ongoing_tracking_consent_state: 'not_offered',
  ongoing_tracking_consent_version: null,
  ongoing_tracking_consented_at: null,
  ongoing_tracking_revoked_at: null,
  tracking_status: 'inactive',
  last_check_attempt_at: null,
  last_successful_check_at: null,
  last_stats_updated_at: null,
  last_new_order_at: null,
  last_tracking_error_at: null,
  last_tracking_error_code: null,
  initial_setup_deferred_until: null,
  ...overrides,
});

test('import preference reads are projections without hidden writes', async () => {
  const statements = [];
  const database = {
    query: async (sql, params) => {
      statements.push({ sql, params });
      return { rows: [validPreferenceRow()] };
    },
  };

  const preferences = await new ImportPreferencesQueryRepository(database).get(userId);

  assert.equal(preferences.userId, userId);
  assert.equal(preferences.gmailImportedCount, 0);
  assert.equal(statements.length, 1);
  assert.doesNotMatch(statements[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.deepEqual(statements[0].params, [userId]);
});

test('provider export reads return both default projections without inserting rows', async () => {
  let statement;
  const database = {
    query: async (sql, params) => {
      statement = { sql, params };
      return {
        rows: [
          {
            provider: 'uber_eats',
            status: 'completed',
            requested_at: null,
            updated_at: new Date('2026-08-01T10:00:00.000Z'),
            error_code: null,
            ready_source: null,
            relevance: 'unknown',
          },
          {
            provider: 'doordash',
            status: 'not_started',
            requested_at: null,
            updated_at: null,
            error_code: null,
            ready_source: null,
            relevance: 'unknown',
          },
        ],
      };
    },
  };

  const providers = await new ImportPreferencesQueryRepository(database).getProviderExports(userId);

  assert.equal(providers.uber_eats.status, 'completed');
  assert.equal(providers.uber_eats.updatedAt, '2026-08-01T10:00:00.000Z');
  assert.equal(providers.doordash.status, 'not_started');
  assert.doesNotMatch(statement.sql, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.deepEqual(statement.params, [userId]);
});

for (const [label, override, pattern] of [
  ['enum', { tracking_status: 'surprise' }, /tracking_status/],
  ['timestamp', { last_check_attempt_at: 'not-a-date' }, /last_check_attempt_at/],
  ['count', { gmail_imported_count: -1 }, /gmail_imported_count/],
  ['UUID', { user_id: 'not-a-uuid' }, /user_id/],
]) {
  test(`import preference adapter rejects malformed database ${label} values`, async () => {
    const database = { query: async () => ({ rows: [validPreferenceRow(override)] }) };
    await assert.rejects(new ImportPreferencesQueryRepository(database).get(userId), pattern);
  });
}

test('eligible tracking users reject malformed database identities', async () => {
  const database = { query: async () => ({ rows: [{ user_id: 'not-a-uuid' }] }) };
  await assert.rejects(
    new ImportPreferencesQueryRepository(database).getEligibleTrackingUserIds(),
    /user_id/,
  );
});
