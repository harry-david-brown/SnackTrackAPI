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
    includeForwardedReceipts: boolean;
    forwardedReceiptEmail: string;
  };
  
  // Database Configuration
  database: {
    useSSL: boolean;
    connectionString: string;
  };
  
  // Email Filtering Configuration
  emailFilter: {
    allowForwardedReceipts: boolean;
    forwardedReceiptSender: string;
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

    return {
      environment,
      
      gmail: {
        // In development: use real API if credentials are configured, otherwise mock
        // In production: always use real API
        useRealApi: isProduction || this.hasGmailCredentials(),
        useMockData: isDevelopment && !this.hasGmailCredentials(),
        includeForwardedReceipts: isDevelopment,
        forwardedReceiptEmail: 'nnamdi852@gmail.com'
      },
      
      database: {
        useSSL: false, // Disabled for local testing - can be enabled for cloud deployments
        connectionString: process.env.DATABASE_URL || 'postgresql://snacktrack:password@localhost:5432/snacktrack_dev'
      },
      
      emailFilter: {
        allowForwardedReceipts: isDevelopment,
        forwardedReceiptSender: 'nnamdi852@gmail.com'
      },
      
      server: {
        port: parseInt(process.env.PORT || '3000'),
        host: process.env.HOST || 'localhost'
      },
      
      debug: {
        enableDetailedLogging: isDevelopment,
        showEmailContent: isDevelopment
      }
    };
  }

  private hasGmailCredentials(): boolean {
    const clientId = process.env.GMAIL_CLIENT_ID;
    const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
    return !!(clientId && refreshToken && 
              clientId !== 'your_client_id_here' && 
              refreshToken !== 'your_refresh_token_here');
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
    const baseQuery = 'from:uber.com OR from:ubereats.com OR from:noreply@uber.com OR from:noreply@ubereats.com';
    
    if (this.config.gmail.includeForwardedReceipts) {
      return `${baseQuery} OR from:${this.config.gmail.forwardedReceiptEmail}`;
    }
    
    return baseQuery;
  }

  public shouldUseMockData(): boolean {
    return this.config.gmail.useMockData;
  }

  public shouldUseRealGmailApi(): boolean {
    return this.config.gmail.useRealApi;
  }

  public shouldAllowForwardedReceipts(): boolean {
    return this.config.emailFilter.allowForwardedReceipts;
  }

  public getForwardedReceiptSender(): string {
    return this.config.emailFilter.forwardedReceiptSender;
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
🔄 Forwarded Receipts: ${this.config.gmail.includeForwardedReceipts ? 'Enabled' : 'Disabled'}
🗄️  Database SSL: ${this.config.database.useSSL ? 'Enabled' : 'Disabled'}
🐛 Debug Logging: ${this.config.debug.enableDetailedLogging ? 'Enabled' : 'Disabled'}
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
  shouldAllowForwardedReceipts: () => appConfig.shouldAllowForwardedReceipts(),
  getForwardedReceiptSender: () => appConfig.getForwardedReceiptSender(),
  shouldUseDatabaseSSL: () => appConfig.shouldUseDatabaseSSL(),
  getDatabaseConnectionString: () => appConfig.getDatabaseConnectionString(),
  shouldEnableDetailedLogging: () => appConfig.shouldEnableDetailedLogging(),
  shouldShowEmailContent: () => appConfig.shouldShowEmailContent(),
  getServerPort: () => appConfig.getServerPort(),
  getServerHost: () => appConfig.getServerHost(),
  getEnvironmentInfo: () => appConfig.getEnvironmentInfo(),
  reloadConfig: () => appConfig.reloadConfig()
};
