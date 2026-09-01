const test = require('node:test');
const assert = require('node:assert/strict');

const { requestContext } = require('../dist/middleware/requestContext');

const run = (supplied) => {
  const headers = {};
  let nextCalls = 0;
  const req = { get: () => supplied };
  const res = {
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  requestContext(req, res, () => {
    nextCalls += 1;
  });
  return { req, headers, nextCalls };
};

test('request context preserves a valid caller correlation ID and returns it', () => {
  const result = run('mobile.request-123');
  assert.equal(result.req.requestId, 'mobile.request-123');
  assert.equal(result.headers['X-Request-ID'], 'mobile.request-123');
  assert.equal(result.nextCalls, 1);
});

test('request context replaces malformed or oversized correlation IDs', () => {
  for (const supplied of ['contains spaces', 'x'.repeat(101), '']) {
    const result = run(supplied);
    assert.match(result.req.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(result.headers['X-Request-ID'], result.req.requestId);
    assert.equal(result.nextCalls, 1);
  }
});
