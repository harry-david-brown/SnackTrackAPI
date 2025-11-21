import { Request, Response, NextFunction } from 'express';
import { sentryConfig } from '../config/sentry';
import { logger, logError } from '../config/logger';

// Custom error classes for different types of errors
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number = 500, isOperational: boolean = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;

    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, field?: string) {
    super(`Validation Error${field ? ` for ${field}` : ''}: ${message}`, 400);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, id?: string) {
    super(`${resource}${id ? ` with ID ${id}` : ''} not found`, 404);
  }
}

export class DatabaseError extends AppError {
  constructor(message: string, originalError?: Error) {
    super(`Database Error: ${message}`, 500);
    if (originalError) {
      this.stack = originalError.stack;
    }
  }
}

export class AuthenticationError extends AppError {
  constructor(message: string = 'Authentication required') {
    super(message, 401);
  }
}

export class AuthorizationError extends AppError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 403);
  }
}

// Error logging utility
export const logErrorToSentry = (error: Error, req?: Request) => {
  const method = req?.method || 'UNKNOWN';
  const url = req?.originalUrl || 'UNKNOWN';
  const userAgent = req?.get('User-Agent') || 'UNKNOWN';
  const ip = req?.ip || req?.connection?.remoteAddress || 'UNKNOWN';

  // Log using Winston logger (only include userId if it exists)
  const logMetadata: any = {
    method,
    url,
    ip,
    userAgent
  };
  const userId = (req as any)?.user?.userId;
  if (userId) {
    logMetadata.userId = userId;
  }
  logError(error, logMetadata);

  // Send to Sentry for production monitoring
  if (sentryConfig.isEnabled()) {
    // Only send 5xx errors to Sentry (not validation errors)
    if (error instanceof AppError && error.statusCode >= 500) {
      sentryConfig.captureError(error, {
        method,
        url,
        userAgent,
        ip,
        statusCode: (error as AppError).statusCode
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
  } else {
    // Log when Sentry is disabled for debugging
    logger.debug('Sentry is disabled, error not sent', {
      errorMessage: error.message,
      hasDSN: !!process.env.SENTRY_DSN
    });
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
    return res.status(error.statusCode).json({
      error: {
        message: error.message,
        statusCode: error.statusCode,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      }
    });
  }

  // Handle validation errors (from express-validator or similar)
  if (error.name === 'ValidationError') {
    return res.status(400).json({
      error: {
        message: 'Validation Error',
        details: error.message,
        statusCode: 400,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      }
    });
  }

  // Handle database connection errors
  if (error.message.includes('ECONNREFUSED') || error.message.includes('connection')) {
    return res.status(503).json({
      error: {
        message: 'Database connection failed',
        statusCode: 503,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      }
    });
  }

  // Handle JSON parsing errors
  if (error instanceof SyntaxError && 'body' in error) {
    return res.status(400).json({
      error: {
        message: 'Invalid JSON format',
        statusCode: 400,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      }
    });
  }

  // Default server error
  res.status(500).json({
    error: {
      message: process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : error.message,
      statusCode: 500,
      timestamp: new Date().toISOString(),
      path: req.originalUrl,
      method: req.method,
      ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
    }
  });
};

// Async error wrapper to catch async errors in route handlers
export const asyncHandler = (fn: Function) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Validation helper
export const validateRequired = (data: any, fields: string[]) => {
  const missing: string[] = [];
  
  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      missing.push(field);
    }
  }

  if (missing.length > 0) {
    throw new ValidationError(`Missing required fields: ${missing.join(', ')}`);
  }
};

// UUID validation helper
export const validateUUID = (uuid: string, fieldName: string = 'ID') => {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uuid)) {
    throw new ValidationError(`Invalid ${fieldName} format`, fieldName);
  }
};
