import { Router, type RequestHandler } from 'express';
import { ValidationError } from '../core/errors';
import { authenticatedUserId } from '../http/authenticatedUser';
import { asyncHandler } from '../middleware/errorHandler';
import type { AdConfigurationService } from '../services/ads/AdConfigurationService';
import type { AdPlatform } from '../services/ads/AdConfigurationTypes';

export const createAdsRouter = (dependencies: {
  authenticate: RequestHandler;
  configuration: Pick<AdConfigurationService, 'runtime'>;
}): Router => {
  const router = Router();
  router.get('/runtime', dependencies.authenticate, asyncHandler(async (request, response) => {
    const platform = request.query.platform;
    if (platform !== 'ios' && platform !== 'android') {
      throw new ValidationError('Must be ios or android', 'platform');
    }
    response.set('Cache-Control', 'private, no-store');
    response.json(await dependencies.configuration.runtime(
      authenticatedUserId(request),
      platform as AdPlatform,
    ));
  }));
  return router;
};
