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
    timeEstimate: { kind: 'remaining', minimumMinutes: 1, maximumMinutes: 2, revision: 0 },
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

test('estimates Gmail processing time from the remaining quota-paced message fetches', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 30 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 0, active: 1, delayed: 0, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: null }] },
    () => 1_030_000,
    { messageGetQueryUnits: 60, queryUnitsPerMinute: 3_000 },
  );

  const presentation = await service.forJob(job({
    status: 'running',
    phase: 'importing_mailbox',
    progress: 34,
    checkpoint: {
      estimatedTotalMessages: 600,
      counters: { matchedMessages: 150, supportedReceiptsFound: 7 },
    },
  }));

  // 450 remaining messages * 60 units / 3,000 units per minute = 9 minutes.
  assert.deepEqual(presentation.timeEstimate, {
    kind: 'remaining', minimumMinutes: 7, maximumMinutes: 11, revision: 0,
  });
  assert.equal(presentation.expectedDurationBand, 'over_5_minutes');
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

for (const scenario of [
  {
    name: 'a newly paused queue',
    overrides: {},
    metrics: { waiting: 1, active: 0, delayed: 0, paused: true, workers: 1 },
  },
  {
    name: 'a newly unavailable worker',
    overrides: {},
    metrics: { waiting: 1, active: 0, delayed: 0, paused: false, workers: 0 },
  },
]) {
  test(`does not claim ${scenario.name} will exceed five minutes`, async () => {
    const service = new ImportOperationPresentationService(
      { getP75DurationSeconds: async () => 60 },
      { metrics: async () => [{
        name: 'mailbox-imports', failed: 0, oldestWaitingAgeSeconds: 10,
        ...scenario.metrics,
      }] },
      () => 1_030_000,
    );

    assert.deepEqual(await service.forJob(job(scenario.overrides)), {
      mode: 'foreground', expectedDurationBand: 'unknown', reason: 'normal',
      stage: 'waiting', discoveredOrderCount: null, timeEstimate: null,
    });
  });
}

test('shows the Gmail quota retry window without claiming the import exceeds five minutes', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 0, active: 0, delayed: 1, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: 10 }] },
    () => 1_030_000,
  );

  assert.deepEqual(await service.forJob(job({
    status: 'retrying', phase: 'retrying', attempts: 1, errorCode: 'GMAIL_RATE_LIMITED',
  })), {
    mode: 'foreground', expectedDurationBand: 'under_5_minutes', reason: 'normal',
    stage: 'waiting', discoveredOrderCount: null,
    timeEstimate: { kind: 'retry_wait', minimumMinutes: 1, maximumMinutes: 1, revision: 1 },
  });
});

test('shows a known six-minute admin scenario as delayed with a remaining estimate', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 0, active: 0, delayed: 1, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: null }] },
    () => 1_030_000,
  );
  const presentation = await service.forJob(job({
    status: 'retrying', phase: 'simulated_long_running', attempts: 0,
    errorCode: 'ADMIN_SIMULATED_LONG_RUNNING', updatedAt: new Date(1_000_000).toISOString(),
  }));
  assert.equal(presentation.mode, 'delayed');
  assert.equal(presentation.expectedDurationBand, 'over_5_minutes');
  assert.equal(presentation.reason, 'retrying');
  assert.deepEqual(presentation.timeEstimate, { kind: 'remaining', minimumMinutes: 7, maximumMinutes: 9, revision: 0 });
});

test('starts with a broad total estimate and finishes without a countdown', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 150 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 1, active: 0, delayed: 0, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: null }] },
    () => 1_010_000,
  );
  assert.deepEqual((await service.forJob(job())).timeEstimate, {
    kind: 'total', minimumMinutes: 2, maximumMinutes: 3, revision: 0,
  });
  assert.deepEqual((await service.forJob(job({ status: 'running', progress: 95 }))).timeEstimate, {
    kind: 'finishing', minimumMinutes: null, maximumMinutes: null, revision: 0,
  });
});

test('includes elapsed time when forecasting a completion beyond five minutes', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 180 },
    { metrics: async () => [{ name: 'mailbox-imports', waiting: 0, active: 0, delayed: 0, failed: 0, paused: false, workers: 1, oldestWaitingAgeSeconds: null }] },
    () => 1_150_000,
  );

  assert.equal((await service.forJob(job())).expectedDurationBand, 'over_5_minutes');
});

test('scheduled tracking never receives a user presentation', async () => {
  const service = new ImportOperationPresentationService(
    { getP75DurationSeconds: async () => 60 }, { metrics: async () => [] }, () => 1_030_000,
  );
  assert.equal(await service.forJob(job({ kind: 'scheduled_tracking', trigger: 'scheduler' })), null);
});
