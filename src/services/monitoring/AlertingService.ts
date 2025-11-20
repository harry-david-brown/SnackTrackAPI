/**
 * Alerting Service
 * 
 * Monitors error rates, performance metrics, and system health
 * Sends alerts when thresholds are exceeded
 * 
 * Features:
 * - Error rate monitoring
 * - Performance degradation alerts
 * - Database health monitoring
 * - Rate limit violation tracking
 */

import { logger } from '../../config/logger';
import { sentryConfig } from '../../config/sentry';
import { PostgresService } from '../data/PostgresService';

interface AlertThresholds {
  errorRate: number; // Errors per minute
  responseTime: number; // p95 response time in ms
  databaseLatency: number; // Database query latency in ms
  errorCount: number; // Total errors in time window
}

interface AlertMetrics {
  errorCount: number;
  requestCount: number;
  errorRate: number;
  avgResponseTime: number;
  p95ResponseTime: number;
  databaseLatency: number;
  timestamp: Date;
}

class AlertingService {
  private errorCount: number = 0;
  private requestCount: number = 0;
  private responseTimes: number[] = [];
  private lastReset: Date = new Date();
  private readonly windowMinutes: number = 5; // 5-minute sliding window
  private readonly thresholds: AlertThresholds = {
    errorRate: 10, // 10 errors per minute
    responseTime: 2000, // 2 seconds p95
    databaseLatency: 1000, // 1 second
    errorCount: 50 // 50 errors in 5-minute window
  };

  constructor(private postgresService: PostgresService) {
    // Reset counters every minute
    setInterval(() => this.resetCounters(), 60000);
    
    // Check alerts every 30 seconds
    setInterval(() => this.checkAlerts(), 30000);
  }

  /**
   * Record an error for monitoring
   */
  recordError(error: Error, context?: Record<string, any>): void {
    this.errorCount++;
    
    // Send to Sentry with alert context
    if (sentryConfig.isEnabled()) {
      sentryConfig.addBreadcrumb('Error recorded', 'alerting', {
        errorMessage: error.message,
        errorCount: this.errorCount,
        ...context
      }, 'error');
    }

    logger.warn('Error recorded for alerting', {
      error: error.message,
      errorCount: this.errorCount,
      ...context
    });
  }

  /**
   * Record a request for performance monitoring
   */
  recordRequest(responseTime: number): void {
    this.requestCount++;
    this.responseTimes.push(responseTime);
    
    // Keep only last 1000 response times for performance
    if (this.responseTimes.length > 1000) {
      this.responseTimes.shift();
    }
  }

  /**
   * Record database query latency
   */
  recordDatabaseLatency(latency: number): void {
    if (latency > this.thresholds.databaseLatency) {
      logger.warn('Database latency threshold exceeded', {
        latency,
        threshold: this.thresholds.databaseLatency
      });
      
      if (sentryConfig.isEnabled()) {
        sentryConfig.addBreadcrumb('Database latency alert', 'performance', {
          latency,
          threshold: this.thresholds.databaseLatency
        }, 'warning');
      }
    }
  }

  /**
   * Check all alert conditions
   */
  private async checkAlerts(): Promise<void> {
    const metrics = this.getMetrics();
    
    // Check error rate
    if (metrics.errorRate > this.thresholds.errorRate) {
      await this.triggerAlert('error_rate', {
        errorRate: metrics.errorRate,
        threshold: this.thresholds.errorRate,
        errorCount: metrics.errorCount,
        requestCount: metrics.requestCount
      });
    }

    // Check response time
    if (metrics.p95ResponseTime > this.thresholds.responseTime) {
      await this.triggerAlert('performance', {
        p95ResponseTime: metrics.p95ResponseTime,
        threshold: this.thresholds.responseTime,
        avgResponseTime: metrics.avgResponseTime
      });
    }

    // Check total error count
    if (metrics.errorCount > this.thresholds.errorCount) {
      await this.triggerAlert('error_count', {
        errorCount: metrics.errorCount,
        threshold: this.thresholds.errorCount,
        windowMinutes: this.windowMinutes
      });
    }

    // Check database health
    try {
      const startTime = Date.now();
      await this.postgresService.query('SELECT 1');
      const latency = Date.now() - startTime;
      
      if (latency > this.thresholds.databaseLatency) {
        await this.triggerAlert('database_latency', {
          latency,
          threshold: this.thresholds.databaseLatency
        });
      }
    } catch (error) {
      await this.triggerAlert('database_health', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Trigger an alert
   */
  private async triggerAlert(type: string, data: Record<string, any>): Promise<void> {
    const alertMessage = `Alert: ${type}`;
    
    logger.error(alertMessage, {
      type,
      ...data,
      timestamp: new Date().toISOString()
    });

    // Send to Sentry as a warning/error
    if (sentryConfig.isEnabled()) {
      sentryConfig.captureError(new Error(alertMessage), {
        alertType: type,
        ...data
      });
    }

    // In production, you could also:
    // - Send email notifications
    // - Send Slack/Discord webhooks
    // - Trigger PagerDuty alerts
    // - Write to alerting system (e.g., Prometheus Alertmanager)
  }

  /**
   * Get current metrics
   */
  private getMetrics(): AlertMetrics {
    const now = new Date();
    const minutesSinceReset = (now.getTime() - this.lastReset.getTime()) / 60000;
    const errorRate = minutesSinceReset > 0 ? this.errorCount / minutesSinceReset : 0;

    // Calculate p95 response time
    const sortedTimes = [...this.responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedTimes.length * 0.95);
    const p95ResponseTime = sortedTimes.length > 0 ? sortedTimes[p95Index] : 0;
    const avgResponseTime = sortedTimes.length > 0 
      ? sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length 
      : 0;

    return {
      errorCount: this.errorCount,
      requestCount: this.requestCount,
      errorRate,
      avgResponseTime,
      p95ResponseTime,
      databaseLatency: 0, // Will be checked separately
      timestamp: now
    };
  }

  /**
   * Reset counters periodically
   */
  private resetCounters(): void {
    // Keep some history for sliding window
    const minutesSinceReset = (Date.now() - this.lastReset.getTime()) / 60000;
    
    if (minutesSinceReset >= this.windowMinutes) {
      this.errorCount = 0;
      this.requestCount = 0;
      this.responseTimes = [];
      this.lastReset = new Date();
      
      logger.debug('Alerting counters reset', {
        windowMinutes: this.windowMinutes
      });
    }
  }

  /**
   * Get current health status
   */
  getHealthStatus(): {
    status: 'healthy' | 'degraded' | 'unhealthy';
    metrics: AlertMetrics;
    thresholds: AlertThresholds;
  } {
    const metrics = this.getMetrics();
    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

    if (
      metrics.errorRate > this.thresholds.errorRate ||
      metrics.errorCount > this.thresholds.errorCount
    ) {
      status = 'unhealthy';
    } else if (
      metrics.p95ResponseTime > this.thresholds.responseTime * 0.8
    ) {
      status = 'degraded';
    }

    return {
      status,
      metrics,
      thresholds: this.thresholds
    };
  }
}

// Export singleton instance (will be initialized in ServiceContainer)
export { AlertingService };

