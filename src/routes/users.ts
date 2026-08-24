import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, NotFoundError, DatabaseError, ValidationError } from '../middleware/errorHandler';
import { validateUUIDParam, validateUserCreation } from '../middleware/validation';
import { userCreationRateLimit, emailOperationRateLimit } from '../middleware/security';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { cacheService } from '../services/core/CacheService';
import {
  detectTimezoneFromRequest,
  getDefaultTimezone,
  getLocalDateKey,
  isValidTimezone,
} from '../utils/timezone';
import {
  buildDashboardInsightEdition,
  DASHBOARD_INSIGHT_METRIC_VERSION,
  getDashboardInsightPreviewNow,
  MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET,
} from '../services/analytics/dashboard';

const router = Router();
const databaseService = container.databaseService;

// POST /users/:id/reset-onboarding - preserve login identity while clearing all imported data.
router.post('/:id/reset-onboarding', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.id;
  const result = await container.accountResetService.resetForOnboarding(userId);

  container.gmailConnectionHealthService.invalidate(userId);
  await cacheService.invalidateAllUserCaches(userId);

  res.json({
    success: true,
    deletedReceipts: result.deletedReceipts,
    message: 'Account import data reset successfully',
  });
}));

/**
 * @swagger
 * /users/{id}/dashboard-insights:
 *   get:
 *     summary: Get the user's daily dashboard insight edition
 *     description: Returns up to seven deterministic, user-local daily observations derived from persisted receipts.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: header
 *         name: X-Timezone
 *         schema:
 *           type: string
 *         description: Current IANA timezone used for local-day analytics.
 *     responses:
 *       200:
 *         description: Daily dashboard insight edition
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/DashboardInsightEdition'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 */
router.get('/:id/dashboard-insights', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  const rawDevDayOffset = req.query.devDayOffset;
  if (rawDevDayOffset !== undefined && process.env.NODE_ENV === 'production') {
    throw new ValidationError('devDayOffset is only available outside production', 'devDayOffset');
  }
  if (rawDevDayOffset !== undefined && (
    typeof rawDevDayOffset !== 'string'
    || !/^\d+$/.test(rawDevDayOffset)
    || Number(rawDevDayOffset) > MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET
  )) {
    throw new ValidationError(
      `devDayOffset must be a whole number from 0 to ${MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET}`,
      'devDayOffset',
    );
  }
  const devDayOffset = rawDevDayOffset === undefined ? 0 : Number(rawDevDayOffset);
  const isDevPreview = devDayOffset > 0;
  try {
    const userId = req.params.id;
    let user = await container.userRepository.findById(userId);
    if (!user) throw new NotFoundError('User', userId);

    const requestTimezone = detectTimezoneFromRequest(req);
    if (requestTimezone && requestTimezone !== user.timezone) {
      await container.userRepository.updateTimezone(userId, requestTimezone);
      await cacheService.invalidateAllUserCaches(userId);
      user = { ...user, timezone: requestTimezone };
    }
    const timezone = user.timezone || getDefaultTimezone();
    const actualNow = new Date();
    const now = getDashboardInsightPreviewNow(actualNow, timezone, devDayOffset);
    const localDate = getLocalDateKey(now, timezone) ?? now.toISOString().slice(0, 10);
    const cacheKey = `${userId}:${DASHBOARD_INSIGHT_METRIC_VERSION}:${timezone}:${localDate}`;
    // Preview editions intentionally bypass shared caches: otherwise a future
    // preview could poison the real edition when that calendar date arrives.
    const cached = isDevPreview ? null : await cacheService.getDashboardInsightEdition(cacheKey);
    if (cached) {
      res.set('Cache-Control', 'private, no-cache');
      return res.json(cached);
    }

    const receipts = await container.receiptRepository.findByUserId(userId);
    const edition = buildDashboardInsightEdition(receipts, timezone, userId, now);
    if (!isDevPreview) {
      const ttlSeconds = (Date.parse(edition.nextRefreshAt) - actualNow.getTime()) / 1000 + 60;
      await cacheService.cacheDashboardInsightEdition(cacheKey, edition, ttlSeconds);
    }
    res.set('Cache-Control', 'private, no-cache');
    return res.json(edition);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to fetch dashboard insights', error as Error);
  }
}));

