import { AccountDeletionService } from '../account/AccountDeletionService';
import { ReceiptClearService } from '../account/ReceiptClearService';
import { AlertingService } from '../monitoring/AlertingService';
import { CredentialAuthService } from '../auth/CredentialAuthService';
import { EmailVerificationService } from '../auth/EmailVerificationService';
import { AppleIdentityTokenVerifier, GoogleIdentityTokenVerifier } from '../auth/IdentityProvider';
import { PasswordResetService } from '../auth/PasswordResetService';
import { ProviderAuthService } from '../auth/ProviderAuthService';
import { SessionService } from '../auth/SessionService';
import { TokenService } from '../auth/TokenService';
import { WrappedAnalyticsService } from '../analytics/WrappedAnalyticsService';
import { WrappedAnalyticsQueryRepository } from '../analytics/WrappedAnalyticsQueryRepository';
import { AccountResetService } from '../data/AccountResetService';
import { GmailSyncRunRepository } from '../data/GmailSyncRunRepository';
import { ImportEventRepository } from '../data/ImportEventRepository';
import { ImportLifecycleRepository } from '../data/ImportLifecycleRepository';
import { ImportPreferencesQueryRepository } from '../data/ImportPreferencesQueryRepository';
import { ImportSourceCoverageRepository } from '../data/ImportSourceCoverageRepository';
import { OAuthRepository } from '../data/OAuthRepository';
import { PostgresService } from '../data/PostgresService';
import { ReceiptRepository } from '../data/ReceiptRepository';
import { UserRepository } from '../data/UserRepository';
import { EmailSenderService } from '../email/EmailSender';
import { GmailConnectionHealthService } from '../email/GmailConnectionHealthService';
import { GmailClient } from '../email/GmailClient';
import { GmailOAuthProvider } from '../email/GmailOAuthProvider';
import { RedactingFileEmailDebugCapture } from '../email/EmailDebugCapture';
import type { EmailDebugCapturePort } from '../ports/MailboxPorts';
import { ReceiptExtractor } from '../extraction';
import { CsvImportService } from '../import/CsvImportService';
import { CsvImportUseCase } from '../import/CsvImportUseCase';
import { GmailImportService } from '../import/GmailImportService';
import { GmailImportAcquisitionService } from '../import/GmailImportAcquisitionService';
import { GmailImportLifecycleService } from '../import/GmailImportLifecycleService';
import { ReceiptEmailBatchExtractor } from '../import/ReceiptEmailBatchExtractor';
import { ReceiptImportPersistenceService } from '../import/ReceiptImportPersistenceService';
import { GmailConnectionService } from '../import/GmailConnectionService';
import { HistoricalGmailImportService } from '../import/HistoricalGmailImportService';
import { OngoingTrackingService } from '../import/OngoingTrackingService';
import { ManualTrackingCheckService } from '../import/ManualTrackingCheckService';
import { OtpService } from '../OtpService';
import { ListReceiptsService } from '../receipt/ListReceiptsService';
import { GetUserSummaryService } from '../user/GetUserSummaryService';
import { GetDashboardInsightsService } from '../user/GetDashboardInsightsService';
import { CacheService } from './CacheService';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../../config/AppConfig';
import logger from '../../config/logger';
import { redisConfig } from '../../config/redis';
import appleSignin from 'apple-signin-auth';
import { ZipExtractor } from '../import/ZipExtractor';
import { ImportLockService } from '../import/ImportLockService';
import { ImportStatusService } from '../import/ImportStatusService';
import { ImportPreferencesService } from '../import/ImportPreferencesService';
import { AdministratorQueryRepository } from '../admin/AdministratorQueryRepository';
import { AdministratorService } from '../admin/AdministratorService';
import { MonitoringQueryRepository } from '../monitoring/MonitoringQueryRepository';
import { MonitoringService } from '../monitoring/MonitoringService';
import { DatabaseHealthService } from '../data/DatabaseHealthService';
import { MigrationRunner } from '../data/MigrationRunner';
import { migrations } from '../data/migrations';

