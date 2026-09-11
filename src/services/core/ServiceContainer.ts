import { AccountDeletionService } from '../account/AccountDeletionService';
import { ReceiptClearService } from '../account/ReceiptClearService';
import { AlertingService } from '../monitoring/AlertingService';
import { CredentialAuthService } from '../auth/CredentialAuthService';
import { EmailVerificationService } from '../auth/EmailVerificationService';
import { AppleIdentityTokenVerifier, GoogleIdentityTokenVerifier } from '../auth/IdentityProvider';
import { PasswordResetService } from '../auth/PasswordResetService';
import { ProviderAuthService } from '../auth/ProviderAuthService';
import { MicrosoftLoginService } from '../auth/MicrosoftLoginService';
import { MicrosoftIdentityVerifier } from '../auth/MicrosoftIdentityVerifier';
import { MicrosoftJwksClient } from '../auth/MicrosoftJwksClient';
import { SessionService } from '../auth/SessionService';
import { TokenService } from '../auth/TokenService';
import { AuthenticationActivityService } from '../auth/AuthenticationActivityService';
import { WrappedAnalyticsService } from '../analytics/WrappedAnalyticsService';
import { WrappedAnalyticsQueryRepository } from '../analytics/WrappedAnalyticsQueryRepository';
import { AccountResetService } from '../data/AccountResetService';
import { GmailSyncRunRepository } from '../data/GmailSyncRunRepository';
import { MailboxConnectionRepository } from '../data/MailboxConnectionRepository';
import { MailboxSyncRunRepository } from '../data/MailboxSyncRunRepository';
import { ImportEventRepository } from '../data/ImportEventRepository';
import { ImportLifecycleRepository } from '../data/ImportLifecycleRepository';
import { ImportPreferencesQueryRepository } from '../data/ImportPreferencesQueryRepository';
import { ImportSourceCoverageRepository } from '../data/ImportSourceCoverageRepository';
import { OAuthRepository } from '../data/OAuthRepository';
import { MicrosoftLoginAttemptRepository } from '../data/MicrosoftLoginAttemptRepository';
import { PostgresService } from '../data/PostgresService';
import { ReceiptRepository } from '../data/ReceiptRepository';
import { UserRepository } from '../data/UserRepository';
import { EmailSenderService } from '../email/EmailSender';
import { GmailConnectionHealthService } from '../email/GmailConnectionHealthService';
import { GmailClient } from '../email/GmailClient';
import { GmailOAuthProvider } from '../email/GmailOAuthProvider';
import { MailboxSecretCipher } from '../mailbox/MailboxSecretCipher';
import { MicrosoftMailboxOAuthProvider } from '../mailbox/MicrosoftMailboxOAuthProvider';
import { MicrosoftMailboxTokenService } from '../mailbox/MicrosoftMailboxTokenService';
import { MicrosoftGraphMailboxClient } from '../mailbox/MicrosoftGraphMailboxClient';
import { MicrosoftMailboxConnectionHealthService } from '../mailbox/MicrosoftMailboxConnectionHealthService';
import { MicrosoftMailboxConnectionService } from '../mailbox/MicrosoftMailboxConnectionService';
import { OutlookExportReadyDetector } from '../mailbox/OutlookExportReadyDetector';
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
import { HistoricalOutlookImportService } from '../import/HistoricalOutlookImportService';
import { OutlookImportAcquisitionService } from '../import/OutlookImportAcquisitionService';
import { OutlookImportService } from '../import/OutlookImportService';
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
import { refreshTokenStore } from '../../config/redis';
import appleSignin from 'apple-signin-auth';
import { ZipExtractor } from '../import/ZipExtractor';
import { ImportLockService } from '../import/ImportLockService';
import { ImportStatusService } from '../import/ImportStatusService';
import { ImportPreferencesService } from '../import/ImportPreferencesService';
import { AdministratorQueryRepository } from '../admin/AdministratorQueryRepository';
import { AdministratorService } from '../admin/AdministratorService';
import { MonitoringQueryRepository } from '../monitoring/MonitoringQueryRepository';
import { MonitoringService } from '../monitoring/MonitoringService';
import { AdminRepository } from '../admin/AdminRepository';
import { AdminAuthService } from '../admin/AdminAuthService';
import { AdminManagementService } from '../admin/AdminManagementService';
import { AdminAnalyticsQueryService, AnalyticsEventService } from '../analytics/AdminAnalyticsService';
import { AnalyticsMaintenanceService } from '../analytics/AnalyticsMaintenanceService';
import { DatabaseHealthService } from '../data/DatabaseHealthService';
import { MigrationRunner } from '../data/MigrationRunner';
import { migrations } from '../data/migrations';
import { ImportJobRepository } from '../data/ImportJobRepository';
import { ImportJobService } from '../import/ImportJobService';
import { ScheduledImportJobService } from '../import/ScheduledImportJobService';
import { ImportObjectStorage } from '../storage/ImportObjectStorage';
import { PushDeviceRepository } from '../notifications/PushDeviceRepository';
import { MailboxSecurityPolicyRepository } from '../data/MailboxSecurityPolicyRepository';
import { ImportTestScenarioRepository } from '../data/ImportTestScenarioRepository';
import { AdConfigurationRepository } from '../data/AdConfigurationRepository';
import { AdConfigurationService } from '../ads/AdConfigurationService';
import { ExperienceStateRepository } from '../data/ExperienceStateRepository';
import { ExperienceStateService } from '../experience/ExperienceStateService';
import { GmailUnitBudgetRepository } from '../data/GmailUnitBudgetRepository';
import { GmailPushRepository } from '../data/GmailPushRepository';
import { GmailPubSubVerifier } from '../email/GmailPubSubVerifier';
import { GmailWatchService } from '../import/GmailWatchService';
import { GmailPushDispatchService } from '../import/GmailPushDispatchService';
import { GmailPushTrackingService } from '../import/GmailPushTrackingService';
import { GmailPushMaintenanceService } from '../import/GmailPushMaintenanceService';

