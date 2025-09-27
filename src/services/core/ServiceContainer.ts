import { PostgresService } from '../data/PostgresService';
import { UserRepository } from '../data/UserRepository';
import { ReceiptRepository } from '../data/ReceiptRepository';
import { ReceiptLookupService } from '../receipt/ReceiptLookupService';
import { DatabaseService } from './DatabaseService';
import { CsvImportService } from '../import/CsvImportService';
import { ReceiptParserService } from '../receipt/ReceiptParserService';
import { EmailFilterService } from '../email/EmailFilterService';

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
    this.services.set('receiptRepository', new ReceiptRepository(this.get('postgres')));
    
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
}

// Export singleton instance
export const container = ServiceContainer.getInstance();
