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
      (SELECT n_live_tup FROM pg_stat_user_tables WHERE schemaname = t.schemaname AND relname = t.tablename) as row_count
    FROM pg_tables t
    WHERE schemaname = 'public'
    ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
  `);

  // Get all indexes on receipts table
  const receiptsIndexes = await postgres.query(`
    SELECT 
      pg_indexes.indexname,
      pg_indexes.indexdef,
      COALESCE(pg_stat_user_indexes.idx_scan, 0) as index_scans,
      COALESCE(pg_stat_user_indexes.idx_tup_read, 0) as tuples_read,
      COALESCE(pg_stat_user_indexes.idx_tup_fetch, 0) as tuples_fetched
    FROM pg_indexes
    LEFT JOIN pg_stat_user_indexes ON pg_indexes.indexname = pg_stat_user_indexes.indexrelname::text
    WHERE pg_indexes.schemaname = 'public' AND pg_indexes.tablename = 'receipts'
    ORDER BY pg_indexes.indexname
  `);

  // Check for specific optimization indexes
  const optimizationChecks = await postgres.query(`
    SELECT 
      indexname,
      CASE 
        WHEN indexname LIKE '%items_gin%' THEN 'GIN index on JSONB items'
        WHEN indexname LIKE '%year%' THEN 'Year column index'
        ELSE 'Other index'
      END as optimization_type
    FROM pg_indexes
    WHERE schemaname = 'public' AND tablename = 'receipts'
    AND (
      indexname LIKE '%items_gin%' OR
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
      relname as tablename,
      indexrelname as indexname,
      idx_scan as index_scans,
      idx_tup_read as tuples_read,
      idx_tup_fetch as tuples_fetched,
      pg_size_pretty(pg_relation_size(indexrelid)) as index_size
    FROM pg_stat_user_indexes
    WHERE schemaname = 'public' AND relname = 'receipts'
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
      yearColumn: "Year column enables future partitioning and archiving strategies"
    }
  });
}));

/**
 * @swagger
 * /monitoring/query-performance:
 *   get:
 *     summary: Test database query performance (bypasses Redis cache)
 *     description: Runs EXPLAIN ANALYZE on common queries to verify index usage and performance
 *     tags: [Monitoring]
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *         description: User ID to test queries for
 *     responses:
 *       200:
 *         description: Query performance analysis
 */
