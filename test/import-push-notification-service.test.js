const test = require('node:test');
const assert = require('node:assert/strict');

const { ImportPushNotificationService } = require('../dist/services/notifications/ImportPushNotificationService');

const job = (overrides = {}) => ({
  id: 'operation-1',
  userId: 'user-1',
  kind: 'scheduled_tracking',
  trigger: 'scheduler',
  status: 'succeeded',
  result: { newOrders: 1, updatedOrders: 0 },
  ...overrides,
});

const harness = (currentJob) => {
  const logs = [];
  let deviceLookups = 0;
  const service = new ImportPushNotificationService(
    { findById: async () => currentJob },
    {
      listPendingForJob: async () => {
        deviceLookups += 1;
        return [{ id: 'device-1', token: 'ExponentPushToken[test]' }];
      },
    },
    'log',
    { info: (message, metadata) => logs.push({ message, metadata }) },
  );
  return { service, logs, deviceLookups: () => deviceLookups };
};

test('scheduled tracking uses singular and plural detected-order titles', async () => {
  for (const [count, title] of [[1, 'New order found'], [2, 'New orders found']]) {
    const current = harness(job({ result: { newOrders: count, updatedOrders: 0 } }));
    await current.service.notify('operation-1');
    assert.equal(current.logs[0].metadata.title, title);
  }
});

test('scheduled tracking stays silent when no orders were detected', async () => {
  const current = harness(job({ result: { newOrders: 0, updatedOrders: 0 } }));
  await current.service.notify('operation-1');
  assert.equal(current.deviceLookups(), 0);
  assert.equal(current.logs.length, 0);
});

test('user-started imports keep import-completion wording', async () => {
  const current = harness(job({ kind: 'gmail_historical', trigger: 'user' }));
  await current.service.notify('operation-1');
  assert.equal(current.logs[0].metadata.title, 'SnackTrack import complete');
});

test('new, updated and imported counts overlap rather than add together', async () => {
  const current = harness(job({ result: { newOrders: 1, updatedOrders: 1, importedCount: 2 } }));
  await current.service.notify('operation-1');
  assert.equal(current.logs[0].metadata.body, '1 new order added. 1 existing order updated.');
});

test('refunded/enriched existing orders do not claim a new purchase', async () => {
  const current = harness(job({ result: { newOrders: 0, updatedOrders: 1, importedCount: 1 } }));
  await current.service.notify('operation-1');
  assert.equal(current.logs[0].metadata.title, 'Order history updated');
  assert.equal(current.logs[0].metadata.body, '1 existing order updated.');
});

test('unchanged imports stay quiet even when importedCount is positive', async () => {
  const current = harness(job({ result: { newOrders: 0, updatedOrders: 0, unchangedOrders: 10, importedCount: 10 } }));
  await current.service.notify('operation-1');
  assert.equal(current.deviceLookups(), 0);
});

test('legacy export totals are checked orders, not proof of new purchases', async () => {
  const current = harness(job({ trigger: 'user', result: { importedCount: 8 } }));
  await current.service.notify('operation-1');
  assert.equal(current.logs[0].metadata.body, '8 orders checked. View your history for details.');
});


test('ready checks stay silent on no detection and failures', async () => {
  for (const status of ['succeeded', 'failed']) {
    const current = harness(job({ kind: 'export_ready_check', status, result: { exportReadyDetected: false } }));
    await current.service.notify('operation-1');
    assert.equal(current.deviceLookups(), 0);
  }
});
test('DoorDash ready notifications name the matching provider', async () => {
  const current = harness(job({ kind: 'export_ready_check', exportProvider: 'doordash', result: { exportReadyDetected: true } }));
  await current.service.notify('operation-1');
  assert.equal(current.logs[0].metadata.title, 'Your DoorDash data is ready');
});
