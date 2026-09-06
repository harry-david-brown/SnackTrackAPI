import { Request, RequestHandler, Response, Router } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { asyncHandler } from '../middleware/errorHandler';
import type { ImportJobService } from '../services/import/ImportJobService';
import type { ImportStatusService } from '../services/import/ImportStatusService';
import { isImportJourneyContext, toImportOperation } from '../services/import/ImportJobTypes';
import { ValidationError } from '../core/errors';

export interface GmailImportRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly status: Pick<ImportStatusService, 'getConnection'>;
  readonly historicalImport: { isInProgress(userId: string): Promise<boolean> };
  readonly importJobs: Pick<ImportJobService, 'start'>;
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
      const journeyContext = request.body?.journeyContext ?? 'legacy';
      if (!isImportJourneyContext(journeyContext)) throw new ValidationError('Invalid import journey context.', 'journeyContext');
      const operation = await dependencies.importJobs.start(
        authenticatedUserId(request), 'gmail_historical', 'user', request.get('Idempotency-Key')?.trim(), journeyContext,
      );
      response.status(202).json({ operation: toImportOperation(operation) });
    }),
  );

  return router;
};
