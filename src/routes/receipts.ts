import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { ReceiptType } from '../models/Receipt';
import { PostgresService } from '../services/data/PostgresService';
import { ReceiptService, ReceiptFilters } from '../services/receipt/ReceiptService';
import { paginationMiddleware, parsePagination, createPaginatedResponse } from '../middleware/pagination';
import { authenticateToken, validateOwnership } from '../middleware/auth';
import { ValidationError } from '../middleware/errorHandler';

const router = Router();
const postgresService = container.postgres;
const receiptService = new ReceiptService(postgresService);

// Apply pagination middleware to all routes
router.use(paginationMiddleware);

/**
 * @swagger
 * /receipts:
 *   get:
 *     summary: Get receipts (requires authentication)
 *     description: Retrieve receipts with optional filtering and pagination. Requires JWT authentication. Users can only query their own receipts (userId must match authenticated user).
 *     tags: [Receipts]
 *     security:
 *       - BearerAuth: []
 *     parameters:
 *       - in: query
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: User ID (required, must match authenticated user)
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
// Requires authentication - users can only query their own receipts
router.get('/', authenticateToken, async (req: Request, res: Response) => {
  try {
    const filters: ReceiptFilters = {};
    const { page, limit, offset } = parsePagination(req);

    // Require userId filter and ensure it matches authenticated user
    if (!req.query.userId) {
      throw new ValidationError('userId query parameter is required');
    }
    
    const requestedUserId = req.query.userId as string;
    
    // Ensure user can only query their own receipts
    if (req.user?.userId !== requestedUserId) {
      throw new ValidationError('You can only query your own receipts');
    }
    
    filters.userId = requestedUserId;
    if (req.query.receiptType) filters.receiptType = req.query.receiptType as ReceiptType;
    if (req.query.restaurantName) filters.restaurantName = req.query.restaurantName as string;
    if (req.query.startDate) filters.startDate = new Date(req.query.startDate as string);
    if (req.query.endDate) filters.endDate = new Date(req.query.endDate as string);
    if (req.query.minAmount) filters.minAmount = parseFloat(req.query.minAmount as string);
    if (req.query.maxAmount) filters.maxAmount = parseFloat(req.query.maxAmount as string);

    const receipts = await receiptService.getReceipts(filters, limit, offset);
    
    // Ensure items are properly serialized as arrays
    const serializedReceipts = receipts.map(receipt => {
      const receiptObj = receipt.toApiResponse ? receipt.toApiResponse() : receipt;
      // Ensure items is always an array
      if (!Array.isArray(receiptObj.items)) {
        receiptObj.items = [];
      }
      return receiptObj;
    });
    
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
    
    res.json(createPaginatedResponse(serializedReceipts, total, page, limit));
  } catch (err) {
    console.error('Error fetching receipts:', err);
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const errorDetails = err instanceof Error ? err.stack : String(err);
    console.error('Error details:', errorDetails);
    res.status(500).json({ 
      error: 'Failed to fetch receipts',
      message: errorMessage
    });
  }
});

export default router;