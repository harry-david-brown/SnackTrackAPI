import { Request, RequestHandler, Response, Router } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { optionalIntegerField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import type { ManualTrackingCheckService } from '../services/import/ManualTrackingCheckService';
import type { OngoingTrackingService } from '../services/import/OngoingTrackingService';

export interface GmailTrackingRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly validateScheduler: RequestHandler;
  readonly manualCheck: Pick<ManualTrackingCheckService, 'execute'>;
  readonly scheduledTracking: Pick<OngoingTrackingService, 'runEligibleBatch'>;
}

export const createGmailTrackingRouter = (
  dependencies: GmailTrackingRouterDependencies,
): Router => {
  const router = Router();
  router.post(
    '/tracking/check',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json(await dependencies.manualCheck.execute(authenticatedUserId(request)));
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
      response.json(await dependencies.scheduledTracking.runEligibleBatch(requestedLimit ?? 100));
    }),
  );
  return router;
};
