import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, NotFoundError, DatabaseError, ValidationError } from '../middleware/errorHandler';
import { validateUUIDParam, validateUserCreation } from '../middleware/validation';
import { userCreationRateLimit } from '../middleware/security';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { config } from '../config/AppConfig';
import {
  detectTimezoneFromRequest,
  getDefaultTimezone,
  isValidTimezone,
} from '../utils/timezone';
import {
  MAX_DASHBOARD_INSIGHT_DEV_DAY_OFFSET,
} from '../services/analytics/dashboard';

const router = Router();
const databaseService = container.databaseService;
const cacheService = container.cacheService;

// POST /users/:id/reset-onboarding - preserve login identity while clearing all imported data.
router.post('/:id/reset-onboarding', authenticateToken, validateOwnership, validateUUIDParam('id'), asyncHandler(async (req: Request, res: Response) => {
  const userId = req.params.id;
  const result = await container.accountResetService.resetForOnboarding(userId);

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
  if (rawDevDayOffset !== undefined && config.isProduction()) {
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
  const edition = await container.getDashboardInsightsService.execute({
    userId: req.params.id,
    requestTimezone: detectTimezoneFromRequest(req) ?? undefined,
    devDayOffset,
  });
  res.set('Cache-Control', 'private, no-cache');
  res.json(edition);
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
  const summary = await container.getUserSummaryService.execute({
    userId: req.params.id,
    includeWrapped: req.query.includeWrapped === 'true',
    requestTimezone: detectTimezoneFromRequest(req) ?? undefined,
  });

  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.json(summary);
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
