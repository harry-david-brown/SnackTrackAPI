/**
 * Human-Readable Structured Logging Configuration
 * 
 * CENTRALIZED LOGGING SYSTEM:
 * - All application logs go through Winston logger
 * - Console output: Human-readable, scannable format
 * - In-memory buffer: Last 1000 logs (queryable via API)
 * - Log aggregation: Better Stack/Logtail (recommended for 30-day retention)
 * 
 * DYNAMIC ZOOM LEVELS (no restart required):
 * - Change via API: POST /monitoring/log-level { "level": "debug" }
 * - info (default): Essential information, clean and scannable
 * - debug: Full details including IP, user agent, stack traces, all metadata
 * 
 * STORAGE:
 * - Console: Human-readable for real-time monitoring (Railway captures this)
 * - In-memory buffer: Last 1000 logs, queryable via GET /monitoring/logs
 * - Better Stack/Logtail: Recommended for long-term storage (30+ days, searchable)
 */

import winston from 'winston';
import { config } from './AppConfig';

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

// Dynamic log level (can be changed at runtime without restart)
let currentLogLevel: string = (() => {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL.toLowerCase();
  }
  return 'info';
})();

// Get current log level
export const getLogLevel = (): string => {
  return currentLogLevel;
};

// Set log level dynamically (no restart required)
export const setLogLevel = (level: string): void => {
  const validLevels = ['error', 'warn', 'info', 'debug'];
  const normalizedLevel = level.toLowerCase();
  
  if (!validLevels.includes(normalizedLevel)) {
    throw new Error(`Invalid log level: ${level}. Must be one of: ${validLevels.join(', ')}`);
  }
  
  currentLogLevel = normalizedLevel;
  logger.level = normalizedLevel;
  
  // Update all transports
  logger.transports.forEach(transport => {
    if (transport.level !== undefined) {
      transport.level = normalizedLevel;
    }
  });
  
  logger.info('Log level changed', { 
    oldLevel: currentLogLevel, 
    newLevel: normalizedLevel 
  });
};

