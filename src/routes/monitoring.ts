/**
 * Monitoring Routes
 * 
 * Endpoints for system monitoring, health checks, and alerting status
 */

import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler } from '../middleware/errorHandler';
import { getLogLevel, setLogLevel, getRecentLogs } from '../config/logger';
import { cacheService } from '../services/core/CacheService';

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
router.get('/health', asyncHandler(async (req: Request, res: Response) => {
  const alertingService = container.alertingService;
  const healthStatus = alertingService.getHealthStatus();

  res.json({
    status: healthStatus.status,
    timestamp: new Date().toISOString(),
    metrics: {
      ...healthStatus.metrics,
      // Add clarity: all times are in milliseconds
      avgResponseTime: healthStatus.metrics.avgResponseTime, // milliseconds
      p95ResponseTime: healthStatus.metrics.p95ResponseTime, // milliseconds (95th percentile)
      databaseLatency: healthStatus.metrics.databaseLatency // milliseconds
    },
    thresholds: healthStatus.thresholds,
    // Explanation of metrics
    _note: {
      responseTime: "All response times are in milliseconds",
      p95ResponseTime: "95th percentile - 95% of requests are faster than this value",
      errorRate: "Errors per minute",
      errorCount: `Total errors in last ${healthStatus.metrics.timestamp ? '5 minutes' : 'current window'}`
    }
  });
}));

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
router.get('/alerts', asyncHandler(async (req: Request, res: Response) => {
  const alertingService = container.alertingService;
  const healthStatus = alertingService.getHealthStatus();

  res.json({
    alerts: {
      errorRate: healthStatus.metrics.errorRate > healthStatus.thresholds.errorRate,
      responseTime: healthStatus.metrics.p95ResponseTime > healthStatus.thresholds.responseTime,
      errorCount: healthStatus.metrics.errorCount > healthStatus.thresholds.errorCount
    },
    metrics: healthStatus.metrics,
    thresholds: healthStatus.thresholds
  });
}));

/**
 * @swagger
 * /monitoring/log-level:
 *   get:
 *     summary: Get current log level
 *     description: Returns the current log level setting
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Current log level
 */
router.get('/log-level', asyncHandler(async (req: Request, res: Response) => {
  res.json({
    level: getLogLevel(),
    availableLevels: ['error', 'warn', 'info', 'debug'],
    note: 'Change log level via POST /monitoring/log-level (no restart required)'
  });
}));

/**
 * @swagger
 * /monitoring/log-level:
 *   post:
 *     summary: Change log level dynamically
 *     description: Changes the log level at runtime without requiring a server restart
 *     tags: [Monitoring]
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
router.post('/log-level', asyncHandler(async (req: Request, res: Response) => {
  const { level } = req.body;
  
  if (!level) {
    return res.status(400).json({ error: 'Level is required' });
  }
  
  try {
    const oldLevel = getLogLevel();
    setLogLevel(level);
    
    res.json({
      success: true,
      oldLevel,
      newLevel: getLogLevel(),
      message: `Log level changed from ${oldLevel} to ${getLogLevel()} (no restart required)`
    });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid log level',
      availableLevels: ['error', 'warn', 'info', 'debug']
    });
  }
}));

/**
 * @swagger
 * /monitoring/logs:
 *   get:
 *     summary: Get recent logs from in-memory buffer
 *     description: Returns recent logs from the in-memory buffer (last 1000 entries). For long-term storage, use Better Stack/Logtail.
 *     tags: [Monitoring]
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
router.get('/logs', asyncHandler(async (req: Request, res: Response) => {
  const level = req.query.level as string | undefined;
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
  const since = req.query.since as string | undefined;
  
  const logs = getRecentLogs({ level, limit, since });
  
  res.json({
    logs,
    count: logs.length,
    maxBufferSize: 1000,
    note: 'This is an in-memory buffer. For long-term storage and search, use Better Stack/Logtail (set LOGTAIL_TOKEN)'
  });
}));

/**
 * @swagger
 * /monitoring/cache:
 *   get:
 *     summary: Get Redis cache statistics and performance metrics
 *     description: Returns cache status, hit/miss rates, and performance impact
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Cache statistics
 */
router.get('/cache', asyncHandler(async (req: Request, res: Response) => {
  const cacheStats = await cacheService.getStats();
  
  res.json({
    enabled: cacheStats.enabled,
    stats: cacheStats.stats,
    note: cacheStats.enabled 
      ? 'Cache is active. Check response times: cached requests should be faster (<50ms vs 100-500ms uncached)'
      : 'Cache is disabled. Set REDIS_URL to enable caching for better performance.'
  });
}));

