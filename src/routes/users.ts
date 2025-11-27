import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { asyncHandler, NotFoundError, DatabaseError } from '../middleware/errorHandler';
import { validateUUIDParam, validateUserCreation } from '../middleware/validation';
import { userCreationRateLimit, emailOperationRateLimit } from '../middleware/security';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { cacheService } from '../services/core/CacheService';

const router = Router();
const databaseService = container.databaseService;

/**
 * @swagger
 * /users/create:
 *   post:
 *     summary: Create a new user
 *     description: Create a new user account with an email address
 *     tags: [Users]
 *     security:
 *       - ApiKeyAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateUserRequest'
 *           example:
 *             email: "user@example.com"
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/CreateUserResponse'
 *             example:
 *               userId: "550e8400-e29b-41d4-a716-446655440000"
 *               message: "User created successfully"
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
    const id = await databaseService.createUser(req.body.email);
    res.status(201).json({ 
      userId: id,
      message: 'User created successfully'
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
    
    // Check cache first (different cache key if wrapped analytics requested)
    const cacheKey = includeWrapped ? `${userId}-wrapped` : userId;
    const cachedSummary = await cacheService.getUserSummary(cacheKey);
    if (cachedSummary) {
      return res.json(cachedSummary);
    }
    
    // Get user details
    const user = await container.userRepository.findById(userId);
    if (!user) {
      throw new NotFoundError('User', userId);
    }

    // Get user's receipts
    const receipts = await container.receiptRepository.findByUserId(userId);
    
    // Calculate statistics
    const totalSpent = receipts.reduce((sum, receipt) => sum + receipt.amountSpent, 0);
    const averageSpent = receipts.length > 0 ? totalSpent / receipts.length : 0;
    const totalReceipts = receipts.length;
    
    // Data source breakdown
    const dataSourceBreakdown = receipts.reduce((acc, receipt) => {
      acc[receipt.dataSource] = (acc[receipt.dataSource] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Monthly breakdown
    const monthlyBreakdown = receipts.reduce((acc, receipt) => {
      if (!receipt.orderDate) return acc;
      const month = receipt.orderDate.toISOString().substring(0, 7); // YYYY-MM
      if (!acc[month]) {
        acc[month] = { count: 0, total: 0 };
      }
      acc[month].count++;
      acc[month].total += receipt.amountSpent;
      return acc;
    }, {} as Record<string, { count: number; total: number }>);

    // Top restaurants
    const restaurantStats = receipts.reduce((acc, receipt) => {
      const restaurant = receipt.restaurantName;
      if (!restaurant) return acc;
      if (!acc[restaurant]) {
        acc[restaurant] = { count: 0, total: 0 };
      }
      acc[restaurant].count++;
      acc[restaurant].total += receipt.amountSpent;
      return acc;
    }, {} as Record<string, { count: number; total: number }>);

    const topRestaurants = Object.entries(restaurantStats)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.total - a.total)
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
      }))
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

export default router; 