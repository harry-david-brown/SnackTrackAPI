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
const importJob = (id, userId, kind) => ({
  id, userId, kind, trigger: 'user', status: 'pending_dispatch', phase: 'waiting', progress: 0,
  result: null, errorCode: null, errorMessage: null, attempts: 0, heartbeatAt: null,
  objectKey: null, originalFilename: null, contentType: null, contentLength: null,
  exportProvider: null, objectEtag: null, submittedContentType: null, submittedContentLength: null,
  importGeneration: 0, createdAt: '2026-09-02T12:00:00.000Z', queuedAt: null,
  startedAt: null, completedAt: null, expiresAt: null, updatedAt: '2026-09-02T12:00:00.000Z',
});
const publicOperation = (id, kind) => ({
  id, kind, trigger: 'user', status: 'pending_dispatch', phase: 'waiting', progress: 0,
  result: null, errorCode: null, errorMessage: null, attempts: 0, provider: null,
  journeyContext: undefined, presentation: kind === 'gmail_historical' ? { discoveredOrderCount: null, expectedDurationBand: 'unknown', mode: 'foreground', reason: 'normal', stage: 'waiting', timeEstimate: null } : null,
  createdAt: '2026-09-02T12:00:00.000Z', queuedAt: null, startedAt: null,
  completedAt: null, updatedAt: '2026-09-02T12:00:00.000Z',
});

const routeLayer = (router, path, method) =>
  router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);

const invoke = (router, path, method, request) =>
  new Promise((resolve, reject) => {
    const layer = routeLayer(router, path, method);
    assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const response = {
      statusCode: 200,
      status(value) { this.statusCode = value; return this; },
      json: (value) => resolve(value),
    };
    handler({ get: () => undefined, ...request }, response, reject);
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
    getSetupGuidance: async () => ({ initialSetupDeferredUntil: null }),
    setInitialSetupDeferral: async (...args) => {
      calls.push(args);
      return { initialSetupDeferredUntil: '2026-09-08T12:00:00.000Z' };
    },
    setProviderRelevance: async (...args) => {
      calls.push(args);
      return projection;
    },
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

  assert.deepEqual(
    await invoke(router, '/preferences/setup-deferral', 'put', {
      user: { userId: 'token-user' },
      body: { decision: 'defer' },
    }),
    { initialSetupDeferredUntil: '2026-09-08T12:00:00.000Z' },
  );
  assert.equal(
    await invoke(router, '/preferences/provider-relevance', 'put', {
      user: { userId: 'token-user' },
      body: { provider: 'uber_eats', relevance: 'not_used' },
    }),
    projection,
  );
  assert.deepEqual(calls.slice(1), [
    ['token-user', 'defer'],
    ['token-user', 'uber_eats', 'not_used'],
  ]);
  await assert.rejects(
    invoke(router, '/preferences/provider-relevance', 'put', {
      user: { userId: 'token-user' },
      body: { provider: 'uber_eats', relevance: 'irrelevant' },
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
    importJobs: { start: async (userId, kind) => importJob('job-1', userId, kind) },
    pushMaintenance: { run: async (limit) => ({ limit }) },
  });
  assert.deepEqual(
    await invoke(tracking, '/tracking/check', 'post', {
      user: { userId: 'user-1' },
      body: {},
    }),
    { operation: publicOperation('job-1', 'manual_tracking') },
  );
  assert.deepEqual(await invoke(tracking, '/tracking/run-batch', 'post', { body: { limit: 25 } }), {
    limit: 25,
  });
  await assert.rejects(
    invoke(tracking, '/tracking/run-batch', 'post', { body: { limit: '25' } }),
    (error) => error.code === 'VALIDATION_ERROR',
  );

  const imports = createGmailImportRouter({
    authenticate: passThrough,
    status: { getConnection: async () => ({ status: { connected: true } }) },
    historicalImport: {
      isInProgress: async () => true,
    },
    importJobs: { start: async (userId, kind) => importJob('job-2', userId, kind) },
  });
  assert.deepEqual(await invoke(imports, '/import/status', 'get', { user: { userId: 'user-1' } }), {
    inProgress: true,
  });
  const importResult = await invoke(imports, '/import', 'post', {
    user: { userId: 'user-1' },
  });
  assert.deepEqual(importResult, { operation: publicOperation('job-2', 'gmail_historical') });
});


test('Gmail import validates and forwards the onboarding automatic updates choice', async () => {
  const calls = [];
  const router = createGmailImportRouter({ authenticate: passThrough, status: {}, historicalImport: {}, importJobs: {
    start: async (...args) => { calls.push(args); return importJob('job-automatic', args[0], args[1]); },
  }});
  await invoke(router, '/import', 'post', { user: { userId: 'user-automatic' }, body: { journeyContext: 'onboarding', automaticUpdates: true } });
  assert.equal(calls[0][4], 'onboarding');
  assert.equal(calls[0][5], true);
  await assert.rejects(invoke(router, '/import', 'post', { user: { userId: 'user-automatic' }, body: { journeyContext: 'onboarding', automaticUpdates: 'yes' } }), error => error.code === 'VALIDATION_ERROR');
  assert.equal(calls.length, 1);
});
