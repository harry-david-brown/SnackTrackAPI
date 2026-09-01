import { AppError, AuthenticationError, NotFoundError } from '../../core/errors';
import { StructuredLogger } from '../core/StructuredLogger';
import type {
  AuthUserPort,
  TransactionalEmailPort,
  VerificationCodePort,
} from '../ports/AuthPorts';

const normalizeEmail = (email: string): string => email.toLowerCase().trim();

/** Owns verification-code delivery and atomic email verification. */
export class EmailVerificationService {
  constructor(
    private readonly users: Pick<AuthUserPort, 'findByEmail' | 'updateEmailVerified'>,
    private readonly codes: VerificationCodePort,
    private readonly email: TransactionalEmailPort,
    private readonly logger: StructuredLogger,
  ) {}

  async send(email: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.users.findByEmail(normalizedEmail);
    if (!user) throw new NotFoundError('Email');
    if (user.emailVerified) {
      throw new AppError({ code: 'EMAIL_ALREADY_VERIFIED', message: 'Email is already verified' });
    }
    const code = await this.codes.storeOTP(normalizedEmail, 'email_verification');
    if (this.email.isEnabled()) await this.email.sendVerificationEmail(normalizedEmail, code);
    this.logger.info('Email verification code prepared', {
      operation: 'send_email_verification',
      outcome: this.email.isEnabled() ? 'sent' : 'delivery_not_configured',
    });
  }

  async confirm(email: string, code: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    const result = await this.codes.consumeOTP(
      normalizedEmail,
      code,
      'email_verification',
      async (transaction) => {
        if (!(await this.users.updateEmailVerified(normalizedEmail, true, transaction))) {
          throw new NotFoundError('Email');
        }
      },
    );
    if (result === 'not_pending') {
      throw new AppError({
        code: 'VERIFICATION_CODE_NOT_PENDING',
        message: 'No pending email verification request exists',
      });
    }
    if (result === 'invalid') {
      throw new AuthenticationError('Invalid or expired code', 'VERIFICATION_CODE_INVALID');
    }
    this.logger.info('Email verification completed', {
      operation: 'confirm_email_verification',
      outcome: 'success',
    });
  }
}
