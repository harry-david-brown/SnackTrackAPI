import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { ReceiptType } from '../models/Receipt';
import { PostgresService } from '../services/data/PostgresService';
import { ReceiptService, ReceiptFilters } from '../services/receipt/ReceiptService';
import { paginationMiddleware, parsePagination, createPaginatedResponse } from '../middleware/pagination';

const router = Router();
const postgresService = container.postgres;
const receiptService = new ReceiptService(postgresService);

// Apply pagination middleware to all routes
router.use(paginationMiddleware);

/**
 * @swagger
 * /receipts:
 *   get:
 *     summary: Get all receipts
 *     description: Retrieve receipts with optional filtering and pagination
 *     tags: [Receipts]
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
 *         description: Maximum number of receipts to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *         description: Number of receipts to skip
 *       - in: query
 *         name: userId
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by user ID
 *       - in: query
 *         name: restaurantName
 *         schema:
 *           type: string
 *         description: Filter by restaurant name
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter receipts from this date
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: Filter receipts until this date
 *       - in: query
 *         name: minAmount
 *         schema:
 *           type: number
 *           format: float
 *         description: Minimum amount filter
 *       - in: query
 *         name: maxAmount
 *         schema:
 *           type: number
 *           format: float
 *         description: Maximum amount filter
 *     responses:
 *       200:
 *         description: Receipts retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 receipts:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Receipt'
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                       example: 15420
 *                     limit:
 *                       type: integer
 *                       example: 50
 *                     offset:
 *                       type: integer
 *                       example: 0
 *                     hasMore:
 *                       type: boolean
 *                       example: true
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
// GET /receipts - Get all receipts with optional filters
router.get('/', async (req: Request, res: Response) => {
  try {
    const filters: ReceiptFilters = {};
    const { page, limit, offset } = parsePagination(req);

    // Parse filters from query parameters
    if (req.query.userId) filters.userId = req.query.userId as string;
    if (req.query.receiptType) filters.receiptType = req.query.receiptType as ReceiptType;
    if (req.query.restaurantName) filters.restaurantName = req.query.restaurantName as string;
    if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
    if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
    if (req.query.minAmount) filters.minAmount = parseFloat(req.query.minAmount as string);
    if (req.query.maxAmount) filters.maxAmount = parseFloat(req.query.maxAmount as string);

    const receipts = await receiptService.getReceipts(filters, limit, offset);
    
    // Get total count for pagination (with filters applied)
    // Build WHERE clause for count query to match filters
    let countQuery = 'SELECT COUNT(*) as count FROM receipts WHERE 1=1';
    const countParams: any[] = [];
    let paramIndex = 1;
    
    if (filters.userId) {
        countQuery += ` AND user_id = $${paramIndex}`;
        countParams.push(filters.userId);
        paramIndex++;
    }
    if (filters.startDate) {
        countQuery += ` AND order_date >= $${paramIndex}`;
        countParams.push(filters.startDate);
        paramIndex++;
    }
    if (filters.endDate) {
        countQuery += ` AND order_date <= $${paramIndex}`;
        countParams.push(filters.endDate);
        paramIndex++;
    }
    if (filters.restaurantName) {
        countQuery += ` AND restaurant_name = $${paramIndex}`;
        countParams.push(filters.restaurantName);
        paramIndex++;
    }
    if (filters.minAmount !== undefined) {
        countQuery += ` AND amount_spent >= $${paramIndex}`;
        countParams.push(filters.minAmount);
        paramIndex++;
    }
    if (filters.maxAmount !== undefined) {
        countQuery += ` AND amount_spent <= $${paramIndex}`;
        countParams.push(filters.maxAmount);
        paramIndex++;
    }
    if (filters.receiptType) {
        countQuery += ` AND receipt_type = $${paramIndex}`;
        countParams.push(filters.receiptType);
        paramIndex++;
    }
    
    const totalResult = await postgresService.query(countQuery, countParams);
    const total = parseInt(totalResult.rows[0].count);
    
    res.json(createPaginatedResponse(receipts, total, page, limit));
  } catch (err) {
    console.error('Error fetching receipts:', err);
    res.status(500).json({ error: 'Failed to fetch receipts' });
  }
});

export default router;