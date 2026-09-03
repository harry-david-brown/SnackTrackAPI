import { Request, RequestHandler, Response, Router } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { optionalIntegerField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import type { ManualTrackingCheckService } from '../services/import/ManualTrackingCheckService';
import type { OngoingTrackingService } from '../services/import/OngoingTrackingService';
import type { ImportJobService } from '../services/import/ImportJobService';
import { toImportOperation } from '../services/import/ImportJobTypes';
import type { ScheduledImportJobService } from '../services/import/ScheduledImportJobService';

export interface GmailTrackingRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly validateScheduler: RequestHandler;
  readonly manualCheck: Pick<ManualTrackingCheckService, 'execute'>;
  readonly importJobs: Pick<ImportJobService, 'start'>;
  readonly scheduledTracking: Pick<ScheduledImportJobService, 'enqueueEligible'>;
}

export const createGmailTrackingRouter = (
  dependencies: GmailTrackingRouterDependencies,
): Router => {
  const router = Router();
  router.post(
    '/tracking/check',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const operation = await dependencies.importJobs.start(
        authenticatedUserId(request), 'manual_tracking', 'user', request.get('Idempotency-Key')?.trim(),
      );
      response.status(202).json({ operation: toImportOperation(operation) });
    }),
  );
  router.post(
    '/tracking/run-batch',
    dependencies.validateScheduler,
    asyncHandler(async (request: Request, response: Response) => {
      const requestedLimit = optionalIntegerField(request.body, 'limit', {
        minimum: 1,
        maximum: 500,
      });
      response.status(202).json(await dependencies.scheduledTracking.enqueueEligible(requestedLimit ?? 100));
    }),
  );
  return router;
};
