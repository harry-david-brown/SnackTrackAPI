import { Router, Request, Response } from 'express';
import { PostgresService } from '../services/PostgresService';
import { CsvImportService } from '../services/CsvImportService';
import { getChainName } from '../config/ChainConfig';

const router = Router();
const postgresService = new PostgresService();
const csvImportService = new CsvImportService(postgresService);

// GET /validation/user/:userId/summary - Get comprehensive user data summary
router.get('/user/:userId/summary', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    
    // Get user info
    const userResult = await postgresService.query(
      'SELECT * FROM users WHERE id = $1',
      [userId]
    );
    
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult.rows[0];
    
    // Get receipt statistics
    const receiptStats = await postgresService.query(`
      SELECT 
        COUNT(*) as total_receipts,
        COUNT(DISTINCT restaurant_name) as unique_restaurants,
        COUNT(DISTINCT DATE(order_date)) as unique_days,
        MIN(order_date) as earliest_order,
        MAX(order_date) as latest_order,
        SUM(amount_spent) as total_spent,
        AVG(amount_spent) as average_order_value,
        MIN(amount_spent) as min_order_value,
        MAX(amount_spent) as max_order_value
      FROM receipts 
      WHERE user_id = $1
    `, [userId]);
    
    // Get restaurant breakdown
    const restaurantBreakdown = await postgresService.query(`
      SELECT 
        restaurant_name,
        COUNT(*) as order_count,
        SUM(amount_spent) as total_spent,
        AVG(amount_spent) as average_order_value
      FROM receipts 
      WHERE user_id = $1 AND restaurant_name IS NOT NULL
      GROUP BY restaurant_name
      ORDER BY total_spent DESC
      LIMIT 10
    `, [userId]);
    
    // Get monthly spending
    const monthlySpending = await postgresService.query(`
      SELECT 
        TO_CHAR(order_date, 'YYYY-MM') as month,
        COUNT(*) as order_count,
        SUM(amount_spent) as total_spent
      FROM receipts 
      WHERE user_id = $1 AND order_date IS NOT NULL
      GROUP BY TO_CHAR(order_date, 'YYYY-MM')
      ORDER BY month DESC
      LIMIT 12
    `, [userId]);
    
    // Get chain spending breakdown
    const chainSpending = await postgresService.query(`
      SELECT 
        restaurant_name,
        SUM(amount_spent) as total_spent,
        COUNT(*) as order_count,
        COUNT(DISTINCT restaurant_name) as location_count
      FROM receipts 
      WHERE user_id = $1 AND restaurant_name IS NOT NULL
      GROUP BY restaurant_name
      ORDER BY total_spent DESC
    `, [userId]);
    
    // Process chain data
    const chainMap = new Map<string, {
      totalSpent: number;
      orderCount: number;
      locationCount: number;
      locations: string[];
    }>();
    
    for (const row of chainSpending.rows) {
      const chainName = getChainName(row.restaurant_name);
      const totalSpent = parseFloat(row.total_spent);
      const orderCount = parseInt(row.order_count);
      
      if (chainName) {
        // This is a major chain
        if (!chainMap.has(chainName)) {
          chainMap.set(chainName, {
            totalSpent: 0,
            orderCount: 0,
            locationCount: 0,
            locations: []
          });
        }
        
        const chainData = chainMap.get(chainName)!;
        chainData.totalSpent += totalSpent;
        chainData.orderCount += orderCount;
        chainData.locationCount += 1;
        chainData.locations.push(row.restaurant_name);
      }
    }
    
    // Convert to array and sort by total spent
    const topChains = Array.from(chainMap.entries())
      .map(([chainName, data]) => ({
        chainName,
        totalSpent: data.totalSpent,
        orderCount: data.orderCount,
        locationCount: data.locationCount,
        locations: data.locations
      }))
      .sort((a, b) => b.totalSpent - a.totalSpent)
      .slice(0, 10);
    
    const stats = receiptStats.rows[0];
    
    res.json({
      user: {
        id: user.id,
        email: user.email,
        accountType: user.account_type,
        createdAt: user.created_at
      },
      summary: {
        totalReceipts: parseInt(stats.total_receipts),
        uniqueRestaurants: parseInt(stats.unique_restaurants),
        uniqueDays: parseInt(stats.unique_days),
        totalSpent: parseFloat(stats.total_spent),
        averageOrderValue: parseFloat(stats.average_order_value),
        minOrderValue: parseFloat(stats.min_order_value),
        maxOrderValue: parseFloat(stats.max_order_value),
        dateRange: {
          earliest: stats.earliest_order,
          latest: stats.latest_order
        }
      },
      topRestaurants: restaurantBreakdown.rows.map((row: any) => ({
        name: row.restaurant_name,
        orderCount: parseInt(row.order_count),
        totalSpent: parseFloat(row.total_spent),
        averageOrderValue: parseFloat(row.average_order_value)
      })),
      monthlySpending: monthlySpending.rows.map((row: any) => ({
        month: row.month,
        orderCount: parseInt(row.order_count),
        totalSpent: parseFloat(row.total_spent)
      })),
      topChains: topChains
    });
    
  } catch (error) {
    console.error('Validation summary error:', error);
    res.status(500).json({ 
      error: 'Failed to get validation summary', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// GET /validation/user/:userId/receipts - Get detailed receipt breakdown
router.get('/user/:userId/receipts', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    
    const receipts = await postgresService.query(`
      SELECT 
        id,
        restaurant_name,
        order_date,
        amount_spent,
        subtotal,
        tax,
        tip,
        delivery_fee,
        service_fee,
        items,
        email_from,
        email_subject,
        created_at
      FROM receipts 
      WHERE user_id = $1
      ORDER BY order_date DESC
      LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);
    
    const totalCount = await postgresService.query(
      'SELECT COUNT(*) as count FROM receipts WHERE user_id = $1',
      [userId]
    );
    
    res.json({
      receipts: receipts.rows.map((row: any) => ({
        id: row.id,
        restaurantName: row.restaurant_name,
        orderDate: row.order_date,
        amountSpent: parseFloat(row.amount_spent),
        breakdown: {
          subtotal: row.subtotal ? parseFloat(row.subtotal) : null,
          tax: row.tax ? parseFloat(row.tax) : null,
          tip: row.tip ? parseFloat(row.tip) : null,
          deliveryFee: row.delivery_fee ? parseFloat(row.delivery_fee) : null,
          serviceFee: row.service_fee ? parseFloat(row.service_fee) : null
        },
        items: row.items ? (typeof row.items === 'string' ? JSON.parse(row.items) : row.items) : [],
        emailFrom: row.email_from,
        emailSubject: row.email_subject,
        createdAt: row.created_at
      })),
      pagination: {
        total: parseInt(totalCount.rows[0].count),
        limit,
        offset,
        hasMore: offset + limit < parseInt(totalCount.rows[0].count)
      }
    });
    
  } catch (error) {
    console.error('Validation receipts error:', error);
    res.status(500).json({ 
      error: 'Failed to get receipt details', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// GET /validation/user/:userId/verify-csv - Verify CSV data integrity
router.get('/user/:userId/verify-csv', async (req: Request, res: Response) => {
  try {
    const userId = req.params.userId;
    
    // Get all receipts for the user
    const receipts = await postgresService.query(`
      SELECT 
        restaurant_name,
        order_date,
        amount_spent,
        items,
        email_from
      FROM receipts 
      WHERE user_id = $1
      ORDER BY order_date DESC
    `, [userId]);
    
    // Perform data integrity checks
    const checks = {
      totalReceipts: receipts.rows.length,
      receiptsWithAmount: receipts.rows.filter((r: any) => r.amount_spent > 0).length,
      refundedReceipts: receipts.rows.filter((r: any) => r.amount_spent === 0).length,
      receiptsWithRestaurant: receipts.rows.filter((r: any) => r.restaurant_name).length,
      receiptsWithDate: receipts.rows.filter((r: any) => r.order_date).length,
      receiptsWithItems: receipts.rows.filter((r: any) => r.items && (Array.isArray(r.items) ? r.items : JSON.parse(r.items)).length > 0).length,
      csvImportedReceipts: receipts.rows.filter((r: any) => r.email_from === 'uber-csv-import').length,
      totalAmount: receipts.rows.reduce((sum: number, r: any) => sum + parseFloat(r.amount_spent), 0),
      duplicateRestaurants: new Set(receipts.rows.map((r: any) => r.restaurant_name)).size,
      dateRange: {
        earliest: receipts.rows.length > 0 ? Math.min(...receipts.rows.map((r: any) => new Date(r.order_date).getTime())) : null,
        latest: receipts.rows.length > 0 ? Math.max(...receipts.rows.map((r: any) => new Date(r.order_date).getTime())) : null
      }
    };
    
    // Check for potential issues
    const issues = [];
    const refundedReceipts = checks.totalReceipts - checks.receiptsWithAmount;
    if (refundedReceipts > 0) {
      issues.push(`${refundedReceipts} receipts have zero amount (likely refunded orders)`);
    }
    if (checks.receiptsWithRestaurant !== checks.totalReceipts) {
      issues.push(`${checks.totalReceipts - checks.receiptsWithRestaurant} receipts missing restaurant name`);
    }
    if (checks.receiptsWithDate !== checks.totalReceipts) {
      issues.push(`${checks.totalReceipts - checks.receiptsWithDate} receipts missing order date`);
    }
    
    res.json({
      userId,
      dataIntegrity: {
        checks,
        issues,
        status: issues.length === 0 ? 'PASS' : 'WARN'
      },
      sampleReceipts: receipts.rows.slice(0, 5).map((row: any) => ({
        restaurantName: row.restaurant_name,
        orderDate: row.order_date,
        amountSpent: parseFloat(row.amount_spent),
        itemCount: row.items ? (typeof row.items === 'string' ? JSON.parse(row.items) : row.items).length : 0,
        emailFrom: row.email_from
      }))
    });
    
  } catch (error) {
    console.error('CSV verification error:', error);
    res.status(500).json({ 
      error: 'Failed to verify CSV data', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

// GET /validation/database/health - Check database health and statistics
router.get('/database/health', async (req: Request, res: Response) => {
  try {
    // Get database statistics
    const dbStats = await postgresService.query(`
      SELECT 
        (SELECT COUNT(*) FROM users) as total_users,
        (SELECT COUNT(*) FROM receipts) as total_receipts,
        (SELECT COUNT(DISTINCT user_id) FROM receipts) as users_with_receipts,
        (SELECT SUM(amount_spent) FROM receipts) as total_amount_all_users,
        (SELECT AVG(amount_spent) FROM receipts) as average_receipt_amount
    `);
    
    // Get table sizes
    const tableSizes = await postgresService.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as size
      FROM pg_tables 
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);
    
    // Get recent activity
    const recentActivity = await postgresService.query(`
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
    
    const stats = dbStats.rows[0];
    
    res.json({
      database: {
        totalUsers: parseInt(stats.total_users),
        totalReceipts: parseInt(stats.total_receipts),
        usersWithReceipts: parseInt(stats.users_with_receipts),
        totalAmountAllUsers: parseFloat(stats.total_amount_all_users),
        averageReceiptAmount: parseFloat(stats.average_receipt_amount)
      },
      tableSizes: tableSizes.rows.map((row: any) => ({
        table: row.tablename,
        size: row.size
      })),
      recentActivity: recentActivity.rows.map((row: any) => ({
        table: row.table_name,
        recentCount: parseInt(row.recent_count)
      })),
      health: {
        status: 'HEALTHY',
        timestamp: new Date().toISOString()
      }
    });
    
  } catch (error) {
    console.error('Database health check error:', error);
    res.status(500).json({ 
      error: 'Failed to check database health', 
      details: error instanceof Error ? error.message : 'Unknown error' 
    });
  }
});

export default router;
