import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { validateApiKey } from '../middleware/security';

const router = Router();

// All database routes require API key authentication
router.use(validateApiKey);

/**
 * @swagger
 * /database/users:
 *   get:
 *     summary: Get all users
 *     description: Retrieve all users in the database with their statistics
 *     tags: [Database]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 1000
 *           default: 50
 *         description: Maximum number of users to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of users to skip
 *     responses:
 *       200:
 *         description: List of users retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 users:
 *                   type: array
 *                   items:
 *                     allOf:
 *                       - $ref: '#/components/schemas/User'
 *                       - type: object
 *                         properties:
 *                           receiptCount:
 *                             type: integer
 *                             example: 45
 *                           totalSpent:
 *                             type: number
 *                             format: float
 *                             example: 1250.75
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                       example: 1250
 *                     limit:
 *                       type: integer
 *                       example: 50
 *                     offset:
 *                       type: integer
 *                       example: 0
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /database/users - Get all users in the database
router.get('/users', async (req: Request, res: Response) => {
  try {
    const users = await container.userRepository.findAll();
    
    // Add receipt count and total spent for each user
    const usersWithStats = await Promise.all(
      users.map(async (user) => {
        const totalSpent = await container.receiptRepository.getTotalSpentByUserId(user.id);
        const userReceipts = await container.receiptRepository.findByUserId(user.id);
        
        return {
          ...user,
          receiptCount: userReceipts.length,
          totalSpent,
          lastReceiptDate: userReceipts.length > 0 ? userReceipts[0].orderDate : null
        };
      })
    );

    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    res.json({
      users: usersWithStats.slice(offset, offset + limit),
      pagination: {
        total: usersWithStats.length,
        limit,
        offset,
        hasMore: offset + limit < usersWithStats.length
      }
    });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ 
      error: 'Failed to fetch users', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * @swagger
 * /database/stats:
 *   get:
 *     summary: Get database statistics and health
 *     description: Get comprehensive database statistics, analytics, and health information
 *     tags: [Database]
 *     security:
 *       - ApiKeyAuth: []
 *     responses:
 *       200:
 *         description: Database statistics and health retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 database:
 *                   type: object
 *                   properties:
 *                     totalUsers:
 *                       type: integer
 *                       example: 1250
 *                     totalReceipts:
 *                       type: integer
 *                       example: 15420
 *                     usersWithReceipts:
 *                       type: integer
 *                       example: 1180
 *                     totalAmountAllUsers:
 *                       type: number
 *                       format: float
 *                       example: 125000.75
 *                     averageReceiptAmount:
 *                       type: number
 *                       format: float
 *                       example: 8.12
 *                 tableSizes:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       table:
 *                         type: string
 *                         example: "receipts"
 *                       size:
 *                         type: string
 *                         example: "728 kB"
 *                 recentActivity:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       table:
 *                         type: string
 *                         example: "users"
 *                       recentCount:
 *                         type: integer
 *                         example: 7
 *                 health:
 *                   type: object
 *                   properties:
 *                     status:
 *                       type: string
 *                       example: "HEALTHY"
 *                     timestamp:
 *                       type: string
 *                       format: date-time
 *                       example: "2025-09-27T05:40:09.876Z"
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /database/stats - Get comprehensive database statistics and health
router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Get user count
    const userCountResult = await container.postgres.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count);

    // Get receipt count
    const receiptCountResult = await container.postgres.query('SELECT COUNT(*) as count FROM receipts');
    const receiptCount = parseInt(receiptCountResult.rows[0].count);

    // Get users with receipts count
    const usersWithReceiptsResult = await container.postgres.query('SELECT COUNT(DISTINCT user_id) as count FROM receipts');
    const usersWithReceipts = parseInt(usersWithReceiptsResult.rows[0].count);

    // Get total amount spent
    const totalAmountResult = await container.postgres.query('SELECT SUM(amount_spent) as total FROM receipts');
    const totalAmount = parseFloat(totalAmountResult.rows[0].total || '0');

    // Get average receipt amount
    const avgAmountResult = await container.postgres.query('SELECT AVG(amount_spent) as average FROM receipts');
    const avgAmount = parseFloat(avgAmountResult.rows[0].average || '0');

    // Get table sizes
    const tableSizesResult = await container.postgres.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);

    // Get recent activity (last 24 hours)
    const recentActivityResult = await container.postgres.query(`
      SELECT 
        'users' as table_name,
        COUNT(*) as recent_count
      FROM users 
      WHERE created_at > NOW() - INTERVAL '24 hours'
      UNION ALL
      SELECT 
        'receipts' as table_name,
        COUNT(*) as recent_count
      FROM receipts 
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    res.json({
      database: {
        totalUsers: userCount,
        totalReceipts: receiptCount,
        usersWithReceipts: usersWithReceipts,
        totalAmountAllUsers: totalAmount,
        averageReceiptAmount: avgAmount
      },
      tableSizes: tableSizesResult.rows.map((row: any) => ({
        table: row.tablename,
        size: row.size
      })),
      recentActivity: recentActivityResult.rows.map((row: any) => ({
        table: row.table_name,
        recentCount: parseInt(row.recent_count)
      })),
      health: {
        status: 'HEALTHY',
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    console.error('Error fetching database stats:', err);
    res.status(500).json({ 
      error: 'Failed to fetch database statistics', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

/**
 * @swagger
 * /database/users/{id}:
 *   delete:
 *     summary: Delete user
 *     description: Delete a user and all their associated receipts
 *     tags: [Database]
 *     security:
 *       - ApiKeyAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID to delete
 *         example: "550e8400-e29b-41d4-a716-446655440000"
 *     responses:
 *       200:
 *         description: User deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: "User and associated receipts deleted successfully"
 *       404:
 *         $ref: '#/components/responses/NotFound'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// DELETE /database/users/:id - Delete user and all receipts
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    const userId = req.params.id;
    
    // First check if user exists
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

    // Delete all receipts for this user
    await container.postgres.query('DELETE FROM receipts WHERE user_id = $1', [userId]);
    
    // Delete the user
    await container.postgres.query('DELETE FROM users WHERE id = $1', [userId]);
    
    res.json({ 
      message: 'User and associated receipts deleted successfully' 
    });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ 
      error: 'Failed to delete user', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

export default router;