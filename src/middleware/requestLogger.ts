/**
 * Request Logging Middleware
 * 
 * Logs all HTTP requests with structured logging
 * Integrates with Sentry for breadcrumbs
 * Tracks response times for performance monitoring
 * Records metrics for alerting service
 */

import { Request, Response, NextFunction } from 'express';
import { logger, logRequest } from '../config/logger';
import { sentryConfig } from '../config/sentry';
import { container } from '../services/core/ServiceContainer';

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const startTime = Date.now();

  // Add breadcrumb to Sentry
  if (sentryConfig.isEnabled()) {
    sentryConfig.addBreadcrumb('HTTP Request', 'http', {
      method: req.method,
      url: req.originalUrl || req.url,
      ip: req.ip || req.connection?.remoteAddress
    });
  }

  // Log response when finished
  res.on('finish', () => {
    const responseTime = Date.now() - startTime;
    logRequest(req, res, responseTime);

    // Record metrics for alerting
    try {
      const alertingService = container.alertingService;
      alertingService.recordRequest(responseTime);
      
      // Record errors for alerting
      if (res.statusCode >= 500) {
        alertingService.recordError(
          new Error(`HTTP ${res.statusCode}: ${req.method} ${req.originalUrl || req.url}`),
          {
            statusCode: res.statusCode,
            method: req.method,
            url: req.originalUrl || req.url
          }
        );
      }
    } catch (error) {
      // Don't fail request if alerting service has issues
      logger.debug('Failed to record request metrics', { error: error instanceof Error ? error.message : String(error) });
    }

    // Log slow requests (only if above threshold)
    if (responseTime > 1000) {
      logger.warn('Slow request', {
        method: req.method,
        url: req.originalUrl || req.url,
        responseTime: responseTime,
        statusCode: res.statusCode,
        threshold: 1000
      });
    }
  });

  next();
};

