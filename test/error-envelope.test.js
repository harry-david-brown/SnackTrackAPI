const test = require('node:test');
const assert = require('node:assert/strict');

const { errorHandler, ValidationError } = require('../dist/middleware/errorHandler');
const {
  AppError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
} = require('../dist/core/errors');
const { statusForError } = require('../dist/middleware/errorHandler');

test('stable failures cover authorization, missing resources, busy conflicts, and providers', () => {
  const cases = [
    [new AppError({ code: 'ACCOUNT_DELETION_PENDING', message: 'Deletion pending' }), 401, 'ACCOUNT_DELETION_PENDING'],
    [new AuthorizationError(), 403, 'AUTHORIZATION_DENIED'],
    [new NotFoundError('User'), 404, 'NOT_FOUND'],
    [new ConflictError('IMPORT_IN_PROGRESS', 'Busy'), 409, 'IMPORT_IN_PROGRESS'],
    [
      new AppError({ code: 'GMAIL_IMPORT_FAILED', message: 'Provider import failed' }),
      502,
      'GMAIL_IMPORT_FAILED',
    ],
  ];
  for (const [error, expectedStatus, expectedCode] of cases) {
    assert.equal(statusForError(error), expectedStatus);
    assert.equal(error.code, expectedCode);
  }
});

test('central error mapper emits the versioned coded envelope', () => {
  let status;
  let body;
  const req = {
    method: 'GET',
    originalUrl: '/receipts',
    requestId: '11111111-1111-4111-8111-111111111111',
    get: () => undefined,
    connection: {},
  };
  const res = {
    status(value) {
      status = value;
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  errorHandler(new ValidationError('Bad filter', 'limit'), req, res, () => {});

  assert.equal(status, 400);
  assert.equal(body.error.version, '1');
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details.field, 'limit');
});

test('central error mapper preserves Gmail recovery codes and selects their HTTP status', () => {
  const mapped = [];
  const req = {
    method: 'POST',
    originalUrl: '/gmail/import',
    requestId: '22222222-2222-4222-8222-222222222222',
    get: () => undefined,
    connection: {},
  };
  const res = {
    status(value) {
      mapped.push({ status: value });
      return this;
    },
    json(value) {
      mapped[mapped.length - 1].body = value;
      return this;
    },
  };

  errorHandler(
    new ConflictError('GMAIL_RECONNECT_REQUIRED', 'Reconnect Gmail to continue.'),
    req,
    res,
    () => {},
  );
  errorHandler(
    new AppError({
      code: 'GMAIL_VALIDATION_UNAVAILABLE',
      message: 'Gmail could not be reached.',
    }),
    req,
    res,
    () => {},
  );

  assert.equal(mapped[0].status, 409);
  assert.equal(mapped[0].body.error.code, 'GMAIL_RECONNECT_REQUIRED');
  assert.equal(mapped[1].status, 503);
  assert.equal(mapped[1].body.error.code, 'GMAIL_VALIDATION_UNAVAILABLE');
});

test('central error mapper classifies database availability by driver code, not message text', () => {
  const mapped = [];
  const req = {
    method: 'GET',
    originalUrl: '/users/id/summary',
    requestId: '33333333-3333-4333-8333-333333333333',
    get: () => undefined,
    connection: {},
  };
  const res = {
    status(value) {
      mapped.push({ status: value });
      return this;
    },
    json(value) {
      mapped[mapped.length - 1].body = value;
      return this;
    },
  };

  errorHandler(
    new DatabaseError(
      'Summary query failed',
      Object.assign(new Error('socket closed'), { code: '08006' }),
    ),
    req,
    res,
    () => {},
  );
  errorHandler(new Error('A connection label appeared in an unrelated error'), req, res, () => {});

  assert.equal(mapped[0].status, 503);
  assert.equal(mapped[0].body.error.code, 'DATABASE_UNAVAILABLE');
  assert.equal(mapped[1].status, 500);
  assert.equal(mapped[1].body.error.code, 'INTERNAL_ERROR');
});

test('central error mapper safely normalizes non-Error thrown values', () => {
  let body;
  const req = {
    method: 'GET',
    originalUrl: '/health',
    requestId: '44444444-4444-4444-8444-444444444444',
    get: () => undefined,
    connection: {},
  };
  const res = {
    status() {
      return this;
    },
    json(value) {
      body = value;
      return this;
    },
  };

  errorHandler('unexpected rejection', req, res, () => {});

  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.version, '1');
});