// Human-readable format with zoom levels
const humanReadableFormat = printf((info: any) => {
  const { level, message, timestamp, ...metadata } = info;
  // Use shorter time format: HH:MM:SS instead of full ISO
  let time = timestamp || new Date().toISOString();
  if (time.includes('T')) {
    time = time.split('T')[1]?.split('.')[0] || time.substring(11, 19);
  } else if (time.length > 8) {
    // Handle "YYYY-MM-DD HH:mm:ss" format
    time = time.split(' ')[1] || time.substring(11, 19);
  }
  // Ensure we have HH:MM:SS format
  if (!time.match(/^\d{2}:\d{2}:\d{2}$/)) {
    const now = new Date();
    time = now.toTimeString().split(' ')[0];
  }
  const levelUpper = String(level || 'INFO').toUpperCase().padEnd(5);
  const msg = String(message || '');
  
  // Color codes for terminal (removed in production for Railway)
  const colors: Record<string, string> = {
    error: '\x1b[31m', // Red
    warn: '\x1b[33m',  // Yellow
    info: '\x1b[36m',  // Cyan
    debug: '\x1b[90m', // Gray
    reset: '\x1b[0m'
  };
  
  const color = config.isDevelopment() ? colors[level] || '' : '';
  const reset = config.isDevelopment() ? colors.reset : '';
  
  // Format based on message type and log level
  let output = '';
  
  // ERROR: Clean, elegant format
  if (level === 'error') {
    // Format: "HH:MM:SS  ✗  message  | context"
    const errorSymbol = config.isDevelopment() ? '\x1b[31m✗\x1b[0m' : '✗';
    
    // Show error message prominently (one line)
    let errorMsg = msg;
    if (metadata.message) {
      const actualError = String(metadata.message);
      // If msg is generic like "Error occurred", use the actual error message
      if (msg === 'Error occurred' || msg === 'Error' || msg === '') {
        errorMsg = actualError.length > 100 ? actualError.substring(0, 100) + '...' : actualError;
      } else {
        errorMsg = `${msg}  ${actualError.length > 80 ? actualError.substring(0, 80) + '...' : actualError}`;
      }
      delete metadata.message;
    }
    
    output = `${time}  ${errorSymbol}  ${errorMsg}`;
    
    // Show key context fields inline (only important ones, no stack, no undefined/null values)
    const keyFields = ['method', 'url', 'statusCode'];
    const context: string[] = [];
    keyFields.forEach(field => {
      const value = metadata[field];
      // Filter out undefined, null, and string 'undefined'/'null'
      const valueStr = String(value);
      if (value !== undefined && value !== null && 
          valueStr !== 'undefined' && valueStr !== 'null' && valueStr.trim() !== '') {
        context.push(`${field}=${value}`);
        delete metadata[field];
      }
    });
    if (context.length > 0) {
      output += `  |  ${context.join(' ')}`;
    }
    
    // Stack trace only in debug mode (and only first line)
    if (metadata.stack && getLogLevel() === 'debug') {
      const stack = String(metadata.stack);
      const firstLine = stack.split('\n')[0];
      output += `\n  ${firstLine}`;
      delete metadata.stack;
    } else {
      // Remove stack from metadata if not in debug mode
      delete metadata.stack;
    }
    
    // Remove undefined/null values and internal fields
    const cleaned = Object.fromEntries(
      Object.entries(metadata).filter(([k, v]) => 
        v !== undefined && 
        v !== 'undefined' && 
        v !== null &&
        !['service', 'environment', 'userAgent', 'ip', 'userId'].includes(k)
      )
    );
    
    // Other metadata only in debug mode (as key=value, not JSON)
    if (Object.keys(cleaned).length > 0 && getLogLevel() === 'debug') {
      const pairs = Object.entries(cleaned).map(([k, v]) => {
        const val = String(v);
        return `${k}=${val.length > 50 ? val.substring(0, 50) + '...' : val}`;
      }).join(' ');
      output += ` | ${pairs}`;
    }
    
    return output;
  }
  
  // WARN: Show key information
  if (level === 'warn') {
    const warnPrefix = config.isDevelopment() ? '\x1b[33m⚠\x1b[0m' : '⚠';
    output = `${time}  ${warnPrefix}  ${msg}`;
    const keyFields = ['url', 'responseTime', 'latency', 'threshold', 'errorCount'];
    const relevant: Record<string, any> = {};
    keyFields.forEach(field => {
      if (metadata[field] !== undefined) relevant[field] = metadata[field];
    });
    if (Object.keys(relevant).length > 0) {
      output += `  |  ${Object.entries(relevant).map(([k, v]) => `${k}=${v}`).join(' ')}`;
    }
    // Show other fields if in debug mode
    const other = Object.fromEntries(Object.entries(metadata).filter(([k]) => !keyFields.includes(k)));
    if (Object.keys(other).length > 0 && getLogLevel() === 'debug') {
      const otherStr = JSON.stringify(other, null, 2);
      output += `\n  ${otherStr.split('\n').join('\n  ')}`;
    }
    return output;
  }
  
  // HTTP REQUESTS: Clean, elegant format
  if (msg === 'HTTP Request' || msg.includes('HTTP')) {
    const method = String(metadata.method || '').padEnd(6);
    const status = Number(metadata.statusCode) || 0;
    const url = String(metadata.url || '').substring(0, 50);
    const respTime = metadata.responseTime ? `${String(metadata.responseTime).padStart(4)}ms` : '';
    const userId = metadata.userId ? ` user=${String(metadata.userId).substring(0, 8)}...` : '';
    
    // Status code color coding
    let statusColor = '';
    let statusReset = '';
    if (config.isDevelopment()) {
      if (status >= 500) statusColor = '\x1b[31m'; // Red for 5xx
      else if (status >= 400) statusColor = '\x1b[33m'; // Yellow for 4xx
      else if (status >= 300) statusColor = '\x1b[36m'; // Cyan for 3xx
      else statusColor = '\x1b[32m'; // Green for 2xx
      statusReset = '\x1b[0m';
    }
    
    // Summary level: Just method, status, URL, time
    if (getLogLevel() === 'warn' || getLogLevel() === 'error') {
      // Only log errors and warnings for requests
      if (status >= 400) {
        return `${time}  ${method}${statusColor}${status}${statusReset}  ${url}${respTime ? `  ${respTime}` : ''}`;
      }
      return ''; // Skip normal requests at warn/error level
    }
    
    // Info level: Clean, aligned format - time, method, status, URL, response time
    // Format: "HH:MM:SS  METHOD  STATUS  URL  TIME"
    output = `${time}  ${method}${statusColor}${status}${statusReset}  ${url}${respTime ? `  ${respTime}` : ''}${userId}`;
    
    // Debug level: Add IP, user agent on same line
    if (getLogLevel() === 'debug') {
      const details: string[] = [];
      if (metadata.ip) details.push(`ip=${String(metadata.ip)}`);
      if (metadata.userAgent) {
        const ua = String(metadata.userAgent);
        details.push(`ua=${ua.substring(0, 40)}`);
      }
      // Only show other metadata if there's something unusual (not service/environment)
      const filteredMeta = Object.fromEntries(
        Object.entries(metadata).filter(([k]) => 
          !['method', 'statusCode', 'url', 'responseTime', 'userId', 'ip', 'userAgent', 'service', 'environment'].includes(k)
        )
      );
      if (Object.keys(filteredMeta).length > 0) {
        // Show as key=value pairs, not JSON
        details.push(...Object.entries(filteredMeta).map(([k, v]) => {
          const val = String(v);
          return `${k}=${val.length > 30 ? val.substring(0, 30) + '...' : val}`;
        }));
      }
      if (details.length > 0) {
        output += `  |  ${details.join(' ')}`;
      }
    }
    // At info level, return output WITHOUT IP/UA - they're filtered out
    return output;
  }
  
  // OTHER MESSAGES: Structured format (no JSON dumps)
  output = `${time}  ${msg}`;
  
  // Info level: Show key fields inline as key=value pairs (but NOT IP/UA for HTTP-like messages)
  if (getLogLevel() === 'info' && Object.keys(metadata).length > 0) {
    // Filter out internal metadata AND IP/UA (they're too verbose for info level)
    const filtered = Object.fromEntries(
      Object.entries(metadata).filter(([k]) => 
        !['service', 'environment', 'stack', 'ip', 'userAgent'].includes(k)
      )
    );
    const keyFields = Object.keys(filtered).slice(0, 3); // First 3 fields
    const inline = keyFields.map(k => `${k}=${filtered[k]}`).join(' ');
    if (inline) output += `  |  ${inline}`;
    
    // Show remaining fields in debug mode (as key=value, not JSON)
    const remaining = Object.fromEntries(
      Object.entries(filtered).filter(([k]) => !keyFields.includes(k))
    );
    if (Object.keys(remaining).length > 0 && getLogLevel() === 'debug') {
      const remainingPairs = Object.entries(remaining).map(([k, v]) => `${k}=${v}`).join(' ');
      output += `  |  ${remainingPairs}`;
    }
  } else if (getLogLevel() === 'debug' && Object.keys(metadata).length > 0) {
    // Debug level: Show all metadata as key=value pairs (not JSON), including IP/UA
    const filtered = Object.fromEntries(
      Object.entries(metadata).filter(([k]) => !['service', 'environment'].includes(k))
    );
    if (Object.keys(filtered).length > 0) {
      const pairs = Object.entries(filtered).map(([k, v]) => {
        // Truncate long values
        const val = String(v);
        return `${k}=${val.length > 50 ? val.substring(0, 50) + '...' : val}`;
      }).join(' ');
      output += `  |  ${pairs}`;
    }
  }
  
  return output;
});

