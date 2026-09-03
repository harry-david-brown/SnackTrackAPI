/**
 * Monitoring Routes
 *
 * Endpoints for system monitoring, health checks, and alerting status
 */

import { Router, Request, RequestHandler, Response } from 'express';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import {
  optionalQueryString,
  parseQueryInteger,
  requireObject,
  requireUuid,
} from '../http/validation/requestValues';
import type { AlertingService } from '../services/monitoring/AlertingService';
import type { CacheService } from '../services/core/CacheService';
import type { MonitoringService } from '../services/monitoring/MonitoringService';

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'] as const;
type LogLevel = (typeof LOG_LEVELS)[number];
const isLogLevel = (value: string): value is LogLevel => LOG_LEVELS.includes(value as LogLevel);

export interface MonitoringRouterDependencies {
  readonly authorizeSensitive: RequestHandler;
  readonly alerting: Pick<AlertingService, 'getHealthStatus'>;
  readonly cache: Pick<CacheService, 'getStats'>;
  readonly monitoring: Pick<
    MonitoringService,
    'getDatabaseOptimizationStatus' | 'getQueryPerformance'
  >;
  readonly logs: {
    getLevel(): string;
    setLevel(level: LogLevel): void;
    getRecent(options: { level?: string; limit?: number; since?: string }): unknown[];
  };
}

