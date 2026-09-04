const test = require('node:test');
const assert = require('node:assert/strict');

const { AdConfigurationService } = require('../dist/services/ads/AdConfigurationService');
const { AdConfigurationRepository } = require('../dist/services/data/AdConfigurationRepository');
const { launchAdsMigration } = require('../dist/services/data/migrations/017_launch_ads');
const { createAdsRouter } = require('../dist/routes/ads');

const invokeRoute = (router, path, method, request) => new Promise((resolve, reject) => {
  const layer = router.stack.find((candidate) => candidate.route?.path === path && candidate.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
  const handlers = layer.route.stack.map(({ handle }) => handle);
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { resolve({ body, headers: this.headers }); },
  };
  let index = 0;
  const next = (error) => error ? reject(error) : handlers[index++]?.(request, response, next);
  next();
});

const configuration = (overrides = {}) => ({
  enabled: true,
  iosRolloutPercent: 100,
  androidRolloutPercent: 0,
  placement: 'dashboard_after_insights',
  maxImpressionsPerSession: 1,
  minimumReceiptCount: 3,
  version: 1,
  updatedAt: '2026-09-03T00:00:00.000Z',
  updatedBy: null,
  ...overrides,
});

test('runtime configuration applies platform rollout deterministically', async () => {
  const store = { get: async () => configuration() };
  const service = new AdConfigurationService(store);
  assert.equal((await service.runtime('5f586923-18d5-4bc8-b5eb-ea52ae35284c', 'ios')).enabled, true);
  assert.equal((await service.runtime('5f586923-18d5-4bc8-b5eb-ea52ae35284c', 'android')).enabled, false);
  assert.deepEqual(
    await service.runtime('5f586923-18d5-4bc8-b5eb-ea52ae35284c', 'ios'),
    await service.runtime('5f586923-18d5-4bc8-b5eb-ea52ae35284c', 'ios'),
  );
});

test('runtime route requires authentication identity, validates platform, and disables caching', async () => {
  let authenticationCalls = 0;
  const calls = [];
  const router = createAdsRouter({
    authenticate: (request, _response, next) => {
      authenticationCalls += 1;
      request.user = { userId: 'user-17' };
      next();
    },
    configuration: {
      runtime: async (...args) => {
        calls.push(args);
        return { enabled: false, configurationVersion: 1 };
      },
    },
  });
  const result = await invokeRoute(router, '/runtime', 'get', { query: { platform: 'ios' } });
  assert.equal(authenticationCalls, 1);
  assert.deepEqual(calls, [['user-17', 'ios']]);
  assert.equal(result.headers['Cache-Control'], 'private, no-store');

  await assert.rejects(
    invokeRoute(router, '/runtime', 'get', { query: { platform: 'web' } }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('configuration updates validate every bounded field and reason', async () => {
  const calls = [];
  const store = {
    get: async () => configuration(),
    update: async input => { calls.push(input); return configuration({ version: 2 }); },
  };
  const service = new AdConfigurationService(store);
  const input = {
    ...configuration(), expectedVersion: 1, actorAdminId: 'admin', reason: 'Launch at five percent',
  };
  await service.update(input);
  assert.equal(calls.length, 1);
  assert.throws(() => service.update({ ...input, iosRolloutPercent: 101 }), error => error.code === 'VALIDATION_ERROR');
  assert.throws(() => service.update({ ...input, placement: 'wrapped' }), error => error.code === 'VALIDATION_ERROR');
  assert.throws(() => service.update({ ...input, reason: 'short' }), error => error.code === 'VALIDATION_ERROR');
});

test('launch migration is disabled by default and constrains every operator control', () => {
  const sql = launchAdsMigration.statements.join('\n');
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(sql, /ios_rollout_percent BETWEEN 0 AND 100/);
  assert.match(sql, /android_rollout_percent BETWEEN 0 AND 100/);
  assert.match(sql, /max_impressions_per_session BETWEEN 1 AND 3/);
  assert.match(sql, /minimum_receipt_count BETWEEN 1 AND 100/);
  assert.match(sql, /ON CONFLICT \(config_key\) DO NOTHING/);
});

test('repository updates configuration and audit atomically', async () => {
  const calls = [];
  const row = {
    enabled: true, ios_rollout_percent: 5, android_rollout_percent: 5,
    placement: 'dashboard_after_insights', max_impressions_per_session: 1,
    minimum_receipt_count: 3, version: 2, updated_at: '2026-09-03T00:00:00.000Z',
    updated_by: 'admin', updated_by_email: 'owner@example.com',
  };
  const database = {
    query: async () => ({ rows: [row], rowCount: 1 }),
    withTransaction: async operation => operation({
      query: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.includes('SELECT config.enabled')) return { rows: [row], rowCount: 1 };
        return { rows: sql.includes('RETURNING version') ? [{ version: 2 }] : [], rowCount: 1 };
      },
    }),
  };
  const repository = new AdConfigurationRepository(database);
  const result = await repository.update({
    enabled: true, iosRolloutPercent: 5, androidRolloutPercent: 5,
    placement: 'dashboard_after_insights', maxImpressionsPerSession: 1,
    minimumReceiptCount: 3, expectedVersion: 1, actorAdminId: 'admin',
    reason: 'Launch at five percent', requestId: 'request',
  });
  assert.equal(result.version, 2);
  assert.equal(result.updatedBy.email, 'owner@example.com');
  assert.ok(calls.some(call => call.sql.includes('AND version = $11')));
  assert.ok(calls.some(call => call.sql.includes("'ad_configuration'")));
});

test('emergency kill does not depend on an expected version and is audited', async () => {
  const calls = [];
  const row = {
    enabled: false, ios_rollout_percent: 100, android_rollout_percent: 100,
    placement: 'dashboard_after_insights', max_impressions_per_session: 1,
    minimum_receipt_count: 3, version: 9, updated_at: '2026-09-03T00:00:00.000Z',
    updated_by: 'admin', updated_by_email: 'owner@example.com',
  };
  const database = {
    query: async () => ({ rows: [row], rowCount: 1 }),
    withTransaction: async operation => operation({ query: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('SELECT config.enabled')) return { rows: [row], rowCount: 1 };
      return { rows: sql.includes('RETURNING version') ? [{ version: 9 }] : [], rowCount: 1 };
    } }),
  };
  const repository = new AdConfigurationRepository(database);
  assert.equal((await repository.kill({ actorAdminId: 'admin', reason: 'Emergency shutdown' })).enabled, false);
  assert.ok(calls.some(call => call.sql.includes('SET enabled = FALSE') && !call.sql.includes('expectedVersion')));
  assert.ok(calls.some(call => call.values?.includes('ads.killed')));
});
