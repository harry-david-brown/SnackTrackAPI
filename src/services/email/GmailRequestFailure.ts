const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const knownReasons = new Set([
  'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded',
  'insufficientPermissions', 'authError', 'domainPolicy', 'accessNotConfigured',
  'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED', 'SERVICE_DISABLED',
]);

/** Only allowlisted provider reasons reach diagnostics; never retain response bodies or credentials. */
export function classifyGmailRequestFailure(error: unknown) {
  const candidate = record(error);
  const response = record(candidate.response);
  const data = record(response.data);
  const providerError = record(data.error);
  const status = typeof response.status === 'number' ? response.status
    : typeof candidate.code === 'number' ? candidate.code : null;
  const entries = [...(Array.isArray(providerError.errors) ? providerError.errors : []),
    ...(Array.isArray(providerError.details) ? providerError.details : []),
    ...(Array.isArray(candidate.errors) ? candidate.errors : [])];
  const reasons = entries.map(entry => record(entry).reason)
    .filter((reason): reason is string => typeof reason === 'string' && knownReasons.has(reason));
  const reason = reasons.join(',') || 'unspecified';
  const rateLimited = status === 429 || reasons.some(r => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'RATE_LIMIT_EXCEEDED', 'QUOTA_EXCEEDED'].includes(r));
  if (rateLimited) return { status, reason, code: 'GMAIL_RATE_LIMITED', publicMessage: 'Your receipt import couldn’t finish right now. Please wait a little before trying again. Your email connection is still active.' };
  if (status === 401 || data.error === 'invalid_grant' || reasons.some(r => ['insufficientPermissions', 'authError', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(r))) {
    return { status, reason, code: 'GMAIL_RECONNECT_REQUIRED', publicMessage: 'Reconnect Gmail and allow access to your receipts to continue.' };
  }
  if (status === 403) return { status, reason, code: 'GMAIL_ACCESS_BLOCKED', publicMessage: 'Google blocked access to receipt messages. This may be an account policy or app configuration issue. Your Gmail connection has been kept.' };
  return { status, reason, code: 'GMAIL_IMPORT_FAILED', publicMessage: 'Gmail messages could not be loaded. Please try again.' };
}

const diagnosticText = (value: unknown): string | undefined => typeof value === 'string'
  ? value.replace(/[\w.+-]+@[\w.-]+/g, '[address]')
    .replace(/https?:\/\/[^\s"<>]+/gi, '[url]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(?:ya29\.|1\/\/|GOCSPX-)[A-Za-z0-9_.\/-]+/g, '[redacted]')
    .slice(0, 1500) : undefined;

/** Selected response fields only: no request configuration, headers, tokens, or mailbox payloads. */
export function gmailFailureDiagnostics(error: unknown) {
  const response = record(record(error).response);
  const providerError = record(record(response.data).error);
  const headers = record(response.headers);
  const failure = classifyGmailRequestFailure(error);
  return {
    status: failure.status,
    googleStatus: diagnosticText(providerError.status),
    googleMessage: diagnosticText(providerError.message),
    googleErrors: Array.isArray(providerError.errors) ? providerError.errors.slice(0, 5).map(value => {
      const entry = record(value);
      return { reason: diagnosticText(entry.reason), domain: diagnosticText(entry.domain), message: diagnosticText(entry.message) };
    }) : undefined,
    quotaDetails: Array.isArray(providerError.details) ? providerError.details.slice(0, 5).map(value => {
      const entry = record(value); const metadata = record(entry.metadata);
      return { reason: diagnosticText(entry.reason),
        quotaMetric: diagnosticText(metadata.quota_metric), quotaLimit: diagnosticText(metadata.quota_limit),
        quotaLimitValue: diagnosticText(metadata.quota_limit_value), quotaUnit: diagnosticText(metadata.quota_unit),
      };
    }) : undefined,
    retryAfter: diagnosticText(headers['retry-after']),
  };
}
