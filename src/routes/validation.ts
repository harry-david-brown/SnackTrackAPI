import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { cacheService } from '../services/core/CacheService';

const router = Router();

/**
 * @swagger
 * /validation/user/{userId}/summary:
 *   get:
 *     summary: Get user data summary and validation
 *     description: Get comprehensive summary of user data including validation insights and analytics
 *     tags: [Validation & Analytics]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID to get summary for
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: User summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/UserSummary'
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /validation/user/:userId/summary - Get user data summary and validation
router.get('/user/:userId/summary', authenticateToken, validateOwnership, async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    
    // Check cache first
    const cachedSummary = await cacheService.getUserSummary(userId);
    if (cachedSummary) {
      return res.json(cachedSummary);
    }
    
    // Get user details
    const user = await container.userRepository.findById(userId);
    if (!user) {
      return res.status(404).json({ 
        error: 'User not found',
        statusCode: 404,
        timestamp: new Date().toISOString(),
        path: req.originalUrl,
        method: req.method
      });
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

    const summary = {
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

    // Cache the summary for future requests
    await cacheService.cacheUserSummary(userId, summary);

    res.json(summary);
  } catch (err) {
    console.error('Error fetching user summary:', err);
    res.status(500).json({ 
      error: 'Failed to fetch user summary', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

export default router;