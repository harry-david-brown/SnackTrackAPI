import type { AuthProvider, OAuthAccount } from '../../models/OAuthAccount';
import type { AuthTokens, TokenPayload } from '../../models/Token';
import type { User } from '../../models/User';
import type { DatabaseQueryExecutor } from './DatabasePort';

export interface AuthUserPort {
  findById(id: string): Promise<User | undefined>;
  findByEmail(email: string): Promise<User | undefined>;
  findByEmailWithPassword(email: string): Promise<User | undefined>;
  createUser(email: string, timezone?: string): Promise<string>;
  createUserWithPassword(email: string, passwordHash: string, timezone?: string): Promise<string>;
  updateEmailVerified(
    email: string,
    verified: boolean,
    executor?: DatabaseQueryExecutor,
  ): Promise<boolean>;
  updatePassword(
    email: string,
    passwordHash: string,
    executor?: DatabaseQueryExecutor,
  ): Promise<boolean>;
}

export interface OAuthIdentityPort {
  findByProvider(provider: AuthProvider, providerUserId: string): Promise<OAuthAccount | undefined>;
  create(data: Omit<OAuthAccount, 'id' | 'createdAt' | 'updatedAt'>): Promise<string>;
}

export interface AuthTokenPort {
  generateTokens(user: User): AuthTokens;
  verifyRefreshTokenWithBlacklist(token: string): Promise<TokenPayload>;
  consumeRefreshToken(token: string): Promise<TokenPayload>;
  revokeRefreshToken(token: string): Promise<void>;
}

export type AuthenticationMethod = 'password' | 'google' | 'apple' | 'microsoft';

export interface AuthenticationActivityPort {
  recordSuccess(
    userId: string,
    method: AuthenticationMethod,
    action: 'registered' | 'signed_in',
  ): Promise<void>;
}

export type CodeType = 'password_reset' | 'email_verification' | 'provider_login';
export type ConsumeCodeResult = 'consumed' | 'invalid' | 'not_pending';

export interface VerificationCodePort {
  storeOTP(email: string, codeType: CodeType): Promise<string>;
  verifyOTP(
    email: string,
    code: string,
    codeType: CodeType,
    markAsUsed?: boolean,
  ): Promise<boolean>;
  hasValidCode(email: string, codeType: CodeType): Promise<boolean>;
  consumeOTP(
    email: string,
    code: string,
    codeType: CodeType,
    onVerified: (transaction: DatabaseQueryExecutor) => Promise<void>,
  ): Promise<ConsumeCodeResult>;
  storeScopedOTP(scopeId: string, email: string, codeType: 'provider_login'): Promise<string>;
  consumeScopedOTP(
    scopeId: string,
    email: string,
    code: string,
    codeType: 'provider_login',
    onVerified: (transaction: DatabaseQueryExecutor) => Promise<void>,
  ): Promise<ConsumeCodeResult>;
}

export interface TransactionalEmailPort {
  isEnabled(): boolean;
  sendVerificationEmail(email: string, code: string): Promise<void>;
  sendPasswordResetEmail(email: string, code: string): Promise<void>;
  sendProviderLoginVerificationEmail(email: string, code: string): Promise<void>;
}
