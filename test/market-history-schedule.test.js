const test = require('node:test');
const assert = require('node:assert/strict');
const {
  nextMarketHistoryCheck,
  runMarketHistorySchedule,
} = require('../dist/services/market/marketHistorySchedule');

test('daily checks follow the production 08:00 UTC schedule across month and DST boundaries', () => {
  assert.equal(
    nextMarketHistoryCheck(new Date('2026-09-30T07:00:00Z')).toISOString(),
    '2026-09-30T08:00:00.000Z',
  );
  assert.equal(
    nextMarketHistoryCheck(new Date('2026-09-30T08:00:00Z')).toISOString(),
    '2026-10-01T08:00:00.000Z',
  );
  assert.equal(
    nextMarketHistoryCheck(new Date('2026-11-01T09:00:00Z')).toISOString(),
    '2026-11-02T08:00:00.000Z',
  );
});

test('Compose checks immediately and shutdown cancels the next scheduled check', async () => {
  const controller = new AbortController();
  let calls = 0;
  await runMarketHistorySchedule(
    async () => {
      calls++;
      controller.abort();
    },
    () => assert.fail('unexpected failure'),
    controller.signal,
  );
  assert.equal(calls, 1);
});

test('a failed startup check is reported without terminating the scheduler', async () => {
  const controller = new AbortController();
  let reported;
  await runMarketHistorySchedule(
    async () => {
      throw new Error('provider unavailable');
    },
    (error) => {
      reported = error;
      controller.abort();
    },
    controller.signal,
  );
  assert.equal(reported.message, 'provider unavailable');
});