export const createMonitoringRouter = (dependencies: MonitoringRouterDependencies): Router => {
  const router = Router();

  /**
   * @swagger
   * /monitoring/health:
   *   get:
   *     summary: Get detailed system health status with alerting metrics
   *     description: Returns health status including alerting metrics and thresholds. Public endpoint for monitoring tools.
   *     tags: [Monitoring]
   *     responses:
   *       200:
   *         description: Health status with metrics
   */
  router.get(
    '/health',
    asyncHandler(async (req: Request, res: Response) => {
      const healthStatus = dependencies.alerting.getHealthStatus();

      res.json({
        status: healthStatus.status,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  /**
   * @swagger
   * /monitoring/alerts:
   *   get:
   *     summary: Get current alerting status
   *     description: Returns current alert metrics and status. Public endpoint for monitoring tools.
   *     tags: [Monitoring]
   *     responses:
   *       200:
   *         description: Alerting status
   */
  router.get(
    '/alerts',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      const healthStatus = dependencies.alerting.getHealthStatus();

      res.json({
        alerts: {
          errorRate: healthStatus.metrics.errorRate > healthStatus.thresholds.errorRate,
          responseTime: healthStatus.metrics.p95ResponseTime > healthStatus.thresholds.responseTime,
          errorCount: healthStatus.metrics.errorCount > healthStatus.thresholds.errorCount,
        },
        metrics: healthStatus.metrics,
        thresholds: healthStatus.thresholds,
      });
    }),
  );

  /**
   * @swagger
   * /monitoring/log-level:
   *   get:
   *     summary: Get current log level
   *     description: Returns the current log level setting
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     responses:
   *       200:
   *         description: Current log level
   */
  router.get(
    '/log-level',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      res.json({
        level: dependencies.logs.getLevel(),
        availableLevels: ['error', 'warn', 'info', 'debug'],
        note: 'Change log level via POST /monitoring/log-level (no restart required)',
      });
    }),
  );

  /**
   * @swagger
   * /monitoring/log-level:
   *   post:
   *     summary: Change log level dynamically
   *     description: Changes the log level at runtime without requiring a server restart
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required:
   *               - level
   *             properties:
   *               level:
   *                 type: string
   *                 enum: [error, warn, info, debug]
   *     responses:
   *       200:
   *         description: Log level changed successfully
   *       400:
   *         description: Invalid log level
   */
  // Sensitive monitoring routes require API key authentication
  router.post(
    '/log-level',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      const { level } = requireObject(req.body as unknown);

      if (typeof level !== 'string' || !isLogLevel(level)) {
        throw new ValidationError('Must be error, warn, info, or debug', 'level');
      }

      const oldLevel = dependencies.logs.getLevel();
      dependencies.logs.setLevel(level);

      res.json({
        success: true,
        oldLevel,
        newLevel: dependencies.logs.getLevel(),
        message: `Log level changed from ${oldLevel} to ${dependencies.logs.getLevel()} (no restart required)`,
      });
    }),
  );

  /**
   * @swagger
   * /monitoring/logs:
   *   get:
   *     summary: Get recent logs from in-memory buffer
   *     description: Returns recent logs from the in-memory buffer (last 1000 entries). For long-term storage, use Better Stack/Logtail.
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     parameters:
   *       - in: query
   *         name: level
   *         schema:
   *           type: string
   *           enum: [error, warn, info, debug]
   *         description: Filter by log level
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 100
   *         description: Maximum number of logs to return
   *       - in: query
   *         name: since
   *         schema:
   *           type: string
   *           format: date-time
   *         description: ISO timestamp - only return logs since this time
   *     responses:
   *       200:
   *         description: Recent logs
   */
  router.get(
    '/logs',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      const level = optionalQueryString(req.query.level, 'level');
      if (level !== undefined && !isLogLevel(level)) {
        throw new ValidationError('Must be error, warn, info, or debug', 'level');
      }
      const limit = parseQueryInteger(req.query.limit, 'limit', {
        defaultValue: 100,
        minimum: 1,
        maximum: 1000,
      })!;
      const since = optionalQueryString(req.query.since, 'since');
      if (since !== undefined && Number.isNaN(new Date(since).getTime())) {
        throw new ValidationError('Must be a valid ISO timestamp', 'since');
      }

      const logs = dependencies.logs.getRecent({ level, limit, since });

      res.json({
        logs,
        count: logs.length,
        maxBufferSize: 1000,
        note: 'This is an in-memory buffer. For long-term storage and search, use Better Stack/Logtail (set LOGTAIL_TOKEN)',
      });
    }),
  );

  /**
   * @swagger
   * /monitoring/cache:
   *   get:
   *     summary: Get Redis cache statistics and performance metrics
   *     description: Returns cache status, hit/miss rates, and performance impact
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     responses:
   *       200:
   *         description: Cache statistics
   */
  router.get(
    '/cache',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      const cacheStats = await dependencies.cache.getStats();

      res.json({
        enabled: cacheStats.enabled,
        stats: cacheStats.stats,
        note: cacheStats.enabled
          ? 'Cache is active. Check response times: cached requests should be faster (<50ms vs 100-500ms uncached)'
          : 'Cache is disabled. Set REDIS_URL to enable caching for better performance.',
      });
    }),
  );

  /**
   * @swagger
   * /monitoring/test-sentry:
   *   get:
   *     summary: Test Sentry error capture
   *     description: Intentionally triggers an error to test Sentry integration. Useful for verifying error tracking is working.
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     responses:
   *       500:
   *         description: Test error (this is expected)
   */
  router.get(
    '/test-sentry',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      // Intentionally throw an error to test Sentry
      throw new Error(
        'Sentry test error - This is intentional to verify error tracking is working',
      );
    }),
  );

  /**
   * @swagger
   * /monitoring/database-optimizations:
   *   get:
   *     summary: Get database optimization status
   *     description: Returns information about database indexes, table sizes, and optimization status
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     responses:
   *       200:
   *         description: Database optimization status
   */
  router.get(
    '/database-optimizations',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await dependencies.monitoring.getDatabaseOptimizationStatus());
    }),
  );

  /**
   * @swagger
   * /monitoring/query-performance:
   *   get:
   *     summary: Test database query performance (bypasses Redis cache)
   *     description: Runs EXPLAIN ANALYZE on common queries to verify index usage and performance
   *     tags: [Monitoring]
   *     security:
   *       - ApiKeyAuth: []
   *     parameters:
   *       - in: query
   *         name: userId
   *         required: false
   *         schema:
   *           type: string
   *         description: User ID to test queries for
   *     responses:
   *       200:
   *         description: Query performance analysis
   */
  router.get(
    '/query-performance',
    dependencies.authorizeSensitive,
    asyncHandler(async (req: Request, res: Response) => {
      const rawUserId = optionalQueryString(req.query.userId, 'userId');
      const userId = rawUserId === undefined ? undefined : requireUuid(rawUserId, 'userId');
      res.json(await dependencies.monitoring.getQueryPerformance(userId));
    }),
  );

  return router;
};