/** The process-wide, typed composition root and resource owner. */
export class ServiceContainer {
  readonly postgres: PostgresService;
  readonly userRepository: UserRepository;
  readonly oauthRepository: OAuthRepository;
  readonly receiptRepository: ReceiptRepository;
  readonly importEventRepository: ImportEventRepository;
  readonly importLifecycleRepository: ImportLifecycleRepository;
  readonly gmailSyncRunRepository: GmailSyncRunRepository;
  readonly importPreferencesQueryRepository: ImportPreferencesQueryRepository;
  readonly importSourceCoverageRepository: ImportSourceCoverageRepository;
  readonly cacheService: CacheService;
  readonly tokenService: TokenService;
  readonly credentialAuthService: CredentialAuthService;
  readonly providerAuthService: ProviderAuthService;
  readonly sessionService: SessionService;
  readonly passwordResetService: PasswordResetService;
  readonly emailVerificationService: EmailVerificationService;
  readonly csvImportService: CsvImportService;
  readonly csvImportUseCase: CsvImportUseCase;
  readonly zipExtractor: ZipExtractor;
  readonly gmailClient: GmailClient;
  readonly emailDebugCapture: EmailDebugCapturePort;
  readonly gmailOAuthProvider: GmailOAuthProvider;
  readonly gmailImportService: GmailImportService;
  readonly gmailImportAcquisitionService: GmailImportAcquisitionService;
  readonly gmailImportLifecycleService: GmailImportLifecycleService;
  readonly receiptEmailBatchExtractor: ReceiptEmailBatchExtractor;
  readonly receiptImportPersistenceService: ReceiptImportPersistenceService;
  readonly gmailConnectionService: GmailConnectionService;
  readonly historicalGmailImportService: HistoricalGmailImportService;
  readonly importStatusService: ImportStatusService;
  readonly importPreferencesService: ImportPreferencesService;
  readonly ongoingTrackingService: OngoingTrackingService;
  readonly manualTrackingCheckService: ManualTrackingCheckService;
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
  readonly administratorQueryRepository: AdministratorQueryRepository;
  readonly administratorService: AdministratorService;
  readonly monitoringQueryRepository: MonitoringQueryRepository;
  readonly monitoringService: MonitoringService;
  readonly databaseHealthService: DatabaseHealthService;
  readonly migrationRunner: MigrationRunner;

