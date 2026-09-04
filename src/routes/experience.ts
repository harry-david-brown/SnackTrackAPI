import { Router, type RequestHandler } from 'express';
import { authenticatedUserId } from '../http/authenticatedUser';
import { requireObject, requireStringField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import type { ExperienceStateService } from '../services/experience/ExperienceStateService';

export const createExperienceRouter = ({
  authenticate,
  experience,
}: {
  readonly authenticate: RequestHandler;
  readonly experience: Pick<ExperienceStateService, 'get' | 'markFirstRecapSeen'>;
}): Router => {
  const router = Router();
  router.use(authenticate);
  router.get('/state', asyncHandler(async (request, response) => {
    response.set('Cache-Control', 'private, no-cache');
    response.json(await experience.get(authenticatedUserId(request)));
  }));
  router.put('/first-recap/seen', asyncHandler(async (request, response) => {
    const version = requireStringField(requireObject(request.body as unknown), 'version');
    response.json(await experience.markFirstRecapSeen(authenticatedUserId(request), version));
  }));
  return router;
};
