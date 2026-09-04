import { Request, RequestHandler, Response, Router } from 'express';
import { Expo } from 'expo-server-sdk';
import { ValidationError } from '../core/errors';
import { authenticatedUserId } from '../http/authenticatedUser';
import { requireObject, requireStringField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import type { ImportJobRepository } from '../services/data/ImportJobRepository';
import type { ImportJobService } from '../services/import/ImportJobService';
import type { PushDeviceRepository } from '../services/notifications/PushDeviceRepository';
import { toImportOperation } from '../services/import/ImportJobTypes';
import type { ImportOperationPresentationService } from '../services/import/ImportOperationPresentationService';

interface ImportsRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly rateLimit: RequestHandler;
  readonly operations: ImportJobRepository;
  readonly jobs: ImportJobService;
  readonly presentation: Pick<ImportOperationPresentationService, 'operation'>;
}

const idempotencyKey = (request: Request): string | undefined => {
  const value = request.get('Idempotency-Key')?.trim();
  if (!value) return undefined;
  if (value.length > 128) throw new ValidationError('Idempotency-Key is too long.');
  return value;
};

export const createImportsRouter = (dependencies: ImportsRouterDependencies): Router => {
  const router = Router();
  router.use(dependencies.authenticate);

  router.get('/active', asyncHandler(async (request: Request, response: Response) => {
    const operation = await dependencies.operations.findActive(authenticatedUserId(request));
    response.json({ operation: operation ? await dependencies.presentation.operation(operation) : null });
  }));
  router.get('/recent', asyncHandler(async (request: Request, response: Response) => {
    const operations = await dependencies.operations.listRecent(authenticatedUserId(request));
    response.json({ operations: await Promise.all(operations.map((operation) => dependencies.presentation.operation(operation))) });
  }));
  router.get('/:id', asyncHandler(async (request: Request, response: Response) => {
    response.json({ operation: await dependencies.presentation.operation(await dependencies.operations.findForUser(authenticatedUserId(request), request.params.id)) });
  }));

  const uploadIntent = (provider: 'uber_eats' | 'doordash') => asyncHandler(async (request: Request, response: Response) => {
    const body = requireObject(request.body as unknown);
    const contentLength = Number(body.contentLength);
    const create = provider === 'uber_eats'
      ? dependencies.jobs.createUberEatsUploadIntent.bind(dependencies.jobs)
      : dependencies.jobs.createDoorDashUploadIntent.bind(dependencies.jobs);
    const result = await create({
      userId: authenticatedUserId(request),
      filename: requireStringField(body, 'filename'),
      contentType: requireStringField(body, 'contentType'),
      contentLength,
      idempotencyKey: idempotencyKey(request),
    });
    response.status(201).json({ ...result, operation: toImportOperation(result.operation) });
  });
  router.post('/exports/uber-eats/upload-intent', dependencies.rateLimit, uploadIntent('uber_eats'));
  router.post('/exports/doordash/upload-intent', dependencies.rateLimit, uploadIntent('doordash'));
  router.post('/:id/upload-url', dependencies.rateLimit, asyncHandler(async (request: Request, response: Response) => {
    const result = await dependencies.jobs.refreshUploadUrl(authenticatedUserId(request), request.params.id);
    response.json({ ...result, operation: toImportOperation(result.operation) });
  }));
  router.post('/:id/submit', dependencies.rateLimit, asyncHandler(async (request: Request, response: Response) => {
    response.status(202).json({ operation: toImportOperation(await dependencies.jobs.submitUpload(authenticatedUserId(request), request.params.id)) });
  }));
  return router;
};

interface NotificationDeviceRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly devices: PushDeviceRepository;
}

export const createNotificationDeviceRouter = (dependencies: NotificationDeviceRouterDependencies): Router => {
  const router = Router();
  router.put('/device', dependencies.authenticate, asyncHandler(async (request: Request, response: Response) => {
    const body = requireObject(request.body as unknown);
    const installationId = requireStringField(body, 'installationId');
    const token = requireStringField(body, 'token');
    const platform = requireStringField(body, 'platform');
    if (installationId.length > 128 || !Expo.isExpoPushToken(token) || (platform !== 'ios' && platform !== 'android')) {
      throw new ValidationError('Invalid notification device registration.');
    }
    await dependencies.devices.upsert(authenticatedUserId(request), installationId, token, platform);
    response.json({ success: true });
  }));
  router.delete('/device/:installationId', dependencies.authenticate, asyncHandler(async (request: Request, response: Response) => {
    await dependencies.devices.disableInstallation(authenticatedUserId(request), request.params.installationId);
    response.status(204).send();
  }));
  return router;
};
