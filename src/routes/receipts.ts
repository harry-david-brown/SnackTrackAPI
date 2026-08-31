import { Router, Request, Response } from 'express';
import { container } from '../services/core/ServiceContainer';
import { ReceiptType } from '../models/Receipt';
import { ReceiptListFilters } from '../services/data/ReceiptRepository';
import { paginationMiddleware, parsePagination, createPaginatedResponse } from '../middleware/pagination';
import { authenticateToken } from '../middleware/auth';
import {
  asyncHandler,
  AuthenticationError,
  AuthorizationError,
  ValidationError,
} from '../middleware/errorHandler';

const router = Router();
const receiptTypes = new Set<string>(Object.values(ReceiptType));
const isReceiptType = (value: string): value is ReceiptType => receiptTypes.has(value);

const queryString = (value: unknown, field: string): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ValidationError('Must be a string', field);
  const normalized = value.trim();
  return normalized || undefined;
};

const queryNumber = (value: unknown, field: string): number | undefined => {
  const text = queryString(value, field);
  if (text === undefined) return undefined;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) throw new ValidationError('Must be a finite number', field);
  return parsed;
};

const queryDate = (value: unknown, field: string): Date | undefined => {
  const text = queryString(value, field);
  if (text === undefined) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) throw new ValidationError('Must be a valid date', field);
  return parsed;
};

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
router.get('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const authenticatedUserId = req.user?.userId;
  if (!authenticatedUserId) throw new AuthenticationError();

  // `userId` is accepted temporarily for released clients, but identity comes
  // exclusively from the verified access token.
  const requestedUserId = queryString(req.query.userId, 'userId');
  if (requestedUserId && requestedUserId !== authenticatedUserId) {
    throw new AuthorizationError('You can only query your own receipts');
  }

  const receiptType = queryString(req.query.receiptType, 'receiptType');
  let normalizedReceiptType: ReceiptType | undefined;
  if (receiptType) {
    if (!isReceiptType(receiptType)) {
      throw new ValidationError('Unsupported receipt type', 'receiptType');
    }
    normalizedReceiptType = receiptType;
  }
  const filters: ReceiptListFilters = {
    userId: authenticatedUserId,
    receiptType: normalizedReceiptType,
    restaurantName: queryString(req.query.restaurantName, 'restaurantName'),
    startDate: queryDate(req.query.startDate, 'startDate'),
    endDate: queryDate(req.query.endDate, 'endDate'),
    minAmount: queryNumber(req.query.minAmount, 'minAmount'),
    maxAmount: queryNumber(req.query.maxAmount, 'maxAmount'),
  };
  const { page, limit, offset } = parsePagination(req);
  const result = await container.listReceiptsService.execute({ filters, limit, offset });

  res.json(createPaginatedResponse(
    result.receipts.map((receipt) => receipt.toApiResponse()),
    result.total,
    page,
    limit
  ));
}));

/**
 * @swagger
 * /receipts:
 *   delete:
 *     summary: Delete all receipts for the authenticated user
 *     description: Permanently delete all receipts belonging to the authenticated user.
 *     tags: [Receipts]
 *     security:
 *       - BearerAuth: []
 *     responses:
 *       200:
 *         description: Receipts deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Deleted 42 receipts
 *                 deletedCount:
 *                   type: integer
 *                   example: 42
 *       400:
 *         $ref: '#/components/responses/ValidationError'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 *       500:
 *         description: Internal server error
 */
router.delete('/', authenticateToken, asyncHandler(async (req: Request, res: Response) => {
  const authenticatedUserId = req.user?.userId;

  if (!authenticatedUserId) {
    throw new AuthenticationError('Authentication required');
  }

  const { deletedReceipts: deletedCount } = await container.receiptClearService
    .clearReceipts(authenticatedUserId);

  res.json({
    success: true,
    message: deletedCount > 0
      ? `Deleted ${deletedCount} receipt${deletedCount === 1 ? '' : 's'}`
      : 'No receipts found to delete',
    deletedCount,
  });
}));

export default router;
