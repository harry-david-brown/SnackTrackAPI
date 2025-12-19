/**
 * Token-related types and interfaces for JWT authentication
 */

export interface TokenPayload {
  userId: string;
  email: string;
  type: 'access' | 'refresh';
  iat?: number; // issued at
  exp?: number; // expiration
  jti?: string; // JWT ID for revocation
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

export interface RefreshTokenStore {
  token: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthResponse {
  userId: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email: string;
    emailVerified: boolean;
    createdAt: string;
  };
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface RefreshTokenRequest {
  refreshToken: string;
}

