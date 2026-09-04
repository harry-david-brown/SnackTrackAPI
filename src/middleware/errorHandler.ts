import { Request, Response, NextFunction, RequestHandler } from 'express';
import { sentryConfig } from '../config/sentry';
import { logger, logError } from '../config/logger';
import { config } from '../config/AppConfig';
import {
  AppError,
  ApplicationErrorCode,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from '../core/errors';
import { buildErrorEnvelopeV1 } from '../http/errors/errorEnvelope';

// Transitional transport re-exports keep route imports stable while inner
// modules migrate to the transport-neutral error owner.
export {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from '../core/errors';

const DATABASE_UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  '57P01', // PostgreSQL admin shutdown
  '57P02', // PostgreSQL crash shutdown
  '57P03', // PostgreSQL cannot connect now
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

const valueCode = (value: unknown): string | undefined => {
  if (typeof value !== 'object' || value === null || !('code' in value)) return undefined;
  return typeof value.code === 'string' ? value.code : undefined;
};

export const isDatabaseUnavailableError = (error: unknown): boolean => {
  const code = valueCode(error);
  if (code && DATABASE_UNAVAILABLE_CODES.has(code)) return true;
  if (error instanceof AppError && error.cause !== undefined) {
    return isDatabaseUnavailableError(error.cause);
  }
  if (typeof error === 'object' && error !== null && 'errors' in error) {
    const errors: unknown = error.errors;
    return Array.isArray(errors) && (errors as unknown[]).some(isDatabaseUnavailableError);
  }
  return false;
};

export const statusForError = (error: AppError): number => {
  if (error.code === 'DATABASE_ERROR' && isDatabaseUnavailableError(error)) return 503;
  switch (error.code) {
    case 'VALIDATION_ERROR':
      return 400;
    case 'INVALID_CSV_FORMAT':
    case 'UNKNOWN_EXPORT_PROVIDER':
    case 'NO_VALID_EXPORT_ORDERS':
    case 'UPLOAD_PROVIDER_MISMATCH':
    case 'UPLOAD_PROVIDER_REQUIRED':
    case 'UPLOAD_INTEGRITY_FAILED':
    case 'UNSUPPORTED_UPLOAD_TYPE':
    case 'ZIP_INVALID':
    case 'ZIP_UNSAFE_ENTRY':
    case 'ZIP_ENCRYPTED':
    case 'ZIP_AMBIGUOUS_EXPORT':
    case 'ZIP_SIZE_MISMATCH':
    case 'ZIP_INTEGRITY_FAILED':
    case 'CSV_HEADER_TOO_LARGE':
    case 'CSV_ROW_TOO_LARGE':
      return 400;
    case 'AUTHENTICATION_REQUIRED':
    case 'INVALID_CREDENTIALS':
    case 'ACCESS_TOKEN_EXPIRED':
    case 'ACCESS_TOKEN_INVALID':
    case 'REFRESH_TOKEN_EXPIRED':
    case 'REFRESH_TOKEN_INVALID':
    case 'REFRESH_TOKEN_REVOKED':
    case 'PROVIDER_AUTH_FAILED':
    case 'MICROSOFT_TOKEN_INVALID':
    case 'VERIFICATION_CODE_INVALID':
      return 401;
    case 'AUTHORIZATION_DENIED':
      return 403;
    case 'RATE_LIMIT_EXCEEDED':
    case 'IMPORT_RATE_LIMITED':
    case 'MICROSOFT_VERIFICATION_COOLDOWN':
      return 429;
    case 'PAYLOAD_TOO_LARGE':
    case 'UPLOAD_TOO_LARGE':
    case 'ARCHIVE_TOO_LARGE':
    case 'ARCHIVE_ENTRY_TOO_LARGE':
    case 'ARCHIVE_EXPANSION_LIMIT':
    case 'ZIP_TOO_MANY_ENTRIES':
    case 'ZIP_TOO_LARGE':
    case 'ZIP_OUTPUT_TOO_LARGE':
    case 'ZIP_COMPRESSION_RATIO':
    case 'MAILBOX_MESSAGE_TOO_LARGE':
      return 413;
    case 'NOT_FOUND':
    case 'VERIFICATION_CODE_NOT_PENDING':
      return 404;
    case 'CONFLICT':
    case 'MICROSOFT_ATTEMPT_EXPIRED':
    case 'MICROSOFT_EMAIL_VERIFICATION_REQUIRED':
    case 'OAUTH_ACCOUNT_CONFLICT':
    case 'ACCOUNT_ALREADY_EXISTS':
    case 'EMAIL_ALREADY_VERIFIED':
    case 'IMPORT_IN_PROGRESS':
    case 'HISTORICAL_BASELINE_REQUIRED':
    case 'GMAIL_RECONNECT_REQUIRED':
    case 'OUTLOOK_RECONNECT_REQUIRED':
    case 'MAILBOX_RECONNECT_REQUIRED':
    case 'TRACKING_NOT_AVAILABLE':
    case 'EXPORT_ALREADY_PROCESSING':
    case 'UPLOAD_NOT_SUBMITTABLE':
    case 'IDEMPOTENCY_KEY_REUSED':
    case 'UPLOAD_CHANGED':
    case 'UPLOAD_SIZE_MISMATCH':
    case 'AD_CONFIG_VERSION_CONFLICT':
      return 409;
    case 'UPLOAD_NOT_FOUND':
      return 404;
    case 'GMAIL_IMPORT_FAILED':
    case 'OUTLOOK_IMPORT_FAILED':
    case 'OUTLOOK_FETCH_FAILED':
    case 'OUTLOOK_RESPONSE_INVALID':
    case 'OUTLOOK_RESULT_LIMIT':
    case 'OUTLOOK_OAUTH_FAILED':
    case 'EXPORT_IMPORT_FAILED':
      return 502;
    case 'GMAIL_VALIDATION_UNAVAILABLE':
    case 'OUTLOOK_VALIDATION_UNAVAILABLE':
    case 'OUTLOOK_UNAVAILABLE':
    case 'MAILBOX_VALIDATION_UNAVAILABLE':
    case 'MICROSOFT_AUTH_UNAVAILABLE':
    case 'IMPORT_QUEUE_FULL':
    case 'SESSION_STORE_UNAVAILABLE':
    case 'LOCK_BACKEND_UNAVAILABLE':
      return 503;
    case 'DATABASE_UNAVAILABLE':
      return 503;
    case 'CONFIGURATION_ERROR':
      return 500;
    case 'DATABASE_ERROR':
    case 'INTERNAL_ERROR':
    default:
      return 500;
  }
};

const publicCodeForError = (error: AppError): ApplicationErrorCode | (string & {}) =>
  error.code === 'DATABASE_ERROR' && isDatabaseUnavailableError(error)
    ? 'DATABASE_UNAVAILABLE'
    : error.code;

// Error logging utility
export const logErrorToSentry = (error: Error, req?: Request) => {
  const method = req?.method || 'UNKNOWN';
  const url = req?.originalUrl || 'UNKNOWN';
  const userAgent = req?.get('User-Agent') || 'UNKNOWN';
  const ip = req?.ip || req?.connection?.remoteAddress || 'UNKNOWN';

  // Log using Winston logger (only include userId if it exists)
  const logMetadata: Record<string, unknown> = {
    requestId: req?.requestId,
    method,
    url,
    ip,
    userAgent,
  };
  const userId = req?.user?.userId;
  if (userId) {
    logMetadata.userId = userId;
  }
  if (error instanceof AppError && statusForError(error) < 500) {
    logger.warn('Operational request failure', {
      ...logMetadata,
      errorCode: error.code,
      message: error.publicMessage,
    });
  } else {
    logError(error, logMetadata);
  }

  // Send to Sentry for production monitoring
  if (sentryConfig.isEnabled()) {
    // Only send 5xx errors to Sentry (not validation errors)
    if (error instanceof AppError && statusForError(error) >= 500) {
      sentryConfig.captureError(error, {
        method,
        url,
        userAgent,
        ip,
        statusCode: statusForError(error),
        errorCode: error.code,
      });
    } else if (!(error instanceof AppError)) {
      // Unknown errors (not our custom AppError) - always send to Sentry
      // This includes plain Error objects thrown in routes
      sentryConfig.captureError(error, {
        method,
        url,
        userAgent,
        ip,
      });
    }
  }
};

// Main error handling middleware
export const errorHandler = (value: unknown, req: Request, res: Response, next: NextFunction) => {
  const error =
    value instanceof Error ? value : new Error('Non-Error value reached error middleware');
  // Log the error
  logErrorToSentry(error, req);

  // Handle known error types
  if (error instanceof AppError) {
    const statusCode = statusForError(error);
    return res.status(statusCode).json(
      buildErrorEnvelopeV1(req, statusCode, publicCodeForError(error), error.publicMessage, {
        details: error.details,
      }),
    );
  }

  // Handle validation errors (from express-validator or similar)
  if (error.name === 'ValidationError') {
    return res.status(400).json(
      buildErrorEnvelopeV1(req, 400, 'VALIDATION_ERROR', 'Validation Error', {
        details: error.message,
      }),
    );
  }

  // Handle driver/network failures by stable error codes rather than message text.
  if (isDatabaseUnavailableError(error)) {
    return res
      .status(503)
      .json(buildErrorEnvelopeV1(req, 503, 'DATABASE_UNAVAILABLE', 'Database connection failed'));
  }

  // Handle JSON parsing errors
  if (error instanceof SyntaxError && 'body' in error) {
    return res
      .status(400)
      .json(buildErrorEnvelopeV1(req, 400, 'INVALID_JSON', 'Invalid JSON format'));
  }

  // Default server error
  res
    .status(500)
    .json(
      buildErrorEnvelopeV1(
        req,
        500,
        'INTERNAL_ERROR',
        config.isProduction() ? 'Internal server error' : error.message,
        { stack: config.isProduction() ? undefined : error.stack },
      ),
    );
};

// Async error wrapper to catch async errors in route handlers
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
