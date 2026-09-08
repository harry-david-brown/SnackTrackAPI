const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyGmailRequestFailure } = require('../dist/services/email/GmailRequestFailure');
const { GmailImportService } = require('../dist/services/import/GmailImportService');
const { AppError } = require('../dist/core/errors');
const providerError = (status, reason) => ({ response: { status, data: { error: { errors: [{ reason }] } } } });

for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']) {
  test(`403 ${reason} is retryable without reconnecting`, () => {
    assert.equal(classifyGmailRequestFailure(providerError(403, reason)).code, 'GMAIL_RATE_LIMITED');
  });
}
test('429 and structured quota details are rate limits', () => {
  assert.equal(classifyGmailRequestFailure(providerError(429)).code, 'GMAIL_RATE_LIMITED');
  assert.equal(classifyGmailRequestFailure({ response: { status: 403, data: { error: { details: [{ reason: 'RATE_LIMIT_EXCEEDED' }] } } } }).code, 'GMAIL_RATE_LIMITED');
});
test('only authorization evidence asks for reconnect', () => {
  for (const error of [providerError(401), providerError(403, 'insufficientPermissions'), { response: { status: 400, data: { error: 'invalid_grant' } } }]) {
    assert.equal(classifyGmailRequestFailure(error).code, 'GMAIL_RECONNECT_REQUIRED');
  }
  for (const reason of ['domainPolicy', 'accessNotConfigured', undefined]) {
    assert.equal(classifyGmailRequestFailure(providerError(403, reason)).code, 'GMAIL_ACCESS_BLOCKED');
  }
});
test('provider details cannot leak arbitrary content into diagnostics', () => {
  const error = providerError(403, 'private account detail');
  error.response.data.error.message = 'private body';
  assert.equal(classifyGmailRequestFailure(error).reason, 'unspecified');
  assert.ok(!JSON.stringify(classifyGmailRequestFailure(error)).includes('private'));
});
for (const code of ['GMAIL_RATE_LIMITED', 'GMAIL_ACCESS_BLOCKED', 'GMAIL_RECONNECT_REQUIRED']) {
  test(`${code} preserves credentials unless reconnection is actually required`, async () => {
    let reconnects = 0;
    const service = new GmailImportService(
      { acquire: async () => { throw new AppError({ code, message: 'Message request failed' }); } },
      { extract: async () => { throw new Error('must not extract'); } },
      { persist: async () => { throw new Error('must not persist'); } },
      { start: async () => 'sync-1', complete: async () => { throw new Error('must not complete'); }, fail: async () => {}, markReconnectRequired: async () => { reconnects++; } },
    );
    const result = await service.importFromGmail({ id: 'user-1' }, {});
    assert.equal(result.success, false);
    assert.equal(result.errorCode, code);
    assert.equal(reconnects, code === 'GMAIL_RECONNECT_REQUIRED' ? 1 : 0);
  });
}

const { HistoricalGmailImportService } = require('../dist/services/import/HistoricalGmailImportService');
for (const code of ['GMAIL_RATE_LIMITED', 'GMAIL_ACCESS_BLOCKED']) {
  test(`historical import preserves ${code} for worker retry policy and UI`, async () => {
    const service = new HistoricalGmailImportService(
      { getConnection: async () => ({ user: { id: 'user-1' }, health: { status: 'valid' }, status: { canImport: true, needsReconnect: false } }) },
      { importFromGmail: async () => ({ success: false, errorCode: code }) },
      {}, { info: () => {} },
    );
    await assert.rejects(service.executeWithLock('user-1', {}), error => error.code === code);
  });
}

const { gmailFailureDiagnostics } = require('../dist/services/email/GmailRequestFailure');
test('response diagnostics retain Google reasons and quota fields without request credentials', () => {
  const error = { config: { headers: { Authorization: 'secret' } }, response: {
    status: 403, headers: { 'retry-after': '60', authorization: 'secret' },
    data: { error: { status: 'RESOURCE_EXHAUSTED', message: 'Rate limit for person@example.test',
      errors: [{ reason: 'userRateLimitExceeded', domain: 'usageLimits', message: 'Rate limit exceeded' }],
      details: [{ metadata: { quota_metric: 'gmail.googleapis.com/read_requests', quota_limit_value: '100', consumer: 'private-project' } }],
    } },
  } };
  const diagnostics = gmailFailureDiagnostics(error);
  assert.equal(diagnostics.googleErrors[0].reason, 'userRateLimitExceeded');
  assert.equal(diagnostics.googleMessage, 'Rate limit for [address]');
  assert.equal(diagnostics.quotaDetails[0].quotaLimitValue, '100');
  assert.equal(diagnostics.retryAfter, '60');
  assert.ok(!JSON.stringify(diagnostics).includes('secret'));
  assert.ok(!JSON.stringify(diagnostics).includes('private-project'));
});
