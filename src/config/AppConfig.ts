export type Environment = 'development' | 'test' | 'production';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  environment: Environment;
  database: { useSSL: boolean; connectionString: string; maxConnections: number };
  server: { port: number; host: string; trackingIntervalMinutes: number; analyticsMaintenanceEnabled: boolean };
  gmail: {
    useRealApi: boolean;
    useMockData: boolean;
    importQueryUnitsPerMinute: number;
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    iosClientId?: string;
    webClientId?: string;
  };
  microsoftMailbox: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    tokenEncryptionKey: string;
    authority: string;
  };
  microsoftLogin: { enabled: boolean; clientId?: string; jwksUri: string };
  apple: { clientIds: readonly string[] };
  auth: {
    jwtSecret: string;
    jwtRefreshSecret: string;
    accessTokenExpiry: string;
    refreshTokenExpiry: string;
  };
  redis: { url: string; password?: string; enabled: boolean; defaultTTLSeconds: number };
  queue: {
    redisUrl: string;
    mailboxConcurrency: number;
    exportConcurrency: number;
    notificationConcurrency: number;
    maximumWaitingJobs: number;
  };
  objectStorage: {
    endpoint: string;
    publicEndpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
    uploadUrlTtlSeconds: number;
  };
  push: { deliveryMode: 'log' | 'expo' };
  mail: {
    sendGridApiKey?: string;
    smtpHost?: string;
    smtpPort: number;
    smtpSecure: boolean;
    smtpUser?: string;
    smtpPassword?: string;
    from: string;
  };
  security: {
    apiKey?: string;
    schedulerApiKey?: string;
    legacyAdminApiKeyEnabled: boolean;
    corsOrigins: readonly string[];
    adminDashboardUrl: string;
  };
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

