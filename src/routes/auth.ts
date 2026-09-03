import { RequestHandler, Router } from 'express';
import { ValidationError } from '../core/errors';
import { authenticatedUserId } from '../http/authenticatedUser';
import { requestTimezone } from '../http/requestTimezone';
import { requireObject, requireStringField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import { validateEmail } from '../middleware/validation';
import { AccountDeletionResult } from '../services/account/AccountDeletionService';
import { CredentialAuthService } from '../services/auth/CredentialAuthService';
import { AppleFirstSignInData, ProviderAuthService } from '../services/auth/ProviderAuthService';
import { SessionService } from '../services/auth/SessionService';
import { MicrosoftLoginService } from '../services/auth/MicrosoftLoginService';
import { getDefaultTimezone } from '../utils/timezone';

export interface AuthAccountDeletionOperation {
  deleteAccount(userId: string, refreshToken?: string): Promise<AccountDeletionResult>;
}

export interface AuthRouterDependencies {
  readonly credentials: Pick<CredentialAuthService, 'register' | 'login'>;
  readonly providers: Pick<ProviderAuthService, 'loginWithGoogle' | 'loginWithApple'>;
  readonly microsoft: Pick<
    MicrosoftLoginService,
    'createAttempt' | 'login' | 'sendVerificationEmail' | 'confirmVerificationEmail'
  >;
  readonly sessions: Pick<SessionService, 'refresh' | 'revoke'>;
  readonly accountDeletion: AuthAccountDeletionOperation;
  readonly authenticate: RequestHandler;
  readonly rateLimitRegistration: RequestHandler;
  readonly rateLimitMicrosoftAttempt: RequestHandler;
  readonly rateLimitMicrosoftEmail: RequestHandler;
  readonly rateLimitMicrosoftConfirmation: RequestHandler;
}

const emailField = (body: unknown): string => {
  const email = requireStringField(body, 'email');
  if (email.length > 255 || !validateEmail(email)) {
    throw new ValidationError('Invalid email format', 'email');
  }
  return email;
};

const optionalRefreshToken = (body: unknown): string | undefined => {
  if (body === undefined) return undefined;
  const record = requireObject(body);
  if (record.refreshToken === undefined) return undefined;
  return requireStringField(body, 'refreshToken');
};

const appleUserData = (body: unknown): AppleFirstSignInData | undefined => {
  const value = requireObject(body).user;
  if (value === undefined) return undefined;
  const user = requireObject(value, 'user');
  const email = user.email === undefined ? undefined : requireStringField(user, 'email');
  const rawName = user.name;
  if (rawName === undefined) return email ? { email } : {};
  const name = requireObject(rawName, 'user.name');
  const firstName =
    name.firstName === undefined ? undefined : requireStringField(name, 'firstName');
  const lastName = name.lastName === undefined ? undefined : requireStringField(name, 'lastName');
  return { ...(email ? { email } : {}), name: { firstName, lastName } };
};

/** Composition-only authentication transport. */
export const createAuthRouter = (dependencies: AuthRouterDependencies): Router => {
  const router = Router();

  router.post(
    '/register',
    dependencies.rateLimitRegistration,
    asyncHandler(async (req, res) => {
      const email = emailField(req.body);
      const password = requireStringField(req.body, 'password', { trim: false });
      const timezone = requestTimezone(req) || getDefaultTimezone();
      res.status(201).json(await dependencies.credentials.register(email, password, timezone));
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (req, res) => {
      const email = emailField(req.body);
      const password = requireStringField(req.body, 'password', { trim: false });
      res.status(200).json(await dependencies.credentials.login(email, password));
    }),
  );

  router.post(
    '/google',
    asyncHandler(async (req, res) => {
      const idToken = requireStringField(req.body, 'idToken');
      res.status(200).json(await dependencies.providers.loginWithGoogle(idToken));
    }),
  );

  router.post(
    '/apple',
    asyncHandler(async (req, res) => {
      const identityToken = requireStringField(req.body, 'identityToken');
      res
        .status(200)
        .json(await dependencies.providers.loginWithApple(identityToken, appleUserData(req.body)));
    }),
  );

  router.post(
    '/microsoft/attempt',
    dependencies.rateLimitMicrosoftAttempt,
    asyncHandler(async (_req, res) => {
      res.status(201).json(await dependencies.microsoft.createAttempt());
    }),
  );

  router.post(
    '/microsoft',
    dependencies.rateLimitMicrosoftAttempt,
    asyncHandler(async (req, res) => {
      const identityToken = requireStringField(req.body, 'identityToken', { trim: false });
      const attemptToken = requireStringField(req.body, 'attemptToken', { trim: false });
      const result = await dependencies.microsoft.login(identityToken, attemptToken);
      if (result.status === 'authenticated') {
        res.status(200).json(result.session);
        return;
      }
      res.status(202).json(result);
    }),
  );

  router.post(
    '/microsoft/email/send',
    dependencies.rateLimitMicrosoftEmail,
    asyncHandler(async (req, res) => {
      const attemptToken = requireStringField(req.body, 'attemptToken', { trim: false });
      res
        .status(200)
        .json(await dependencies.microsoft.sendVerificationEmail(attemptToken, emailField(req.body)));
    }),
  );

  router.post(
    '/microsoft/email/confirm',
    dependencies.rateLimitMicrosoftConfirmation,
    asyncHandler(async (req, res) => {
      const attemptToken = requireStringField(req.body, 'attemptToken', { trim: false });
      const code = requireStringField(req.body, 'code', { trim: false });
      if (!/^\d{6}$/.test(code)) throw new ValidationError('Code must be 6 digits', 'code');
      res
        .status(200)
        .json(
          await dependencies.microsoft.confirmVerificationEmail(
            attemptToken,
            emailField(req.body),
            code,
          ),
        );
    }),
  );

  router.post(
    '/refresh',
    asyncHandler(async (req, res) => {
      const refreshToken = requireStringField(req.body, 'refreshToken');
      res.status(200).json(await dependencies.sessions.refresh(refreshToken));
    }),
  );

  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      const refreshToken = optionalRefreshToken(req.body);
      if (refreshToken) await dependencies.sessions.revoke(refreshToken);
      res.status(200).json({ success: true, message: 'Logged out successfully.' });
    }),
  );

  router.delete(
    '/delete-account',
    dependencies.authenticate,
    asyncHandler(async (req, res) => {
      const userId = authenticatedUserId(req);
      await dependencies.accountDeletion.deleteAccount(userId, optionalRefreshToken(req.body));
      res.status(200).json({ success: true, message: 'Account deleted successfully' });
    }),
  );

  return router;
};
