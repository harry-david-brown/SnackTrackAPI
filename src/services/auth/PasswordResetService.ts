import { AppError, AuthenticationError, NotFoundError, ValidationError } from '../../core/errors';
import { UserModel } from '../../models/User';
import type {
  AuthUserPort,
  TransactionalEmailPort,
  VerificationCodePort,
} from '../ports/AuthPorts';
import { StructuredLogger } from '../core/StructuredLogger';

export interface CodeRequestResult {
  readonly success: true;
  readonly message: string;
  readonly expiresIn: number;
  readonly attemptLimit: number;
}

const normalizeEmail = (email: string): string => email.toLowerCase().trim();

/** Owns the complete password-reset workflow and its anti-enumeration policy. */
export class PasswordResetService {
  constructor(
    private readonly users: Pick<AuthUserPort, 'findByEmail' | 'updatePassword'>,
    private readonly codes: VerificationCodePort,
    private readonly email: TransactionalEmailPort,
    private readonly logger: StructuredLogger,
  ) {}

  async request(email: string): Promise<CodeRequestResult> {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.users.findByEmail(normalizedEmail);
    if (user) {
      const code = await this.codes.storeOTP(normalizedEmail, 'password_reset');
      if (this.email.isEnabled()) await this.email.sendPasswordResetEmail(normalizedEmail, code);
    }
    this.logger.info('Password reset request accepted', {
      operation: 'request_password_reset',
      outcome: 'accepted',
    });
    return {
      success: true,
      message: 'Password reset code sent to your email',
      expiresIn: 60,
      attemptLimit: 5,
    };
  }

  async verify(email: string, code: string): Promise<void> {
    const normalizedEmail = normalizeEmail(email);
    if (!(await this.codes.hasValidCode(normalizedEmail, 'password_reset'))) {
      throw new AppError({
        code: 'VERIFICATION_CODE_NOT_PENDING',
        message: 'No pending password reset request exists',
      });
    }
    if (!(await this.codes.verifyOTP(normalizedEmail, code, 'password_reset', false))) {
      throw new AuthenticationError('Invalid or expired code', 'VERIFICATION_CODE_INVALID');
    }
  }

  async complete(email: string, code: string, newPassword: string): Promise<void> {
    const validation = UserModel.validatePassword(newPassword);
    if (!validation.valid) throw new ValidationError(validation.errors.join('; '), 'newPassword');
    const normalizedEmail = normalizeEmail(email);
    const result = await this.codes.consumeOTP(
      normalizedEmail,
      code,
      'password_reset',
      async (transaction) => {
        const passwordHash = await UserModel.hashPassword(newPassword);
        if (!(await this.users.updatePassword(normalizedEmail, passwordHash, transaction))) {
          throw new NotFoundError('User');
        }
      },
    );
    if (result === 'not_pending') {
      throw new AppError({
        code: 'VERIFICATION_CODE_NOT_PENDING',
        message: 'No pending password reset request exists',
      });
    }
    if (result === 'invalid') {
      throw new AuthenticationError('Invalid or expired code', 'VERIFICATION_CODE_INVALID');
    }
    this.logger.info('Password reset completed', {
      operation: 'complete_password_reset',
      outcome: 'success',
    });
  }
}
