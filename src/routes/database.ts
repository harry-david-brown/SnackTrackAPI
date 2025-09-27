import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';

const router = Router();

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

    res.json({
      count: usersWithStats.length,
      users: usersWithStats
    });
  } catch (err) {
    console.error('Error fetching users:', err);
    res.status(500).json({ 
      error: 'Failed to fetch users', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// GET /database/users/:id - Get specific user details
router.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const user = await container.userRepository.findById(req.params.id);
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const totalSpent = await container.receiptRepository.getTotalSpentByUserId(user.id);
    const userReceipts = await container.receiptRepository.findByUserId(user.id);
    
    res.json({
      ...user,
      receiptCount: userReceipts.length,
      totalSpent,
      receipts: userReceipts,
      lastReceiptDate: userReceipts.length > 0 ? userReceipts[0].orderDate : null
    });
  } catch (err) {
    console.error('Error fetching user:', err);
    res.status(500).json({ 
      error: 'Failed to fetch user', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// GET /database/receipts - Get all receipts with optional filters
router.get('/receipts', async (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const userId = req.query.userId as string;
    const receiptType = req.query.receiptType as string;
    const restaurantName = req.query.restaurantName as string;

    let query = `
      SELECT r.*, u.email as user_email, u.account_type as user_account_type
      FROM receipts r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE 1=1
    `;
    const params: any[] = [];
    let paramIndex = 1;

    if (userId) {
      query += ` AND r.user_id = $${paramIndex}`;
      params.push(userId);
      paramIndex++;
    }

    if (receiptType) {
      query += ` AND r.receipt_type = $${paramIndex}`;
      params.push(receiptType);
      paramIndex++;
    }

    if (restaurantName) {
      query += ` AND r.restaurant_name ILIKE $${paramIndex}`;
      params.push(`%${restaurantName}%`);
      paramIndex++;
    }

    query += ` ORDER BY r.order_date DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
    params.push(limit, offset);

    const result = await container.postgres.query(query, params);
    
    // Get total count for pagination
    let countQuery = 'SELECT COUNT(*) FROM receipts r WHERE 1=1';
    const countParams: any[] = [];
    let countParamIndex = 1;

    if (userId) {
      countQuery += ` AND r.user_id = $${countParamIndex}`;
      countParams.push(userId);
      countParamIndex++;
    }

    if (receiptType) {
      countQuery += ` AND r.receipt_type = $${countParamIndex}`;
      countParams.push(receiptType);
      countParamIndex++;
    }

    if (restaurantName) {
      countQuery += ` AND r.restaurant_name ILIKE $${countParamIndex}`;
      countParams.push(`%${restaurantName}%`);
      countParamIndex++;
    }

    const countResult = await container.postgres.query(countQuery, countParams);
    const totalCount = parseInt(countResult.rows[0].count);

    res.json({
      receipts: result.rows,
      pagination: {
        total: totalCount,
        limit,
        offset,
        hasMore: offset + limit < totalCount
      }
    });
  } catch (err) {
    console.error('Error fetching receipts:', err);
    res.status(500).json({ 
      error: 'Failed to fetch receipts', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// GET /database/receipts/:id - Get specific receipt by ID
router.get('/receipts/:id', async (req: Request, res: Response) => {
  try {
    const result = await container.postgres.query(`
      SELECT r.*, u.email as user_email, u.account_type as user_account_type
      FROM receipts r
      LEFT JOIN users u ON r.user_id = u.id
      WHERE r.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    const receipt = result.rows[0];
    
    // Parse items if they exist
    if (receipt.items && typeof receipt.items === 'string') {
      try {
        receipt.items = JSON.parse(receipt.items);
      } catch (e) {
        console.warn('Failed to parse items JSON:', e);
        receipt.items = [];
      }
    }

    res.json(receipt);
  } catch (err) {
    console.error('Error fetching receipt:', err);
    res.status(500).json({ 
      error: 'Failed to fetch receipt', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// GET /database/stats - Get database statistics
router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Get user count
    const userCountResult = await container.postgres.query('SELECT COUNT(*) as count FROM users');
    const userCount = parseInt(userCountResult.rows[0].count);

    // Get receipt count
    const receiptCountResult = await container.postgres.query('SELECT COUNT(*) as count FROM receipts');
    const receiptCount = parseInt(receiptCountResult.rows[0].count);

    // Get total spending
    const totalSpentResult = await container.postgres.query('SELECT COALESCE(SUM(amount_spent), 0) as total FROM receipts');
    const totalSpent = parseFloat(totalSpentResult.rows[0].total);

    // Get receipt types breakdown
    const receiptTypesResult = await container.postgres.query(`
      SELECT receipt_type, COUNT(*) as count, COALESCE(SUM(amount_spent), 0) as total
      FROM receipts 
      GROUP BY receipt_type 
      ORDER BY count DESC
    `);

    // Get top restaurants
    const topRestaurantsResult = await container.postgres.query(`
      SELECT restaurant_name, COUNT(*) as order_count, COALESCE(SUM(amount_spent), 0) as total_spent
      FROM receipts 
      WHERE restaurant_name IS NOT NULL 
      GROUP BY restaurant_name 
      ORDER BY total_spent DESC 
      LIMIT 10
    `);

    // Get recent activity (last 7 days)
    const recentActivityResult = await container.postgres.query(`
      SELECT DATE(order_date) as date, COUNT(*) as receipts, COALESCE(SUM(amount_spent), 0) as total
      FROM receipts 
      WHERE order_date >= NOW() - INTERVAL '7 days'
      GROUP BY DATE(order_date)
      ORDER BY date DESC
    `);

    res.json({
      users: {
        total: userCount
      },
      receipts: {
        total: receiptCount,
        totalSpent,
        breakdownByType: receiptTypesResult.rows
      },
      restaurants: {
        top10: topRestaurantsResult.rows
      },
      recentActivity: {
        last7Days: recentActivityResult.rows
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

// DELETE /database/users/:id - Delete user and all their receipts
router.delete('/users/:id', async (req: Request, res: Response) => {
  try {
    // Check if user exists
    const user = await container.userRepository.findById(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Delete user (receipts will be cascade deleted due to foreign key constraint)
    await container.postgres.query('DELETE FROM users WHERE id = $1', [req.params.id]);

    res.json({ 
      message: 'User and all associated receipts deleted successfully',
      deletedUserId: req.params.id
    });
  } catch (err) {
    console.error('Error deleting user:', err);
    res.status(500).json({ 
      error: 'Failed to delete user', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

// DELETE /database/receipts/:id - Delete specific receipt
router.delete('/receipts/:id', async (req: Request, res: Response) => {
  try {
    const result = await container.postgres.query('DELETE FROM receipts WHERE id = $1 RETURNING id', [req.params.id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    res.json({ 
      message: 'Receipt deleted successfully',
      deletedReceiptId: req.params.id
    });
  } catch (err) {
    console.error('Error deleting receipt:', err);
    res.status(500).json({ 
      error: 'Failed to delete receipt', 
      details: err instanceof Error ? err.message : 'Unknown error' 
    });
  }
});

export default router;
