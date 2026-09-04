const test = require('node:test');
const assert = require('node:assert/strict');

const { AnalyticsEventService } = require('../dist/services/analytics/AdminAnalyticsService');
const { AdminAnalyticsQueryService } = require('../dist/services/analytics/AdminAnalyticsService');
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

test('ad analytics accepts only bounded privacy-safe properties', async () => {
  const service = new AnalyticsEventService({ query: async () => ({ rows: [], rowCount: 1 }) }, () => now);
  const base = event({ eventName: 'ad_impression', properties: {
    placement: 'dashboard_after_insights', source: 'admob', configurationVersion: 1,
  } });
  assert.deepEqual(await service.ingest(userId, [base]), { accepted: 1, duplicates: 0, rejected: 0 });
  assert.deepEqual(await service.ingest(userId, [{ ...base, eventId: '52f287d3-3a99-4a46-81fe-08f1ac0d7549', properties: { ...base.properties, restaurant: 'Private' } }]), { accepted: 0, duplicates: 0, rejected: 1 });
  assert.deepEqual(await service.ingest(userId, [{ ...base, eventId: '0a1c2f84-9bca-4c20-87ac-d01697929eb2', eventName: 'ad_revenue_paid', properties: { ...base.properties, currency: 'CAD', valueMicros: -1, precision: 'precise' } }]), { accepted: 0, duplicates: 0, rejected: 1 });
});

test('ad metric query handles zero denominators and keeps currencies separate', async () => {
  const database = { query: async sql => {
    if (sql.includes('AS exposed_users')) return { rows: [{ requests: 0, loads: 0, impressions: 0, exposed_users: 0, clicks: 0, failures: 0 }], rowCount: 1 };
    if (sql.includes("GROUP BY currency ORDER BY currency")) return { rows: [
      { currency: 'CAD', value_micros: '1250000', paid_events: 2 },
      { currency: 'USD', value_micros: '500000', paid_events: 1 },
    ], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  } };
  const result = await new AdminAnalyticsQueryService(database).ads(
    new Date('2026-09-01T00:00:00.000Z'), new Date('2026-09-02T00:00:00.000Z'),
  );
  assert.equal(result.summary.fillRate, null);
  assert.equal(result.summary.clickThroughRate, null);
  assert.deepEqual(result.revenue.map(row => row.currency), ['CAD', 'USD']);
  assert.ok(result.revenue.every(row => row.effectiveCpmMicros === null));
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
