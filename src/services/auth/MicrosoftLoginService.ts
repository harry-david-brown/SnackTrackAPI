import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { AppError, AuthenticationError, ConflictError } from '../../core/errors';
import type { AuthResponse } from '../../models/Token';
import type { User } from '../../models/User';
import type { StructuredLogger } from '../core/StructuredLogger';
import type { MicrosoftLoginAttemptRepository } from '../data/MicrosoftLoginAttemptRepository';
import type { AuthenticationActivityPort, OAuthIdentityPort, TransactionalEmailPort, VerificationCodePort } from '../ports/AuthPorts';
import type { AuthTokenPort } from '../ports/AuthPorts';
import { mapAuthResponse } from './AuthResponseMapper';
import type { MicrosoftIdentityVerifierPort } from './MicrosoftIdentity';
import { MicrosoftIdentityVerificationError } from './MicrosoftIdentityVerifier';

export interface MicrosoftLoginAttemptResponse {
  readonly attemptToken: string;
  readonly nonce: string;
  readonly expiresIn: number;
}

export type MicrosoftLoginResult =
  | { readonly status: 'authenticated'; readonly session: AuthResponse }
  | {
      readonly status: 'email_verification_required';
      readonly attemptToken: string;
      readonly suggestedEmail?: string;
    };

const ATTEMPT_EXPIRY_SECONDS = 10 * 60;
const VERIFICATION_EXPIRY_SECONDS = 15 * 60;
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

export class MicrosoftLoginService {
  constructor(
    private readonly enabled: boolean,
    private readonly attempts: MicrosoftLoginAttemptRepository,
    private readonly identities: MicrosoftIdentityVerifierPort | null,
    private readonly oauthAccounts: OAuthIdentityPort,
    private readonly codes: Pick<VerificationCodePort, 'storeScopedOTP' | 'consumeScopedOTP'>,
    private readonly email: TransactionalEmailPort,
    private readonly tokens: Pick<AuthTokenPort, 'generateTokens'>,
    private readonly logger: StructuredLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly activity?: AuthenticationActivityPort,
  ) {}

  async createAttempt(): Promise<MicrosoftLoginAttemptResponse> {
    this.requireConfigured();
    await this.attempts.cleanupExpired();
    const attemptToken = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const expiresAt = new Date(this.now().getTime() + ATTEMPT_EXPIRY_SECONDS * 1000);
    await this.attempts.create(uuidv4(), hash(attemptToken), hash(nonce), expiresAt);
    return { attemptToken, nonce, expiresIn: ATTEMPT_EXPIRY_SECONDS };
  }

  async login(identityToken: string, attemptToken: string): Promise<MicrosoftLoginResult> {
    const identities = this.requireConfigured();
    const attempt = await this.activeAttempt(attemptToken);
    if (attempt.status === 'email_verification_required' && attempt.providerUserId) {
      return {
        status: 'email_verification_required',
        attemptToken,
        suggestedEmail: attempt.suggestedEmail,
      };
    }

    let identity;
    try {
      identity = await identities.verify(identityToken, attempt.nonceHash);
    } catch (error) {
      const mapped =
        error instanceof MicrosoftIdentityVerificationError
          ? new AuthenticationError(
              'Microsoft sign-in could not be verified. Please try again.',
              'MICROSOFT_TOKEN_INVALID',
            )
          : new AppError({
              code: 'MICROSOFT_AUTH_UNAVAILABLE',
              message: 'Microsoft identity verification is unavailable',
              publicMessage: 'Microsoft sign-in is temporarily unavailable. Please try again.',
              cause: error,
            });
      this.logger.warn('Microsoft identity authentication failed', {
        operation: 'microsoft_login',
        outcome: 'failure',
        errorCode: mapped.code,
      });
      throw mapped;
    }

    const linked = await this.oauthAccounts.findByProvider('microsoft', identity.providerUserId);
    if (linked) {
      const user = await this.attempts.complete(
        attempt.id,
        identity.providerUserId,
        identity.emailVerified ? identity.email : undefined,
      );
      return { status: 'authenticated', session: await this.issueSession(user) };
    }
    if (identity.emailVerified && identity.email) {
      const user = await this.attempts.complete(
        attempt.id,
        identity.providerUserId,
        identity.email,
      );
      return { status: 'authenticated', session: await this.issueSession(user) };
    }

    const unverifiedEmail = identity.email ?? identity.suggestedEmail;
    if (unverifiedEmail) {
      const user = await this.attempts.completeUnverifiedNewAccount(
        attempt.id,
        identity.providerUserId,
        unverifiedEmail,
      );
      if (user) {
        return { status: 'authenticated', session: await this.issueSession(user) };
      }
    }

    await this.attempts.requireEmailVerification(
      attempt.id,
      identity.providerUserId,
      identity.suggestedEmail,
    );
    return {
      status: 'email_verification_required',
      attemptToken,
      suggestedEmail: identity.suggestedEmail,
    };
  }

