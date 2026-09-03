// Reference Node.js types for process and environment
/// <reference types="node" />
import 'dotenv/config';
import express, { Request, Response } from 'express';
import { createAuthRouter } from './routes/auth';
import { createPasswordResetRouter } from './routes/authPasswordReset';
import { createEmailVerificationRouter } from './routes/authEmailVerification';
import { createUsersRouter } from './routes/users';
import { createReceiptsRouter } from './routes/receipts';
import { createImportsRouter, createNotificationDeviceRouter } from './routes/imports';
import { createDatabaseRouter } from './routes/database';
import { createMonitoringRouter } from './routes/monitoring';
import { createAdminRouter } from './routes/admin';
import { createAnalyticsEventsRouter } from './routes/analyticsEvents';
import { createGmailRouter } from './routes/gmail';
import { createOutlookRouter } from './routes/outlook';
import { config } from './config/AppConfig';
import { asyncHandler, errorHandler } from './middleware/errorHandler';
import { setupSwagger } from './config/swagger';
import { sentryConfig } from './config/sentry';
import { redisConfig } from './config/redis';
import { getLogLevel, getRecentLogs, logger, logRequest, setLogLevel } from './config/logger';
import * as Sentry from '@sentry/node';
import { container } from './services/core/ServiceContainer';
import { ShutdownCoordinator } from './services/core/ShutdownCoordinator';
import { ImportQueueOperations } from './services/queue/ImportQueues';
import { AdminQueueOperationsService } from './services/admin/AdminQueueOperationsService';
import { redisLockStore } from './config/redis';

import {
  securityHeaders,
  corsConfig,
  requestSizeLimit,
  securityLogger,
  apiRateLimit,
  progressiveSlowDown,
  userCreationRateLimit,
  validateApiKey,
  validateSchedulerApiKey,
  adminAuthenticationRateLimit,
  csvImportRateLimit,
  passwordResetIPRateLimit,
  passwordResetRequestRateLimit,
  emailVerificationSendRateLimit,
  otpVerificationRateLimit,
  microsoftAuthAttemptRateLimit,
  microsoftAuthEmailRateLimit,
  importStartIpRateLimit,
} from './middleware/security';
import {
  createAuthenticateAdmin,
  createRequireAdminCsrf,
  createRequireAdminRole,
  requireAdminOrigin,
} from './middleware/adminAuth';
import { createRequestLogger } from './middleware/requestLogger';
import { requestContext } from './middleware/requestContext';
import { createAuthenticateToken, validateOwnership } from './middleware/auth';
import { paginationMiddleware } from './middleware/pagination';
import { validateUUIDParam } from './middleware/validation';

const app = express();
const queueOperations = new ImportQueueOperations(config.getQueueConfig());
const adminQueueOperations = new AdminQueueOperationsService(
  container.importJobRepository,
  queueOperations,
  redisLockStore,
);

const authenticateToken = createAuthenticateToken({
  tokens: container.tokenService,
  observability: sentryConfig,
  logger,
});
const authenticateAdmin = createAuthenticateAdmin(container.adminAuthService);
const requireAdminCsrf = createRequireAdminCsrf(container.adminAuthService);

// Initialize Sentry (must be first, before any middleware)
sentryConfig.initialize(app);

// Correlate every response and log, including failures in early security middleware.
app.use(requestContext);

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
app.use(
  createRequestLogger({
    alerting: container.alertingService,
    observability: {
      isSentryEnabled: () => sentryConfig.isEnabled(),
      addBreadcrumb: (...args) => sentryConfig.addBreadcrumb(...args),
      logRequest,
      debug: (message, metadata) => logger.debug(message, metadata),
      warn: (message, metadata) => logger.warn(message, metadata),
    },
  }),
);
// Body parsing (with size limits)
app.use(express.json({ limit: config.isProduction() ? '10mb' : '50mb' }));
app.use(express.urlencoded({ extended: true, limit: config.isProduction() ? '10mb' : '50mb' }));

