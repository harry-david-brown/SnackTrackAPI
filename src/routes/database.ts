import { Router, Request, RequestHandler, Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { parseQueryInteger, requireUuid } from '../http/validation/requestValues';
import type { AdministratorService } from '../services/admin/AdministratorService';
import type { AccountDeletionService } from '../services/account/AccountDeletionService';

export interface DatabaseRouterDependencies {
  readonly authorizeAdministrator: RequestHandler;
  readonly administrator: Pick<AdministratorService, 'listUsers' | 'getDatabaseStatistics'>;
  readonly accountDeletion: Pick<AccountDeletionService, 'deleteAccount'>;
}

export const createDatabaseRouter = (dependencies: DatabaseRouterDependencies): Router => {
  const router = Router();

  // All database routes require API key authentication
  router.use(dependencies.authorizeAdministrator);

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
   *                             description: Stored canonical records, including unresolved candidates and unlinked adjustments. Use receiptSummary for order counts.
   *                             example: 45
   *                           totalSpent:
   *                             type: number
   *                             nullable: true
   *                             deprecated: true
   *                             description: Single-currency net order cost, or null when currencies or unresolved amounts prevent a single total.
   *                             format: float
   *                             example: 1250.75
   *                           currencyCode:
   *                             type: string
   *                             nullable: true
   *                           receiptSummary:
   *                             $ref: '#/components/schemas/AdminReceiptSummary'
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
  router.get(
    '/users',
    asyncHandler(async (req: Request, res: Response) => {
      const limit = parseQueryInteger(req.query.limit, 'limit', {
        defaultValue: 50,
        minimum: 1,
        maximum: 1000,
      })!;
      const offset = parseQueryInteger(req.query.offset, 'offset', {
        defaultValue: 0,
        minimum: 0,
      })!;
      res.json(await dependencies.administrator.listUsers(limit, offset));
    }),
  );

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
   *                       description: Physical canonical record count, not a count of delivered purchases or source documents.
   *                       example: 15420
   *                     usersWithReceipts:
   *                       type: integer
   *                       example: 1180
   *                     totalAmountAllUsers:
   *                       type: number
   *                       nullable: true
   *                       deprecated: true
   *                       description: Single-currency known net order cost, or null for mixed currencies or unresolved amounts. Use receiptSummary.currencies.
   *                       format: float
   *                       example: 125000.75
   *                     averageReceiptAmount:
   *                       type: number
   *                       nullable: true
   *                       deprecated: true
   *                       description: Average net cost per established attempt in currencyCode, not per source document. Null when a single total is unavailable.
   *                       format: float
   *                       example: 8.12
   *                     currencyCode:
   *                       type: string
   *                       nullable: true
   *                     receiptSummary:
   *                       $ref: '#/components/schemas/AdminReceiptSummary'
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
  router.get(
    '/stats',
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await dependencies.administrator.getDatabaseStatistics());
    }),
  );

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
  router.delete(
    '/users/:id',
    asyncHandler(async (req: Request, res: Response) => {
      const userId = requireUuid(req.params.id, 'id');
      await dependencies.accountDeletion.deleteAccount(userId);
      res.json({
        success: true,
        message: 'User and associated data deleted successfully',
      });
    }),
  );

  return router;
};