/** The process-wide, typed composition root and resource owner. */
export class ServiceContainer {
  readonly postgres: PostgresService;
  readonly userRepository: UserRepository;
  readonly oauthRepository: OAuthRepository;
  readonly microsoftLoginAttemptRepository: MicrosoftLoginAttemptRepository;
  readonly receiptRepository: ReceiptRepository;
  readonly importEventRepository: ImportEventRepository;
  readonly importLifecycleRepository: ImportLifecycleRepository;
  readonly gmailSyncRunRepository: GmailSyncRunRepository;
  readonly mailboxConnectionRepository: MailboxConnectionRepository;
  readonly mailboxSyncRunRepository: MailboxSyncRunRepository;
  readonly importPreferencesQueryRepository: ImportPreferencesQueryRepository;
  readonly importSourceCoverageRepository: ImportSourceCoverageRepository;
  readonly cacheService: CacheService;
  readonly tokenService: TokenService;
  readonly credentialAuthService: CredentialAuthService;
  readonly providerAuthService: ProviderAuthService;
  readonly microsoftLoginService: MicrosoftLoginService;
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
  readonly microsoftMailboxOAuthProvider: MicrosoftMailboxOAuthProvider;
  readonly microsoftMailboxTokenService: MicrosoftMailboxTokenService;
  readonly microsoftGraphMailboxClient: MicrosoftGraphMailboxClient;
  readonly microsoftMailboxConnectionHealthService: MicrosoftMailboxConnectionHealthService;
  readonly microsoftMailboxConnectionService: MicrosoftMailboxConnectionService;
  readonly outlookImportAcquisitionService: OutlookImportAcquisitionService;
  readonly outlookImportService: OutlookImportService;
  readonly historicalOutlookImportService: HistoricalOutlookImportService;
  readonly outlookExportReadyDetector: OutlookExportReadyDetector;
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
  readonly adminRepository: AdminRepository;
  readonly adminAuthService: AdminAuthService;
  readonly adminManagementService: AdminManagementService;
  readonly adminAnalyticsQueryService: AdminAnalyticsQueryService;
  readonly analyticsEventService: AnalyticsEventService;
  readonly authenticationActivityService: AuthenticationActivityService;
  readonly analyticsMaintenanceService: AnalyticsMaintenanceService;
  readonly databaseHealthService: DatabaseHealthService;
  readonly migrationRunner: MigrationRunner;
  readonly importJobRepository: ImportJobRepository;
  readonly importJobService: ImportJobService;
  readonly scheduledImportJobService: ScheduledImportJobService;
  readonly importObjectStorage: ImportObjectStorage;
  readonly pushDeviceRepository: PushDeviceRepository;
  readonly mailboxSecurityPolicyRepository: MailboxSecurityPolicyRepository;
  readonly importTestScenarioRepository: ImportTestScenarioRepository;
  readonly adConfigurationRepository: AdConfigurationRepository;
  readonly adConfigurationService: AdConfigurationService;
  readonly experienceStateRepository: ExperienceStateRepository;
  readonly experienceStateService: ExperienceStateService;
  readonly gmailUnitBudgetRepository: GmailUnitBudgetRepository;
  readonly gmailPushRepository: GmailPushRepository;
  readonly gmailPubSubVerifier: GmailPubSubVerifier;
  readonly gmailWatchService: GmailWatchService;
  readonly gmailPushDispatchService: GmailPushDispatchService;
  readonly gmailPushTrackingService: GmailPushTrackingService;
  readonly gmailPushMaintenanceService: GmailPushMaintenanceService;

