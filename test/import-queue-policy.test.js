const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EXPORT_IMPORT_QUEUE,
  MAILBOX_IMPORT_QUEUE,
  importAttemptLimit,
  importRetryBackoff,
  queueAttemptFailureMessage,
} = require('../dist/services/queue/ImportQueues');

test('mailbox retries begin beyond the Gmail one-minute quota window', () => {
  assert.deepEqual(importRetryBackoff(MAILBOX_IMPORT_QUEUE, 'dispatch'), {
    type: 'exponential',
    delay: 90_000,
    jitter: 0.2,
  });
});

test('export and notification retries retain their shorter policies', () => {
  assert.deepEqual(importRetryBackoff(EXPORT_IMPORT_QUEUE, 'dispatch'), {
    type: 'exponential',
    delay: 30_000,
    jitter: 0.2,
  });
  assert.deepEqual(importRetryBackoff(MAILBOX_IMPORT_QUEUE, 'notify'), {
    type: 'exponential',
    delay: 10_000,
  });
});

test('historical Gmail imports get additional resumable attempts', () => {
  assert.equal(importAttemptLimit('gmail_historical', 'dispatch'), 5);
  assert.equal(importAttemptLimit('outlook_historical', 'dispatch'), 3);
  assert.equal(importAttemptLimit('gmail_historical', 'notify'), 5);
});

test('queue failure message exposes the attempt and underlying error', () => {
  const error = Object.assign(new Error('Google quota window is exhausted'), {
    code: 'GMAIL_RATE_LIMITED',
  });
  assert.equal(
    queueAttemptFailureMessage(2, 3, error),
    'Queued task attempt 2/3 failed (GMAIL_RATE_LIMITED): Google quota window is exhausted',
  );
});