// In-memory log buffer for recent logs (queryable via API)
// Stores last 1000 log entries for quick access without external services
const logBuffer: Array<{
  timestamp: string;
  level: string;
  message: string;
  metadata?: any;
}> = [];
const MAX_BUFFER_SIZE = 1000;

// Custom format to capture logs in memory buffer
// This will be added to the console transport format
const memoryCaptureFormat = winston.format((info) => {
  // Capture log entry in buffer
  logBuffer.push({
    timestamp: String(info.timestamp || new Date().toISOString()),
    level: String(info.level || 'info'),
    message: String(info.message || ''),
    metadata: info
  });
  
  // Keep buffer size manageable
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift(); // Remove oldest entry
  }
  
  // Return info to continue with normal logging
  return info;
});

// Create Winston logger instance
export const logger = winston.createLogger({
  level: getLogLevel(),
  // Don't set default format here - each transport will have its own format
  defaultMeta: {
    service: 'snack-track-api',
    environment: config.isProduction() ? 'production' : 'development',
    ...(process.env.RAILWAY_ENVIRONMENT && {
      railwayEnvironment: process.env.RAILWAY_ENVIRONMENT,
      railwayServiceId: process.env.RAILWAY_SERVICE_ID
    })
  },
  transports: [
    // Console transport - ALWAYS human-readable format (clean, scannable)
    new winston.transports.Console({
      format: combine(
        memoryCaptureFormat(), // Capture logs in memory buffer (must be first)
        errors({ stack: true }), // Capture stack traces
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        // Remove default metadata from console output for cleaner logs
        winston.format((info) => {
          const { service, environment, railwayEnvironment, railwayServiceId, ...rest } = info;
          return rest;
        })(),
        config.isDevelopment() ? colorize() : winston.format((info) => info)(), // Color only in dev
        humanReadableFormat // Human-readable format for console
      ),
      handleExceptions: true,
      handleRejections: true
    })
  ],
  exceptionHandlers: [
    new winston.transports.Console({
      format: combine(
        errors({ stack: true }),
        timestamp({ format: 'HH:mm:ss' }),
        config.isDevelopment() ? colorize() : winston.format((info) => info)(),
        humanReadableFormat
      )
    })
  ],
  rejectionHandlers: [
    new winston.transports.Console({
      format: combine(
        errors({ stack: true }),
        timestamp({ format: 'HH:mm:ss' }),
        config.isDevelopment() ? colorize() : winston.format((info) => info)(),
        humanReadableFormat
      )
    })
  ]
});

