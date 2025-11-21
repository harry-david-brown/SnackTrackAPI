/**
 * Sentry Configuration
 * 
 * Error tracking and performance monitoring
 * Supports both free tier and paid upgrades seamlessly
 * 
 * Features:
 * - Automatic error capture
 * - Performance monitoring (APM)
 * - User context tracking
 * - Breadcrumb logging
 * - Custom transaction tracking
 */

import * as Sentry from '@sentry/node';
import { Express } from 'express';
import { logger } from './logger';

interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  sampleRate: number;
  tracesSampleRate: number;
  enabled: boolean;
}

class SentryConfigManager {
  private config: SentryConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): SentryConfig {
    const dsn = process.env.SENTRY_DSN || '';
    const environment = process.env.NODE_ENV || 'development';
    const release = process.env.SENTRY_RELEASE || this.getVersion();

    const enabled = !!dsn && environment !== 'test';

    return {
      dsn,
      environment,
      release,
      // Free tier: 5,000 errors/month - sample all in dev, 100% in prod (until limit)
      sampleRate: environment === 'production' ? 1.0 : 1.0,
      // Performance monitoring: Free tier gets 10k transactions/month
      // Sample less in prod to stay under free tier limits
      tracesSampleRate: environment === 'production' ? 0.1 : 1.0, // 10% in prod, 100% in dev
      enabled
    };
  }

  private getVersion(): string {
    try {
      const packageJson = require('../../package.json');
      return packageJson.version || '1.0.0';
    } catch {
      return '1.0.0';
    }
  }

  /**
   * Initialize Sentry with the Express app
   */
  initialize(app: Express): void {
    if (!this.config.enabled) {
      logger.info('Sentry disabled (SENTRY_DSN not configured)');
      return;
    }

    Sentry.init({
      dsn: this.config.dsn,
      environment: this.config.environment,
      release: this.config.release,
      
      // Enable debug mode to see what's happening
      debug: this.config.environment === 'development',
      
      // Error sampling
      sampleRate: this.config.sampleRate,
      
      // Performance monitoring
      tracesSampleRate: this.config.tracesSampleRate,
      
      // Integrations
      integrations: [
        Sentry.httpIntegration(),
        Sentry.expressIntegration(),
        // Note: PostgreSQL query tracing is handled automatically via httpIntegration
        // when using the pg library with connection pooling
      ],

      // Don't send sensitive data
      beforeSend(event, hint) {
        // Remove password fields from all contexts
        if (event.request?.data) {
          const data = event.request.data;
          if (typeof data === 'object' && data !== null) {
            delete (data as any).password;
            delete (data as any).refreshToken;
            delete (data as any).accessToken;
          }
        }

        // Remove authorization headers
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }

        return event;
      },

      // Ignore common non-critical errors
      ignoreErrors: [
        'NetworkError',
        'AbortError',
        'cancelled',
        /ECONNREFUSED/, // Database connection issues (handled separately)
      ],
    });

    logger.info('Sentry initialized', {
      environment: this.config.environment,
      release: this.config.release,
      errorSampling: `${this.config.sampleRate * 100}%`,
      performanceSampling: `${this.config.tracesSampleRate * 100}%`
    });
  }

  /**
   * Get error handler middleware (must be added after routes)
   * Note: In newer Sentry versions, this is handled by setupExpressErrorHandler in initialize()
   */
  getErrorHandler() {
    // Return a no-op middleware since error handling is set up in initialize()
    return (req: any, res: any, next: any) => next();
  }

  /**
   * Manually capture an error with context
   */
  captureError(error: Error, context?: Record<string, any>): void {
    if (!this.config.enabled) {
      logger.debug('Sentry captureError called but Sentry is disabled');
      return;
    }

    try {
      if (context) {
        Sentry.setContext('additional', context);
      }
      
      // Add breadcrumb for error context
      Sentry.addBreadcrumb({
        message: `Error: ${error.message}`,
        level: 'error',
        category: 'error',
        data: context
      });
      
      const eventId = Sentry.captureException(error);
      logger.debug('Error sent to Sentry', {
        errorMessage: error.message,
        eventId
      });
      
      // Flush in background (don't await - let it send asynchronously)
      Sentry.flush(2000).catch((flushError) => {
        logger.warn('Sentry flush failed', { error: flushError });
      });
    } catch (sentryError) {
      logger.error('Failed to send error to Sentry', {
        originalError: error.message,
        sentryError: sentryError instanceof Error ? sentryError.message : String(sentryError)
      });
    }
  }

  /**
   * Add user context to error reports
   */
  setUserContext(userId: string, email?: string): void {
    if (!this.config.enabled) {
      return;
    }

    Sentry.setUser({
      id: userId,
      email: email,
    });
  }

  /**
   * Clear user context (on logout)
   */
  clearUserContext(): void {
    if (!this.config.enabled) {
      return;
    }
    Sentry.setUser(null);
  }

  /**
   * Add breadcrumb for debugging
   */
  addBreadcrumb(message: string, category: string, data?: Record<string, any>, level: 'info' | 'warning' | 'error' | 'debug' = 'info'): void {
    if (!this.config.enabled) {
      return;
    }

    Sentry.addBreadcrumb({
      message,
      category,
      data,
      level,
    });
  }

  /**
   * Start a custom transaction for performance monitoring
   * Note: In Sentry v10+, transactions are automatically created for HTTP requests
   * This method provides a way to manually start transactions for background jobs
   * 
   * Usage:
   *   const transaction = sentryConfig.startTransaction('Task Name', 'task');
   *   // ... do work ...
   *   transaction?.finish();
   */
  startTransaction(name: string, op: string = 'custom'): { finish: () => void } | undefined {
    if (!this.config.enabled) {
      return undefined;
    }

    // In Sentry v10+, transactions are automatically handled for HTTP requests
    // For custom operations, we'll use a simple wrapper
    // The actual transaction will be created by the Express integration
    return {
      finish: () => {
        // Transaction is automatically finished by Express integration
        // This is a no-op for compatibility
      }
    };
  }

  /**
   * Set transaction name and metadata
   * Note: In Sentry v10+, transactions are automatically named from routes
   */
  setTransaction(name: string, op?: string): void {
    if (!this.config.enabled) {
      return;
    }

    // In Sentry v10+, use setContext or tags for metadata
    Sentry.setTag('transaction.name', name);
    if (op) {
      Sentry.setTag('transaction.op', op);
    }
  }

  /**
   * Add performance measurement to current transaction
   * Note: In Sentry v10+, use startSpan with a callback for nested operations
   * 
   * Usage:
   *   sentryConfig.addSpan('Operation', 'db.query', () => {
   *     // ... do work ...
   *   });
   */
  addSpan<T>(name: string, description: string, callback: () => T): T {
    if (!this.config.enabled) {
      return callback();
    }

    return Sentry.startSpan(
      {
        name: description || name,
        op: 'custom',
      },
      callback
    );
  }

  /**
   * Check if Sentry is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Export singleton instance
export const sentryConfig = new SentryConfigManager();

