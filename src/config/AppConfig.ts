export type Environment = 'development' | 'test' | 'production';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  environment: Environment;
  database: { useSSL: boolean; connectionString: string };
  server: { port: number; host: string; trackingIntervalMinutes: number };
  gmail: {
    useRealApi: boolean;
    useMockData: boolean;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    iosClientId?: string;
    webClientId?: string;
  };
  apple: { clientIds: readonly string[] };
  auth: {
    jwtSecret: string;
    jwtRefreshSecret: string;
    accessTokenExpiry: string;
    refreshTokenExpiry: string;
  };
  redis: { url: string; password?: string; enabled: boolean; defaultTTLSeconds: number };
  mail: {
    sendGridApiKey?: string;
    smtpHost?: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser?: string;
    smtpPassword?: string;
    from: string;
  };
  security: { apiKey?: string; corsOrigins: readonly string[] };
  observability: {
    logLevel: LogLevel;
    logtailToken?: string;
    sentryDsn?: string;
    sentryRelease?: string;
    railwayEnvironment?: string;
    railwayServiceId?: string;
  };
  debug: { enableDetailedLogging: boolean; showEmailContent: boolean; saveDebugEmails: boolean };
}

const optional = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};

const integer = (
  name: string,
  value: string | undefined,
  fallback: number,
  minimum = 0,
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return parsed;
};

const boolean = (name: string, value: string | undefined, fallback: boolean): boolean => {
  const normalized = optional(value)?.toLowerCase();
  if (normalized === undefined) return fallback;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false`);
};

const url = (name: string, value: string, allowedProtocols: readonly string[]): string => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!allowedProtocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use one of: ${allowedProtocols.join(', ')}`);
  }
  return value;
};

const requiredSecret = (name: string, value: string | undefined, minimumLength: number): string => {
  const normalized = optional(value);
  if (!normalized || normalized.length < minimumLength) {
    throw new Error(`${name} must be set and at least ${minimumLength} characters long`);
  }
  return normalized;
};

const environment = (value: string | undefined): Environment => {
  const normalized = optional(value) ?? 'development';
  if (normalized === 'development' || normalized === 'test' || normalized === 'production') {
    return normalized;
  }
  throw new Error('NODE_ENV must be development, test, or production');
};

const logLevel = (value: string | undefined): LogLevel => {
  const normalized = optional(value)?.toLowerCase() ?? 'info';
  if (
    normalized === 'error' ||
    normalized === 'warn' ||
    normalized === 'info' ||
    normalized === 'debug'
  ) {
    return normalized;
  }
  throw new Error('LOG_LEVEL must be error, warn, info, or debug');
};

class ConfigManager {
  private current: AppConfig;

  constructor() {
    this.current = this.load();
  }

  private load(): AppConfig {
    const currentEnvironment = environment(process.env.NODE_ENV);
    const isProduction = currentEnvironment === 'production';
    const isDevelopment = currentEnvironment === 'development';
    const useMockData = boolean('USE_MOCK_DATA', process.env.USE_MOCK_DATA, false);
    const appleClientId = optional(process.env.APPLE_CLIENT_ID);
    const appleClientIds =
      optional(process.env.APPLE_CLIENT_IDS)
        ?.split(',')
        .map((id) => id.trim())
        .filter(Boolean) ?? (appleClientId ? [appleClientId, 'host.exp.Exponent'] : []);
    const corsOrigins = optional(process.env.CORS_ORIGIN)
      ?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? ['https://snacktrack.app'];
    const databaseConnectionString = url(
      'DATABASE_URL',
      optional(process.env.DATABASE_URL) ??
        'postgresql://snacktrack:password@localhost:5432/snacktrack_dev',
      ['postgres:', 'postgresql:'],
    );
    const redisUrl = url('REDIS_URL', optional(process.env.REDIS_URL) ?? 'redis://localhost:6379', [
      'redis:',
      'rediss:',
    ]);
    const gmailRedirectUri = optional(process.env.GMAIL_REDIRECT_URI);
    if (gmailRedirectUri) url('GMAIL_REDIRECT_URI', gmailRedirectUri, ['http:', 'https:']);
    corsOrigins.forEach((origin) => url('CORS_ORIGIN', origin, ['http:', 'https:']));

    const jwtSecret = isProduction
      ? requiredSecret('JWT_SECRET', process.env.JWT_SECRET, 32)
      : (optional(process.env.JWT_SECRET) ?? '');
    const jwtRefreshSecret = isProduction
      ? requiredSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET, 32)
      : (optional(process.env.JWT_REFRESH_SECRET) ?? '');