  async sendVerificationEmail(
    attemptToken: string,
    emailAddress: string,
  ): Promise<{ success: true; expiresIn: number; resendAfter: number }> {
    this.requireConfigured();
    const attempt = await this.activeAttempt(attemptToken);
    if (attempt.status !== 'email_verification_required' || !attempt.providerUserId) {
      throw this.expiredAttempt();
    }
    const normalizedEmail = emailAddress.toLowerCase().trim();
    await this.attempts.setVerificationEmail(attempt.id, normalizedEmail);
    const code = await this.codes.storeScopedOTP(attempt.id, normalizedEmail, 'provider_login');
    await this.email.sendProviderLoginVerificationEmail(normalizedEmail, code);
    return { success: true, expiresIn: VERIFICATION_EXPIRY_SECONDS, resendAfter: 60 };
  }

  async confirmVerificationEmail(
    attemptToken: string,
    emailAddress: string,
    code: string,
  ): Promise<AuthResponse> {
    this.requireConfigured();
    const attempt = await this.activeAttempt(attemptToken);
    const normalizedEmail = emailAddress.toLowerCase().trim();
    if (
      attempt.status !== 'email_verification_required' ||
      !attempt.providerUserId ||
      attempt.suggestedEmail !== normalizedEmail
    ) {
      throw this.expiredAttempt();
    }

    let completedUser: User | undefined;
    const result = await this.codes.consumeScopedOTP(
      attempt.id,
      normalizedEmail,
      code,
      'provider_login',
      async (transaction) => {
        completedUser = await this.attempts.completeWithExecutor(
          attempt.id,
          attempt.providerUserId as string,
          normalizedEmail,
          transaction,
        );
      },
    );
    if (result === 'not_pending') {
      throw new AppError({
        code: 'VERIFICATION_CODE_NOT_PENDING',
        message: 'No active Microsoft sign-in verification code was found.',
      });
    }
    if (result === 'invalid' || !completedUser) {
      throw new AuthenticationError(
        'The verification code is invalid or expired.',
        'VERIFICATION_CODE_INVALID',
      );
    }
    return this.issueSession(completedUser);
  }

  private async issueSession(user: User): Promise<AuthResponse> {
    await this.activity?.recordSuccess(user.id, 'microsoft', 'signed_in');
    return mapAuthResponse(user, this.tokens.generateTokens(user));
  }

  private requireConfigured(): MicrosoftIdentityVerifierPort {
    if (!this.enabled || !this.identities) {
      throw new AppError({
        code: 'MICROSOFT_AUTH_UNAVAILABLE',
        message: 'Microsoft login is not configured',
        publicMessage: 'Microsoft sign-in is not available yet.',
      });
    }
    return this.identities;
  }

  private async activeAttempt(attemptToken: string) {
    if (attemptToken.length < 32 || attemptToken.length > 256) throw this.expiredAttempt();
    const attempt = await this.attempts.findActiveByTokenHash(hash(attemptToken));
    if (!attempt) throw this.expiredAttempt();
    return attempt;
  }

  private expiredAttempt(): ConflictError {
    return new ConflictError(
      'MICROSOFT_ATTEMPT_EXPIRED',
      'Microsoft sign-in expired. Please try again.',
    );
  }
}
