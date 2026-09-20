import { Router, Request, RequestHandler, Response } from 'express';
import { parsePagination } from '../middleware/pagination';
import { asyncHandler } from '../middleware/errorHandler';
import { parseReceiptListFilters } from '../http/validation/receiptListFilters';
import { mapReceiptPageResponse } from '../http/mappers/receiptResponse';
import { authenticatedUserId } from '../http/authenticatedUser';
import type { ListReceiptsService } from '../services/receipt/ListReceiptsService';
import type { ReceiptClearService } from '../services/account/ReceiptClearService';

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
   *         description: Inclusive local order day (YYYY-MM-DD), using the event timezone then account timezone. ISO timestamps with an explicit timezone filter instants instead.
   *       - in: query
   *         name: endDate
   *         schema:
   *           type: string
   *           format: date
   *         description: Inclusive local order day, including the entire end day. Unlinked adjustments have no order day.
   *       - in: query
   *         name: outcome
   *         schema:
   *           type: string
   *           enum: [delivered, canceled, refunded, possible_refund, failed, unfulfilled, needs_review, unknown_cost]
   *         description: Canonical outcome filter. Confirmed and possible refunds are separate; unknown legacy outcomes are not inferred.
   *       - in: query
   *         name: currencyCode
   *         schema:
   *           type: string
   *           enum: [CAD, USD, EUR, GBP, UNKNOWN]
   *         description: Recorded currency; no conversion is performed.
   *       - in: query
   *         name: minAmount
   *         schema:
   *           type: number
   *           format: float
   *         description: Minimum known net order cost. Unknown costs and unlinked adjustments are excluded. Without currencyCode the threshold applies separately in each recorded currency.
   *       - in: query
   *         name: maxAmount
   *         schema:
   *           type: number
   *           format: float
   *         description: Maximum known net order cost, not export item subtotal or legacy compatibility zero.
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

      const filters = parseReceiptListFilters(userId, req.query);
      const { page, limit, offset } = parsePagination(req);
      const result = await dependencies.listReceipts.execute({ filters, limit, offset });

      res.json(mapReceiptPageResponse(result.receipts, result.total, page, limit, result.timezone));
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