    return {
      environment: currentEnvironment,
      database: {
        useSSL: isProduction,
        connectionString: databaseConnectionString,
      },
      server: {
        port: integer('PORT', process.env.PORT, 3000, 1),
        host: optional(process.env.HOST) ?? 'localhost',
        trackingIntervalMinutes: integer(
          'TRACKING_SYNC_INTERVAL_MINUTES',
          process.env.TRACKING_SYNC_INTERVAL_MINUTES,
          isProduction ? 60 : 0,
        ),
      },
      gmail: {
        useRealApi: !useMockData,
        useMockData,
        clientId: optional(process.env.GMAIL_CLIENT_ID),
        clientSecret: optional(process.env.GMAIL_CLIENT_SECRET),
        redirectUri: gmailRedirectUri,
        iosClientId: optional(process.env.GMAIL_IOS_CLIENT_ID),
        webClientId: optional(process.env.GMAIL_WEB_CLIENT_ID),
      },
      apple: { clientIds: appleClientIds },
      auth: {
        jwtSecret,
        jwtRefreshSecret,
        accessTokenExpiry: optional(process.env.JWT_ACCESS_EXPIRY) ?? '15m',
        refreshTokenExpiry: optional(process.env.JWT_REFRESH_EXPIRY) ?? '7d',
      },
      redis: {
        url: redisUrl,
        password: optional(process.env.REDIS_PASSWORD),
        enabled: boolean('REDIS_ENABLED', process.env.REDIS_ENABLED, true),
        defaultTTLSeconds: 300,
      },
      mail: {
        sendGridApiKey: optional(process.env.SENDGRID_API_KEY),
        smtpHost: optional(process.env.SMTP_HOST),
        smtpPort: integer('SMTP_PORT', process.env.SMTP_PORT, 587, 1),
        smtpSecure: boolean('SMTP_SECURE', process.env.SMTP_SECURE, false),
        smtpUser: optional(process.env.SMTP_USER),
        smtpPassword: optional(process.env.SMTP_PASS),
        from:
          optional(process.env.SMTP_FROM) ??
          optional(process.env.SENDGRID_FROM) ??
          '"Snack Track" <noreply@getsnacktrack.com>',
      },
      security: {
        apiKey: optional(process.env.API_KEY),
        corsOrigins,
      },
      observability: {
        logLevel: logLevel(process.env.LOG_LEVEL),
        logtailToken: optional(process.env.LOGTAIL_TOKEN),
        sentryDsn: optional(process.env.SENTRY_DSN),
        sentryRelease: optional(process.env.SENTRY_RELEASE),
        railwayEnvironment: optional(process.env.RAILWAY_ENVIRONMENT),
        railwayServiceId: optional(process.env.RAILWAY_SERVICE_ID),
      },
      debug: {
        enableDetailedLogging: isDevelopment,
        showEmailContent: isDevelopment,
        saveDebugEmails:
          isDevelopment && boolean('SAVE_DEBUG_EMAILS', process.env.SAVE_DEBUG_EMAILS, false),
      },
    };
  }

  get(): Readonly<AppConfig> {
    return this.current;
  }
  reload(): void {
    this.current = this.load();
  }
}

export const appConfig = new ConfigManager();

export const config = {
  isDevelopment: () => appConfig.get().environment === 'development',
  isProduction: () => appConfig.get().environment === 'production',
  getEnvironment: () => appConfig.get().environment,
  getGmailSearchQuery: () =>
    'from:uber.com OR from:ubereats.com OR from:noreply@uber.com OR from:noreply@ubereats.com OR from:doordash.com',
  shouldUseMockData: () => appConfig.get().gmail.useMockData,
  shouldUseRealGmailApi: () => appConfig.get().gmail.useRealApi,
  shouldUseDatabaseSSL: () => appConfig.get().database.useSSL,
  getDatabaseConnectionString: () => appConfig.get().database.connectionString,
  shouldEnableDetailedLogging: () => appConfig.get().debug.enableDetailedLogging,
  shouldShowEmailContent: () => appConfig.get().debug.showEmailContent,
  shouldSaveDebugEmails: () => appConfig.get().debug.saveDebugEmails,
  getServerPort: () => appConfig.get().server.port,
  getServerHost: () => appConfig.get().server.host,
  getTrackingIntervalMinutes: () => appConfig.get().server.trackingIntervalMinutes,
  getGmailConfig: () => appConfig.get().gmail,
  getAppleConfig: () => appConfig.get().apple,
  getAuthConfig: () => appConfig.get().auth,
  getRedisConfig: () => appConfig.get().redis,
  getMailConfig: () => appConfig.get().mail,
  getSecurityConfig: () => appConfig.get().security,
  getObservabilityConfig: () => appConfig.get().observability,
  getEnvironmentInfo: () => ({
    environment: appConfig.get().environment,
    gmailApi: appConfig.get().gmail.useRealApi ? 'real' : 'mock',
    databaseSSL: appConfig.get().database.useSSL,
    detailedLogging: appConfig.get().debug.enableDetailedLogging,
    saveDebugEmails: appConfig.get().debug.saveDebugEmails,
  }),
  reloadConfig: () => appConfig.reload(),
};
