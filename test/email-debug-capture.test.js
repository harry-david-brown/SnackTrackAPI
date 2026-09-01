const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readdir, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const {
  DisabledEmailDebugCapture,
  RedactingFileEmailDebugCapture,
} = require('../dist/services/email/EmailDebugCapture');

test('disabled email debug capture performs no filesystem work', async () => {
  await new DisabledEmailDebugCapture().capture('ignored', {
    emailBody: 'sensitive content',
  });
});

test('enabled email debug capture writes only a redacted operational record', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'snacktrack-debug-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const warnings = [];
  const capture = new RedactingFileEmailDebugCapture(
    true,
    { warn: (...args) => warnings.push(args) },
    directory,
  );

  await capture.capture('gmail-summary', {
    count: 4,
    email: 'consumer@example.test',
    from: 'sender@example.test',
    subject: 'Your order',
    body: 'receipt body',
    accessToken: 'secret-token',
    nested: { externalId: 'provider-id', safeCount: 2 },
  });

  const files = await readdir(directory);
  assert.equal(files.length, 1);
  const record = JSON.parse(await readFile(join(directory, files[0]), 'utf8'));
  assert.equal(record.event, 'gmail-summary');
  assert.equal(record.metadata.count, 4);
  assert.equal(record.metadata.email, '[REDACTED]');
  assert.equal(record.metadata.from, '[REDACTED]');
  assert.equal(record.metadata.subject, '[REDACTED]');
  assert.equal(record.metadata.body, '[REDACTED]');
  assert.equal(record.metadata.accessToken, '[REDACTED]');
  assert.equal(record.metadata.nested.externalId, '[REDACTED]');
  assert.equal(record.metadata.nested.safeCount, 2);
  assert.deepEqual(warnings, []);
});
