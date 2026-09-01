/**
 * Authentication Configuration
 *
 * Manages JWT token settings and authentication-related configuration
 */
import { config as appConfig } from './AppConfig';

export interface AuthConfig {
  jwt: {
    secret: string;
    refreshSecret: string;
    accessTokenExpiry: string;
    refreshTokenExpiry: string;
  };
  bcrypt: {
    saltRounds: number;
  };
  password: {
    minLength: number;
    requireUppercase: boolean;
    requireNumber: boolean;
    requireSpecialChar: boolean;
  };
}

class AuthConfigManager {
  private config: AuthConfig;

  constructor() {
    this.config = this.loadConfig();
    this.validateConfig();
  }

  private loadConfig(): AuthConfig {
    const auth = appConfig.getAuthConfig();
    return {
      jwt: {
        secret: auth.jwtSecret,
        refreshSecret: auth.jwtRefreshSecret,
        accessTokenExpiry: auth.accessTokenExpiry,
        refreshTokenExpiry: auth.refreshTokenExpiry,
      },
      bcrypt: {
        saltRounds: 12, // High security, good balance of speed and security
      },
      password: {
        minLength: 8,
        requireUppercase: true,
        requireNumber: true,
        requireSpecialChar: false, // Optional for MVP
      },
    };
  }

  private validateConfig(): void {
    const { jwt } = this.config;

    if (!jwt.secret || jwt.secret.length < 32) {
      throw new Error('JWT_SECRET must be set and at least 32 characters long');
    }
    if (!jwt.refreshSecret || jwt.refreshSecret.length < 32) {
      throw new Error('JWT_REFRESH_SECRET must be set and at least 32 characters long');
    }
  }

  public getConfig(): AuthConfig {
    return this.config;
  }

  public getJWTSecret(): string {
    return this.config.jwt.secret;
  }

  public getRefreshSecret(): string {
    return this.config.jwt.refreshSecret;
  }

  public getAccessTokenExpiry(): string {
    return this.config.jwt.accessTokenExpiry;
  }

  public getRefreshTokenExpiry(): string {
    return this.config.jwt.refreshTokenExpiry;
  }

  public getSaltRounds(): number {
    return this.config.bcrypt.saltRounds;
  }

  public validatePassword(password: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const { minLength, requireUppercase, requireNumber, requireSpecialChar } = this.config.password;

    if (password.length < minLength) {
      errors.push(`Password must be at least ${minLength} characters long`);
    }

    if (requireUppercase && !/[A-Z]/.test(password)) {
      errors.push('Password must contain at least one uppercase letter');
    }

    if (requireNumber && !/\d/.test(password)) {
      errors.push('Password must contain at least one number');
    }

    if (requireSpecialChar && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
      errors.push('Password must contain at least one special character');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

// Export singleton instance
export const authConfig = new AuthConfigManager();
