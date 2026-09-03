import { Router } from 'express';
import type { RequestHandler } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { AppError } from '../core/errors';
import { asyncHandler } from '../middleware/errorHandler';
import type { AnalyticsEventService } from '../services/analytics/AdminAnalyticsService';

export const createAnalyticsEventsRouter = (dependencies: {
  authenticate: RequestHandler;
  events: Pick<AnalyticsEventService, 'ingest'>;
}): Router => {
  const router = Router();
  router.post('/batch', dependencies.authenticate, asyncHandler(async (request, response) => {
    if (Buffer.byteLength(JSON.stringify(request.body ?? null), 'utf8') > 64 * 1024) {
      throw new AppError({ code: 'PAYLOAD_TOO_LARGE', message: 'Analytics batch exceeds 64 KB' });
    }
    const body = request.body as { events?: unknown } | undefined;
    response.status(202).json(await dependencies.events.ingest(authenticatedUserId(request), body?.events));
  }));
  return router;
};
