import { Request, RequestHandler, Response, Router } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { asyncHandler } from '../middleware/errorHandler';
import type { HistoricalGmailImportService } from '../services/import/HistoricalGmailImportService';
import type { ImportStatusService } from '../services/import/ImportStatusService';

export interface GmailImportRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly status: Pick<ImportStatusService, 'getConnection'>;
  readonly historicalImport: Pick<HistoricalGmailImportService, 'execute' | 'isInProgress'>;
}

export const createGmailImportRouter = (dependencies: GmailImportRouterDependencies): Router => {
  const router = Router();

  /** @swagger
   * /gmail/status:
   *   get:
   *     summary: Get the authenticated user's Gmail connection status
   *     tags: [Gmail Integration]
   *     security: [{ BearerAuth: [] }]
   *     responses:
   *       200: { description: Canonical Gmail connection status }
   *       401: { $ref: '#/components/responses/Unauthorized' }
   */
  router.get(
    '/status',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const { status } = await dependencies.status.getConnection(authenticatedUserId(request));
      response.json(status);
    }),
  );

  /** @swagger
   * /gmail/import/status:
   *   get:
   *     summary: Check whether this user's receipt writer is occupied by an import
   *     tags: [Gmail Integration]
   *     security: [{ BearerAuth: [] }]
   *     responses:
   *       200: { description: Import activity status }
   *       401: { $ref: '#/components/responses/Unauthorized' }
   */
  router.get(
    '/import/status',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json({
        inProgress: await dependencies.historicalImport.isInProgress(authenticatedUserId(request)),
      });
    }),
  );

  /** @swagger
   * /gmail/import:
   *   post:
   *     summary: Run an explicit historical supported-receipt import from Gmail
   *     tags: [Gmail Integration]
   *     security: [{ BearerAuth: [] }]
   *     responses:
   *       200: { description: Canonical import operation result }
   *       401: { $ref: '#/components/responses/Unauthorized' }
   *       409: { $ref: '#/components/responses/Conflict' }
   */
  router.post(
    '/import',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      request.setTimeout(600_000);
      const result = await dependencies.historicalImport.execute(authenticatedUserId(request));
      response.json({
        success: result.success,
        totalEmailsFound: result.totalEmailsFound,
        totalReceiptsProcessed: result.totalReceiptsProcessed,
        emailsExamined: result.emailsExamined,
        supportedReceiptsFound: result.supportedReceiptsFound,
        exportCoveredReceipts: result.exportCoveredReceipts,
        eligibleReceipts: result.eligibleReceipts,
        deduplicatedReceipts: result.deduplicatedReceipts,
        totalReceiptsImported: result.totalReceiptsImported,
        newOrders: result.newOrders,
        updatedOrders: result.updatedOrders,
        unchangedOrders: result.unchangedOrders,
        totalAmount: result.totalAmount,
        errors: result.errors,
        code: result.errorCode,
      });
    }),
  );

  return router;
};
