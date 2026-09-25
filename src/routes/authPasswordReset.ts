import { RequestHandler, Router } from 'express';
import { ValidationError } from '../core/errors';
import { requireStringField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import { validateEmail } from '../middleware/validation';
import { PasswordResetService } from '../services/auth/PasswordResetService';

export interface PasswordResetRouterDependencies {
  readonly passwords: Pick<PasswordResetService, 'request' | 'verify' | 'complete'>;
  readonly rateLimitRequestByIp: RequestHandler;
  readonly rateLimitRequestByEmail: RequestHandler;
  readonly rateLimitVerification: RequestHandler;
}

const emailField = (body: unknown): string => {
  const email = requireStringField(body, 'email');
  if (!validateEmail(email)) throw new ValidationError('Invalid email format', 'email');
  return email;
};

const codeField = (body: unknown): string => {
  const code = requireStringField(body, 'code');
  if (!/^\d{6}$/.test(code)) throw new ValidationError('Must be a 6-digit code', 'code');
  return code;
};

export const createPasswordResetRouter = (
  dependencies: PasswordResetRouterDependencies,
): Router => {
  const router = Router();
  router.post(
    '/request',
    dependencies.rateLimitRequestByIp,
    dependencies.rateLimitRequestByEmail,
    asyncHandler(async (req, res) => {
      res.status(200).json(await dependencies.passwords.request(emailField(req.body)));
    }),
  );
  router.post(
    '/verify',
    dependencies.rateLimitVerification,
    asyncHandler(async (req, res) => {
      await dependencies.passwords.verify(emailField(req.body), codeField(req.body));
      res.status(200).json({ success: true, message: 'Code verified successfully', expiresIn: 60 });
    }),
  );
  router.post(
    '/complete',
    dependencies.rateLimitVerification,
    asyncHandler(async (req, res) => {
      await dependencies.passwords.complete(
        emailField(req.body),
        codeField(req.body),
        requireStringField(req.body, 'newPassword', { trim: false }),
      );
      res.status(200).json({ success: true, message: 'Password reset successfully' });
    }),
  );
  return router;
};
