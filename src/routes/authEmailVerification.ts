import { RequestHandler, Router } from 'express';
import { ValidationError } from '../core/errors';
import { requireStringField } from '../http/validation/requestValues';
import { asyncHandler } from '../middleware/errorHandler';
import { validateEmail } from '../middleware/validation';
import { EmailVerificationService } from '../services/auth/EmailVerificationService';

export interface EmailVerificationRouterDependencies {
  readonly verification: Pick<EmailVerificationService, 'send' | 'confirm'>;
  readonly rateLimitSend: RequestHandler;
  readonly rateLimitConfirmation: RequestHandler;
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

export const createEmailVerificationRouter = (
  dependencies: EmailVerificationRouterDependencies,
): Router => {
  const router = Router();
  router.post(
    '/send',
    dependencies.rateLimitSend,
    asyncHandler(async (req, res) => {
      await dependencies.verification.send(emailField(req.body));
      res.status(200).json({
        success: true,
        expiresIn: 60,
        message: 'Verification code sent to your email',
      });
    }),
  );
  router.post(
    '/confirm',
    dependencies.rateLimitConfirmation,
    asyncHandler(async (req, res) => {
      await dependencies.verification.confirm(emailField(req.body), codeField(req.body));
      res.status(200).json({ success: true, message: 'Email verified successfully' });
    }),
  );
  return router;
};
