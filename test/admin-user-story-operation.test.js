const test = require('node:test');
const assert = require('node:assert/strict');

const { AuthenticationActivityService } = require('../dist/services/auth/AuthenticationActivityService');
const { AdminManagementService } = require('../dist/services/admin/AdminManagementService');

test('successful authentication activity records only bounded method metadata', async () => {
  const calls = [];
  const service = new AuthenticationActivityService({ recordServerEvent: async input => calls.push(input) }, { debug() {}, info() {}, warn() {}, error() {} });
  await service.recordSuccess('user-1', 'google', 'signed_in');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].eventName, 'account_authenticated');
  assert.equal(calls[0].provider, 'google');
  assert.deepEqual(calls[0].properties, { method: 'google', action: 'signed_in' });
  assert.equal(JSON.stringify(calls[0]).includes('token'), false);
});

test('analytics failure never prevents a successful authentication', async () => {
  const warnings = [];
  const service = new AuthenticationActivityService({ recordServerEvent: async () => { throw new Error('offline'); } }, { debug() {}, info() {}, warn(message, context) { warnings.push({ message, context }); }, error() {} });
  await assert.doesNotReject(service.recordSuccess('user-1', 'password', 'signed_in'));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].context.provider, 'password');
});

test('operational attention maps actionable people counts to drill-down filters', async () => {
  const database = { query: async () => ({ rows: [{ stuck_imports: 2, recent_import_failures: 4, reconnect_required: 3, tracking_errors: 1 }] }) };
  const service = new AdminManagementService(database, {}, {});
  const result = await service.operationalAttention(new Date('2026-08-01'), new Date('2026-09-01'));
  assert.deepEqual(result.items.map(item => [item.issue, item.peopleCount]), [
    ['stuck_import', 2], ['recent_import_failure', 4], ['reconnect_required', 3], ['tracking_error', 1],
  ]);
});

test('user timeline rejects malformed cursors before querying data', async () => {
  let queried = false;
  const database = { query: async () => { queried = true; return { rows: [] }; } };
  const service = new AdminManagementService(database, {}, {});
  await assert.rejects(service.userTimeline('user-1', { cursor: 'not-a-cursor', limit: 30 }), error => error.code === 'VALIDATION_ERROR');
  assert.equal(queried, false);
});

test('owner Gmail expiry uses the reconnect transition and records an audit reason', async () => {
  const queries = [];
  const database = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return queries.length === 1 ? { rows: [{ gmail_connected: true }] } : { rows: [] };
    },
  };
  const expired = [];
  const service = new AdminManagementService(
    database,
    {},
    {},
    {},
    { expireForTesting: async id => expired.push(id) },
  );

  const result = await service.expireGmailConnection({
    userId: 'user-1',
    actorAdminId: 'admin-1',
    reason: 'Testing the reconnect experience',
    requestId: 'request-1',
  });

  assert.deepEqual(result, { gmailStatus: 'reconnect_required' });
  assert.deepEqual(expired, ['user-1']);
  assert.match(queries[1].sql, /gmail_connection\.expired_for_testing/);
  assert.deepEqual(queries[1].params.slice(0, 4), [
    'admin-1', 'user-1', 'Testing the reconnect experience', 'request-1',
  ]);
});
