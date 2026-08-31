const test = require('node:test');
const assert = require('node:assert/strict');

const { errorHandler, ValidationError } = require('../dist/middleware/errorHandler');

test('central error mapper emits the versioned coded envelope', () => {
  let status;
  let body;
  const req = {
    method: 'GET',
    originalUrl: '/receipts',
    get: () => undefined,
    connection: {},
  };
  const res = {
    status(value) { status = value; return this; },
    json(value) { body = value; return this; },
  };

  errorHandler(new ValidationError('Bad filter', 'limit'), req, res, () => {});

  assert.equal(status, 400);
  assert.equal(body.error.version, '1');
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details.field, 'limit');
});
