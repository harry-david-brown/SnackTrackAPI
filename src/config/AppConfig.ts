/**
 * Centralized Application Configuration
 * 
 * This file manages all environment-specific settings in one place.
 * To switch between dev and prod, simply change the NODE_ENV in .env
 */

export type Environment = 'development' | 'production';

export interface AppConfig {
  environment: Environment;

  // Gmail Configuration
  gmail: {
    useRealApi: boolean;
    useMockData: boolean;
  };

  // Database Configuration
  database: {
    useSSL: boolean;
    connectionString: string;
  };

  // Server Configuration
  server: {
    port: number;
    host: string;
  };

  // Debug Configuration
  debug: {
    enableDetailedLogging: boolean;
    showEmailContent: boolean;
    saveDebugEmails: boolean;
  };
}

class ConfigManager {
  private config: AppConfig;

  constructor() {
    this.config = this.loadConfig();
  }

  private loadConfig(): AppConfig {
    const environment = (process.env.NODE_ENV as Environment) || 'development';
    const isDevelopment = environment === 'development';
    const isProduction = environment === 'production';
    const useMockData = process.env.USE_MOCK_DATA === 'true';

    return {
      environment,

      gmail: {
        useRealApi: !useMockData,
        useMockData,
      },

      database: {
        useSSL: isProduction, // Enable SSL in production (required by most cloud databases)
        connectionString: process.env.DATABASE_URL || 'postgresql://snacktrack:password@localhost:5432/snacktrack_dev'
      },

      server: {
        port: parseInt(process.env.PORT || '3000'),
        host: process.env.HOST || 'localhost'
      },

      debug: {
        enableDetailedLogging: isDevelopment,
        showEmailContent: isDevelopment,
        saveDebugEmails: isDevelopment && process.env.SAVE_DEBUG_EMAILS === 'true'  // Default to true in dev for now, or make configurable
      }
    };
  }

  public getConfig(): AppConfig {
    return this.config;
  }

  public isDevelopment(): boolean {
    return this.config.environment === 'development';
  }

  public isProduction(): boolean {
    return this.config.environment === 'production';
  }

  public getGmailSearchQuery(): string {
    return 'from:uber.com OR from:ubereats.com OR from:noreply@uber.com OR from:noreply@ubereats.com';
  }

  public shouldUseMockData(): boolean {
    return this.config.gmail.useMockData;
  }

  public shouldUseRealGmailApi(): boolean {
    return this.config.gmail.useRealApi;
  }

  public shouldUseDatabaseSSL(): boolean {
    return this.config.database.useSSL;
  }

  public getDatabaseConnectionString(): string {
    return this.config.database.connectionString;
  }

  public shouldEnableDetailedLogging(): boolean {
    return this.config.debug.enableDetailedLogging;
  }

  public shouldShowEmailContent(): boolean {
    return this.config.debug.showEmailContent;
  }

  public shouldSaveDebugEmails(): boolean {
    return this.config.debug.saveDebugEmails;
  }

  public getServerPort(): number {
    return this.config.server.port;
  }

  public getServerHost(): string {
    return this.config.server.host;
  }

  // Method to reload config (useful for testing)
  public reloadConfig(): void {
    this.config = this.loadConfig();
  }

  // Method to get current environment info for debugging
  public getEnvironmentInfo(): string {
    return `
🌍 Environment: ${this.config.environment}
📧 Gmail API: ${this.config.gmail.useRealApi ? 'Real API' : 'Mock Data'}
🧪 Mock Data: ${this.config.gmail.useMockData ? 'Enabled' : 'Disabled'}
🗄️  Database SSL: ${this.config.database.useSSL ? 'Enabled' : 'Disabled'}
🐛 Debug Logging: ${this.config.debug.enableDetailedLogging ? 'Enabled' : 'Disabled'}
💾 Save Debug Emails: ${this.config.debug.saveDebugEmails ? 'Enabled' : 'Disabled'}
    `.trim();
  }
}

// Export singleton instance
export const appConfig = new ConfigManager();

// Export individual getters for convenience
export const config = {
  isDevelopment: () => appConfig.isDevelopment(),
  isProduction: () => appConfig.isProduction(),
  getGmailSearchQuery: () => appConfig.getGmailSearchQuery(),
  shouldUseMockData: () => appConfig.shouldUseMockData(),
  shouldUseRealGmailApi: () => appConfig.shouldUseRealGmailApi(),
  shouldUseDatabaseSSL: () => appConfig.shouldUseDatabaseSSL(),
  getDatabaseConnectionString: () => appConfig.getDatabaseConnectionString(),
  shouldEnableDetailedLogging: () => appConfig.shouldEnableDetailedLogging(),
  shouldShowEmailContent: () => appConfig.shouldShowEmailContent(),
  shouldSaveDebugEmails: () => appConfig.shouldSaveDebugEmails(),
  getServerPort: () => appConfig.getServerPort(),
  getServerHost: () => appConfig.getServerHost(),
  getEnvironmentInfo: () => appConfig.getEnvironmentInfo(),
  reloadConfig: () => appConfig.reloadConfig()
};
