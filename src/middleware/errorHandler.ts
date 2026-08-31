import { Request, Response, NextFunction, RequestHandler } from 'express';
import { sentryConfig } from '../config/sentry';
import { logger, logError } from '../config/logger';
import { config } from '../config/AppConfig';
import {
  AppError,
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  NotFoundError,
  ValidationError,
} from '../core/errors';

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

const statusForError = (error: AppError): number => {
  switch (error.code) {
    case 'VALIDATION_ERROR': return 400;
    case 'INVALID_CSV_FORMAT':
    case 'UNKNOWN_EXPORT_PROVIDER':
    case 'NO_VALID_EXPORT_ORDERS': return 400;
    case 'AUTHENTICATION_REQUIRED': return 401;
    case 'AUTHORIZATION_DENIED': return 403;
    case 'NOT_FOUND': return 404;
    case 'CONFLICT':
    case 'IMPORT_IN_PROGRESS': return 409;
    case 'DATABASE_ERROR':
    case 'INTERNAL_ERROR':
    default: return 500;
  }
};

const errorEnvelope = (
  req: Request,
  statusCode: number,
  code: string,
  message: string,
  options?: { details?: unknown; stack?: string },
) => ({
  error: {
    version: '1' as const,
    code,
    message,
    ...(options?.details !== undefined ? { details: options.details } : {}),
    statusCode,
    timestamp: new Date().toISOString(),
    path: req.originalUrl,
    method: req.method,
    ...(options?.stack ? { stack: options.stack } : {}),
  },
});

// Error logging utility
export const logErrorToSentry = (error: Error, req?: Request) => {
  const method = req?.method || 'UNKNOWN';
  const url = req?.originalUrl || 'UNKNOWN';
  const userAgent = req?.get('User-Agent') || 'UNKNOWN';
  const ip = req?.ip || req?.connection?.remoteAddress || 'UNKNOWN';

  // Log using Winston logger (only include userId if it exists)
  const logMetadata: Record<string, unknown> = {
    method,
    url,
    ip,
    userAgent
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
        ip
      });
    }
  }
};

// Main error handling middleware
export const errorHandler = (
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Log the error
  logErrorToSentry(error, req);

  // Handle known error types
  if (error instanceof AppError) {
    const statusCode = statusForError(error);
    return res.status(statusCode).json(errorEnvelope(
      req,
      statusCode,
      error.code,
      error.publicMessage,
      { details: error.details },
    ));
  }

  // Handle validation errors (from express-validator or similar)
  if (error.name === 'ValidationError') {
    return res.status(400).json(errorEnvelope(
      req, 400, 'VALIDATION_ERROR', 'Validation Error', { details: error.message },
    ));
  }

  // Handle database connection errors
  if (error.message.includes('ECONNREFUSED') || error.message.includes('connection')) {
    return res.status(503).json(errorEnvelope(
      req, 503, 'DATABASE_UNAVAILABLE', 'Database connection failed',
    ));
  }

  // Handle JSON parsing errors
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json(errorEnvelope(req, 400, 'INVALID_JSON', 'Invalid JSON format'));
  }

  // Default server error
  res.status(500).json(errorEnvelope(
    req,
    500,
    'INTERNAL_ERROR',
    config.isProduction() ? 'Internal server error' : error.message,
    { stack: config.isProduction() ? undefined : error.stack },
  ));
};

// Async error wrapper to catch async errors in route handlers
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>,
): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
