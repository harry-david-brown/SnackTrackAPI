const test = require('node:test');
const assert = require('node:assert/strict');

const { AnalyticsEventService } = require('../dist/services/analytics/AdminAnalyticsService');
const {
  createRequireAdminRole,
  createRequireAdminCsrf,
  requireAdminOrigin,
} = require('../dist/middleware/adminAuth');

const userId = '5f586923-18d5-4bc8-b5eb-ea52ae35284c';
const now = Date.parse('2026-09-01T12:00:00.000Z');
const event = (overrides = {}) => ({
  eventId: 'd38b42b3-69c2-4c49-9ded-98797f12a67a',
  eventName: 'dashboard_viewed',
  schemaVersion: 1,
  occurredAt: new Date(now).toISOString(),
  platform: 'ios',
  environment: 'production',
  properties: {},
  ...overrides,
});

test('analytics ingestion validates privacy, deduplicates IDs, and assigns the authenticated user', async () => {
  const calls = [];
  const database = {
    query: async (sql, values) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: calls.length === 2 ? 0 : 1 };
    },
  };
  const service = new AnalyticsEventService(database, () => now);
  const result = await service.ingest(userId, [
    event(),
    event(),
    event({ eventId: '05da98c6-87c2-48cc-9686-3d3373a37d59', properties: { email: 'forbidden@example.com' } }),
  ]);

  assert.deepEqual(result, { accepted: 1, duplicates: 1, rejected: 1 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].values[4], userId);
  assert.equal(calls[0].values[8], 'production');
});

test('analytics ingestion rejects unbounded batches and expired events', async () => {
  const service = new AnalyticsEventService({ query: async () => ({ rows: [], rowCount: 1 }) }, () => now);
  await assert.rejects(service.ingest(userId, Array.from({ length: 51 }, () => event())), (error) => error.code === 'VALIDATION_ERROR');
  assert.deepEqual(await service.ingest(userId, [event({ occurredAt: '2026-08-01T00:00:00.000Z' })]), {
    accepted: 0, duplicates: 0, rejected: 1,
  });
});

const runMiddleware = (middleware, request) => new Promise((resolve) =>
  middleware(request, {}, (error) => resolve(error)),
);

test('admin middleware enforces the role matrix, exact origin, and double-submit CSRF', async () => {
  const identity = { id: 'admin', email: 'owner@example.com', status: 'active' };
  assert.equal(await runMiddleware(createRequireAdminRole('operator'), { admin: { ...identity, role: 'owner' } }), undefined);
  assert.equal((await runMiddleware(createRequireAdminRole('operator'), { admin: { ...identity, role: 'analyst' } })).code, 'AUTHORIZATION_DENIED');

  const origin = requireAdminOrigin('https://admin.getsnacktrack.com');
  assert.equal(await runMiddleware(origin, { get: (name) => name === 'origin' ? 'https://admin.getsnacktrack.com' : undefined }), undefined);
  assert.equal((await runMiddleware(origin, { get: () => undefined })).code, 'AUTHORIZATION_DENIED');

  const csrf = createRequireAdminCsrf({ verifyCsrf: (expected, supplied) => {
    assert.equal(expected, 'stored-hash');
    assert.equal(supplied, 'proof');
  } });
  const request = {
    admin: { ...identity, role: 'owner', csrfHash: 'stored-hash' },
    get: (name) => name === 'X-CSRF-Token' ? 'proof' : name === 'cookie' ? 'snacktrack_admin_csrf=proof' : undefined,
  };
  assert.equal(await runMiddleware(csrf, request), undefined);
});