/**
 * @swagger
 * /users/create:
 *   post:
 *     summary: Create a new user
 *     description: |
 *       Create a new user account with an email address.
 *       The user's timezone is automatically detected from the X-Timezone header (mobile apps should send this).
 *       Alternatively, timezone can be provided in the request body, or it defaults to 'America/New_York'.
 *     tags: [Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: header
 *         name: X-Timezone
 *         schema:
 *           type: string
 *           example: "America/New_York"
 *         description: IANA timezone identifier (e.g., 'America/New_York', 'Europe/London'). Mobile apps should send this header based on device settings.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               timezone:
 *                 type: string
 *                 description: Optional IANA timezone identifier. If not provided, will use X-Timezone header or default.
 *                 example: "America/New_York"
 *           example:
 *             email: "user@example.com"
 *             timezone: "America/New_York"
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:
 *                   type: string
 *                   format: uuid
 *                 message:
 *                   type: string
 *                 timezone:
 *                   type: string
 *                   description: The timezone that was set for the user
 *             example:
 *               userId: "550e8400-e29b-41d4-a716-446655440000"
 *               message: "User created successfully"
 *               timezone: "America/New_York"
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       429:
 *         $ref: '#/components/responses/RateLimitExceeded'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Create a new user (with rate limiting)
router.post('/create', userCreationRateLimit, validateUserCreation, asyncHandler(async (req: Request, res: Response) => {
  try {
    // Detect timezone from request (mobile apps should send X-Timezone header)
    // Falls back to request body timezone field, then to default
    const detectedTimezone = detectTimezoneFromRequest(req) || getDefaultTimezone();
    
    const id = await databaseService.createUser(req.body.email, detectedTimezone);
    res.status(201).json({ 
      userId: id,
      message: 'User created successfully',
      timezone: detectedTimezone // Return detected timezone so frontend knows what was set
    });
  } catch (error) {
    throw new DatabaseError('Failed to create user', error as Error);
  }
}));

/**
 * @swagger
 * /users/{id}/totalSpent:
 *   get:
 *     summary: Get user's total spending
 *     description: Retrieve the total amount spent by a user across all receipts
 *     tags: [Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: Total spending retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 totalSpent:
 *                   type: number
 *                   format: float
 *                   description: Total amount spent
 *                   example: 1250.75
 *             example:
 *               totalSpent: 1250.75
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// Get user's total spending
router.get('/:id/totalSpent', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    // First check if user exists
    const user = await databaseService.getUser(req.params.id);
    if (!user) {
      throw new NotFoundError('User', req.params.id);
    }
    
    const total = await databaseService.getUserTotalSpent(req.params.id);
    res.json({ totalSpent: total });
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to get user total spent', error as Error);
  }
}));

/**
 * @swagger
 * /users/{id}/summary:
 *   get:
 *     summary: Get user data summary and analytics
 *     description: Get comprehensive summary of user data including statistics, validation insights, and optionally Spotify Wrapped-style analytics.
 *     tags: [Users]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID to get summary for
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *       - in: query
 *         name: includeWrapped
 *         required: false
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Include Spotify Wrapped-style analytics (shame, flex, comparative, patterns)
 *         example: true
 *     responses:
 *       200:
 *         description: User summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserSummary'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /users/:id/summary - Get user data summary and analytics
router.get('/:id/summary', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    const includeWrapped = req.query.includeWrapped === 'true';

    // Keep the analytics timezone aligned with the signed-in device. This also
    // repairs older Google/Apple accounts that were created with the fallback.
    let user = await container.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User', userId);
    }
    const requestTimezone = detectTimezoneFromRequest(req);
    if (requestTimezone && requestTimezone !== user.timezone) {
      await container.userRepository.updateTimezone(userId, requestTimezone);
      await cacheService.invalidateAllUserCaches(userId);
      user = { ...user, timezone: requestTimezone };
    }
    const analyticsTimezone = user.timezone || getDefaultTimezone();
    
    // Timezone and metric-versioned keys prevent a device timezone correction
    // or formula fix from returning an older cached payload.
    const cacheKey = includeWrapped
      ? `${userId}-wrapped-v6-${analyticsTimezone}`
      : `${userId}-v5-${analyticsTimezone}`;
    const cachedSummary = await cacheService.getUserSummary(cacheKey);
    if (cachedSummary) {
      return res.json(cachedSummary);
    }
    
    // Get user's receipts
    const receipts = await container.receiptRepository.findByUserId(userId);
    
    // Calculate statistics
    const roundMoney = (amount: number) => Math.round((amount + Number.EPSILON) * 100) / 100;
    const totalSpent = roundMoney(receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0));
    const averageSpent = receipts.length > 0 ? roundMoney(totalSpent / receipts.length) : 0;
    const totalReceipts = receipts.length;
    
    // Data source breakdown
    const dataSourceBreakdown = receipts.reduce((acc, receipt) => {
      acc[receipt.dataSource] = (acc[receipt.dataSource] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Monthly breakdown
    const monthlyBreakdown = receipts.reduce((acc, receipt) => {
      if (!receipt.orderDate) return acc;
      const localDate = getLocalDateKey(receipt.orderDate, analyticsTimezone);
      if (!localDate) return acc;
      const month = localDate.substring(0, 7); // YYYY-MM in the user's timezone
      if (!acc[month]) {
        acc[month] = { count: 0, total: 0 };
      }
      acc[month].count++;
      acc[month].total = roundMoney(acc[month].total + receipt.amountSpent);
      return acc;
    }, {} as Record<string, { count: number; total: number }>);

    // Top restaurants
    const restaurantStats = receipts.reduce((acc, receipt) => {
      const restaurant = receipt.restaurantName?.trim();
      // Do not let blank or punctuation-only import values occupy a ranked
      // restaurant slot. This also coalesces names with stray outer spaces.
      if (!restaurant || !/[\p{L}\p{N}]/u.test(restaurant)) return acc;
      if (!acc[restaurant]) {
        acc[restaurant] = { count: 0, total: 0 };
      }
      acc[restaurant].count++;
      acc[restaurant].total = roundMoney(acc[restaurant].total + receipt.amountSpent);
      return acc;
    }, {} as Record<string, { count: number; total: number }>);

    const topRestaurants = Object.entries(restaurantStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.count - a.count || b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 10);

    // Validation insights
    const issues = [];
    const zeroAmountReceipts = receipts.filter(r => parseFloat(r.amountSpent.toString()) === 0);
    if (zeroAmountReceipts.length > 0) {
      issues.push(`${zeroAmountReceipts.length} receipts have zero amount (likely refunded orders)`);
    }

    const recentReceipts = receipts
      .filter(r => r.orderDate && r.orderDate > new Date(Date.now() - 30 * 24 * 60 * 60 * 1000))
      .sort((a, b) => (b.orderDate?.getTime() || 0) - (a.orderDate?.getTime() || 0))
      .slice(0, 5);

    const summary: any = {
      user: {
        id: user.id,
        email: user.email,
        dataSource: 'csv' // All users now come from CSV
      },
      statistics: {
        totalSpent,
        averageSpent,
        totalReceipts,
        dataSourceBreakdown,
        monthlyBreakdown,
        topRestaurants
      },
      validation: {
        issues,
        zeroAmountReceipts: zeroAmountReceipts.length,
        refundedReceipts: zeroAmountReceipts.length
      },
      recentReceipts: recentReceipts.map(receipt => ({
        restaurantName: receipt.restaurantName,
        amountSpent: receipt.amountSpent,
        orderDate: receipt.orderDate,
        dataSource: receipt.dataSource
      })),
    };

    // Optionally include Spotify Wrapped-style analytics
    if (includeWrapped) {
      try {
        const wrappedAnalytics = await container.wrappedAnalyticsService.calculateWrappedAnalytics(userId);
        summary.wrappedAnalytics = wrappedAnalytics;
      } catch (error) {
        console.error('Error calculating wrapped analytics:', error);
        // Continue without wrapped analytics if there's an error
        summary.wrappedAnalytics = null;
      }
    }

    // Cache the summary for future requests
    await cacheService.cacheUserSummary(cacheKey, summary);

    // Prevent HTTP caching to ensure fresh data after imports
    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    
    res.json(summary);
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to fetch user summary', error as Error);
  }
}));

// Update user receipts from emails (with rate limiting)
router.post('/:id/update-receipts', authenticateToken, validateOwnership, emailOperationRateLimit, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    await databaseService.updateUserReceiptsForUser(req.params.id);
    const total = await databaseService.getUserTotalSpent(req.params.id);
    res.json({ 
      message: 'Receipts updated successfully',
      total 
    });
  } catch (error) {
    throw new DatabaseError('Failed to update receipts', error as Error);
  }
}));

// Debug endpoint to test email fetching and parsing
router.get('/:id/debug/emails', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const user = await databaseService.getUser(req.params.id);
    if (!user) {
      throw new NotFoundError('User', req.params.id);
    }
    
    const emails = await container.receiptLookupService.getUserEmails(user);
    const receipts = emails.map((email: any) => ({
      from: email.from,
      to: email.to,
      body: email.body,
      parsedReceipt: email.toReceipt()
    }));
    
    res.json({
      user: user.email,
      emailCount: emails.length,
      emails: receipts
    });
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to fetch emails', error as Error);
  }
}));

/**
 * @swagger
 * /users/{id}/timezone:
 *   put:
 *     summary: Update user's timezone
 *     description: Update the timezone for a user. This affects how receipt times are displayed in analytics (e.g., "3am regret" orders are calculated based on local time).
 *     tags: [Users]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - timezone
 *             properties:
 *               timezone:
 *                 type: string
 *                 description: IANA timezone identifier (e.g., 'America/New_York', 'Europe/London', 'Asia/Tokyo')
 *                 example: "America/New_York"
 *     responses:
 *       200:
 *         description: Timezone updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "Timezone updated successfully"
 *                 timezone:
 *                   type: string
 *                   example: "America/New_York"
 *       400:
 *         description: Invalid timezone format
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 */
router.put('/:id/timezone', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  try {
    const { timezone } = req.body;
    
    if (!timezone || typeof timezone !== 'string') {
      return res.status(400).json({ 
        error: 'Invalid request',
        message: 'Timezone is required and must be a string'
      });
    }

    if (!isValidTimezone(timezone)) {
      return res.status(400).json({ 
        error: 'Invalid timezone format',
        message: 'Timezone must be a valid IANA timezone identifier (e.g., "America/New_York", "Europe/London")'
      });
    }

    // Check if user exists
    const user = await databaseService.getUser(req.params.id);
    if (!user) {
      throw new NotFoundError('User', req.params.id);
    }

    await databaseService.updateUserTimezone(req.params.id, timezone);
    await cacheService.invalidateAllUserCaches(req.params.id);
    
    res.json({ 
      message: 'Timezone updated successfully',
      timezone 
    });
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new DatabaseError('Failed to update timezone', error as Error);
  }
}));

export default router;
