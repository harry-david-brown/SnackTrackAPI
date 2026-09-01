import { AuthResponse, AuthTokens } from '../../models/Token';
import { User } from '../../models/User';

export const mapAuthResponse = (user: User, tokens: AuthTokens): AuthResponse => ({
  userId: user.id,
  email: user.email,
  accessToken: tokens.accessToken,
  refreshToken: tokens.refreshToken,
  user: {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified ?? false,
    createdAt: user.createdAt ?? new Date(0).toISOString(),
  },
});
