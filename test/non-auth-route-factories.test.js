const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createReceiptsRouter } = require('../dist/routes/receipts');
const { createUsersRouter } = require('../dist/routes/users');
const { createDatabaseRouter } = require('../dist/routes/database');
const { createCsvRouter } = require('../dist/routes/csv');
const { createMonitoringRouter } = require('../dist/routes/monitoring');
const { createRequestLogger } = require('../dist/middleware/requestLogger');

const passThrough = (_request, _response, next) => next();

const routeLayer = (router, path, method) =>
  router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);

const invoke = (router, path, method, request) =>
  new Promise((resolve, reject) => {
    const layer = routeLayer(router, path, method);
    assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const response = {
      statusCode: 200,
      headers: {},
      status(value) {
        this.statusCode = value;
        return this;
      },
      set(name, value) {
        this.headers[name] = value;
        return this;
      },
      json(value) {
        resolve({ body: value, statusCode: this.statusCode, headers: this.headers });
      },
    };
    handler(request, response, reject);
  });

const unusedUsersDependencies = () => ({
  authenticate: passThrough,
  authorizeOwnership: passThrough,
  validateUserId: passThrough,
  production: false,
  accountReset: { resetForOnboarding: async () => ({ deletedReceipts: 0 }) },
  dashboardInsights: { execute: async () => ({}), getInsightOrders: async () => ({ receipts: [], total: 0, timezone: 'UTC' }) },
  summaries: { execute: async () => ({}) },
});

test('non-auth resource routers delegate through the injected capabilities', async () => {
  const receiptCalls = [];
  const receipts = createReceiptsRouter({
    authenticate: passThrough,
    paginate: passThrough,
    listReceipts: { execute: async () => ({ receipts: [], total: 0 }) },
    clearReceipts: {
      clearReceipts: async (userId) => {
        receiptCalls.push(userId);
        return { deletedReceipts: 2 };
      },
    },
  });
  assert.deepEqual(await invoke(receipts, '/', 'delete', { user: { userId: 'token-user' } }), {
    body: { success: true, message: 'Deleted 2 receipts', deletedCount: 2 },
    statusCode: 200,
    headers: {},
  });
  assert.deepEqual(receiptCalls, ['token-user']);

  const usersDependencies = unusedUsersDependencies();
  const summaryCalls = [];
  usersDependencies.summaries.execute = async (input) => {
    summaryCalls.push(input);
    return { statistics: { totalSpent: 42.5 } };
  };
  const users = createUsersRouter(usersDependencies);
  assert.deepEqual(
    await invoke(users, '/:id/summary', 'get', {
      params: { id: 'route-user' },
      query: { includeWrapped: 'true' },
      headers: {},
    }),
    {
      body: { statistics: { totalSpent: 42.5 } },
      statusCode: 200,
      headers: {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
      },
    },
  );
  assert.deepEqual(summaryCalls, [
    { userId: 'route-user', includeWrapped: true, requestTimezone: undefined, displayCurrency: undefined, spendCurrency: undefined },
  ]);
  await invoke(users, '/:id/summary', 'get', {
    params: { id: 'route-user' }, query: { spendCurrency: 'JPY' }, headers: {},
  });
  assert.equal(summaryCalls.at(-1).spendCurrency, 'JPY');
  await assert.rejects(invoke(users, '/:id/summary', 'get', {
    params: { id: 'route-user' }, query: { spendCurrency: 'INVALID' }, headers: {},
  }), error => error.code === 'VALIDATION_ERROR');
  await assert.rejects(
    invoke(users, '/:id/summary', 'get', {
      params: { id: 'route-user' },
      query: { includeWrapped: 'yes' },
      headers: {},
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  await assert.rejects(
    invoke(users, '/:id/dashboard-insights', 'get', {
      params: { id: 'route-user' },
      query: { devDayOffset: '-1' },
      headers: {},
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  );

  const listCalls = [];
  const database = createDatabaseRouter({
    authorizeAdministrator: passThrough,
    administrator: {
      listUsers: async (...args) => {
        listCalls.push(args);
        return { users: [], pagination: { total: 0, limit: args[0], offset: args[1] } };
      },
      getDatabaseStatistics: async () => ({}),
    },
    accountDeletion: { deleteAccount: async () => undefined },
  });
  const listed = await invoke(database, '/users', 'get', {
    query: { limit: '17', offset: '4' },
  });
  assert.equal(listed.body.pagination.limit, 17);
  assert.equal(listed.body.pagination.offset, 4);
  assert.deepEqual(listCalls, [[17, 4]]);
});

test('CSV and monitoring factories register isolated routes without resolving global services', () => {
  const csv = createCsvRouter({
    authenticate: passThrough,
    rateLimit: passThrough,
    limitConcurrency: passThrough,
    authorizeOwnership: passThrough,
    zip: { isZipFile: async () => false, extractCSV: async () => ({ content: Buffer.alloc(0) }) },
    importCsv: { execute: async () => ({}) },
    logger: { warn: () => undefined },
  });
  assert.ok(routeLayer(csv, '/import', 'post'));

  const monitoring = createMonitoringRouter({
    authorizeSensitive: passThrough,
    alerting: { getHealthStatus: () => ({ metrics: {}, thresholds: {} }) },
    cache: { getStats: async () => ({ enabled: false, stats: {} }) },
    monitoring: {
      getDatabaseOptimizationStatus: async () => ({}),
      getQueryPerformance: async () => ({}),
    },
    logs: {
      getLevel: () => 'info',
      setLevel: () => undefined,
      getRecent: () => [],
    },
  });
  assert.ok(routeLayer(monitoring, '/health', 'get'));
  assert.ok(routeLayer(monitoring, '/database-optimizations', 'get'));
});

test('request logger uses injected telemetry, clock, and alerting capabilities', () => {
  const response = new EventEmitter();
  response.statusCode = 503;
  const events = [];
  const ticks = [100, 1_250];
  const middleware = createRequestLogger({
    now: () => ticks.shift(),
    alerting: {
      recordRequest: (duration) => events.push(['request', duration]),
      recordError: (error, context) => events.push(['error', error.message, context.statusCode]),
    },
    observability: {
      isSentryEnabled: () => true,
      addBreadcrumb: (...args) => events.push(['breadcrumb', ...args.slice(0, 2)]),
      logRequest: (_request, _response, duration) => events.push(['log', duration]),
      debug: (...args) => events.push(['debug', ...args]),
      warn: (_message, metadata) => events.push(['slow', metadata.durationMs]),
    },
  });
  const request = {
    method: 'GET',
    originalUrl: '/health',
    url: '/health',
    ip: '127.0.0.1',
    requestId: 'request-1',
  };
  let nextCalls = 0;
  middleware(request, response, () => {
    nextCalls += 1;
  });
  response.emit('finish');

  assert.equal(nextCalls, 1);
  assert.deepEqual(events, [
    ['breadcrumb', 'HTTP Request', 'http'],
    ['log', 1_150],
    ['request', 1_150],
    ['error', 'HTTP 503: GET /health', 503],
    ['slow', 1_150],
  ]);
});
