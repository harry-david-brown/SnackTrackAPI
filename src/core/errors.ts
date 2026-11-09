export type ApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'ACCESS_TOKEN_EXPIRED'
  | 'ACCESS_TOKEN_INVALID'
  | 'REFRESH_TOKEN_EXPIRED'
  | 'REFRESH_TOKEN_INVALID'
  | 'REFRESH_TOKEN_REVOKED'
  | 'ACCOUNT_DELETION_PENDING'
  | 'SESSION_STORE_UNAVAILABLE'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_EMAIL_VERIFICATION_REQUIRED'
  | 'MICROSOFT_TOKEN_INVALID'
  | 'MICROSOFT_AUTH_UNAVAILABLE'
  | 'MICROSOFT_ATTEMPT_EXPIRED'
  | 'MICROSOFT_EMAIL_VERIFICATION_REQUIRED'
  | 'MICROSOFT_VERIFICATION_COOLDOWN'
  | 'OAUTH_ACCOUNT_CONFLICT'
  | 'ACCOUNT_ALREADY_EXISTS'
  | 'EMAIL_ALREADY_VERIFIED'
  | 'VERIFICATION_CODE_INVALID'
  | 'VERIFICATION_CODE_NOT_PENDING'
  | 'AUTHORIZATION_DENIED'
  | 'RATE_LIMIT_EXCEEDED'
  | 'EXPORT_UPLOAD_RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'CONFIGURATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'AD_CONFIG_VERSION_CONFLICT'
  | 'IMPORT_IN_PROGRESS'
  | 'LOCK_BACKEND_UNAVAILABLE'
  | 'HISTORICAL_BASELINE_REQUIRED'
  | 'GMAIL_RECONNECT_REQUIRED'
  | 'GMAIL_VALIDATION_UNAVAILABLE'
  | 'OUTLOOK_RECONNECT_REQUIRED'
  | 'OUTLOOK_VALIDATION_UNAVAILABLE'
  | 'MAILBOX_RECONNECT_REQUIRED'
  | 'MAILBOX_VALIDATION_UNAVAILABLE'
  | 'TRACKING_NOT_AVAILABLE'
  | 'EXPORT_ALREADY_PROCESSING'
  | 'PROVIDER_USAGE_EVIDENCE_EXISTS'
  | 'PROVIDER_WORKFLOW_ACTIVE'
  | 'GMAIL_IMPORT_FAILED'
  | 'OUTLOOK_IMPORT_FAILED'
  | 'OUTLOOK_OAUTH_FAILED'
  | 'OUTLOOK_UNAVAILABLE'
  | 'OUTLOOK_FETCH_FAILED'
  | 'OUTLOOK_RESPONSE_INVALID'
  | 'OUTLOOK_RESULT_LIMIT'
  | 'EXPORT_IMPORT_FAILED'
  | 'INVALID_CSV_FORMAT'
  | 'UNKNOWN_EXPORT_PROVIDER'
  | 'NO_VALID_EXPORT_ORDERS'
  | 'UPLOAD_PROVIDER_MISMATCH'
  | 'DATABASE_ERROR'
  | 'DATABASE_UNAVAILABLE'
  | 'INVALID_JSON'
  | 'INTERNAL_ERROR';

export interface AppErrorOptions {
  code: ApplicationErrorCode | (string & {});
  message: string;
  publicMessage?: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

/**
 * Transport-neutral operational failure.
 *
 * HTTP status selection belongs to the HTTP error mapper. Application code
 * communicates recovery semantics through a stable code instead.
 */
export class AppError extends Error {
  readonly code: AppErrorOptions['code'];
  readonly publicMessage: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly isOperational = true;

  constructor(options: AppErrorOptions) {
    super(options.message);
    this.name = new.target.name;
    this.code = options.code;
    this.publicMessage = options.publicMessage ?? options.message;
    this.details = options.details;
    this.cause = options.cause;
    Error.captureStackTrace(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, field?: string, cause?: unknown) {
    const fullMessage = `Validation Error${field ? ` for ${field}` : ''}: ${message}`;
    super({
      code: 'VALIDATION_ERROR',
      message: fullMessage,
      publicMessage: fullMessage,
      details: field ? { field } : undefined,
      cause,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    const message = `${resource}${id ? ` with ID ${id}` : ''} not found`;
    super({ code: 'NOT_FOUND', message, publicMessage: message });
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({
      code: 'DATABASE_ERROR',
      message: `Database Error: ${message}`,
      publicMessage: 'Unable to complete the database operation.',
      cause,
    });
  }
}

export class AuthenticationError extends AppError {
  constructor(
    message = 'Authentication required',
    code:
      | 'AUTHENTICATION_REQUIRED'
      | 'INVALID_CREDENTIALS'
      | 'ACCESS_TOKEN_EXPIRED'
      | 'ACCOUNT_DELETION_PENDING'
      | 'ACCESS_TOKEN_INVALID'
      | 'REFRESH_TOKEN_EXPIRED'
      | 'REFRESH_TOKEN_INVALID'
      | 'REFRESH_TOKEN_REVOKED'
      | 'PROVIDER_AUTH_FAILED'
      | 'PROVIDER_EMAIL_VERIFICATION_REQUIRED'
      | 'MICROSOFT_TOKEN_INVALID'
      | 'VERIFICATION_CODE_INVALID' = 'AUTHENTICATION_REQUIRED',
  ) {
    super({ code, message, publicMessage: message });
  }
}

export class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super({ code: 'AUTHORIZATION_DENIED', message, publicMessage: message });
  }
}

export class ConflictError extends AppError {
  constructor(code: 'CONFLICT' | 'IMPORT_IN_PROGRESS' | (string & {}), message: string) {
    super({ code, message, publicMessage: message });
  }
}

/** Persistence-neutral signal for a unique account-email race. */
export class DuplicateUserEmailError extends Error {
  constructor() {
    super('A user with this email already exists');
    this.name = 'DuplicateUserEmailError';
  }
}
