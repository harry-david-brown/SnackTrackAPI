import { Request, RequestHandler, Response, Router } from 'express';
import { ValidationError } from '../core/errors';
import { authenticatedUserId } from '../http/authenticatedUser';
import {
  optionalBooleanField,
  optionalQueryString,
  requireObject,
  requireStringField,
} from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import type { HistoricalOutlookImportService } from '../services/import/HistoricalOutlookImportService';
import type { ImportJobService } from '../services/import/ImportJobService';
import { isImportJourneyContext, toImportOperation } from '../services/import/ImportJobTypes';
import type { MicrosoftMailboxConnectionHealthService } from '../services/mailbox/MicrosoftMailboxConnectionHealthService';
import type { MicrosoftMailboxConnectionService } from '../services/mailbox/MicrosoftMailboxConnectionService';
import {
  MAILBOX_CONNECTION_PURPOSES,
  type MailboxConnectionPurpose,
} from '../services/mailbox/MicrosoftMailboxOAuthProvider';

interface OutlookRouterDependencies {
  readonly authenticate: RequestHandler;
  readonly connections: MicrosoftMailboxConnectionService;
  readonly health: MicrosoftMailboxConnectionHealthService;
  readonly historicalImport: Pick<HistoricalOutlookImportService, 'execute' | 'isInProgress'>;
  readonly importJobs: Pick<ImportJobService, 'start'>;
  readonly logger: {
    info(message: string, metadata: Readonly<Record<string, unknown>>): void;
    warn(message: string, metadata: Readonly<Record<string, unknown>>): void;
  };
}

const isPurpose = (value: unknown): value is MailboxConnectionPurpose =>
  typeof value === 'string' &&
  MAILBOX_CONNECTION_PURPOSES.includes(value as MailboxConnectionPurpose);

export const createOutlookRouter = (dependencies: OutlookRouterDependencies): Router => {
  const router = Router();

  router.post(
    '/auth-url',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const body = requireObject(request.body as unknown);
      const redirectUri = requireStringField(body, 'redirectUri');
      if (redirectUri.length > 2048) {
        throw new ValidationError('redirectUri is too long', 'redirectUri');
      }
      if (body.purpose !== undefined && !isPurpose(body.purpose)) {
        throw new ValidationError('purpose is invalid', 'purpose');
      }
      response.json({
        success: true,
        authUrl: await dependencies.connections.createAuthorizationUrl(
          authenticatedUserId(request),
          redirectUri,
          body.purpose,
          requireStringField(body, 'handoffChallenge'),
          request.user?.sessionVersion ?? 0,
        ),
      });
    }),
  );

  router.post('/complete', dependencies.authenticate, asyncHandler(async (request, response) => {
    await dependencies.connections.finishAuthorization(authenticatedUserId(request),
      requireStringField(request.body, 'completionToken'), requireStringField(request.body, 'verifier'));
    response.json({ success: true, message: 'Outlook connected successfully' });
  }));

  router.get(
    '/callback',
    asyncHandler(async (request: Request, response: Response) => {
      const state = optionalQueryString(request.query.state, 'state');
      try {
        if (!state) throw new ValidationError('Missing OAuth state', 'state');
        const result = await dependencies.connections.completeAuthorization(
          state,
          optionalQueryString(request.query.code, 'code'),
          optionalQueryString(request.query.error, 'error'),
        );
        response.set('Cache-Control', 'no-store');
        response.set('Referrer-Policy', 'no-referrer');
        response.redirect(result.redirectUri);
      } catch (error) {
        dependencies.logger.warn('Outlook OAuth callback failed', {
          operation: 'outlook_oauth_callback',
          provider: 'microsoft',
          outcome: 'failure',
          error,
        });
        response.redirect(dependencies.connections.failureRedirect(state, error));
      }
    }),
  );

  router.get(
    '/status',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const result = await dependencies.health.validate(authenticatedUserId(request));
      response.json(dependencies.health.buildStatus(result.connection, result.health));
    }),
  );

  router.post(
    '/disconnect',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const userId = authenticatedUserId(request);
      const resetImportStatus = optionalBooleanField(request.body, 'resetImportStatus') ?? false;
      await dependencies.connections.disconnect(userId, resetImportStatus);
      dependencies.logger.info('Outlook disconnected', {
        userId,
        operation: 'outlook_disconnect',
        provider: 'microsoft',
        outcome: 'success',
      });
      response.json({ success: true, message: 'Outlook account disconnected successfully' });
    }),
  );

  router.get(
    '/import/status',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      response.json({
        inProgress: await dependencies.historicalImport.isInProgress(authenticatedUserId(request)),
      });
    }),
  );

  router.post(
    '/import',
    dependencies.authenticate,
    asyncHandler(async (request: Request, response: Response) => {
      const journeyContext = request.body?.journeyContext ?? 'legacy';
      if (!isImportJourneyContext(journeyContext)) throw new ValidationError('Invalid import journey context.', 'journeyContext');
      const automaticUpdates = request.body?.automaticUpdates ?? false;
      if (typeof automaticUpdates !== 'boolean') throw new ValidationError('Invalid automatic updates choice.', 'automaticUpdates');
      const operation = await dependencies.importJobs.start(
        authenticatedUserId(request), 'outlook_historical', 'user', request.get('Idempotency-Key')?.trim(), journeyContext, automaticUpdates,
      );
      response.status(202).json({ operation: toImportOperation(operation) });
    }),
  );

  return router;
};
