import rateLimit from 'express-rate-limit';
import slowDown from 'express-slow-down';
import helmet from 'helmet';
import cors from 'cors';
import { Request, Response, NextFunction } from 'express';
import { config } from '../config/AppConfig';

// Rate limiting configurations
const createRateLimit = (windowMs: number, max: number, message?: string) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      error: {
        message: message || 'Too many requests, please try again later',
        statusCode: 429,
        timestamp: new Date().toISOString()
      }
    },
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        error: {
          message: message || 'Too many requests, please try again later',
          statusCode: 429,
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
          method: req.method,
          retryAfter: Math.round(windowMs / 1000)
        }
      });
    }
  });
};

// Slow down configuration for progressive delays
const createSlowDown = (windowMs: number, delayAfter: number, delayMs: number) => {
  return slowDown({
    windowMs,
    delayAfter,
    delayMs,
    maxDelayMs: 5000, // Maximum delay of 5 seconds
    skipSuccessfulRequests: true, // Don't slow down successful requests
    skipFailedRequests: false // Do slow down failed requests
  });
};

// General API rate limiting (viral app friendly)
export const apiRateLimit = createRateLimit(
  config.isProduction() ? 5 * 60 * 1000 : 60 * 1000, // 5 minutes in prod, 1 minute in dev
  config.isProduction() ? 10000 : 1000, // 10,000 requests per 5 minutes in prod, 1000 in dev
  'API rate limit exceeded. Please slow down your requests.'
);

// Rate limiting for user creation (viral app friendly)
export const userCreationRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  config.isProduction() ? 1000 : 50, // 1000 user creations per 5 minutes in prod, 50 in dev
  'Too many user creation attempts. Please wait before creating another user.'
);

// Rate limiting for CSV/ZIP imports (viral-friendly with retry support)
// Per-user rate limiting to allow retries but prevent abuse
export const csvImportRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minute window
  max: config.isProduction() ? 20 : 100, // 20 uploads per 15min in prod (allows retries), 100 in dev
  message: {
    error: {
      message: 'Too many upload attempts. Please wait a few minutes before trying again.',
      statusCode: 429,
      timestamp: new Date().toISOString()
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  // Use user ID from token for rate limiting if available, otherwise IP
  keyGenerator: (req: Request) => {
    // If user is authenticated, rate limit by userId (more fair)
    if (req.user?.userId) {
      return `upload_${req.user.userId}`;
    }
    // Otherwise rate limit by IP
    return req.ip || req.connection.remoteAddress || 'unknown';
  },
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error: {
        message: 'Too many upload attempts. Please wait a few minutes and try again.',
        statusCode: 429,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method,
        retryAfter: 900, // 15 minutes in seconds
        hint: 'You can retry in 15 minutes. Make sure you\'re uploading a valid Uber data file.'
      }
    });
  },
  skip: (req: Request) => {
    // Skip rate limiting for health checks
    return req.path === '/' || req.path === '/health';
  }
});

// Rate limiting for email operations (external API calls - most restrictive)
export const emailOperationRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  config.isProduction() ? 500 : 100, // 500 email operations per 5 minutes in prod, 100 in dev
  'Too many email operations. Please wait before trying again.'
);

// Progressive slow down for repeated failed requests
export const progressiveSlowDown = createSlowDown(
  15 * 60 * 1000, // 15 minutes
  5, // After 5 failed requests
  500 // Add 500ms delay per additional request
);

// Security headers configuration
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
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
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  frameguard: { action: 'deny' },
  hidePoweredBy: true
});

// CORS configuration
export const corsConfig = cors({
  origin: config.isProduction() 
    ? ['https://yourdomain.com'] // Replace with your actual domain
    : true, // Allow all origins in development
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 200
});

// Request size limiting middleware
export const requestSizeLimit = (req: Request, res: Response, next: NextFunction) => {
  const contentLength = parseInt(req.get('Content-Length') || '0');
  const maxSize = config.isProduction() ? 10 * 1024 * 1024 : 50 * 1024 * 1024; // 10MB in prod, 50MB in dev
  
  if (contentLength > maxSize) {
    return res.status(413).json({
      error: {
        message: 'Request entity too large',
        statusCode: 413,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method,
        maxSize: `${maxSize / (1024 * 1024)}MB`
      }
    });
  }
  
  next();
};

// IP whitelist middleware (for admin endpoints)
export const ipWhitelist = (allowedIPs: string[]) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const clientIP = req.ip || req.connection.remoteAddress || req.socket.remoteAddress;
    
    if (!allowedIPs.includes(clientIP || '')) {
      return res.status(403).json({
        error: {
          message: 'Access denied: IP not whitelisted',
          statusCode: 403,
          timestamp: new Date().toISOString(),
          path: req.originalUrl,
          method: req.method
        }
      });
    }
    
    next();
  };
};

// API key validation middleware (for sensitive endpoints)
export const validateApiKey = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = req.get('X-API-Key') || req.query.apiKey;
  const validApiKey = process.env.API_KEY;
  
  if (!validApiKey) {
    console.warn('⚠️ API_KEY environment variable not set - API key validation disabled');
    return next();
  }
  
  if (!apiKey || apiKey !== validApiKey) {
    return res.status(401).json({
      error: {
        message: 'Invalid or missing API key',
        statusCode: 401,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      }
    });
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
    /javascript:/i // JavaScript injection
  ];
  
  const requestString = `${req.method} ${req.originalUrl} ${JSON.stringify(req.body)}`;
  const isSuspicious = suspiciousPatterns.some(pattern => pattern.test(requestString));
  
  if (isSuspicious) {
    console.warn(`
🚨 SUSPICIOUS REQUEST DETECTED
   IP: ${clientIP}
   Method: ${req.method}
   URL: ${req.originalUrl}
   User-Agent: ${userAgent}
   Body: ${JSON.stringify(req.body)}
   Time: ${new Date().toISOString()}
`);
  }
  
  // Log response time
  res.on('finish', () => {
    const duration = Date.now() - start;
    const statusCode = res.statusCode;
    
    if (statusCode >= 400 || duration > 5000) {
      console.log(`📊 ${req.method} ${req.originalUrl} - ${statusCode} - ${duration}ms - IP: ${clientIP}`);
    }
  });
  
  next();
};
