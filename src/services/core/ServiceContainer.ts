import { PostgresService } from '../data/PostgresService';
import { UserRepository } from '../data/UserRepository';
import { ReceiptRepository } from '../data/ReceiptRepository';
import { ReceiptLookupService } from '../receipt/ReceiptLookupService';
import { DatabaseService } from './DatabaseService';
import { CsvImportService } from '../import/CsvImportService';
import { ReceiptParserService } from '../receipt/ReceiptParserService';
import { EmailFilterService } from '../email/EmailFilterService';
import { AuthService } from '../AuthService';
import { WrappedAnalyticsService } from '../analytics/WrappedAnalyticsService';
import { OtpService } from '../OtpService';
import { EmailSenderService } from '../email/EmailSender';
import { AlertingService } from '../monitoring/AlertingService';
import { OAuthRepository } from '../data/OAuthRepository';

/**
 * Simple service container for dependency injection
 * Manages service instances and their dependencies
 * 
 * Used by API routes to access services without manual instantiation
 * Centralizes all service creation and dependency management
 */
export class ServiceContainer {
  private static instance: ServiceContainer;
  private services: Map<string, any> = new Map();

  private constructor() {
    this.initializeServices();
  }

  static getInstance(): ServiceContainer {
    if (!ServiceContainer.instance) {
      ServiceContainer.instance = new ServiceContainer();
    }
    return ServiceContainer.instance;
  }

  private initializeServices(): void {
    // Core services
    this.services.set('postgres', new PostgresService());

    // Repositories
    this.services.set('userRepository', new UserRepository(this.get('postgres')));
    this.services.set('oauthRepository', new OAuthRepository(this.get('postgres')));
    this.services.set('receiptRepository', new ReceiptRepository(this.get('postgres')));

    // Authentication service
    this.services.set('authService', new AuthService(
      this.get('userRepository'),
      this.get('oauthRepository')
    ));

    // Business services
    this.services.set('receiptLookupService', new ReceiptLookupService());
    this.services.set('databaseService', new DatabaseService(
      this.get('receiptLookupService'),
      this.get('userRepository'),
      this.get('receiptRepository')
    ));

    // Utility services
    this.services.set('csvImportService', new CsvImportService(this.get('postgres')));
    this.services.set('receiptParserService', new ReceiptParserService());
    this.services.set('emailFilterService', new EmailFilterService());

    // Analytics services
    this.services.set('wrappedAnalyticsService', new WrappedAnalyticsService(this.get<PostgresService>('postgres').getPool()));

    // OTP and Email services
    this.services.set('otpService', new OtpService(this.get('postgres')));
    this.services.set('emailSender', new EmailSenderService());

    // Monitoring services
    this.services.set('alertingService', new AlertingService(this.get('postgres')));
  }

  get<T>(serviceName: string): T {
    const service = this.services.get(serviceName);
    if (!service) {
      throw new Error(`Service '${serviceName}' not found`);
    }
    return service as T;
  }

  // Convenience getters for commonly used services
  get postgres(): PostgresService {
    return this.get<PostgresService>('postgres');
  }

  get userRepository(): UserRepository {
    return this.get<UserRepository>('userRepository');
  }

  get receiptRepository(): ReceiptRepository {
    return this.get<ReceiptRepository>('receiptRepository');
  }

  get receiptLookupService(): ReceiptLookupService {
    return this.get<ReceiptLookupService>('receiptLookupService');
  }

  get databaseService(): DatabaseService {
    return this.get<DatabaseService>('databaseService');
  }

  get csvImportService(): CsvImportService {
    return this.get<CsvImportService>('csvImportService');
  }

  get receiptParserService(): ReceiptParserService {
    return this.get<ReceiptParserService>('receiptParserService');
  }

  get emailFilterService(): EmailFilterService {
    return this.get<EmailFilterService>('emailFilterService');
  }

  get authService(): AuthService {
    return this.get<AuthService>('authService');
  }

  get wrappedAnalyticsService(): WrappedAnalyticsService {
    return this.get<WrappedAnalyticsService>('wrappedAnalyticsService');
  }

  get otpService(): OtpService {
    return this.get<OtpService>('otpService');
  }

  get emailSender(): EmailSenderService {
    return this.get<EmailSenderService>('emailSender');
  }

  get alertingService(): AlertingService {
    return this.get<AlertingService>('alertingService');
  }
}

// Export singleton instance
export const container = ServiceContainer.getInstance();
