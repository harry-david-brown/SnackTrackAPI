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
import { logger, redactLogMetadata, redactLogString } from './logger';
import { config as appConfig } from './AppConfig';

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
    const observability = appConfig.getObservabilityConfig();
    const dsn = observability.sentryDsn || '';
    const environment = appConfig.getEnvironment();
    const release = observability.sentryRelease || this.getVersion();

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
      enabled,
    };
  }

  private getVersion(): string {
    return '1.0.0';
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
          const data: unknown = event.request.data;
          if (typeof data === 'object' && data !== null) {
            const record = data as Record<string, unknown>;
            delete record.password;
            delete record.refreshToken;
            delete record.accessToken;
          }
        }

        // Remove authorization headers
        if (event.request?.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }

        if (event.request) {
          delete event.request.data;
          delete event.request.query_string;
          if (event.request.url) event.request.url = redactLogString(event.request.url);
        }
        return redactLogMetadata(event) as typeof event;
      },
      beforeBreadcrumb(breadcrumb) { return redactLogMetadata(breadcrumb) as typeof breadcrumb; },
      beforeSendTransaction(event) {
        if (event.request) { delete event.request.data; delete event.request.query_string; }
        return redactLogMetadata(event) as typeof event;
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
      performanceSampling: `${this.config.tracesSampleRate * 100}%`,
    });
  }

  /**
   * Manually capture an error with context
   */
  captureError(error: Error, context?: Record<string, unknown>): void {
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
        data: context,
      });

      const eventId = Sentry.captureException(error);
      logger.debug('Error sent to Sentry', {
        errorMessage: error.message,
        eventId,
      });

      // Flush in background (don't await - let it send asynchronously)
      Sentry.flush(2000).catch((flushError: unknown) => {
        logger.warn('Sentry flush failed', { error: flushError });
      });
    } catch (sentryError) {
      logger.error('Failed to send error to Sentry', {
        originalError: error.message,
        sentryError: sentryError instanceof Error ? sentryError.message : String(sentryError),
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
  addBreadcrumb(
    message: string,
    category: string,
    data?: Record<string, unknown>,
    level: 'info' | 'warning' | 'error' | 'debug' = 'info',
  ): void {
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
   * Check if Sentry is enabled
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

// Export singleton instance
export const sentryConfig = new SentryConfigManager();
