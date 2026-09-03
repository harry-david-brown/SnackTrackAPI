import {
  AppError,
  AuthenticationError,
  DuplicateUserEmailError,
  ValidationError,
} from '../../core/errors';
import { AuthResponse } from '../../models/Token';
import { UserModel } from '../../models/User';
import type { AuthenticationActivityPort, AuthTokenPort, AuthUserPort } from '../ports/AuthPorts';
import { mapAuthResponse } from './AuthResponseMapper';

const normalizeEmail = (email: string): string => email.toLowerCase().trim();

/** Owns password registration and credential authentication. */
export class CredentialAuthService {
  constructor(
    private readonly users: AuthUserPort,
    private readonly tokens: AuthTokenPort,
    private readonly activity?: AuthenticationActivityPort,
  ) {}

  async register(email: string, password: string, timezone: string): Promise<AuthResponse> {
    const normalizedEmail = normalizeEmail(email);
    const validation = UserModel.validatePassword(password);
    if (!validation.valid) {
      throw new ValidationError(validation.errors.join('; '), 'password');
    }
    if (await this.users.findByEmail(normalizedEmail)) {
      throw new AppError({
        code: 'ACCOUNT_ALREADY_EXISTS',
        message: 'An account with this email already exists',
      });
    }
    const passwordHash = await UserModel.hashPassword(password);
    let userId: string;
    try {
      userId = await this.users.createUserWithPassword(normalizedEmail, passwordHash, timezone);
    } catch (error) {
      if (error instanceof DuplicateUserEmailError) {
        throw new AppError({
          code: 'ACCOUNT_ALREADY_EXISTS',
          message: 'An account with this email already exists',
          cause: error,
        });
      }
      throw error;
    }
    const user = await this.users.findById(userId);
    if (!user) throw new Error('Created account could not be loaded');
    await this.activity?.recordSuccess(user.id, 'password', 'registered');
    return mapAuthResponse(user, this.tokens.generateTokens(user));
  }

  async login(email: string, password: string): Promise<AuthResponse> {
    const user = await this.users.findByEmailWithPassword(normalizeEmail(email));
    if (!user?.password || !(await UserModel.comparePassword(password, user.password))) {
      throw new AuthenticationError('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    await this.activity?.recordSuccess(user.id, 'password', 'signed_in');
    return mapAuthResponse(user, this.tokens.generateTokens(user));
  }
}
