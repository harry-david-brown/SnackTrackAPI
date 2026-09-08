const test = require('node:test');
const assert = require('node:assert/strict');
const { createImportsRouter } = require('../dist/routes/imports');

const passThrough = (_request, _response, next) => next();
const routeLayer = (router, path) => router.stack.find(layer => layer.route?.path === path && layer.route.methods.get);
const invoke = (router, path, request) => new Promise((resolve, reject) => {
  const layer = routeLayer(router, path);
  assert.ok(layer, `GET ${path} should be registered`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const response = {
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    json(body) { resolve({ body, headers: this.headers }); },
  };
  handler(request, response, reject);
});

test('live import status endpoints cannot return stale or 304 responses', async () => {
  const operation = { id: 'job-1' };
  const router = createImportsRouter({
    authenticate: passThrough,
    rateLimit: passThrough,
    operations: {
      findActive: async () => operation,
      listRecent: async () => [operation],
      findForUser: async () => operation,
    },
    jobs: {},
    presentation: { operation: async value => value },
  });
  for (const [path, request] of [
    ['/active', { user: { userId: 'user-1' } }],
    ['/recent', { user: { userId: 'user-1' } }],
    ['/:id', { user: { userId: 'user-1' }, params: { id: 'job-1' } }],
  ]) {
    const result = await invoke(router, path, request);
    assert.equal(result.headers['Cache-Control'], 'private, no-cache, no-store, must-revalidate');
    assert.equal(result.headers.Pragma, 'no-cache');
    assert.equal(result.headers.Expires, '0');
  }
});
