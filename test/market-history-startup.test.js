const test = require('node:test');
const assert = require('node:assert/strict');
const { startDevMarketHistoryCheck } = require('../dist/services/market/startDevMarketHistoryCheck');

test('production startup never runs a refresh even when refresh is enabled', async () => {
  await startDevMarketHistoryCheck(false, true, () => assert.fail('unexpected refresh'),
    () => assert.fail('unexpected log'), () => assert.fail('unexpected failure'));
});

test('disabled development startup reports its state without accessing market data', async () => {
  const messages = [];
  await startDevMarketHistoryCheck(true, false, () => assert.fail('unexpected refresh'),
    message => messages.push(message), () => assert.fail('unexpected failure'));
  assert.deepEqual(messages, ['Market history startup check disabled']);
});

test('development starts a refresh immediately and exposes completion for shutdown', async () => {
  let finish;
  let calls = 0;
  const messages = [];
  const pending = startDevMarketHistoryCheck(true, true, () => {
    calls++;
    return new Promise(resolve => { finish = resolve; });
  }, (message, metadata) => messages.push({ message, metadata }), () => assert.fail('unexpected failure'));
  assert.equal(calls, 1);
  assert.equal(messages.length, 1);
  finish({ status: 'current' });
  await pending;
  assert.equal(messages[1].metadata.result.status, 'current');
});

test('refresh failure is reported without rejecting API startup', async () => {
  const failure = new Error('provider unavailable');
  let reported;
  await startDevMarketHistoryCheck(true, true, async () => { throw failure; },
    () => {}, error => { reported = error; });
  assert.equal(reported, failure);
});
