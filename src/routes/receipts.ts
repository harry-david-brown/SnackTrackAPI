import { Router, Request, RequestHandler, Response } from 'express';
import { ReceiptType } from '../models/Receipt';
import type { ReceiptListFilters } from '../services/ports/ReceiptPorts';
import { parsePagination } from '../middleware/pagination';
import { asyncHandler, ValidationError } from '../middleware/errorHandler';
import {
  optionalQueryString,
  parseQueryDate,
  parseQueryNumber,
} from '../http/validation/requestValues';
import { mapReceiptPageResponse } from '../http/mappers/receiptResponse';
import { authenticatedUserId } from '../http/authenticatedUser';
import type { ListReceiptsService } from '../services/receipt/ListReceiptsService';
import type { ReceiptClearService } from '../services/account/ReceiptClearService';

const receiptTypes = new Set<string>(Object.values(ReceiptType));
const isReceiptType = (value: string): value is ReceiptType => receiptTypes.has(value);

export interface ReceiptsRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly paginate: RequestHandler;
  readonly listReceipts: Pick<ListReceiptsService, 'execute'>;
  readonly clearReceipts: Pick<ReceiptClearService, 'clearReceipts'>;
}

export const createReceiptsRouter = (dependencies: ReceiptsRouterDependencies): Router => {
  const router = Router();

  // Apply pagination middleware to all routes
  router.use(dependencies.paginate);

  /**
   * @swagger
   * /receipts:
   *   get:
   *     summary: Get receipts (requires authentication)
   *     description: Retrieve the authenticated user's receipts with optional filtering and pagination.
   *     tags: [Receipts]
   *     security:
   *       - BearerAuth: []
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
   *               $ref: '#/components/schemas/ReceiptPage'
   *       400:
   *         $ref: '#/components/responses/ValidationError'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       500:
   *         description: Internal server error
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // GET /receipts - Get all receipts with optional filters
  // Requires authentication - users can only query their own receipts
  router.get(
    '/',
    dependencies.authenticate,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = authenticatedUserId(req);

      const receiptType = optionalQueryString(req.query.receiptType, 'receiptType');
      let normalizedReceiptType: ReceiptType | undefined;
      if (receiptType) {
        if (!isReceiptType(receiptType)) {
          throw new ValidationError('Unsupported receipt type', 'receiptType');
        }
        normalizedReceiptType = receiptType;
      }
      const filters: ReceiptListFilters = {
        userId,
        receiptType: normalizedReceiptType,
        restaurantName: optionalQueryString(req.query.restaurantName, 'restaurantName'),
        startDate: parseQueryDate(req.query.startDate, 'startDate'),
        endDate: parseQueryDate(req.query.endDate, 'endDate'),
        minAmount: parseQueryNumber(req.query.minAmount, 'minAmount'),
        maxAmount: parseQueryNumber(req.query.maxAmount, 'maxAmount'),
      };
      const { page, limit, offset } = parsePagination(req);
      const result = await dependencies.listReceipts.execute({ filters, limit, offset });

      res.json(mapReceiptPageResponse(result.receipts, result.total, page, limit));
    }),
  );

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
   *               additionalProperties: false
   *               required: [success, message, deletedCount]
   *               properties:
   *                 success: { type: boolean }
   *                 message: { type: string }
   *                 deletedCount: { type: integer, minimum: 0 }
   *       400:
   *         $ref: '#/components/responses/ValidationError'
   *       401:
   *         $ref: '#/components/responses/Unauthorized'
   *       500:
   *         description: Internal server error
   */
  router.delete(
    '/',
    dependencies.authenticate,
    asyncHandler(async (req: Request, res: Response) => {
      const { deletedReceipts: deletedCount } = await dependencies.clearReceipts.clearReceipts(
        authenticatedUserId(req),
      );

      res.json({
        success: true,
        message:
          deletedCount > 0
            ? `Deleted ${deletedCount} receipt${deletedCount === 1 ? '' : 's'}`
            : 'No receipts found to delete',
        deletedCount,
      });
    }),
  );

  return router;
};
