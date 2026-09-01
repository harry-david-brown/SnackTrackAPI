export type AuthProvider = 'google' | 'apple';

export interface OAuthAccount {
  id: string;
  userId: string;
  provider: AuthProvider;
  providerUserId: string;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  tokenExpiry?: Date;
  createdAt: Date;
  updatedAt: Date;
}
