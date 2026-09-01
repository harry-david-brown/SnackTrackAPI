/**
 * Request Logging Middleware
 *
 * Logs all HTTP requests with structured logging
 * Integrates with Sentry for breadcrumbs
 * Tracks response times for performance monitoring
 * Records metrics for alerting service
 */

import { Request, Response, NextFunction } from 'express';
import type { AlertingService } from '../services/monitoring/AlertingService';

export interface RequestLoggerDependencies {
  readonly alerting: Pick<AlertingService, 'recordRequest' | 'recordError'>;
  readonly observability: {
    isSentryEnabled(): boolean;
    addBreadcrumb(message: string, category: string, data: Record<string, unknown>): void;
    logRequest(request: Request, response: Response, durationMs: number): void;
    debug(message: string, metadata: Record<string, unknown>): void;
    warn(message: string, metadata: Record<string, unknown>): void;
  };
  readonly now?: () => number;
}

export const createRequestLogger =
  ({ alerting, observability, now = Date.now }: RequestLoggerDependencies) =>
  (req: Request, res: Response, next: NextFunction) => {
    const startTime = now();

    // Add breadcrumb to Sentry
    if (observability.isSentryEnabled()) {
      observability.addBreadcrumb('HTTP Request', 'http', {
        method: req.method,
        url: req.originalUrl || req.url,
        ip: req.ip || req.connection?.remoteAddress,
      });
    }

    // Log response when finished
    res.on('finish', () => {
      const responseTime = now() - startTime;
      observability.logRequest(req, res, responseTime);

      // Record metrics for alerting
      try {
        alerting.recordRequest(responseTime);

        // Record errors for alerting
        if (res.statusCode >= 500) {
          alerting.recordError(
            new Error(`HTTP ${res.statusCode}: ${req.method} ${req.originalUrl || req.url}`),
            {
              requestId: req.requestId,
              statusCode: res.statusCode,
              method: req.method,
              url: req.originalUrl || req.url,
            },
          );
        }
      } catch (error) {
        // Don't fail request if alerting service has issues
        observability.debug('Failed to record request metrics', {
          requestId: req.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Log slow requests (only if above threshold)
      if (responseTime > 1000) {
        observability.warn('Slow request', {
          requestId: req.requestId,
          method: req.method,
          url: req.originalUrl || req.url,
          durationMs: responseTime,
          statusCode: res.statusCode,
          outcome: 'slow',
          threshold: 1000,
        });
      }
    });

    next();
  };
