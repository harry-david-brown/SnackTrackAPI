import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import slowDown from 'express-slow-down';
import helmet from 'helmet';
import cors from 'cors';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config/AppConfig';
import { logger } from '../config/logger';
import { buildErrorEnvelopeV1 } from '../http/errors/errorEnvelope';

const sendRateLimitError = (
  req: Request,
  res: Response,
  message: string,
  retryAfter: number,
  details?: Readonly<Record<string, unknown>>,
) =>
  res.status(429).json(
    buildErrorEnvelopeV1(req, 429, 'RATE_LIMIT_EXCEEDED', message, {
      details: { retryAfter, ...details },
    }),
  );

// Rate limiting configurations
const createRateLimit = (windowMs: number, max: number, message?: string) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      error: {
        message: message || 'Too many requests, please try again later',
        statusCode: 429,
        timestamp: new Date().toISOString(),
      },
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: (req: Request, res: Response) => {
      sendRateLimitError(
        req,
        res,
        message || 'Too many requests, please try again later',
        Math.round(windowMs / 1000),
      );
    },
  });
};

// Slow down configuration for progressive delays
const createSlowDown = (windowMs: number, delayAfter: number, delayMs: number) => {
  return slowDown({
    windowMs,
    delayAfter,
    delayMs: () => delayMs, // express-slow-down v3 requires a function
    maxDelayMs: 5000, // Maximum delay of 5 seconds
    skipSuccessfulRequests: true, // Don't slow down successful requests
    skipFailedRequests: false, // Do slow down failed requests
  });
};

// General API rate limiting (viral app friendly)
// Using production-level limits for realistic testing and deployment
export const apiRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  10000, // 10,000 requests per 5 minutes (production-ready)
  'API rate limit exceeded. Please slow down your requests.',
);

// Rate limiting for user creation (viral app friendly)
// Using production-level limits
export const userCreationRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  1000, // 1000 user creations per 5 minutes (production-ready)
  'Too many user creation attempts. Please wait before creating another user.',
);

// Rate limiting for CSV/ZIP imports (viral-friendly with retry support)
// Per-user rate limiting to allow retries but prevent abuse
// Using production-level limits
export const csvImportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute window
  max: 20, // 20 uploads per 15min (allows retries, prevents abuse)
  message: {
    error: {
      message: 'Too many upload attempts. Please wait a few minutes before trying again.',
      statusCode: 429,
      timestamp: new Date().toISOString(),
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use user ID from token for rate limiting if available, otherwise IP
  keyGenerator: (req: Request) => {
    // If user is authenticated, rate limit by userId (more fair)
    if (req.user?.userId) {
      return `upload_${req.user.userId}`;
    }
    // Use the default IP-based key generator (handles IPv6 properly)
    return ipKeyGenerator(req.ip ?? '127.0.0.1');
  },
  handler: (req: Request, res: Response) => {
    sendRateLimitError(
      req,
      res,
      'Too many upload attempts. Please wait a few minutes and try again.',
      900,
      {
        hint: 'You can retry in 15 minutes. Make sure you are uploading a valid provider data file.',
      },
    );
  },
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/' || req.path === '/health';
  },
});

// Rate limiting for email operations (external API calls - most restrictive)
// Using production-level limits
export const emailOperationRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  500, // 500 email operations per 5 minutes (production-ready)
  'Too many email operations. Please wait before trying again.',
);

// Rate limiting for password reset requests
// 3 per hour per email, 10 per hour per IP
export const passwordResetRequestRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per window
  keyGenerator: (req: Request) => {
    // Rate limit by email if provided, otherwise by IP
    const body: unknown = req.body;
    const email =
      typeof body === 'object' && body !== null && 'email' in body ? body.email : undefined;
    return typeof email === 'string' && email.length > 0
      ? `pwreset:${email.toLowerCase().trim()}`
      : ipKeyGenerator(req.ip ?? '127.0.0.1');
  },
  message: {
    error: {
      message: 'Too many password reset requests. Please try again later.',
      statusCode: 429,
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    sendRateLimitError(req, res, 'Too many password reset requests. Please try again later.', 3600);
  },
});

// IP-based rate limit for password reset (10 per hour per IP)
export const passwordResetIPRateLimit = createRateLimit(
  60 * 60 * 1000, // 1 hour
  10, // 10 requests per hour per IP
  'Too many password reset requests from your IP. Please try again later.',
);

