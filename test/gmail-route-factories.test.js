const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-thirty-two-characters';

const { createGmailPreferencesRouter } = require('../dist/routes/gmailPreferences');
const { createGmailTrackingRouter } = require('../dist/routes/gmailTracking');
const { createGmailImportRouter } = require('../dist/routes/gmailImport');
const {
  ManualTrackingCheckService,
} = require('../dist/services/import/ManualTrackingCheckService');

const passThrough = (_request, _response, next) => next();

const routeLayer = (router, path, method) =>
  router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);

const invoke = (router, path, method, request) =>
  new Promise((resolve, reject) => {
    const layer = routeLayer(router, path, method);
    assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const response = { json: (value) => resolve(value) };
    handler(request, response, reject);
  });

test('Gmail preference routes use token identity and validated provider input', async () => {
  const calls = [];
  const projection = { monitoring: {}, export: {} };
  const preferences = {
    get: async () => projection,
    setMonitoringConsent: async () => projection,
    setOngoingTrackingConsent: async () => projection,
    markExportRequested: async (...args) => {
      calls.push(args);
      return projection;
    },
    confirmExportReady: async () => projection,
    checkExportReady: async () => ({ detected: false, preferences: projection }),
  };
  const router = createGmailPreferencesRouter({ authenticate: passThrough, preferences });

  assert.equal(
    await invoke(router, '/preferences/export-requested', 'post', {
      user: { userId: 'token-user' },
      body: { provider: 'doordash' },
    }),
    projection,
  );
  assert.deepEqual(calls, [['token-user', 'doordash']]);

  await assert.rejects(
    invoke(router, '/preferences/export-requested', 'post', {
      user: { userId: 'token-user' },
      body: { provider: 'other' },
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('manual tracking operation returns one committed result projection or a stable conflict', async () => {
  const result = { success: true, newOrders: 1 };
  const preferences = { ongoingTracking: { effectiveState: 'active' } };
  const service = new ManualTrackingCheckService(
    { checkUser: async () => result },
    { get: async () => preferences },
  );
  assert.deepEqual(await service.execute('user-1'), { ...result, preferences });

  await assert.rejects(
    new ManualTrackingCheckService(
      { checkUser: async () => null },
      { get: async () => preferences },
    ).execute('user-1'),
    (error) => error.code === 'TRACKING_NOT_AVAILABLE',
  );
});

test('Gmail tracking and import routers delegate each endpoint to one capability', async () => {
  const tracking = createGmailTrackingRouter({
    authenticate: passThrough,
    validateScheduler: passThrough,
    manualCheck: { execute: async (userId) => ({ userId, success: true }) },
    scheduledTracking: { runEligibleBatch: async (limit) => ({ limit }) },
  });
  assert.deepEqual(
    await invoke(tracking, '/tracking/check', 'post', {
      user: { userId: 'user-1' },
      body: {},
    }),
    { userId: 'user-1', success: true },
  );
  assert.deepEqual(await invoke(tracking, '/tracking/run-batch', 'post', { body: { limit: 25 } }), {
    limit: 25,
  });
  await assert.rejects(
    invoke(tracking, '/tracking/run-batch', 'post', { body: { limit: '25' } }),
    (error) => error.code === 'VALIDATION_ERROR',
  );

  const timeouts = [];
  const imports = createGmailImportRouter({
    authenticate: passThrough,
    status: { getConnection: async () => ({ status: { connected: true } }) },
    historicalImport: {
      isInProgress: async () => true,
      execute: async () => ({
        success: true,
        totalEmailsFound: 1,
        totalReceiptsProcessed: 1,
        emailsExamined: 1,
        supportedReceiptsFound: 1,
        exportCoveredReceipts: 0,
        eligibleReceipts: 1,
        deduplicatedReceipts: 0,
        totalReceiptsImported: 1,
        newOrders: 1,
        updatedOrders: 0,
        unchangedOrders: 0,
        totalAmount: 12,
        errors: [],
      }),
    },
  });
  assert.deepEqual(await invoke(imports, '/import/status', 'get', { user: { userId: 'user-1' } }), {
    inProgress: true,
  });
  const importResult = await invoke(imports, '/import', 'post', {
    user: { userId: 'user-1' },
    setTimeout: (value) => timeouts.push(value),
  });
  assert.equal(importResult.totalReceiptsImported, 1);
  assert.deepEqual(timeouts, [600_000]);
});
