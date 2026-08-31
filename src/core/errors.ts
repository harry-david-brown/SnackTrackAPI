export type ApplicationErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHORIZATION_DENIED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IMPORT_IN_PROGRESS'
  | 'INVALID_CSV_FORMAT'
  | 'UNKNOWN_EXPORT_PROVIDER'
  | 'NO_VALID_EXPORT_ORDERS'
  | 'DATABASE_ERROR'
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
  constructor(message = 'Authentication required') {
    super({ code: 'AUTHENTICATION_REQUIRED', message, publicMessage: message });
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
