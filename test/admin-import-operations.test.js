const test = require('node:test');
const assert = require('node:assert/strict');
const { AdminManagementService } = require('../dist/services/admin/AdminManagementService');

const operation = {
  id: '67bce5bc-436e-4c4f-9c0f-93880b5ced9a', user_id: '57d0a1df-93ca-4ec3-a47c-6d9700340e18',
  user_email: 'person@example.com', kind: 'gmail_historical', export_provider: null,
  trigger_type: 'user', journey_context: 'post_onboarding', status: 'retrying', phase: 'retrying',
  progress: 19, attempts: 2, error_code: 'GMAIL_RATE_LIMITED', error_message: 'Try later',
  created_at: '2026-09-07T10:00:00.000Z', queued_at: '2026-09-07T10:00:01.000Z',
  started_at: '2026-09-07T10:00:02.000Z', completed_at: null, updated_at: '2026-09-07T10:01:00.000Z',
  heartbeat_at: null, duration_seconds: 60, heartbeat_age_seconds: null, stalled: false,
  checkpoint: { provider: 'gmail', cursor: 'secret-page-token', counters: { pages: 2, emailsExamined: 100 } },
  result: { newOrders: 0 }, original_filename: null, content_type: null, content_length: null,
  submitted_content_type: null, submitted_content_length: null,
};

test('admin import detail exposes progress and result while removing provider cursors and tokens', async () => {
  let call = 0;
  const database = { query: async () => {
    call += 1;
    if (call === 1) return { rows: [operation] };
    return { rows: [{ id: 1, event_type: 'attempt_failed_retrying', attempt: 2, status: 'retrying', phase: 'retrying', progress: 19, error_code: 'GMAIL_RATE_LIMITED', details: { status: 403, accessToken: 'secret', googleMessage: 'Quota exceeded', retryNotBefore: '2026-09-07T10:02:00.000Z', retryBy: '2026-09-07T10:02:15.000Z' }, created_at: operation.updated_at }] };
  } };
  const service = new AdminManagementService(database, {}, {}, {});
  const detail = await service.importOperation(operation.id);
  assert.equal(detail.operation.checkpoint.cursor, undefined);
  assert.equal(detail.operation.checkpoint.counters.emailsExamined, 100);
  assert.equal(detail.operation.result.newOrders, 0);
  assert.equal(detail.events[0].details.accessToken, undefined);
  assert.equal(detail.events[0].details.status, 403);
  assert.equal(detail.operation.retryNotBefore, '2026-09-07T10:02:00.000Z');
  assert.equal(detail.operation.retryBy, '2026-09-07T10:02:15.000Z');
});

test('admin import list supports active operations with live execution fields', async () => {
  const database = { query: async () => ({ rows: [{ ...operation, total: 1 }] }) };
  const service = new AdminManagementService(database, {}, {}, {});
  const result = await service.importOperations({ status: 'active', limit: 50, offset: 0 });
  assert.equal(result.operations[0].provider, 'gmail');
  assert.equal(result.operations[0].progress, 19);
  assert.equal(result.pagination.total, 1);
});

test('admin import detail does not expose an old retry window after completion', async () => {
  let call = 0;
  const database = { query: async () => {
    call += 1;
    if (call === 1) return { rows: [{ ...operation, status: 'succeeded', phase: 'completed', completed_at: '2026-09-07T10:03:00.000Z' }] };
    return { rows: [{ id: 1, event_type: 'attempt_failed_retrying', attempt: 1, status: 'retrying', phase: 'retrying', progress: 19, error_code: 'GMAIL_RATE_LIMITED', details: { retryNotBefore: '2026-09-07T10:02:00.000Z', retryBy: '2026-09-07T10:02:15.000Z' }, created_at: operation.updated_at }] };
  } };
  const service = new AdminManagementService(database, {}, {}, {});
  const detail = await service.importOperation(operation.id);
  assert.equal(detail.operation.retryNotBefore, null);
  assert.equal(detail.operation.retryBy, null);
});
