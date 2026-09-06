const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-thirty-two-characters';

const { ImportJobService } = require('../dist/services/import/ImportJobService');

const job = (overrides = {}) => ({
  id: '67bce5bc-436e-4c4f-9c0f-93880b5ced9a', userId: 'user-1', kind: 'export_file', trigger: 'user',
  journeyContext: 'post_onboarding',
  status: 'awaiting_upload', phase: 'awaiting_upload', progress: 0, result: null, errorCode: null,
  errorMessage: null, attempts: 0, heartbeatAt: null, objectKey: 'imports/user-1/persisted/export.zip',
  originalFilename: 'export.zip', contentType: 'application/zip', contentLength: 1024,
  exportProvider: 'uber_eats', objectEtag: null, submittedContentType: null, submittedContentLength: null,
  importGeneration: 1, checkpoint: {}, createdAt: '2026-09-02T12:00:00.000Z', queuedAt: null, startedAt: null,
  completedAt: null, expiresAt: '2099-09-02T13:00:00.000Z', updatedAt: '2026-09-02T12:00:00.000Z',
  ...overrides,
});

test('upload intent signs persisted metadata and preserves idempotency and journey context', async () => {
  const signed = [];
  const created = [];
  const service = new ImportJobService(
    { create: async (input) => { created.push(input); return job(); } },
    {
      createUploadUrl: async (...args) => { signed.push(args); return 'http://storage.test/upload'; },
      uploadUrlExpiresAt: () => '2026-09-02T12:15:00.000Z',
    },
  );
  const result = await service.createUberEatsUploadIntent({
    userId: 'user-1', filename: 'export.zip', contentType: 'application/zip', contentLength: 1024,
    idempotencyKey: 'same-request', journeyContext: 'post_onboarding',
  });
  assert.deepEqual(signed, [['imports/user-1/persisted/export.zip', 'application/zip', 1024]]);
  assert.equal(result.operation.id, job().id);
  assert.equal(result.expiresAt, '2026-09-02T12:15:00.000Z');
  assert.equal(created[0].journeyContext, 'post_onboarding');
});

test('upload intent rejects files above the type-specific limit before creating a job', async () => {
  let created = false;
  const service = new ImportJobService(
    { create: async () => { created = true; return job(); } },
    { createUploadUrl: async () => '', uploadUrlExpiresAt: () => '' },
  );
  await assert.rejects(
    service.createUberEatsUploadIntent({ userId: 'user-1', filename: 'export.csv', contentType: 'text/csv', contentLength: 10 * 1024 * 1024 + 1 }),
    (error) => error.code === 'PAYLOAD_TOO_LARGE',
  );
  assert.equal(created, false);
});

test('upload submission verifies object size before dispatch', async () => {
  let submitted = false;
  const service = new ImportJobService(
    {
      findForUser: async () => job(),
      submitUpload: async () => { submitted = true; return job({ status: 'pending_dispatch' }); },
    },
    { head: async () => ({ contentLength: 2048, contentType: 'application/zip', etag: 'etag-1' }) },
  );
  await assert.rejects(service.submitUpload('user-1', job().id), (error) => error.code === 'VALIDATION_ERROR');
  assert.equal(submitted, false);
});


test('onboarding email import carries the disclosed automatic update choice', async () => {
  const inputs = [];
  const service = new ImportJobService({ create: async input => { inputs.push(input); return job(); } }, {});
  await service.start('user-1', 'gmail_historical', 'user', undefined, 'onboarding', true);
  assert.equal(inputs[0].automaticUpdates, true);
  await service.start('user-1', 'gmail_historical', 'user', undefined, 'legacy');
  assert.equal(inputs[1].automaticUpdates, false);
  assert.throws(() => service.start('user-1', 'gmail_historical', 'user', undefined, 'post_onboarding', true), error => error.code === 'VALIDATION_ERROR');
  assert.throws(() => service.start('user-1', 'scheduled_tracking', 'scheduler', undefined, 'onboarding', true), error => error.code === 'VALIDATION_ERROR');
});