// Initialize database
const postgresService = container.postgres;

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
app.get(
  '/health',
  asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const readiness = await container.databaseHealthService.check();
    const responseTime = Date.now() - startTime;

    if (readiness.status === 'connected') {
      const redis = redisLockStore.snapshot();
      const degraded = redis.enabled && redis.state !== 'ready';
      logRequest(req, res, responseTime);
      return res.status(200).json({
        status: degraded ? 'degraded' : 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
          status: 'connected',
          latency: readiness.latencyMs,
        },
        redis: {
          cache: redis,
          locks: redis,
        },
      });
    }
    if (readiness.status === 'slow') {
      logger.warn('Database responding slowly', { latency: readiness.latencyMs });
      logRequest(req, res, responseTime);
      return res.status(503).json({
        status: 'degraded',
        timestamp: new Date().toISOString(),
        message: 'Database responding slowly',
      });
    }
    logger.error('Health check failed', { errorCode: readiness.errorCode });
    logRequest(req, res, responseTime);
    return res.status(503).json({
      status: 'down',
      timestamp: new Date().toISOString(),
      message: 'Database connection failed',
    });
  }),
);

import { encode } from 'html-entities';

// OAuth callback handler
app.get('/auth/callback', (req: Request, res: Response) => {
  const code = req.query.code;
  if (code && typeof code === 'string') {
    const sanitizedCode = encode(code);
    res.send(`
      <html>
        <body>
          <h2>✅ Authorization Successful!</h2>
          <p>Authorization code: <code>${sanitizedCode}</code></p>
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

app.use(
  ['/gmail/import', '/outlook/import', '/gmail/tracking/check', '/imports/exports/uber-eats/upload-intent', '/imports/exports/doordash/upload-intent'],
  importStartIpRateLimit,
);

// Mount API routes
app.use(
  '/auth',
  createAuthRouter({
    credentials: container.credentialAuthService,
    providers: container.providerAuthService,
    microsoft: container.microsoftLoginService,
    sessions: container.sessionService,
    accountDeletion: container.accountDeletionService,
    authenticate: authenticateToken,
    rateLimitRegistration: userCreationRateLimit,
    rateLimitMicrosoftAttempt: microsoftAuthAttemptRateLimit,
    rateLimitMicrosoftEmail: microsoftAuthEmailRateLimit,
    rateLimitMicrosoftConfirmation: otpVerificationRateLimit,
  }),
);
app.use(
  '/auth/password/reset',
  createPasswordResetRouter({
    passwords: container.passwordResetService,
    rateLimitRequestByIp: passwordResetIPRateLimit,
    rateLimitRequestByEmail: passwordResetRequestRateLimit,
    rateLimitVerification: otpVerificationRateLimit,
  }),
);
app.use(
  '/auth/email/verify',
  createEmailVerificationRouter({
    verification: container.emailVerificationService,
    rateLimitSend: emailVerificationSendRateLimit,
    rateLimitConfirmation: otpVerificationRateLimit,
  }),
);
app.use(
  '/users',
  createUsersRouter({
    authenticate: authenticateToken,
    authorizeOwnership: validateOwnership,
    validateUserId: validateUUIDParam('id'),
    production: config.isProduction(),
    accountReset: container.accountResetService,
    dashboardInsights: container.getDashboardInsightsService,
    summaries: container.getUserSummaryService,
  }),
);
app.use(
  '/receipts',
  createReceiptsRouter({
    authenticate: authenticateToken,
    paginate: paginationMiddleware,
    listReceipts: container.listReceiptsService,
    clearReceipts: container.receiptClearService,
  }),
);
app.use('/imports', createImportsRouter({
  authenticate: authenticateToken,
  rateLimit: csvImportRateLimit,
  operations: container.importJobRepository,
  jobs: container.importJobService,
}));
app.use('/notifications', createNotificationDeviceRouter({
  authenticate: authenticateToken,
  devices: container.pushDeviceRepository,
}));
app.use(
  '/database',
  createDatabaseRouter({
    authorizeAdministrator: validateApiKey,
    administrator: container.administratorService,
    accountDeletion: container.accountDeletionService,
  }),
);
app.use(
  '/analytics/events',
  createAnalyticsEventsRouter({
    authenticate: authenticateToken,
    events: container.analyticsEventService,
  }),
);
app.use(
  '/admin/v1',
  requireAdminOrigin(config.getSecurityConfig().adminDashboardUrl),
  (req, res, next) => {
    if (req.path === '/auth/login' || req.path === '/auth/forgot-password' || req.path === '/auth/reset-password') {
      return adminAuthenticationRateLimit(req, res, next);
    }
    next();
  },
  createAdminRouter({
    auth: container.adminAuthService,
    analytics: container.adminAnalyticsQueryService,
    management: container.adminManagementService,
    authenticate: authenticateAdmin,
    requireCsrf: requireAdminCsrf,
    requireOwner: createRequireAdminRole('owner'),
    requireOperator: createRequireAdminRole('operator'),
    databaseHealth: container.databaseHealthService,
    cache: container.cacheService,
    alerting: container.alertingService,
    queues: adminQueueOperations,
    production: config.isProduction(),
  }),
);
app.use(
  '/monitoring',
  createMonitoringRouter({
    authorizeSensitive: validateApiKey,
    alerting: container.alertingService,
    cache: container.cacheService,
    monitoring: container.monitoringService,
    logs: { getLevel: getLogLevel, setLevel: setLogLevel, getRecent: getRecentLogs },
  }),
);
app.use(
  '/gmail',
  createGmailRouter({
    authenticate: authenticateToken,
    validateScheduler: validateSchedulerApiKey,
    connections: container.gmailConnectionService,
    preferences: container.importPreferencesService,
    manualCheck: container.manualTrackingCheckService,
    scheduledTracking: container.scheduledImportJobService,
    importJobs: container.importJobService,
    status: container.importStatusService,
    historicalImport: container.historicalGmailImportService,
    logger,
  }),
);
app.use(
  '/outlook',
  createOutlookRouter({
    authenticate: authenticateToken,
    connections: container.microsoftMailboxConnectionService,
    health: container.microsoftMailboxConnectionHealthService,
    historicalImport: container.historicalOutlookImportService,
    importJobs: container.importJobService,
    logger,
  }),
);

// Error handling middleware (must be last)
// Our custom error handler (logs to Winston and handles response formatting)
// Note: Sentry error capture happens in errorHandler via sentryConfig.captureError()
app.use(errorHandler);

const PORT = config.getServerPort();

// Initialize database and start server
async function startServer() {
  try {
    // Initialize Redis cache (optional, won't fail if unavailable)
    await redisConfig.initialize();
    container.alertingService.start();
    if (config.isAnalyticsMaintenanceEnabled()) container.analyticsMaintenanceService.start();

    // Start the server
    const server = app.listen(PORT, () => {
      logger.info('Server started', {
        port: PORT,
        environment: config.isProduction() ? 'production' : 'development',
      });
      logger.info('Database connected');
      if (getLogLevel() === 'debug') {
        logger.debug('Environment', { info: config.getEnvironmentInfo() });
      }
    });

    const shutdown = new ShutdownCoordinator([
      { name: 'alert monitoring', close: () => container.alertingService.close() },
      { name: 'analytics maintenance', close: () => container.analyticsMaintenanceService.close() },
      {
        name: 'HTTP server',
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      },
      { name: 'Redis connection', close: () => redisConfig.close() },
      { name: 'Queue monitoring connection', close: () => adminQueueOperations.close() },
      { name: 'Import object storage', close: () => container.importObjectStorage.close() },
      { name: 'PostgreSQL connection', close: () => postgresService.close() },
      { name: 'Sentry transport', close: () => Sentry.close(2000).then(() => undefined) },
    ]);
    let forcedShutdownTimer: NodeJS.Timeout | null = null;

    const gracefulShutdown = async (signal: string) => {
      logger.info(`${signal} received, starting graceful shutdown...`);
      if (!forcedShutdownTimer) {
        forcedShutdownTimer = setTimeout(() => {
          logger.error('Forced shutdown after timeout');
          process.exit(1);
        }, 10000);
        forcedShutdownTimer.unref();
      }
      try {
        await shutdown.close();
        if (forcedShutdownTimer) clearTimeout(forcedShutdownTimer);
        logger.info('Graceful shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error('Graceful shutdown failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error('Failed to start server', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    container.alertingService.close();
    container.analyticsMaintenanceService.close();
    await Promise.allSettled([redisConfig.close(), adminQueueOperations.close(), postgresService.close(), Sentry.close(2000)]);
    process.exitCode = 1;
  }
}

void startServer();