// Export function to query log buffer
export const getRecentLogs = (options?: {
  level?: string;
  limit?: number;
  since?: string; // ISO timestamp
}): Array<any> => {
  let filtered = [...logBuffer];
  
  if (options?.level) {
    filtered = filtered.filter(log => log.level === options.level);
  }
  
  if (options?.since) {
    const sinceTime = new Date(options.since).getTime();
    filtered = filtered.filter(log => {
      const logTime = new Date(log.timestamp).getTime();
      return logTime >= sinceTime;
    });
  }
  
  const limit = options?.limit || 100;
  return filtered.slice(-limit).reverse(); // Most recent first
};

// Add Better Stack/Logtail transport (optional - sends JSON for aggregation)
const logtailToken = process.env.LOGTAIL_TOKEN;
if (logtailToken) {
  try {
    const { Logtail } = require('@logtail/node');
    const { LogtailTransport } = require('@logtail/winston');
    
    const logtail = new Logtail(logtailToken);
    logger.add(new LogtailTransport(logtail, {
      level: getLogLevel(),
      format: combine(
        timestamp(),
        json() // JSON format for Better Stack
      )
    }));
    
    logger.info('Better Stack logging enabled');
  } catch (error) {
    // Logtail not available, continue without it
  }
}

// Helper methods for common logging patterns
export const logRequest = (req: any, res: any, responseTime?: number) => {
  // Only log requests at info level or below
  // At warn/error level, only log errors (handled separately)
  if (getLogLevel() === 'warn' || getLogLevel() === 'error') {
    if (res.statusCode >= 400) {
      logger.warn('HTTP Request', {
        method: req.method,
        url: req.originalUrl || req.url,
        statusCode: res.statusCode,
        responseTime: responseTime,
        ip: req.ip || req.connection?.remoteAddress,
        userId: (req as any).user?.userId
      });
    }
    return;
  }
  
  logger.info('HTTP Request', {
    method: req.method,
    url: req.originalUrl || req.url,
    statusCode: res.statusCode,
    responseTime: responseTime,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('user-agent'),
    userId: (req as any).user?.userId
  });
};

export const logError = (error: Error, context?: Record<string, any>) => {
  logger.error('Error occurred', {
    message: error.message,
    stack: error.stack,
    ...context
  });
};

export const logDatabaseQuery = (query: string, duration?: number, params?: any[]) => {
  if (getLogLevel() === 'debug') {
    logger.debug('Database Query', {
      query: query.substring(0, 200),
      duration: duration,
      params: params ? params.map(p => typeof p === 'string' ? p.substring(0, 50) : p) : undefined
    });
  }
};

export const logCacheOperation = (operation: string, key: string, hit?: boolean) => {
  if (getLogLevel() === 'debug') {
    logger.debug('Cache Operation', {
      operation,
      key,
      hit
    });
  }
};

// Export logger instance
export default logger;