/**
 * @swagger
 * /monitoring/test-sentry:
 *   get:
 *     summary: Test Sentry error capture
 *     description: Intentionally triggers an error to test Sentry integration. Useful for verifying error tracking is working.
 *     tags: [Monitoring]
 *     responses:
 *       500:
 *         description: Test error (this is expected)
 */
router.get('/test-sentry', asyncHandler(async (req: Request, res: Response) => {
  // Intentionally throw an error to test Sentry
  throw new Error('Sentry test error - This is intentional to verify error tracking is working');
}));

/**
 * @swagger
 * /monitoring/database-optimizations:
 *   get:
 *     summary: Get database optimization status
 *     description: Returns information about database indexes, table sizes, and optimization status
 *     tags: [Monitoring]
 *     responses:
 *       200:
 *         description: Database optimization status
 */
router.get('/database-optimizations', asyncHandler(async (req: Request, res: Response) => {
  const postgres = container.postgres;

  // Get table sizes
  const tableSizes = await postgres.query(`
    SELECT 
      schemaname,
      tablename,
      pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
      pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
      pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as indexes_size,
      pg_stat_get_live_tuples(c.oid)::bigint as row_count
    FROM pg_tables t
    JOIN pg_class c ON c.relname = t.tablename
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
  `);

  // Get all indexes on receipts table
  const receiptsIndexes = await postgres.query(`
    SELECT 
      indexname,
      indexdef,
      idx_scan as index_scans,
      idx_tup_read as tuples_read,
      idx_tup_fetch as tuples_fetched
    FROM pg_indexes
    LEFT JOIN pg_stat_user_indexes ON pg_indexes.indexname = pg_stat_user_indexes.indexname
    WHERE schemaname = 'public' AND tablename = 'receipts'
    ORDER BY indexname
  `);

  // Check for specific optimization indexes
  const optimizationChecks = await postgres.query(`
    SELECT 
      indexname,
      CASE 
        WHEN indexname LIKE '%items_gin%' THEN 'GIN index on JSONB items'
        WHEN indexname LIKE '%has_date%' THEN 'Partial index for receipts with dates'
        WHEN indexname LIKE '%recent%' THEN 'Partial index for recent receipts'
        WHEN indexname LIKE '%has_restaurant%' THEN 'Partial index for receipts with restaurants'
        WHEN indexname LIKE '%year%' THEN 'Year column index'
        ELSE 'Other index'
      END as optimization_type
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'receipts'
    AND (
      indexname LIKE '%items_gin%' OR
      indexname LIKE '%has_date%' OR
      indexname LIKE '%recent%' OR
      indexname LIKE '%has_restaurant%' OR
      indexname LIKE '%year%'
    )
  `);

  // Check if year column exists
  const yearColumnCheck = await postgres.query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' 
    AND table_name = 'receipts' 
    AND column_name = 'year'
  `);

  // Get index usage statistics
  const indexUsage = await postgres.query(`
    SELECT 
      schemaname,
      tablename,
      indexname,
      idx_scan as index_scans,
      idx_tup_read as tuples_read,
      idx_tup_fetch as tuples_fetched,
      pg_size_pretty(pg_relation_size(indexrelid)) as index_size
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public' AND tablename = 'receipts'
    ORDER BY idx_scan DESC
  `);

  res.json({
    tables: tableSizes.rows.map((row: any) => ({
      name: row.tablename,
      totalSize: row.total_size,
      tableSize: row.table_size,
      indexesSize: row.indexes_size,
      rowCount: parseInt(row.row_count) || 0
    })),
    receiptsIndexes: receiptsIndexes.rows.map((row: any) => ({
      name: row.indexname,
      definition: row.indexdef,
      scans: parseInt(row.index_scans) || 0,
      tuplesRead: parseInt(row.tuples_read) || 0,
      tuplesFetched: parseInt(row.tuples_fetched) || 0
    })),
    optimizations: {
      applied: optimizationChecks.rows.map((row: any) => ({
        index: row.indexname,
        type: row.optimization_type
      })),
      yearColumn: yearColumnCheck.rows.length > 0,
      status: {
        ginIndex: optimizationChecks.rows.some((r: any) => r.indexname.includes('items_gin')),
        partialIndexes: optimizationChecks.rows.some((r: any) => r.indexname.includes('has_date') || r.indexname.includes('recent')),
        yearColumn: yearColumnCheck.rows.length > 0
      }
    },
    indexUsage: indexUsage.rows.map((row: any) => ({
      name: row.indexname,
      scans: parseInt(row.index_scans) || 0,
      tuplesRead: parseInt(row.tuples_read) || 0,
      size: row.index_size
    })),
    _note: {
      ginIndex: "GIN index enables fast searches within JSONB items column",
      partialIndexes: "Partial indexes are smaller and faster for filtered queries",
      yearColumn: "Year column enables future partitioning and archiving strategies"
    }
  });
}));

export default router;

