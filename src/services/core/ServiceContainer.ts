import { AccountDeletionService } from '../account/AccountDeletionService';
import { ReceiptClearService } from '../account/ReceiptClearService';
import { AlertingService } from '../monitoring/AlertingService';
import { AuthService } from '../AuthService';
import { WrappedAnalyticsService } from '../analytics/WrappedAnalyticsService';
import { WrappedAnalyticsQueryRepository } from '../analytics/WrappedAnalyticsQueryRepository';
import { AccountResetService } from '../data/AccountResetService';
import { ImportPreferencesRepository } from '../data/ImportPreferencesRepository';
import { OAuthRepository } from '../data/OAuthRepository';
import { PostgresService } from '../data/PostgresService';
import { ReceiptRepository } from '../data/ReceiptRepository';
import { UserRepository } from '../data/UserRepository';
import { EmailSenderService } from '../email/EmailSender';
import { GmailConnectionHealthService } from '../email/GmailConnectionHealthService';
import { GmailClient } from '../email/GmailClient';
import { ReceiptExtractor } from '../extraction';
import { CsvImportService } from '../import/CsvImportService';
import { CsvImportUseCase } from '../import/CsvImportUseCase';
import { GmailImportService } from '../import/GmailImportService';
import { OngoingTrackingService } from '../import/OngoingTrackingService';
import { OtpService } from '../OtpService';
import { ListReceiptsService } from '../receipt/ListReceiptsService';
import { GetUserSummaryService } from '../user/GetUserSummaryService';
import { GetDashboardInsightsService } from '../user/GetDashboardInsightsService';
import { CacheService } from './CacheService';
import { DatabaseService } from './DatabaseService';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../../config/AppConfig';
import appleSignin from 'apple-signin-auth';
import { ZipExtractor } from '../import/ZipExtractor';
import { ImportLockService } from '../import/ImportLockService';

/** The process-wide, typed composition root and resource owner. */
export class ServiceContainer {
  private static instance: ServiceContainer | undefined;

  readonly postgres: PostgresService;
  readonly userRepository: UserRepository;
  readonly oauthRepository: OAuthRepository;
  readonly receiptRepository: ReceiptRepository;
  readonly importPreferencesRepository: ImportPreferencesRepository;
  readonly cacheService: CacheService;
  readonly authService: AuthService;
  readonly databaseService: DatabaseService;
  readonly csvImportService: CsvImportService;
  readonly csvImportUseCase: CsvImportUseCase;
  readonly zipExtractor: ZipExtractor;
  readonly gmailClient: GmailClient;
  readonly gmailImportService: GmailImportService;
  readonly ongoingTrackingService: OngoingTrackingService;
  readonly gmailConnectionHealthService: GmailConnectionHealthService;
  readonly accountResetService: AccountResetService;
  readonly receiptClearService: ReceiptClearService;
  readonly listReceiptsService: ListReceiptsService;
  readonly accountDeletionService: AccountDeletionService;
  readonly wrappedAnalyticsService: WrappedAnalyticsService;
  readonly wrappedAnalyticsQueryRepository: WrappedAnalyticsQueryRepository;
  readonly otpService: OtpService;
  readonly emailSender: EmailSenderService;
  readonly alertingService: AlertingService;
  readonly getUserSummaryService: GetUserSummaryService;
  readonly getDashboardInsightsService: GetDashboardInsightsService;

  private constructor() {
    this.postgres = new PostgresService();
    this.userRepository = new UserRepository(this.postgres);
    this.oauthRepository = new OAuthRepository(this.postgres);
    this.receiptRepository = new ReceiptRepository(this.postgres);
    this.importPreferencesRepository = new ImportPreferencesRepository(this.postgres);
    this.cacheService = new CacheService();
    const gmailConfig = config.getGmailConfig();
    const googleAudiences = [gmailConfig.clientId, gmailConfig.iosClientId, gmailConfig.webClientId]
      .filter((value): value is string => Boolean(value));
    this.authService = new AuthService(
      this.userRepository,
      this.oauthRepository,
      new OAuth2Client(googleAudiences[0]),
      googleAudiences,
      appleSignin,
      config.getAppleConfig().clientIds,
    );
    this.databaseService = new DatabaseService(
      this.userRepository,
      this.receiptRepository
    );
    this.csvImportService = new CsvImportService(this.postgres);
    this.csvImportUseCase = new CsvImportUseCase(
      this.csvImportService,
      this.importPreferencesRepository,
      this.cacheService,
      ImportLockService,
    );
    this.zipExtractor = new ZipExtractor();
    this.gmailClient = new GmailClient();
    this.gmailImportService = new GmailImportService(
      this.gmailClient,
      new ReceiptExtractor(),
      this.receiptRepository,
      this.importPreferencesRepository,
      this.userRepository,
      this.cacheService,
    );
    this.ongoingTrackingService = new OngoingTrackingService(
      this.userRepository,
      this.importPreferencesRepository,
      this.gmailImportService,
    );
    this.gmailConnectionHealthService = new GmailConnectionHealthService(
      this.gmailClient,
      this.userRepository,
      this.importPreferencesRepository,
    );
    this.accountResetService = new AccountResetService(
      this.postgres,
      this.cacheService,
      this.gmailConnectionHealthService
    );
    this.receiptClearService = new ReceiptClearService(this.postgres, this.cacheService);
    this.listReceiptsService = new ListReceiptsService(this.receiptRepository);
    this.accountDeletionService = new AccountDeletionService(
      this.postgres,
      this.cacheService,
      this.gmailConnectionHealthService,
      this.authService
    );
    this.wrappedAnalyticsQueryRepository = new WrappedAnalyticsQueryRepository(this.postgres);
    this.wrappedAnalyticsService = new WrappedAnalyticsService(this.wrappedAnalyticsQueryRepository);
    this.getUserSummaryService = new GetUserSummaryService(
      this.userRepository,
      this.receiptRepository,
      this.wrappedAnalyticsService,
      this.cacheService,
    );
    this.getDashboardInsightsService = new GetDashboardInsightsService(
      this.userRepository,
      this.receiptRepository,
      this.cacheService,
    );
    this.otpService = new OtpService(this.postgres);
    this.emailSender = new EmailSenderService();
    this.alertingService = new AlertingService(this.postgres);
  }

  static getInstance(): ServiceContainer {
    if (!this.instance) this.instance = new ServiceContainer();
    return this.instance;
  }
}

export const container = ServiceContainer.getInstance();