router.get('/query-performance', asyncHandler(async (req: Request, res: Response) => {
  let { userId } = req.query;
  const postgres = container.postgres;

  try {
    // If no userId provided, find a user with receipts
    if (!userId || typeof userId !== 'string') {
      const userWithReceipts = await postgres.query(`
        SELECT DISTINCT user_id 
        FROM receipts 
        WHERE user_id IS NOT NULL 
        LIMIT 1
      `);
      
      if (userWithReceipts.rows.length === 0) {
        return res.status(404).json({ 
          error: 'No users with receipts found. Please provide a userId query parameter.' 
        });
      }
      
      userId = userWithReceipts.rows[0].user_id;
    }

    // Verify user exists
    const userCheck = await postgres.query('SELECT id FROM users WHERE id = $1', [userId]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
  } catch (error: any) {
    return res.status(500).json({ 
      error: 'Error finding user', 
      details: error.message 
    });
  }

  const results: any = {
    userId,
    timestamp: new Date().toISOString(),
    note: 'These queries bypass Redis cache and show raw database performance. If no userId was provided, a user with receipts was automatically selected.',
    tests: []
  };

  // Test 1: Get all receipts for user (most common query)
  try {
    const start = Date.now();
    const explainResult = await postgres.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM receipts 
      WHERE user_id = $1 
      ORDER BY order_date DESC
    `, [userId]);
    const executionTime = Date.now() - start;
    
    // EXPLAIN with FORMAT JSON returns the plan in a specific structure
    // The column name is typically 'QUERY PLAN' (case-sensitive in pg)
    const planData = explainResult.rows[0];
    let plan: any;
    
    // Try different possible column names
    if (planData['QUERY PLAN']) {
      const queryPlan = planData['QUERY PLAN'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else if (planData['query plan']) {
      const queryPlan = planData['query plan'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else {
      // Fallback: get first value
      const firstKey = Object.keys(planData)[0];
      const firstValue = planData[firstKey];
      plan = Array.isArray(firstValue) ? firstValue[0] : firstValue;
    }
    
    if (!plan) {
      throw new Error(`Invalid query plan structure. Keys: ${Object.keys(planData).join(', ')}`);
    }
    
    // Access Plan property (case-sensitive)
    const planObj = plan.Plan || plan['Plan'];
    if (!planObj) {
      throw new Error(`Plan object missing Plan property. Plan keys: ${Object.keys(plan).join(', ')}`);
    }
    
    // Check for index usage - can be at top level or in Plans array
    // PostgreSQL uses "Node Type" (with space) in JSON format
    const checkIndexUsage = (node: any): boolean => {
      if (!node) return false;
      const nodeType = node['Node Type'] || node['Node_Type'];
      if (nodeType === 'Index Scan' || nodeType === 'Bitmap Index Scan' || nodeType === 'Bitmap Heap Scan') {
        return true;
      }
      // Recursively check Plans array
      if (node['Plans'] && Array.isArray(node['Plans'])) {
        return node['Plans'].some((p: any) => checkIndexUsage(p));
      }
      return false;
    };
    
    const indexUsed = checkIndexUsage(planObj);

    results.tests.push({
      name: 'Get all receipts for user (ORDER BY order_date DESC)',
      query: 'SELECT * FROM receipts WHERE user_id = $1 ORDER BY order_date DESC',
      executionTimeMs: executionTime,
      planExecutionTimeMs: parseFloat(plan['Execution Time'] || '0'),
      planningTimeMs: parseFloat(plan['Planning Time'] || '0'),
      totalTimeMs: parseFloat(plan['Execution Time'] || '0') + parseFloat(plan['Planning Time'] || '0'),
      rowsReturned: planObj?.['Actual Rows'] || 0,
      indexUsed,
      nodeType: planObj?.['Node Type'],
      indexName: planObj?.['Index Name'] || 
                 (planObj?.['Plans'] || []).find((p: any) => p['Index Name'])?.['Index Name'] ||
                 'N/A',
      queryPlan: planObj
    });
  } catch (error: any) {
    results.tests.push({
      name: 'Get all receipts for user',
      error: error.message
    });
  }

  // Test 2: Sum total spent (aggregation query)
  try {
    const start = Date.now();
    const explainResult = await postgres.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT COALESCE(SUM(amount_spent), 0) as total 
      FROM receipts 
      WHERE user_id = $1
    `, [userId]);
    const executionTime = Date.now() - start;
    
    const planData = explainResult.rows[0];
    let plan: any;
    
    if (planData['QUERY PLAN']) {
      const queryPlan = planData['QUERY PLAN'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else if (planData['query plan']) {
      const queryPlan = planData['query plan'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else {
      const firstKey = Object.keys(planData)[0];
      const firstValue = planData[firstKey];
      plan = Array.isArray(firstValue) ? firstValue[0] : firstValue;
    }
    
    if (!plan) {
      throw new Error('Invalid query plan structure');
    }
    const planObj = plan.Plan || plan['Plan'];
    if (!planObj) {
      throw new Error(`Plan object missing Plan property. Plan keys: ${Object.keys(plan).join(', ')}`);
    }
    const checkIndexUsage = (node: any): boolean => {
      if (!node) return false;
      const nodeType = node['Node Type'] || node['Node_Type'];
      if (nodeType === 'Index Scan' || nodeType === 'Bitmap Index Scan' || nodeType === 'Bitmap Heap Scan') {
        return true;
      }
      if (node['Plans'] && Array.isArray(node['Plans'])) {
        return node['Plans'].some((p: any) => checkIndexUsage(p));
      }
      return false;
    };
    const indexUsed = checkIndexUsage(planObj);

    results.tests.push({
      name: 'Sum total spent (aggregation)',
      query: 'SELECT COALESCE(SUM(amount_spent), 0) FROM receipts WHERE user_id = $1',
      executionTimeMs: executionTime,
      planExecutionTimeMs: parseFloat(plan['Execution Time'] || '0'),
      planningTimeMs: parseFloat(plan['Planning Time'] || '0'),
      totalTimeMs: parseFloat(plan['Execution Time'] || '0') + parseFloat(plan['Planning Time'] || '0'),
      rowsReturned: planObj?.['Actual Rows'] || 0,
      indexUsed,
      nodeType: planObj?.['Node Type'] || planObj?.['Node_Type'],
      indexName: (() => {
        const findIndexName = (node: any): string | null => {
          if (!node) return null;
          const idxName = node['Index Name'] || node['Index_Name'];
          if (idxName) return idxName;
          if (node['Plans'] && Array.isArray(node['Plans'])) {
            for (const p of node['Plans']) {
              const found = findIndexName(p);
              if (found) return found;
            }
          }
          return null;
        };
        return findIndexName(planObj) || 'N/A';
      })(),
      queryPlan: planObj
    });
  } catch (error: any) {
    results.tests.push({
      name: 'Sum total spent',
      error: error.message
    });
  }

  // Test 3: Date range query (last 30 days)
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - 30);

    const start = Date.now();
    const explainResult = await postgres.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM receipts 
      WHERE user_id = $1 
      AND order_date BETWEEN $2 AND $3 
      ORDER BY order_date DESC
    `, [userId, startDate, endDate]);
    const executionTime = Date.now() - start;
    
    const planData = explainResult.rows[0];
    let plan: any;
    
    if (planData['QUERY PLAN']) {
      const queryPlan = planData['QUERY PLAN'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else if (planData['query plan']) {
      const queryPlan = planData['query plan'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else {
      const firstKey = Object.keys(planData)[0];
      const firstValue = planData[firstKey];
      plan = Array.isArray(firstValue) ? firstValue[0] : firstValue;
    }
    
    if (!plan) {
      throw new Error('Invalid query plan structure');
    }
    const planObj = plan.Plan || plan['Plan'];
    if (!planObj) {
      throw new Error(`Plan object missing Plan property. Plan keys: ${Object.keys(plan).join(', ')}`);
    }
    const indexUsed = planObj?.['Node Type'] === 'Index Scan' || 
                      planObj?.['Node Type'] === 'Bitmap Index Scan' ||
                      (planObj?.['Plans'] || []).some((p: any) => 
                        p['Node Type'] === 'Index Scan' || p['Node Type'] === 'Bitmap Index Scan'
                      );

    results.tests.push({
      name: 'Date range query (last 30 days)',
      query: 'SELECT * FROM receipts WHERE user_id = $1 AND order_date BETWEEN $2 AND $3 ORDER BY order_date DESC',
      executionTimeMs: executionTime,
      planExecutionTimeMs: parseFloat(plan['Execution Time'] || '0'),
      planningTimeMs: parseFloat(plan['Planning Time'] || '0'),
      totalTimeMs: parseFloat(plan['Execution Time'] || '0') + parseFloat(plan['Planning Time'] || '0'),
      rowsReturned: planObj?.['Actual Rows'] || 0,
      indexUsed,
      nodeType: planObj?.['Node Type'],
      indexName: planObj?.['Index Name'] || 
                 (planObj?.['Plans'] || []).find((p: any) => p['Index Name'])?.['Index Name'] ||
                 'N/A',
      queryPlan: planObj
    });
  } catch (error: any) {
    results.tests.push({
      name: 'Date range query',
      error: error.message
    });
  }

  // Test 4: JSONB search (using GIN index)
  try {
    const start = Date.now();
    const explainResult = await postgres.query(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM receipts 
      WHERE user_id = $1 
      AND items @> '[{"name": "test"}]'::jsonb
      LIMIT 10
    `, [userId]);
    const executionTime = Date.now() - start;
    
    const planData = explainResult.rows[0];
    let plan: any;
    
    if (planData['QUERY PLAN']) {
      const queryPlan = planData['QUERY PLAN'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else if (planData['query plan']) {
      const queryPlan = planData['query plan'];
      plan = Array.isArray(queryPlan) ? queryPlan[0] : queryPlan;
    } else {
      const firstKey = Object.keys(planData)[0];
      const firstValue = planData[firstKey];
      plan = Array.isArray(firstValue) ? firstValue[0] : firstValue;
    }
    
    if (!plan) {
      throw new Error('Invalid query plan structure');
    }
    const planObj = plan.Plan || plan['Plan'];
    if (!planObj) {
      throw new Error(`Plan object missing Plan property. Plan keys: ${Object.keys(plan).join(', ')}`);
    }
    const findGINIndex = (node: any): boolean => {
      if (!node) return false;
      const idxName = node['Index Name'] || node['Index_Name'];
      if (idxName && idxName.includes('items_gin')) return true;
      if (node['Plans'] && Array.isArray(node['Plans'])) {
        return node['Plans'].some((p: any) => findGINIndex(p));
      }
      return false;
    };
    const ginIndexUsed = findGINIndex(planObj);

    results.tests.push({
      name: 'JSONB items search (GIN index test)',
      query: 'SELECT * FROM receipts WHERE user_id = $1 AND items @> \'[{"name": "test"}]\'::jsonb',
      executionTimeMs: executionTime,
      planExecutionTimeMs: parseFloat(plan['Execution Time'] || '0'),
      planningTimeMs: parseFloat(plan['Planning Time'] || '0'),
      totalTimeMs: parseFloat(plan['Execution Time'] || '0') + parseFloat(plan['Planning Time'] || '0'),
      rowsReturned: planObj?.['Actual Rows'] || 0,
      ginIndexUsed,
      nodeType: planObj?.['Node Type'],
      indexName: planObj?.['Index Name'] || 
                 (planObj?.['Plans'] || []).find((p: any) => p['Index Name'])?.['Index Name'] ||
                 'N/A',
      queryPlan: planObj
    });
  } catch (error: any) {
    results.tests.push({
      name: 'JSONB items search',
      error: error.message
    });
  }

  // Summary
  results.summary = {
    totalTests: results.tests.length,
    testsWithIndexes: results.tests.filter((t: any) => t.indexUsed || t.ginIndexUsed).length,
    averageExecutionTime: results.tests
      .filter((t: any) => t.executionTimeMs)
      .reduce((sum: number, t: any) => sum + t.executionTimeMs, 0) / 
      results.tests.filter((t: any) => t.executionTimeMs).length || 0,
    fastestQuery: results.tests
      .filter((t: any) => t.executionTimeMs)
      .sort((a: any, b: any) => a.executionTimeMs - b.executionTimeMs)[0]?.name || 'N/A',
    slowestQuery: results.tests
      .filter((t: any) => t.executionTimeMs)
      .sort((a: any, b: any) => b.executionTimeMs - a.executionTimeMs)[0]?.name || 'N/A'
  };

  res.json(results);
}));

export default router;

