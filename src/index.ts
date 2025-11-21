// Reference Node.js types for process and environment
/// <reference types="node" />
// @ts-ignore
import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import authRouter from './routes/auth';
import authPasswordResetRouter from './routes/authPasswordReset';
import authEmailVerificationRouter from './routes/authEmailVerification';
import usersRouter from './routes/users';
import receiptsRouter from './routes/receipts';
import csvRouter from './routes/csv';
import validationRouter from './routes/validation';
import databaseRouter from './routes/database';
import monitoringRouter from './routes/monitoring';
import { PostgresService } from './services/data/PostgresService';
import { config } from './config/AppConfig';
import { errorHandler } from './middleware/errorHandler';
import { setupSwagger } from './config/swagger';
import { sentryConfig } from './config/sentry';
import { redisConfig } from './config/redis';
import { logger, logRequest } from './config/logger';
import * as Sentry from '@sentry/node';

// Helper to get log level (for conditional logging)
const getLogLevel = (): string => {
  if (process.env.LOG_LEVEL) {
    return process.env.LOG_LEVEL.toLowerCase();
  }
  return config.isProduction() ? 'info' : 'debug';
};
import { 
  securityHeaders, 
  corsConfig, 
  requestSizeLimit, 
  securityLogger,
  apiRateLimit,
  progressiveSlowDown 
} from './middleware/security';
import { requestLogger } from './middleware/requestLogger';

dotenv.config();

const app = express();

// Initialize Sentry (must be first, before any middleware)
sentryConfig.initialize(app);

// Trust proxy for accurate IP addresses (important for rate limiting)
app.set('trust proxy', 1);

// Security middleware (must be applied early)
app.use(securityHeaders);
app.use(corsConfig);
app.use(requestSizeLimit);
app.use(securityLogger);

// Rate limiting middleware
app.use(apiRateLimit);
app.use(progressiveSlowDown);

// Request logging (after security, before routes)
app.use(requestLogger);

// Body parsing (with size limits)
app.use(express.json({ limit: config.isProduction() ? '10mb' : '50mb' }));
app.use(express.urlencoded({ extended: true, limit: config.isProduction() ? '10mb' : '50mb' }));

// Initialize database
const postgresService = new PostgresService();

/**
 * @swagger
 * /:
 *   get:
 *     summary: Basic health check
 *     description: Simple health check endpoint to verify the API is running
 *     tags: [System]
 *     responses:
 *       200:
 *         description: API is healthy and running
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: "ALIVE"
 */
// Basic health check
app.get('/', (req: Request, res: Response) => {
  logRequest(req, res);
  res.send('ALIVE');
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Detailed health check
 *     description: Health check with database connectivity test
 *     tags: [System]
 *     responses:
 *       200:
 *         description: Service is healthy
 *       503:
 *         description: Service is degraded or down
 */
// Detailed health check (includes basic database connectivity)
// For comprehensive metrics, use /monitoring/health
app.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();
  try {
    await postgresService.query('SELECT 1');
    const dbLatency = Date.now() - startTime;
    const responseTime = Date.now() - startTime;

    if (dbLatency < 1000) {
      logRequest(req, res, responseTime);
      return res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          status: 'connected',
          latency: dbLatency // milliseconds
        }
      });
    } else {
      logger.warn('Database responding slowly', { latency: dbLatency });
      logRequest(req, res, responseTime);
      return res.status(503).json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        message: 'Database responding slowly'
      });
    }
  } catch (error) {
    const responseTime = Date.now() - startTime;
    logger.error('Health check failed', { error: error instanceof Error ? error.message : String(error) });
    logRequest(req, res, responseTime);
    return res.status(503).json({
      status: 'down',
      timestamp: new Date().toISOString(),
      message: 'Database connection failed'
    });
  }
});

// OAuth callback handler
app.get('/auth/callback', (req: Request, res: Response) => {
  const code = req.query.code;
  if (code) {
    res.send(`
      <html>
        <body>
          <h2>✅ Authorization Successful!</h2>
          <p>Authorization code: <code>${code}</code></p>
          <p>Copy this code and paste it into your terminal where the script is waiting.</p>
        </body>
      </html>
    `);
  } else {
    res.status(400).send('No authorization code received');
  }
});

// Setup Swagger documentation
setupSwagger(app);

// Mount routers
app.use('/auth', authRouter);
app.use('/auth/password/reset', authPasswordResetRouter);
app.use('/auth/email/verify', authEmailVerificationRouter);
app.use('/users', usersRouter);
app.use('/receipts', receiptsRouter);
app.use('/csv', csvRouter);
app.use('/validation', validationRouter);
app.use('/database', databaseRouter);
app.use('/monitoring', monitoringRouter);

// Error handling middleware (must be last)
// Sentry error handler must come before our custom error handler
// This ensures Sentry captures the error before we format the response
if (sentryConfig.isEnabled()) {
  // Use Sentry's setupExpressErrorHandler for v10+
  Sentry.setupExpressErrorHandler(app);
}
// Our custom error handler (logs to Winston and handles response formatting)
app.use(errorHandler);

const PORT = config.getServerPort();

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database tables
    await postgresService.initializeTables();
    
    // Initialize Redis cache (optional, won't fail if unavailable)
    await redisConfig.initialize();
    
    // Start the server
    const server = app.listen(PORT, () => {
      logger.info('Server started', {
        port: PORT,
        environment: config.isProduction() ? 'production' : 'development'
      });
      logger.info('Database connected');
      if (getLogLevel() === 'debug') {
        logger.debug('Environment', { info: config.getEnvironmentInfo() });
      }
    });

    // Graceful shutdown handling
    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown...`);
      
      server.close(async () => {
        logger.info('HTTP server closed');
        
        // Close database connections
        await postgresService.close();
        logger.info('Database connections closed');
        
        // Close Redis connection
        await redisConfig.close();
        logger.info('Redis connection closed');
        
        logger.info('Graceful shutdown complete');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    
  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    process.exit(1);
  }
}

startServer(); 