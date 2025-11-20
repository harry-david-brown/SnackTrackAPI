/**
 * Monitoring Routes
 * 
 * Endpoints for system monitoring, health checks, and alerting status
 */

import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler } from '../middleware/errorHandler';
import { getLogLevel, setLogLevel, getRecentLogs } from '../config/logger';

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

export default router;