  constructor() {
    this.postgres = new PostgresService({
      connectionString: config.getDatabaseConnectionString(),
      useSsl: config.shouldUseDatabaseSSL(),
      maxConnections: config.getDatabaseMaxConnections(),
    });
    this.userRepository = new UserRepository(this.postgres);
    this.oauthRepository = new OAuthRepository(this.postgres);
    this.microsoftLoginAttemptRepository = new MicrosoftLoginAttemptRepository(this.postgres);
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
    const microsoftMailboxConfig = config.getMicrosoftMailboxConfig();
    const mailboxCipher = new MailboxSecretCipher(microsoftMailboxConfig.tokenEncryptionKey);
    this.mailboxConnectionRepository = new MailboxConnectionRepository(
      this.postgres,
      mailboxCipher,
    );
    this.mailboxSyncRunRepository = new MailboxSyncRunRepository(this.postgres);
    this.importPreferencesQueryRepository = new ImportPreferencesQueryRepository(this.postgres);
    this.importSourceCoverageRepository = new ImportSourceCoverageRepository(this.postgres);
    const gmailConfig = config.getGmailConfig();
    this.gmailUnitBudgetRepository = new GmailUnitBudgetRepository(this.postgres, {
      projectMinute: gmailConfig.projectMinuteUnitLimit,
      projectDay: gmailConfig.projectDailyUnitLimit,
      userMinute: gmailConfig.userMinuteUnitLimit,
    });
    this.gmailPushRepository = new GmailPushRepository(this.postgres);
    this.gmailPubSubVerifier = new GmailPubSubVerifier({
      audience: gmailConfig.pubsubAudience,
      serviceAccountEmail: gmailConfig.pubsubServiceAccountEmail,
      subscription: gmailConfig.pubsubSubscription,
    });
    this.importJobRepository = new ImportJobRepository(
      this.postgres,
      config.getQueueConfig().maximumWaitingJobs,
    );
    this.mailboxSecurityPolicyRepository = new MailboxSecurityPolicyRepository(this.postgres);
    this.importTestScenarioRepository = new ImportTestScenarioRepository(this.postgres);
    this.adConfigurationRepository = new AdConfigurationRepository(this.postgres);
    this.adConfigurationService = new AdConfigurationService(this.adConfigurationRepository);
    this.experienceStateRepository = new ExperienceStateRepository(this.postgres);
    this.experienceStateService = new ExperienceStateService(this.experienceStateRepository);
    this.importObjectStorage = new ImportObjectStorage(config.getObjectStorageConfig());
    this.importJobService = new ImportJobService(this.importJobRepository, this.importObjectStorage);
    this.pushDeviceRepository = new PushDeviceRepository(this.postgres);
    this.cacheService = new CacheService();
    this.emailSender = new EmailSenderService();
    this.adminRepository = new AdminRepository(this.postgres);
    this.analyticsEventService = new AnalyticsEventService(this.postgres);
    this.authenticationActivityService = new AuthenticationActivityService(this.analyticsEventService, logger);
    this.analyticsMaintenanceService = new AnalyticsMaintenanceService(this.postgres);
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
      refreshTokenStore,
      logger,
    );
    this.credentialAuthService = new CredentialAuthService(this.userRepository, this.tokenService, this.authenticationActivityService);
    this.providerAuthService = new ProviderAuthService(
      this.userRepository,
      this.oauthRepository,
      this.tokenService,
      new GoogleIdentityTokenVerifier(new OAuth2Client(googleAudiences[0]), googleAudiences),
      new AppleIdentityTokenVerifier(appleSignin, config.getAppleConfig().clientIds),
      logger,
      this.authenticationActivityService,
    );
    const microsoftLoginConfig = config.getMicrosoftLoginConfig();
    const microsoftIdentityVerifier =
      microsoftLoginConfig.enabled && microsoftLoginConfig.clientId
        ? new MicrosoftIdentityVerifier(
            microsoftLoginConfig.clientId,
            new MicrosoftJwksClient(microsoftLoginConfig.jwksUri, (url) =>
              fetch(url, { signal: AbortSignal.timeout(5_000) }),
            ),
          )
        : null;
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
    this.gmailClient = new GmailClient(logger, this.emailDebugCapture, undefined, this.gmailUnitBudgetRepository);
    this.gmailWatchService = new GmailWatchService(
      this.userRepository,
      this.importPreferencesQueryRepository,
      this.gmailClient,
      this.gmailPushRepository,
      gmailConfig.pubsubTopic,
      logger,
    );
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
      this.mailboxSecurityPolicyRepository,
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
    this.gmailConnectionHealthService = new GmailConnectionHealthService(
      this.gmailClient,
      this.userRepository,
      this.importLifecycleRepository,
    );
    this.microsoftMailboxOAuthProvider = new MicrosoftMailboxOAuthProvider(
      {
        clientId: microsoftMailboxConfig.clientId,
        clientSecret: microsoftMailboxConfig.clientSecret,
        callbackRedirectUri: microsoftMailboxConfig.redirectUri,
        authority: microsoftMailboxConfig.authority,
      },
      mailboxCipher,
    );
    this.microsoftMailboxTokenService = new MicrosoftMailboxTokenService(
      this.microsoftMailboxOAuthProvider,
      this.mailboxConnectionRepository,
    );
    this.microsoftGraphMailboxClient = new MicrosoftGraphMailboxClient(
      this.microsoftMailboxTokenService,
      fetch,
      logger,
    );
    this.microsoftMailboxConnectionHealthService = new MicrosoftMailboxConnectionHealthService(
      this.microsoftGraphMailboxClient,
      this.mailboxConnectionRepository,
      this.importLifecycleRepository,
    );
    this.microsoftMailboxConnectionService = new MicrosoftMailboxConnectionService(
      this.microsoftMailboxOAuthProvider,
      this.mailboxConnectionRepository,
      this.userRepository,
      this.importPreferencesQueryRepository,
      this.importLifecycleRepository,
      this.mailboxSyncRunRepository,
      this.microsoftMailboxConnectionHealthService,
    );
    this.outlookImportAcquisitionService = new OutlookImportAcquisitionService(
      this.mailboxConnectionRepository,
      this.microsoftGraphMailboxClient,
      this.receiptRepository,
      this.importPreferencesQueryRepository,
      this.mailboxSecurityPolicyRepository,
    );
    this.outlookImportService = new OutlookImportService(
      this.outlookImportAcquisitionService,
      this.receiptEmailBatchExtractor,
      this.receiptImportPersistenceService,
      this.mailboxSyncRunRepository,
      this.mailboxConnectionRepository,
      this.importLifecycleRepository,
      logger,
    );
    this.ongoingTrackingService = new OngoingTrackingService(
      this.userRepository,
      this.importPreferencesQueryRepository,
      this.importLifecycleRepository,
      this.gmailImportService,
      ImportLockService,
      this.mailboxConnectionRepository,
      this.outlookImportService,
    );
    this.historicalOutlookImportService = new HistoricalOutlookImportService(
      this.userRepository,
      this.microsoftMailboxConnectionHealthService,
      this.outlookImportService,
      ImportLockService,
    );
    this.outlookExportReadyDetector = new OutlookExportReadyDetector(
      this.mailboxConnectionRepository,
      this.microsoftGraphMailboxClient,
    );
    this.gmailConnectionService = new GmailConnectionService(
      this.gmailOAuthProvider,
      this.userRepository,
      this.importPreferencesQueryRepository,
      this.importLifecycleRepository,
      this.gmailSyncRunRepository,
      this.gmailConnectionHealthService,
      this.mailboxConnectionRepository,
      this.gmailWatchService,
    );
    this.importStatusService = new ImportStatusService(
      this.userRepository,
      this.gmailConnectionHealthService,
      this.importPreferencesQueryRepository,
      this.importSourceCoverageRepository,
      this.microsoftMailboxConnectionHealthService,
      this.mailboxConnectionRepository,
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
      this.importSourceCoverageRepository,
      this.outlookExportReadyDetector,
      this.gmailWatchService,
    );
    this.gmailPushDispatchService = new GmailPushDispatchService(
      this.gmailPushRepository,
      this.importJobRepository,
    );
    this.gmailPushMaintenanceService = new GmailPushMaintenanceService(
      this.gmailPushDispatchService,
      this.gmailWatchService,
    );
    this.gmailPushTrackingService = new GmailPushTrackingService(
      this.importPreferencesService,
      this.ongoingTrackingService,
      this.gmailPushRepository,
      this.gmailWatchService,
    );
    this.manualTrackingCheckService = new ManualTrackingCheckService(
      this.ongoingTrackingService,
      this.importPreferencesService,
    );
    this.scheduledImportJobService = new ScheduledImportJobService(
      this.importPreferencesQueryRepository,
      this.importJobRepository,
    );
    const mailboxHealth = {
      invalidate: (userId: string) => {
        this.gmailConnectionHealthService.invalidate(userId);
        this.microsoftMailboxConnectionHealthService.invalidate(userId);
      },
    };
    this.accountResetService = new AccountResetService(
      this.postgres,
      this.cacheService,
      mailboxHealth,
      ImportLockService,
      this.gmailWatchService,
    );
    this.receiptClearService = new ReceiptClearService(this.postgres, this.cacheService);
    this.listReceiptsService = new ListReceiptsService(this.receiptRepository);
    this.accountDeletionService = new AccountDeletionService(
      this.postgres,
      this.cacheService,
      mailboxHealth,
      this.tokenService,
      ImportLockService,
      logger,
      this.adminRepository,
      this.gmailWatchService,
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
    this.adminManagementService = new AdminManagementService(
      this.postgres,
      this.accountDeletionService,
      this.mailboxSecurityPolicyRepository,
      this.importTestScenarioRepository,
      this.gmailConnectionService,
    );
    this.adminAnalyticsQueryService = new AdminAnalyticsQueryService(this.postgres);
    this.adminAuthService = new AdminAuthService(this.adminRepository, this.emailSender, {
      dashboardUrl: config.getSecurityConfig().adminDashboardUrl,
    });
    this.databaseHealthService = new DatabaseHealthService(this.postgres);
    this.migrationRunner = new MigrationRunner(this.postgres, migrations);
    this.otpService = new OtpService(this.postgres);
    this.microsoftLoginService = new MicrosoftLoginService(
      microsoftLoginConfig.enabled,
      this.microsoftLoginAttemptRepository,
      microsoftIdentityVerifier,
      this.oauthRepository,
      this.otpService,
      this.emailSender,
      this.tokenService,
      logger,
      undefined,
      this.authenticationActivityService,
    );
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
