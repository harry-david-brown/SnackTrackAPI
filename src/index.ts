// Reference Node.js types for process and environment
/// <reference types="node" />
// @ts-ignore
import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
import authRouter from './routes/auth';
import usersRouter from './routes/users';
import receiptsRouter from './routes/receipts';
import csvRouter from './routes/csv';
import validationRouter from './routes/validation';
import databaseRouter from './routes/database';
import { PostgresService } from './services/data/PostgresService';
import { config } from './config/AppConfig';
import { errorHandler } from './middleware/errorHandler';
import { setupSwagger } from './config/swagger';
import { sentryConfig } from './config/sentry';
import { 
  securityHeaders, 
  corsConfig, 
  requestSizeLimit, 
  securityLogger,
  apiRateLimit,
  progressiveSlowDown 
} from './middleware/security';

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
// Detailed health check
app.get('/health', async (req: Request, res: Response) => {
  try {
    const startTime = Date.now();
    await postgresService.query('SELECT 1');
    const dbLatency = Date.now() - startTime;

    if (dbLatency < 1000) {
      return res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          status: 'connected',
          latency: dbLatency
        }
      });
    } else {
      return res.status(503).json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        message: 'Database responding slowly'
      });
    }
  } catch (error) {
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
app.use('/users', usersRouter);
app.use('/receipts', receiptsRouter);
app.use('/csv', csvRouter);
app.use('/validation', validationRouter);
app.use('/database', databaseRouter);

// Error handling middleware (must be last)
// Note: Sentry errors are captured via sentryConfig.captureError() in errorHandler
app.use(errorHandler);

const PORT = config.getServerPort();

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database tables
    await postgresService.initializeTables();
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`📊 Database connected and initialized`);
      console.log(config.getEnvironmentInfo());
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

startServer(); 