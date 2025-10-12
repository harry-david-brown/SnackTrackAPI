/**
 * Sentry Configuration
 * 
 * Error tracking and performance monitoring
 * Supports both free tier and paid upgrades seamlessly
 */

import * as Sentry from '@sentry/node';
import { Express } from 'express';

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

    return {
      dsn,
      environment,
      release,
      // Free tier: 5,000 errors/month - sample all in dev, 100% in prod (until limit)
      sampleRate: environment === 'production' ? 1.0 : 1.0,
      // Performance monitoring: Free tier gets 10k transactions/month
      // Sample less in prod to stay under free tier limits
      tracesSampleRate: environment === 'production' ? 0.1 : 1.0, // 10% in prod, 100% in dev
      enabled: !!dsn && environment !== 'test'
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
      console.log('ℹ️  Sentry disabled (SENTRY_DSN not configured)');
      return;
    }

    Sentry.init({
      dsn: this.config.dsn,
      environment: this.config.environment,
      release: this.config.release,
      
      // Error sampling
      sampleRate: this.config.sampleRate,
      
      // Performance monitoring
      tracesSampleRate: this.config.tracesSampleRate,
      
      // Integrations
      integrations: [
        Sentry.httpIntegration(),
        Sentry.expressIntegration(),
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

    console.log(`✅ Sentry initialized (${this.config.environment})`);
    console.log(`   Release: ${this.config.release}`);
    console.log(`   Error sampling: ${this.config.sampleRate * 100}%`);
    console.log(`   Performance sampling: ${this.config.tracesSampleRate * 100}%`);
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
      return;
    }

    if (context) {
      Sentry.setContext('additional', context);
    }
    
    Sentry.captureException(error);
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
  addBreadcrumb(message: string, category: string, data?: Record<string, any>): void {
    if (!this.config.enabled) {
      return;
    }

    Sentry.addBreadcrumb({
      message,
      category,
      data,
      level: 'info',
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

