const test = require('node:test');
const assert = require('node:assert/strict');
const { ImportOperationPresentationService } = require('../dist/services/import/ImportOperationPresentationService');

const job = (overrides = {}) => ({
  id: '00000000-0000-4000-8000-000000000001', userId: '00000000-0000-4000-8000-000000000002',
  kind: 'gmail_historical', trigger: 'user', provider: null, status: 'queued', phase: 'queued', progress: 0,
  result: null, errorCode: null, errorMessage: null, attempts: 0, idempotencyKey: 'key',
  checkpoint: {},
  createdAt: new Date(1_000_000).toISOString(), queuedAt: null, startedAt: null, completedAt: null,
  updatedAt: new Date(1_000_000).toISOString(),
  ...overrides,
});

test('keeps healthy historical operations in the foreground', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 0, active: 0, delayed: 0, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: null }] },
    () => 1_030_000,
  );
  assert.deepEqual(await service.forJob(job()), {
    mode: 'foreground', expectedDurationBand: 'under_5_minutes', reason: 'normal',
    stage: 'waiting', discoveredOrderCount: null,
  });
});

test('projects durable mailbox progress without exposing its checkpoint', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 0, active: 1, delayed: 0, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: null }] },
    () => 1_030_000,
  );
  const presentation = await service.forJob(job({
    status: 'running',
    phase: 'importing_mailbox',
    checkpoint: { counters: { supportedReceiptsFound: 7 } },
  }));
  assert.equal(presentation.stage, 'building_history');
  assert.equal(presentation.discoveredOrderCount, 7);
});

test('exposes delayed mode only for a backlog or elapsed threshold', async () => {
  const backlog = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 120 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 4, active: 1, delayed: 0, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: 10 }] },
    () => 1_030_000,
  );
  assert.equal((await backlog.forJob(job())).reason, 'queue_backlog');

  const elapsed = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 }, { metrics: async () => [] }, () => 1_301_000,
  );
  assert.equal((await elapsed.forJob(job())).reason, 'elapsed_over_threshold');
});

test('scheduled tracking never receives a user presentation', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 }, { metrics: async () => [] }, () => 1_030_000,
  );
  assert.equal(await service.forJob(job({ kind: 'scheduled_tracking', trigger: 'scheduler' })), null);
});
