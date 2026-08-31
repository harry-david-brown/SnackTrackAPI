const test = require('node:test');
const assert = require('node:assert/strict');

const { redactLogMetadata } = require('../dist/config/logger');

test('structured log redaction removes credentials and message bodies recursively', () => {
  const result = redactLogMetadata({
    userId: 'safe-user-id',
    accessToken: 'access-token',
    nested: {
      password: 'password',
      emailBody: '<html>secret message</html>',
      errorCode: 'IMPORT_IN_PROGRESS',
    },
  });

  assert.deepEqual(result, {
    userId: 'safe-user-id',
    accessToken: '[REDACTED]',
    nested: {
      password: '[REDACTED]',
      emailBody: '[REDACTED]',
      errorCode: 'IMPORT_IN_PROGRESS',
    },
  });
});