const boundedInteger = (
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number => {
  const parsed = integer(name, value, fallback, minimum);
  if (parsed > maximum) throw new Error(`${name} must be less than or equal to ${maximum}`);
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
    const configuredDatabaseUrl = optional(process.env.DATABASE_URL);
    const configuredRedisUrl = optional(process.env.REDIS_URL);
    if (isProduction && (!configuredDatabaseUrl || !configuredRedisUrl)) {
      throw new Error('DATABASE_URL and REDIS_URL are required in production');
    }
    const databaseConnectionString = url(
      'DATABASE_URL',
      configuredDatabaseUrl ??
        'postgresql://snacktrack:password@localhost:5432/snacktrack_dev',
      ['postgres:', 'postgresql:'],
    );
    const redisUrl = url('REDIS_URL', configuredRedisUrl ?? 'redis://localhost:6379', [
      'redis:',
      'rediss:',
    ]);
    const queueRedisUrl = url(
      'QUEUE_REDIS_URL',
      optional(process.env.QUEUE_REDIS_URL) ?? redisUrl,
      ['redis:', 'rediss:'],
    );
    const configuredStorageEndpoint = optional(process.env.OBJECT_STORAGE_ENDPOINT);
    const configuredStoragePublicEndpoint = optional(process.env.OBJECT_STORAGE_PUBLIC_ENDPOINT);
    if (isProduction && (!configuredStorageEndpoint || !configuredStoragePublicEndpoint)) {
      throw new Error('OBJECT_STORAGE_ENDPOINT and OBJECT_STORAGE_PUBLIC_ENDPOINT are required in production');
    }
    const objectStorageEndpoint = url(
      'OBJECT_STORAGE_ENDPOINT',
      configuredStorageEndpoint ?? 'http://localhost:9000',
      ['http:', 'https:'],
    );
    const objectStoragePublicEndpoint = url(
      'OBJECT_STORAGE_PUBLIC_ENDPOINT',
      configuredStoragePublicEndpoint ?? objectStorageEndpoint,
      isProduction ? ['https:'] : ['http:', 'https:'],
    );
    const pushDeliveryMode = optional(process.env.PUSH_DELIVERY_MODE) ?? (isProduction ? 'expo' : 'log');
    if (pushDeliveryMode !== 'log' && pushDeliveryMode !== 'expo') {
      throw new Error('PUSH_DELIVERY_MODE must be log or expo');
    }
    const gmailRedirectUri = optional(process.env.GMAIL_REDIRECT_URI);
    if (gmailRedirectUri) url('GMAIL_REDIRECT_URI', gmailRedirectUri, ['http:', 'https:']);
    const microsoftMailboxRedirectUri = optional(process.env.MICROSOFT_MAIL_REDIRECT_URI);
    if (microsoftMailboxRedirectUri) {
      url('MICROSOFT_MAIL_REDIRECT_URI', microsoftMailboxRedirectUri, ['http:', 'https:']);
    }
    corsOrigins.forEach((origin) => url('CORS_ORIGIN', origin, ['http:', 'https:']));
    const adminDashboardUrl = new URL(url(
      'ADMIN_DASHBOARD_URL',
      optional(process.env.ADMIN_DASHBOARD_URL) ?? 'http://localhost:5173',
      ['http:', 'https:'],
    )).origin;

    const jwtSecret = isProduction
      ? requiredSecret('JWT_SECRET', process.env.JWT_SECRET, 32)
      : (optional(process.env.JWT_SECRET) ?? '');
    const jwtRefreshSecret = isProduction
      ? requiredSecret('JWT_REFRESH_SECRET', process.env.JWT_REFRESH_SECRET, 32)
      : (optional(process.env.JWT_REFRESH_SECRET) ?? '');
    const microsoftMailboxConfigured = Boolean(
      optional(process.env.MICROSOFT_MAIL_CLIENT_ID) ||
      optional(process.env.MICROSOFT_MAIL_CLIENT_SECRET) ||
      microsoftMailboxRedirectUri,
    );
    if (
      microsoftMailboxConfigured &&
      (!optional(process.env.MICROSOFT_MAIL_CLIENT_ID) ||
        !optional(process.env.MICROSOFT_MAIL_CLIENT_SECRET) ||
        !microsoftMailboxRedirectUri)
    ) {
      throw new Error(
        'MICROSOFT_MAIL_CLIENT_ID, MICROSOFT_MAIL_CLIENT_SECRET, and MICROSOFT_MAIL_REDIRECT_URI must be configured together',
      );
    }
    const tokenEncryptionKey =
      isProduction && microsoftMailboxConfigured
        ? requiredSecret(
            'MAILBOX_TOKEN_ENCRYPTION_KEY',
            process.env.MAILBOX_TOKEN_ENCRYPTION_KEY,
            32,
          )
        : optional(process.env.MAILBOX_TOKEN_ENCRYPTION_KEY) ||
          jwtSecret ||
          'snacktrack-local-mailbox-key';

    return {
      environment: currentEnvironment,
      database: {
        useSSL: isProduction,
        connectionString: databaseConnectionString,
        maxConnections: integer(
          'DATABASE_POOL_MAX',
          process.env.DATABASE_POOL_MAX,
          isProduction ? 10 : 8,
          1,
        ),
      },
      server: {
        port: integer('PORT', process.env.PORT, 3000, 1),
        host: optional(process.env.HOST) ?? 'localhost',
        trackingIntervalMinutes: integer(
          'TRACKING_SYNC_INTERVAL_MINUTES',
          process.env.TRACKING_SYNC_INTERVAL_MINUTES,
          isProduction ? 60 : 0,
        ),
        analyticsMaintenanceEnabled: boolean(
          'ANALYTICS_MAINTENANCE_ENABLED',
          process.env.ANALYTICS_MAINTENANCE_ENABLED,
          false,
        ),
      },
      gmail: {
        useRealApi: !useMockData,
        useMockData,
        importQueryUnitsPerMinute: boundedInteger(
          'GMAIL_IMPORT_QUERY_UNITS_PER_MINUTE',
          process.env.GMAIL_IMPORT_QUERY_UNITS_PER_MINUTE,
          1_600,
          1,
          6_000,
        ),
        clientId: optional(process.env.GMAIL_CLIENT_ID),
        clientSecret: optional(process.env.GMAIL_CLIENT_SECRET),
        redirectUri: gmailRedirectUri,
        iosClientId: optional(process.env.GMAIL_IOS_CLIENT_ID),
        webClientId: optional(process.env.GMAIL_WEB_CLIENT_ID),
      },
      microsoftMailbox: {
        clientId: optional(process.env.MICROSOFT_MAIL_CLIENT_ID),
        clientSecret: optional(process.env.MICROSOFT_MAIL_CLIENT_SECRET),
        redirectUri: microsoftMailboxRedirectUri,
        tokenEncryptionKey,
        authority: 'https://login.microsoftonline.com/common',
      },
      microsoftLogin: {
        enabled:
          boolean('MICROSOFT_LOGIN_ENABLED', process.env.MICROSOFT_LOGIN_ENABLED, false) &&
          Boolean(optional(process.env.MICROSOFT_LOGIN_CLIENT_ID)),
        clientId: optional(process.env.MICROSOFT_LOGIN_CLIENT_ID),
        jwksUri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
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
      queue: {
        redisUrl: queueRedisUrl,
        mailboxConcurrency: integer('MAILBOX_WORKER_CONCURRENCY', process.env.MAILBOX_WORKER_CONCURRENCY, 2, 1),
        exportConcurrency: integer('EXPORT_WORKER_CONCURRENCY', process.env.EXPORT_WORKER_CONCURRENCY, 1, 1),
        notificationConcurrency: integer('NOTIFICATION_WORKER_CONCURRENCY', process.env.NOTIFICATION_WORKER_CONCURRENCY, 10, 1),
        maximumWaitingJobs: integer('QUEUE_MAXIMUM_WAITING_JOBS', process.env.QUEUE_MAXIMUM_WAITING_JOBS, 1000, 1),
      },
      objectStorage: {
        endpoint: objectStorageEndpoint,
        publicEndpoint: objectStoragePublicEndpoint,
        region: optional(process.env.OBJECT_STORAGE_REGION) ?? 'us-east-1',
        bucket: isProduction
          ? requiredSecret('OBJECT_STORAGE_BUCKET', process.env.OBJECT_STORAGE_BUCKET, 1)
          : optional(process.env.OBJECT_STORAGE_BUCKET) ?? 'snacktrack-imports',
        accessKeyId: isProduction
          ? requiredSecret('OBJECT_STORAGE_ACCESS_KEY_ID', process.env.OBJECT_STORAGE_ACCESS_KEY_ID, 1)
          : optional(process.env.OBJECT_STORAGE_ACCESS_KEY_ID) ?? 'snacktrack',
        secretAccessKey: isProduction
          ? requiredSecret('OBJECT_STORAGE_SECRET_ACCESS_KEY', process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY, 16)
          : optional(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY) ?? 'snacktrack-local-secret',
        forcePathStyle: boolean('OBJECT_STORAGE_FORCE_PATH_STYLE', process.env.OBJECT_STORAGE_FORCE_PATH_STYLE, true),
        uploadUrlTtlSeconds: integer('OBJECT_STORAGE_UPLOAD_URL_TTL_SECONDS', process.env.OBJECT_STORAGE_UPLOAD_URL_TTL_SECONDS, 900, 60),
      },
      push: { deliveryMode: pushDeliveryMode },
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
        schedulerApiKey: optional(process.env.SCHEDULER_API_KEY),
        legacyAdminApiKeyEnabled: boolean(
          'LEGACY_ADMIN_API_KEY_ENABLED',
          process.env.LEGACY_ADMIN_API_KEY_ENABLED,
          !isProduction,
        ),
        corsOrigins,
        adminDashboardUrl,
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
  isAnalyticsMaintenanceEnabled: () => appConfig.get().server.analyticsMaintenanceEnabled,
  getGmailConfig: () => appConfig.get().gmail,
  getMicrosoftMailboxConfig: () => appConfig.get().microsoftMailbox,
  getMicrosoftLoginConfig: () => appConfig.get().microsoftLogin,
  getAppleConfig: () => appConfig.get().apple,
  getAuthConfig: () => appConfig.get().auth,
  getRedisConfig: () => appConfig.get().redis,
  getQueueConfig: () => appConfig.get().queue,
  getObjectStorageConfig: () => appConfig.get().objectStorage,
  getPushConfig: () => appConfig.get().push,
  getDatabaseMaxConnections: () => appConfig.get().database.maxConnections,
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
