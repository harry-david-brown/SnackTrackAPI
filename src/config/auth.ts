/**
 * Authentication Configuration
 * 
 * Manages JWT token settings and authentication-related configuration
 */

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
    return {
      jwt: {
        secret: process.env.JWT_SECRET || '',
        refreshSecret: process.env.JWT_REFRESH_SECRET || '',
        accessTokenExpiry: process.env.JWT_ACCESS_EXPIRY || '15m',
        refreshTokenExpiry: process.env.JWT_REFRESH_EXPIRY || '7d'
      },
      bcrypt: {
        saltRounds: 12 // High security, good balance of speed and security
      },
      password: {
        minLength: 8,
        requireUppercase: true,
        requireNumber: true,
        requireSpecialChar: false // Optional for MVP
      }
    };
  }

  private validateConfig(): void {
    const { jwt } = this.config;

    // In production, JWT secrets are required
    if (process.env.NODE_ENV === 'production') {
      if (!jwt.secret || jwt.secret.length < 32) {
        throw new Error(
          'JWT_SECRET must be set and at least 32 characters long in production'
        );
      }
      if (!jwt.refreshSecret || jwt.refreshSecret.length < 32) {
        throw new Error(
          'JWT_REFRESH_SECRET must be set and at least 32 characters long in production'
        );
      }
    } else {
      // In development, use default secrets with warning
      if (!jwt.secret) {
        console.warn(
          '⚠️  WARNING: JWT_SECRET not set. Using insecure default for development.'
        );
        this.config.jwt.secret = 'dev-secret-change-this-in-production-min-32-chars';
      }
      if (!jwt.refreshSecret) {
        console.warn(
          '⚠️  WARNING: JWT_REFRESH_SECRET not set. Using insecure default for development.'
        );
        this.config.jwt.refreshSecret = 'dev-refresh-secret-change-this-in-production-min-32';
      }
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
      errors
    };
  }
}

// Export singleton instance
export const authConfig = new AuthConfigManager();