// Rate limiting for email verification send
// 3 per hour per email
export const emailVerificationSendRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // 3 requests per window
  keyGenerator: (req: Request) => {
    const body: unknown = req.body;
    const email =
      typeof body === 'object' && body !== null && 'email' in body ? body.email : undefined;
    return typeof email === 'string' && email.length > 0
      ? `emailverify:${email.toLowerCase().trim()}`
      : ipKeyGenerator(req.ip ?? '127.0.0.1');
  },
  message: {
    error: {
      message: 'Too many verification requests. Please try again later.',
      statusCode: 429,
    },
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    sendRateLimitError(req, res, 'Too many verification requests. Please try again later.', 3600);
  },
});

// Rate limiting for OTP verification attempts (max 5 per code)
// This is handled in the OTP service, but we can add IP-based rate limiting here too
export const otpVerificationRateLimit = createRateLimit(
  15 * 60 * 1000, // 15 minutes
  10, // 10 verification attempts per 15 minutes per IP
  'Too many verification attempts. Please try again later.',
);

// Progressive slow down for repeated failed requests
export const progressiveSlowDown = createSlowDown(
  15 * 60 * 1000, // 15 minutes
  5, // After 5 failed requests
  500, // Add 500ms delay per additional request
);

// Security headers configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Disable for API
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' },
  hidePoweredBy: true,
});

// CORS configuration
export const corsConfig = cors({
  origin: config.isProduction() ? [...config.getSecurityConfig().corsOrigins] : true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200,
});

// Request size limiting middleware
export const requestSizeLimit = (req: Request, res: Response, next: NextFunction) => {
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSize = config.isProduction() ? 10 * 1024 * 1024 : 50 * 1024 * 1024; // 10MB in prod, 50MB in dev

  if (contentLength > maxSize) {
    return res.status(413).json(
      buildErrorEnvelopeV1(req, 413, 'PAYLOAD_TOO_LARGE', 'Request entity too large', {
        details: { maxSizeMb: maxSize / (1024 * 1024) },
      }),
    );
  }

  next();
};

// IP whitelist middleware (for admin endpoints)
export const ipWhitelist = (allowedIPs: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;

    if (!allowedIPs.includes(clientIP || '')) {
      return res
        .status(403)
        .json(
          buildErrorEnvelopeV1(
            req,
            403,
            'AUTHORIZATION_DENIED',
            'Access denied: IP not whitelisted',
          ),
        );
    }

    next();
  };
};

// API key validation middleware (for sensitive endpoints)
export const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.get('X-API-Key') || req.query.apiKey;
  const validApiKey = config.getSecurityConfig().apiKey;

  if (!validApiKey) {
    logger.error('Protected administrator endpoint is unavailable', {
      operation: 'validate_api_key',
      outcome: 'configuration_error',
      errorCode: 'CONFIGURATION_ERROR',
    });
    return res
      .status(500)
      .json(
        buildErrorEnvelopeV1(
          req,
          500,
          'CONFIGURATION_ERROR',
          'Administrator access is not configured',
        ),
      );
  }

  if (!apiKey || apiKey !== validApiKey) {
    return res
      .status(401)
      .json(
        buildErrorEnvelopeV1(req, 401, 'AUTHENTICATION_REQUIRED', 'Invalid or missing API key'),
      );
  }

  next();
};

// Request logging middleware for security monitoring
export const securityLogger = (req: Request, res: Response, next: NextFunction) => {
  const start = Date.now();
  const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
  const userAgent = req.get('User-Agent') || 'Unknown';

  // Log suspicious activity
  const suspiciousPatterns = [
    /\.\./, // Path traversal
    /<script/i, // XSS attempts
    /union.*select/i, // SQL injection
    /eval\(/i, // Code injection
    /javascript:/i, // JavaScript injection
  ];

  const requestString = `${req.method} ${req.originalUrl} ${JSON.stringify(req.body)}`;
  const isSuspicious = suspiciousPatterns.some((pattern) => pattern.test(requestString));

  if (isSuspicious) {
    logger.warn('Suspicious request detected', {
      requestId: req.requestId,
      ip: clientIP,
      method: req.method,
      url: req.originalUrl || req.url,
      userAgent,
      bodyPresent: req.body !== undefined,
      pattern: suspiciousPatterns.find((p) => p.test(requestString))?.toString(),
    });
  }

  // Log response time for slow or failed requests (consolidated with main request logger)
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;

    // Only log if it's a security concern (very slow or error)
    if (statusCode >= 500 || duration > 5000) {
      logger.warn('Security event', {
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode,
        durationMs: duration,
        outcome: statusCode >= 500 ? 'failure' : 'slow',
        ip: clientIP,
      });
    }
  });

  next();
};