  constructor() {
    this.postgres = new PostgresService({
      connectionString: config.getDatabaseConnectionString(),
      useSsl: config.shouldUseDatabaseSSL(),
      maxConnections: config.isProduction() ? 20 : 10,
    });
    this.userRepository = new UserRepository(this.postgres);
    this.oauthRepository = new OAuthRepository(this.postgres);
    this.receiptRepository = new ReceiptRepository(this.postgres);
    this.importEventRepository = new ImportEventRepository(this.postgres);
    this.importLifecycleRepository = new ImportLifecycleRepository(
      this.postgres,
      this.importEventRepository,
    );
    this.gmailSyncRunRepository = new GmailSyncRunRepository(
      this.postgres,
      this.importEventRepository,
    );
    this.importPreferencesQueryRepository = new ImportPreferencesQueryRepository(this.postgres);
    this.importSourceCoverageRepository = new ImportSourceCoverageRepository(this.postgres);
    this.cacheService = new CacheService();
    const gmailConfig = config.getGmailConfig();
    const googleAudiences = [
      gmailConfig.clientId,
      gmailConfig.iosClientId,
      gmailConfig.webClientId,
    ].filter((value): value is string => Boolean(value));
    const auth = config.getAuthConfig();
    this.tokenService = new TokenService(
      {
        accessSecret: auth.jwtSecret,
        refreshSecret: auth.jwtRefreshSecret,
        accessTokenExpiry: auth.accessTokenExpiry,
        refreshTokenExpiry: auth.refreshTokenExpiry,
      },
      redisConfig,
      logger,
    );
    this.credentialAuthService = new CredentialAuthService(this.userRepository, this.tokenService);
    this.providerAuthService = new ProviderAuthService(
      this.userRepository,
      this.oauthRepository,
      this.tokenService,
      new GoogleIdentityTokenVerifier(new OAuth2Client(googleAudiences[0]), googleAudiences),
      new AppleIdentityTokenVerifier(appleSignin, config.getAppleConfig().clientIds),
      logger,
    );
    this.sessionService = new SessionService(this.userRepository, this.tokenService);
    this.csvImportService = new CsvImportService(logger);
    this.csvImportUseCase = new CsvImportUseCase(
      this.csvImportService,
      this.receiptRepository,
      this.userRepository,
      this.importLifecycleRepository,
      this.cacheService,
      ImportLockService,
    );
    this.zipExtractor = new ZipExtractor();
    this.emailDebugCapture = new RedactingFileEmailDebugCapture(
      config.shouldSaveDebugEmails(),
      logger,
    );
    this.gmailClient = new GmailClient(logger, this.emailDebugCapture);
    this.gmailOAuthProvider = new GmailOAuthProvider({
      clientId: gmailConfig.clientId,
      clientSecret: gmailConfig.clientSecret,
      callbackRedirectUri: gmailConfig.redirectUri,
      stateSecret: config.getAuthConfig().jwtSecret,
    });
    this.gmailImportAcquisitionService = new GmailImportAcquisitionService(
      this.gmailClient,
      this.receiptRepository,
      this.importPreferencesQueryRepository,
    );
    this.receiptEmailBatchExtractor = new ReceiptEmailBatchExtractor(
      new ReceiptExtractor(),
      this.emailDebugCapture,
    );
    this.receiptImportPersistenceService = new ReceiptImportPersistenceService(
      this.receiptRepository,
      this.cacheService,
      ImportLockService,
    );
    this.gmailImportLifecycleService = new GmailImportLifecycleService(
      this.gmailSyncRunRepository,
      this.importLifecycleRepository,
      this.userRepository,
    );
    this.gmailImportService = new GmailImportService(
      this.gmailImportAcquisitionService,
      this.receiptEmailBatchExtractor,
      this.receiptImportPersistenceService,
      this.gmailImportLifecycleService,
      logger,
    );
    this.ongoingTrackingService = new OngoingTrackingService(
      this.userRepository,
      this.importPreferencesQueryRepository,
      this.importLifecycleRepository,
      this.gmailImportService,
      ImportLockService,
    );
    this.gmailConnectionHealthService = new GmailConnectionHealthService(
      this.gmailClient,
      this.userRepository,
      this.importLifecycleRepository,
    );
    this.gmailConnectionService = new GmailConnectionService(
      this.gmailOAuthProvider,
      this.userRepository,
      this.importPreferencesQueryRepository,
      this.importLifecycleRepository,
      this.gmailSyncRunRepository,
      this.gmailConnectionHealthService,
    );
    this.importStatusService = new ImportStatusService(
      this.userRepository,
      this.gmailConnectionHealthService,
      this.importPreferencesQueryRepository,
      this.importSourceCoverageRepository,
    );
    this.historicalGmailImportService = new HistoricalGmailImportService(
      this.importStatusService,
      this.gmailImportService,
      ImportLockService,
      logger,
    );
    this.importPreferencesService = new ImportPreferencesService(
      this.importLifecycleRepository,
      this.importPreferencesQueryRepository,
      this.importStatusService,
      this.gmailClient,
    );
    this.manualTrackingCheckService = new ManualTrackingCheckService(
      this.ongoingTrackingService,
      this.importPreferencesService,
    );
    this.accountResetService = new AccountResetService(
      this.postgres,
      this.cacheService,
      this.gmailConnectionHealthService,
    );
    this.receiptClearService = new ReceiptClearService(this.postgres, this.cacheService);
    this.listReceiptsService = new ListReceiptsService(this.receiptRepository);
    this.accountDeletionService = new AccountDeletionService(
      this.postgres,
      this.cacheService,
      this.gmailConnectionHealthService,
      this.tokenService,
      ImportLockService,
      logger,
    );
    this.wrappedAnalyticsQueryRepository = new WrappedAnalyticsQueryRepository(this.postgres);
    this.wrappedAnalyticsService = new WrappedAnalyticsService(
      this.wrappedAnalyticsQueryRepository,
      logger,
    );
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
    this.administratorQueryRepository = new AdministratorQueryRepository(this.postgres);
    this.administratorService = new AdministratorService(this.administratorQueryRepository);
    this.monitoringQueryRepository = new MonitoringQueryRepository(this.postgres);
    this.monitoringService = new MonitoringService(this.monitoringQueryRepository);
    this.databaseHealthService = new DatabaseHealthService(this.postgres);
    this.migrationRunner = new MigrationRunner(this.postgres, migrations);
    this.otpService = new OtpService(this.postgres);
    this.emailSender = new EmailSenderService();
    this.passwordResetService = new PasswordResetService(
      this.userRepository,
      this.otpService,
      this.emailSender,
      logger,
    );
    this.emailVerificationService = new EmailVerificationService(
      this.userRepository,
      this.otpService,
      this.emailSender,
      logger,
    );
    this.alertingService = new AlertingService(this.databaseHealthService);
  }
}

export const container = new ServiceContainer();
