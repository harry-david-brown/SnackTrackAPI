import { Request, RequestHandler, Response, Router } from 'express';
import { ValidationError } from '../core/errors';
import { asyncHandler } from '../middleware/errorHandler';
import {
  GMAIL_CONNECTION_PURPOSES,
  GmailConnectionPurpose,
} from '../services/import/GmailConnectionContracts';
import type { GmailConnectionService } from '../services/import/GmailConnectionService';
import {
  optionalBooleanField,
  optionalQueryString,
  requireObject,
  requireStringField,
} from '../http/validation/requestValues';
import { authenticatedUserId } from '../http/authenticatedUser';

interface GmailOAuthRouterContext {
  readonly authenticate: RequestHandler;
  readonly connections: Pick<
    GmailConnectionService,
    'createAuthorizationUrl' | 'completeAuthorization' | 'finishAuthorization' | 'failureRedirect' | 'disconnect'
  >;
  readonly logger: {
    info(message: string, metadata: Readonly<Record<string, unknown>>): void;
    warn(message: string, metadata: Readonly<Record<string, unknown>>): void;
  };
}

const isPurpose = (value: unknown): value is GmailConnectionPurpose =>
  typeof value === 'string' && GMAIL_CONNECTION_PURPOSES.includes(value as GmailConnectionPurpose);

/** Focused HTTP adapter for Gmail connect, callback, and disconnect operations. */
export const createGmailOAuthRouter = ({
  authenticate,
  connections,
  logger,
}: GmailOAuthRouterContext): Router => {
  const router = Router();

  router.post(
    '/auth-url',
    authenticate,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = authenticatedUserId(req);
      const body = requireObject(req.body as unknown);
      const redirectUri = requireStringField(body, 'redirectUri');
      if (redirectUri.length > 2048)
        throw new ValidationError('redirectUri is too long', 'redirectUri');
      const purpose = body.purpose;
      if (purpose !== undefined && !isPurpose(purpose)) {
        throw new ValidationError('purpose is invalid', 'purpose');
      }
      res.json({
        success: true,
        authUrl: await connections.createAuthorizationUrl(userId, redirectUri, purpose,
          requireStringField(body, 'handoffChallenge'), req.user?.sessionVersion ?? 0),
      });
    }),
  );

  router.post('/complete', authenticate, asyncHandler(async (req, res) => {
    await connections.finishAuthorization(authenticatedUserId(req),
      requireStringField(req.body, 'completionToken'), requireStringField(req.body, 'verifier'));
    res.json({ success: true, message: 'Gmail connected successfully' });
  }));

  router.get(
    '/callback',
    asyncHandler(async (req: Request, res: Response) => {
      const state = optionalQueryString(req.query.state, 'state');
      try {
        if (!state) throw new ValidationError('Missing OAuth state', 'state');
        const result = await connections.completeAuthorization(
          state,
          optionalQueryString(req.query.code, 'code'),
          optionalQueryString(req.query.error, 'error'),
        );
        res.set('Cache-Control', 'no-store');
        res.set('Referrer-Policy', 'no-referrer');
        res.redirect(result.redirectUri);
      } catch (error) {
        logger.warn('Gmail OAuth callback failed', {
          operation: 'gmail_oauth_callback',
          outcome: 'failure',
          error,
        });
        res.redirect(connections.failureRedirect(state, error));
      }
    }),
  );

  /**
   * @swagger
   * /gmail/disconnect:
   *   post:
   *     summary: Disconnect Gmail account
   *     tags: [Gmail Integration]
   *     security:
   *       - BearerAuth: []
   *     responses:
   *       200:
   *         description: Gmail disconnected successfully
   */
  router.post(
    '/disconnect',
    authenticate,
    asyncHandler(async (req: Request, res: Response) => {
      const userId = authenticatedUserId(req);
      const resetImportStatus = optionalBooleanField(req.body, 'resetImportStatus') ?? false;
      await connections.disconnect(userId, resetImportStatus);
      logger.info('Gmail disconnected', {
        userId,
        operation: 'gmail_disconnect',
        outcome: 'success',
      });
      res.json({ success: true, message: 'Gmail account disconnected successfully' });
    }),
  );

  return router;
};
