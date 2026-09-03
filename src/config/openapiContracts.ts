import {
  AUTH_SESSION_FIXTURE,
  CSV_IMPORT_FIXTURE,
  ERROR_ENVELOPE_FIXTURE,
  RECEIPT_PAGE_FIXTURE,
} from '../contracts/contractFixtures';

const schema = (name: string): Readonly<Record<string, unknown>> => ({
  $ref: `#/components/schemas/${name}`,
});
const response = (description: string, schemaName: string, example?: unknown) => ({
  description,
  content: {
    'application/json': {
      schema: schema(schemaName),
      ...(example === undefined ? {} : { example }),
    },
  },
});
const jsonBody = (schemaName: string, required = true) => ({
  required,
  content: { 'application/json': { schema: schema(schemaName) } },
});
const secured = [{ BearerAuth: [] }];
const nullableTimestamp = { type: 'string', format: 'date-time', nullable: true };
const gmailHealth = {
  type: 'string',
  enum: ['disconnected', 'valid', 'reconnect_required', 'unavailable'],
};
const providerState = {
  type: 'object',
  additionalProperties: false,
  required: ['provider', 'status', 'requestedAt', 'updatedAt', 'errorCode', 'readySource', 'relevance'],
  properties: {
    provider: { type: 'string', enum: ['uber_eats', 'doordash'] },
    status: {
      type: 'string',
      enum: ['not_started', 'requested', 'file_ready', 'import_processing', 'completed', 'failed'],
    },
    requestedAt: nullableTimestamp,
    updatedAt: nullableTimestamp,
    errorCode: { type: 'string', nullable: true },
    readySource: {
      type: 'string',
      enum: ['detected_email', 'user_confirmed'],
      nullable: true,
    },
    relevance: { type: 'string', enum: ['unknown', 'not_used'] },
  },
};
const sourceCoverage = {
  type: 'object',
  additionalProperties: false,
  required: ['receiptCount', 'hasData', 'earliestOrderDate', 'latestOrderDate'],
  properties: {
    receiptCount: { type: 'integer', minimum: 0 },
    hasData: { type: 'boolean' },
    earliestOrderDate: nullableTimestamp,
    latestOrderDate: nullableTimestamp,
  },
};

export const contractSchemas = {
  AuthUser: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'email', 'emailVerified', 'createdAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      emailVerified: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  AuthSession: {
    type: 'object',
    additionalProperties: false,
    required: ['userId', 'email', 'accessToken', 'refreshToken', 'user'],
    properties: {
      userId: { type: 'string', format: 'uuid' },
      email: { type: 'string', format: 'email' },
      accessToken: { type: 'string' },
      refreshToken: { type: 'string' },
      user: schema('AuthUser'),
    },
    example: AUTH_SESSION_FIXTURE,
  },
  CredentialRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'password'],
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', format: 'password', minLength: 1 },
    },
  },
  GoogleAuthRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['idToken'],
    properties: { idToken: { type: 'string', minLength: 1 } },
  },
  AppleAuthRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['identityToken'],
    properties: {
      identityToken: { type: 'string', minLength: 1 },
      user: {
        type: 'object',
        additionalProperties: false,
        properties: {
          email: { type: 'string', format: 'email' },
          name: {
            type: 'object',
            additionalProperties: false,
            properties: { firstName: { type: 'string' }, lastName: { type: 'string' } },
          },
        },
      },
    },
  },
  MicrosoftLoginAttempt: {
    type: 'object',
    additionalProperties: false,
    required: ['attemptToken', 'nonce', 'expiresIn'],
    properties: {
      attemptToken: { type: 'string', minLength: 32 },
      nonce: { type: 'string', minLength: 32 },
      expiresIn: { type: 'integer', minimum: 1 },
    },
  },
  MicrosoftAuthRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['identityToken', 'attemptToken'],
    properties: {
      identityToken: { type: 'string', minLength: 20 },
      attemptToken: { type: 'string', minLength: 32 },
    },
  },
  MicrosoftEmailVerificationRequired: {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'attemptToken'],
    properties: {
      status: { type: 'string', enum: ['email_verification_required'] },
      attemptToken: { type: 'string', minLength: 32 },
      suggestedEmail: { type: 'string', format: 'email' },
    },
  },
  MicrosoftEmailRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['attemptToken', 'email'],
    properties: {
      attemptToken: { type: 'string', minLength: 32 },
      email: { type: 'string', format: 'email' },
    },
  },
  MicrosoftEmailCodeRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['attemptToken', 'email', 'code'],
    properties: {
      attemptToken: { type: 'string', minLength: 32 },
      email: { type: 'string', format: 'email' },
      code: { type: 'string', pattern: '^\\d{6}$' },
    },
  },
  MicrosoftEmailCodeSent: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'expiresIn', 'resendAfter'],
    properties: {
      success: { type: 'boolean', enum: [true] },
      expiresIn: { type: 'integer', minimum: 1 },
      resendAfter: { type: 'integer', minimum: 1 },
    },
  },
  RefreshTokenRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['refreshToken'],
    properties: { refreshToken: { type: 'string', minLength: 1 } },
  },
  OptionalRefreshTokenRequest: {
    type: 'object',
    additionalProperties: false,
    properties: { refreshToken: { type: 'string', minLength: 1 } },
  },
  TokenPair: {
    type: 'object',
    additionalProperties: false,
    required: ['accessToken', 'refreshToken'],
    properties: { accessToken: { type: 'string' }, refreshToken: { type: 'string' } },
  },
  EmailRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['email'],
    properties: { email: { type: 'string', format: 'email' } },
  },
  EmailCodeRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'code'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', pattern: '^\\d{6}$' },
    },
  },
  PasswordResetCompleteRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['email', 'code', 'newPassword'],
    properties: {
      email: { type: 'string', format: 'email' },
      code: { type: 'string', pattern: '^\\d{6}$' },
      newPassword: { type: 'string', format: 'password', minLength: 1 },
    },
  },
  OperationResult: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message'],
    properties: { success: { type: 'boolean' }, message: { type: 'string' } },
  },
  OtpResult: {
    type: 'object',
    additionalProperties: false,
    required: ['success', 'message', 'expiresIn'],
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      expiresIn: { type: 'integer', minimum: 1 },
      attemptLimit: { type: 'integer', minimum: 1 },
    },
  },
  ReceiptPage: {
    type: 'object',
    additionalProperties: false,
    required: ['items', 'pageInfo'],
    properties: {
      items: { type: 'array', items: schema('Receipt') },
      pageInfo: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'limit', 'total', 'totalPages', 'hasMore', 'nextPage'],
        properties: {
          page: { type: 'integer', minimum: 1 },
          limit: { type: 'integer', minimum: 1 },
          total: { type: 'integer', minimum: 0 },
          totalPages: { type: 'integer', minimum: 0 },
          hasMore: { type: 'boolean' },
          nextPage: { type: 'integer', minimum: 2, nullable: true },
        },
      },
    },
    example: RECEIPT_PAGE_FIXTURE,
  },
  CsvImportResult: {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'importedCount', 'totalAmount', 'fileType', 'provider'],
    properties: {
      message: { type: 'string' },
      importedCount: { type: 'integer', minimum: 1 },
      totalAmount: { type: 'number', minimum: 0 },
      fileType: { type: 'string', enum: ['csv', 'zip'] },
      provider: { type: 'string', enum: ['uber_eats', 'doordash'] },
    },
    example: CSV_IMPORT_FIXTURE,
  },
  GmailAuthUrlRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['redirectUri'],
    properties: {
      redirectUri: { type: 'string', minLength: 1, maxLength: 2048 },
      purpose: {
        type: 'string',
        enum: [
          'receipt_import',
          'export_ready_alerts',
          'ongoing_tracking',
          'connection_recovery',
          'manage_connection',
        ],
      },
    },
  },
  GmailDisconnectRequest: {
    type: 'object',
    additionalProperties: false,
    properties: { resetImportStatus: { type: 'boolean' } },
  },
  ConsentRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: {
      decision: { type: 'string', enum: ['granted', 'declined', 'revoked'] },
      consentVersion: { type: 'string', maxLength: 50 },
    },
  },
  ExportProviderRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['provider'],
    properties: { provider: { type: 'string', enum: ['uber_eats', 'doordash'] } },
  },
  SetupDeferralRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['decision'],
    properties: { decision: { type: 'string', enum: ['defer', 'resume'] } },
  },
  ProviderRelevanceRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['provider', 'relevance'],
    properties: {
      provider: { type: 'string', enum: ['uber_eats', 'doordash'] },
      relevance: { type: 'string', enum: ['unknown', 'not_used'] },
    },
  },
  SetupGuidance: {
    type: 'object',
    additionalProperties: false,
    required: ['initialSetupDeferredUntil'],
    properties: { initialSetupDeferredUntil: nullableTimestamp },
  },
  TrackingBatchRequest: {
    type: 'object',
    additionalProperties: false,
    properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } },
  },
  GmailConnectionStatus: {
    type: 'object',
    additionalProperties: false,
    required: [
      'connected',
      'canImport',
      'needsReconnect',
      'email',
      'connectionMode',
      'scopes',
      'hasRequiredScope',
      'expiresAt',
      'connectionHealth',
      'lastValidatedAt',
      'statusMessage',
    ],
    properties: {
      connected: { type: 'boolean' },
      canImport: { type: 'boolean' },
      needsReconnect: { type: 'boolean' },
      email: { type: 'string', format: 'email' },
      connectionMode: { type: 'string', enum: ['none', 'temporary', 'offline'] },
      scopes: { type: 'array', items: { type: 'string' } },
      hasRequiredScope: { type: 'boolean' },
      expiresAt: nullableTimestamp,
      connectionHealth: gmailHealth,
      lastValidatedAt: nullableTimestamp,
      statusMessage: { type: 'string' },
    },
  },
  OutlookConnectionStatus: {
    type: 'object',
    additionalProperties: false,
    required: [
      'provider',
      'connected',
      'canImport',
      'needsReconnect',
      'email',
      'connectionMode',
      'scopes',
      'hasRequiredScope',
      'expiresAt',
      'connectionHealth',
      'lastValidatedAt',
      'statusMessage',
    ],
    properties: {
      provider: { type: 'string', enum: ['microsoft'] },
      connected: { type: 'boolean' },
      canImport: { type: 'boolean' },
      needsReconnect: { type: 'boolean' },
      email: { type: 'string', format: 'email', nullable: true },
      connectionMode: { type: 'string', enum: ['none', 'temporary', 'offline'] },
      scopes: { type: 'array', items: { type: 'string' } },
      hasRequiredScope: { type: 'boolean' },
      expiresAt: nullableTimestamp,
      connectionHealth: gmailHealth,
      lastValidatedAt: nullableTimestamp,
      statusMessage: { type: 'string' },
    },
  },
  ImportPreferences: {
    type: 'object',
    additionalProperties: false,
    required: [
      'gmailConnection',
      'outlookConnection',
      'monitoring',
      'export',
      'gmailBaseline',
      'outlookBaseline',
      'ongoingTracking',
      'coverage',
      'setupGuidance',
    ],
    properties: {
      gmailConnection: schema('GmailConnectionStatus'),
      outlookConnection: schema('OutlookConnectionStatus'),
      monitoring: {
        type: 'object',
        required: [
          'consentState',
          'consentVersion',
          'consentedAt',
          'revokedAt',
          'effectiveState',
          'capability',
        ],
        properties: {
          consentState: { type: 'string', enum: ['not_offered', 'declined', 'granted', 'revoked'] },
          consentVersion: { type: 'string', nullable: true },
          consentedAt: nullableTimestamp,
          revokedAt: nullableTimestamp,
          effectiveState: {
            type: 'string',
            enum: ['not_offered', 'declined', 'enabled', 'disabled', 'reconnect_required'],
          },
          capability: {
            type: 'object',
            required: [
              'gmailConnected',
              'outlookConnected',
              'durableAccess',
              'needsReconnect',
              'connectionHealth',
              'lastValidatedAt',
              'canMonitor',
            ],
            properties: {
              gmailConnected: { type: 'boolean' },
              outlookConnected: { type: 'boolean' },
              durableAccess: { type: 'boolean' },
              needsReconnect: { type: 'boolean' },
              connectionHealth: gmailHealth,
              lastValidatedAt: nullableTimestamp,
              canMonitor: { type: 'boolean' },
            },
          },
        },
      },
      export: {
        type: 'object',
        required: ['providers'],
        properties: {
          providers: {
            type: 'object',
            required: ['uberEats', 'doorDash'],
            properties: { uberEats: providerState, doorDash: providerState },
          },
        },
      },
      gmailBaseline: {
        type: 'object',
        required: ['hasCompleted', 'completedAt', 'latestAttempt'],
        properties: {
          hasCompleted: { type: 'boolean' },
          completedAt: nullableTimestamp,
          latestAttempt: {
            type: 'object',
            required: ['status', 'updatedAt', 'importedCount', 'errorCode'],
            properties: {
              status: {
                type: 'string',
                enum: ['never_started', 'importing', 'completed', 'failed'],
              },
              updatedAt: nullableTimestamp,
              importedCount: { type: 'integer', minimum: 0 },
              errorCode: { type: 'string', nullable: true },
            },
          },
        },
      },
      outlookBaseline: {
        type: 'object',
        required: ['hasCompleted', 'completedAt', 'latestAttempt'],
        properties: {
          hasCompleted: { type: 'boolean' },
          completedAt: nullableTimestamp,
          latestAttempt: {
            type: 'object',
            required: ['status', 'updatedAt', 'importedCount', 'errorCode'],
            properties: {
              status: {
                type: 'string',
                enum: ['never_started', 'importing', 'completed', 'failed'],
              },
              updatedAt: nullableTimestamp,
              importedCount: { type: 'integer', minimum: 0 },
              errorCode: { type: 'string', nullable: true },
            },
          },
        },
      },
      ongoingTracking: {
        type: 'object',
        required: [
          'consentState',
          'consentVersion',
          'consentedAt',
          'revokedAt',
          'status',
          'effectiveState',
          'baseline',
          'capability',
          'activity',
        ],
        properties: {
          consentState: { type: 'string', enum: ['not_offered', 'declined', 'granted', 'revoked'] },
          consentVersion: { type: 'string', nullable: true },
          consentedAt: nullableTimestamp,
          revokedAt: nullableTimestamp,
          status: {
            type: 'string',
            enum: ['inactive', 'setting_up', 'active', 'paused', 'reconnect_required', 'error'],
          },
          effectiveState: {
            type: 'string',
            enum: [
              'not_offered',
              'declined',
              'setting_up',
              'active',
              'paused',
              'reconnect_required',
              'error',
            ],
          },
          baseline: {
            type: 'object',
            required: ['eligible', 'source'],
            properties: {
              eligible: { type: 'boolean' },
              source: { type: 'string', enum: ['gmail', 'outlook', 'exports', 'none'] },
            },
          },
          capability: {
            type: 'object',
            required: [
              'gmailConnected',
              'outlookConnected',
              'durableAccess',
              'needsReconnect',
              'connectionHealth',
              'lastValidatedAt',
              'canTrack',
            ],
            properties: {
              gmailConnected: { type: 'boolean' },
              outlookConnected: { type: 'boolean' },
              durableAccess: { type: 'boolean' },
              needsReconnect: { type: 'boolean' },
              connectionHealth: gmailHealth,
              lastValidatedAt: nullableTimestamp,
              canTrack: { type: 'boolean' },
            },
          },
          activity: {
            type: 'object',
            required: [
              'lastCheckAttemptAt',
              'lastSuccessfulCheckAt',
              'lastStatsUpdatedAt',
              'lastNewOrderAt',
              'ordersAddedThisWeek',
              'lastErrorAt',
              'lastErrorCode',
            ],
            properties: {
              lastCheckAttemptAt: nullableTimestamp,
              lastSuccessfulCheckAt: nullableTimestamp,
              lastStatsUpdatedAt: nullableTimestamp,
              lastNewOrderAt: nullableTimestamp,
              ordersAddedThisWeek: { type: 'integer', minimum: 0 },
              lastErrorAt: nullableTimestamp,
              lastErrorCode: { type: 'string', nullable: true },
            },
          },
        },
      },
      coverage: {
        type: 'object',
        required: [
          'emailReceiptCount',
          'exportReceiptCount',
          'hasEmailData',
          'hasExportData',
          'emailProviders',
          'exportProviders',
        ],
        properties: {
          emailReceiptCount: { type: 'integer', minimum: 0 },
          exportReceiptCount: { type: 'integer', minimum: 0 },
          hasEmailData: { type: 'boolean' },
          hasExportData: { type: 'boolean' },
          emailProviders: {
            type: 'object',
            required: ['uberEats', 'doorDash'],
            properties: { uberEats: sourceCoverage, doorDash: sourceCoverage },
          },
          exportProviders: {
            type: 'object',
            required: ['uberEats', 'doorDash'],
            properties: { uberEats: sourceCoverage, doorDash: sourceCoverage },
          },
        },
      },
      setupGuidance: schema('SetupGuidance'),
    },
  },
  GmailImportResult: {
    type: 'object',
    additionalProperties: false,
    required: [
      'success',
      'totalEmailsFound',
      'totalReceiptsProcessed',
      'emailsExamined',
      'supportedReceiptsFound',
      'exportCoveredReceipts',
      'eligibleReceipts',
      'deduplicatedReceipts',
      'totalReceiptsImported',
      'newOrders',
      'updatedOrders',
      'unchangedOrders',
      'totalAmount',
      'errors',
      'code',
    ],
    properties: {
      success: { type: 'boolean' },
      totalEmailsFound: { type: 'integer', minimum: 0 },
      totalReceiptsProcessed: { type: 'integer', minimum: 0 },
      emailsExamined: { type: 'integer', minimum: 0 },
      supportedReceiptsFound: { type: 'integer', minimum: 0 },
      exportCoveredReceipts: { type: 'integer', minimum: 0 },
      eligibleReceipts: { type: 'integer', minimum: 0 },
      deduplicatedReceipts: { type: 'integer', minimum: 0 },
      totalReceiptsImported: { type: 'integer', minimum: 0 },
      newOrders: { type: 'integer', minimum: 0 },
      updatedOrders: { type: 'integer', minimum: 0 },
      unchangedOrders: { type: 'integer', minimum: 0 },
      totalAmount: { type: 'number', minimum: 0 },
      errors: { type: 'array', items: { type: 'string' } },
      code: { type: 'string', nullable: true },
    },
  },
  ImportOperation: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'kind', 'trigger', 'status', 'phase', 'progress', 'result', 'errorCode', 'errorMessage', 'attempts', 'createdAt', 'queuedAt', 'startedAt', 'completedAt', 'updatedAt'],
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['gmail_historical', 'outlook_historical', 'manual_tracking', 'scheduled_tracking', 'export_file'] },
      trigger: { type: 'string', enum: ['user', 'scheduler'] },
      status: { type: 'string', enum: ['awaiting_upload', 'pending_dispatch', 'queued', 'running', 'retrying', 'succeeded', 'failed', 'expired', 'superseded'] },
      phase: { type: 'string' },
      progress: { type: 'integer', minimum: 0, maximum: 100 },
      result: { type: 'object', nullable: true, additionalProperties: true },
      errorCode: { type: 'string', nullable: true },
      errorMessage: { type: 'string', nullable: true },
      attempts: { type: 'integer', minimum: 0 },
      createdAt: { type: 'string', format: 'date-time' },
      queuedAt: nullableTimestamp,
      startedAt: nullableTimestamp,
      completedAt: nullableTimestamp,
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  ImportOperationEnvelope: {
    type: 'object',
    additionalProperties: false,
    required: ['operation'],
    properties: { operation: schema('ImportOperation') },
  },
  ExportUploadIntentRequest: {
    type: 'object',
    additionalProperties: false,
    required: ['filename', 'contentType', 'contentLength'],
    properties: {
      filename: { type: 'string', maxLength: 120 },
      contentType: { type: 'string' },
      contentLength: { type: 'integer', minimum: 1, maximum: 52428800 },
    },
  },
} as const;

const authOperation = (
  summary: string,
  requestSchema: string,
  responseSchema: string,
  status = '200',
) => ({
  post: {
    summary,
    tags: ['Authentication'],
    requestBody: jsonBody(requestSchema),
    responses: {
      [status]: response('Success', responseSchema),
      '400': { $ref: '#/components/responses/ValidationError' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '409': { $ref: '#/components/responses/Conflict' },
      '429': { $ref: '#/components/responses/RateLimitExceeded' },
      '503': response('Authentication provider unavailable', 'Error'),
    },
  },
});

const gmailPreferenceMutation = (summary: string, requestSchema?: string) => ({
  post: {
    summary,
    tags: ['Gmail Integration'],
    security: secured,
    ...(requestSchema ? { requestBody: jsonBody(requestSchema) } : {}),
    responses: {
      '200': response('Canonical import preferences', 'ImportPreferences'),
      '400': { $ref: '#/components/responses/ValidationError' },
      '401': { $ref: '#/components/responses/Unauthorized' },
      '409': { $ref: '#/components/responses/Conflict' },
      '503': response('Provider validation unavailable', 'Error'),
    },
  },
});

export const contractPaths: Readonly<Record<string, unknown>> = {
  '/auth/register': authOperation(
    'Register with credentials',
    'CredentialRequest',
    'AuthSession',
    '201',
  ),
  '/auth/login': authOperation('Log in with credentials', 'CredentialRequest', 'AuthSession'),
  '/auth/google': authOperation('Log in with Google identity', 'GoogleAuthRequest', 'AuthSession'),
  '/auth/apple': authOperation('Log in with Apple identity', 'AppleAuthRequest', 'AuthSession'),
  '/imports/active': {
    get: {
      summary: 'Read the authenticated account active import operation', tags: ['Imports'], security: secured,
      responses: { '200': { description: 'Nullable active operation' }, '401': { $ref: '#/components/responses/Unauthorized' } },
    },
  },
  '/imports/recent': {
    get: {
      summary: 'List recent import operations', tags: ['Imports'], security: secured,
      responses: { '200': { description: 'Recent operations' }, '401': { $ref: '#/components/responses/Unauthorized' } },
    },
  },
  '/imports/{id}': {
    get: {
      summary: 'Read one owned import operation', tags: ['Imports'], security: secured,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { '200': response('Import operation', 'ImportOperationEnvelope'), '401': { $ref: '#/components/responses/Unauthorized' }, '404': { $ref: '#/components/responses/NotFound' } },
    },
  },
  '/imports/exports/uber-eats/upload-intent': {
    post: {
      summary: 'Create an Uber Eats export upload intent', tags: ['Imports'], security: secured,
      requestBody: jsonBody('ExportUploadIntentRequest'),
      responses: { '201': { description: 'Operation and signed upload URL' }, '400': { $ref: '#/components/responses/ValidationError' }, '401': { $ref: '#/components/responses/Unauthorized' }, '409': { $ref: '#/components/responses/Conflict' } },
    },
  },
  '/imports/exports/doordash/upload-intent': {
    post: {
      summary: 'Create a DoorDash export upload intent', tags: ['Imports'], security: secured,
      requestBody: jsonBody('ExportUploadIntentRequest'),
      responses: { '201': { description: 'Operation and signed upload URL' }, '400': { $ref: '#/components/responses/ValidationError' }, '401': { $ref: '#/components/responses/Unauthorized' }, '409': { $ref: '#/components/responses/Conflict' } },
    },
  },
  '/imports/{id}/upload-url': {
    post: {
      summary: 'Refresh a signed URL for an awaiting upload', tags: ['Imports'], security: secured,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { '200': { description: 'Refreshed signed upload URL' }, '401': { $ref: '#/components/responses/Unauthorized' }, '409': { $ref: '#/components/responses/Conflict' } },
    },
  },
  '/imports/{id}/submit': {
    post: {
      summary: 'Validate an uploaded export and queue processing', tags: ['Imports'], security: secured,
      parameters: [{ in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } }],
      responses: { '202': response('Queued import operation', 'ImportOperationEnvelope'), '401': { $ref: '#/components/responses/Unauthorized' }, '409': { $ref: '#/components/responses/Conflict' } },
    },
  },
  '/auth/microsoft/attempt': {
    post: {
      summary: 'Create a short-lived Microsoft login attempt',
      tags: ['Authentication'],
      responses: {
        '201': response('Login attempt created', 'MicrosoftLoginAttempt'),
        '429': { $ref: '#/components/responses/RateLimitExceeded' },
        '503': response('Microsoft login unavailable', 'Error'),
      },
    },
  },
  '/auth/microsoft': {
    post: {
      summary: 'Verify a Microsoft identity token',
      tags: ['Authentication'],
      requestBody: jsonBody('MicrosoftAuthRequest'),
      responses: {
        '200': response('Authenticated', 'AuthSession'),
        '202': response('Email ownership must be verified', 'MicrosoftEmailVerificationRequired'),
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
        '429': { $ref: '#/components/responses/RateLimitExceeded' },
        '503': response('Microsoft login unavailable', 'Error'),
      },
    },
  },
  '/auth/microsoft/email/send': authOperation(
    'Send a Microsoft-login email verification code',
    'MicrosoftEmailRequest',
    'MicrosoftEmailCodeSent',
  ),
  '/auth/microsoft/email/confirm': authOperation(
    'Confirm Microsoft-login email ownership',
    'MicrosoftEmailCodeRequest',
    'AuthSession',
  ),
  '/auth/refresh': authOperation('Rotate a refresh token', 'RefreshTokenRequest', 'TokenPair'),
  '/auth/logout': authOperation(
    'Revoke a refresh token',
    'OptionalRefreshTokenRequest',
    'OperationResult',
  ),
  '/auth/delete-account': {
    delete: {
      summary: 'Permanently delete the authenticated account',
      tags: ['Authentication'],
      security: secured,
      requestBody: jsonBody('OptionalRefreshTokenRequest', false),
      responses: {
        '200': response('Account deleted after commit', 'OperationResult'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
      },
    },
  },
  '/auth/password/reset/request': authOperation(
    'Request a password reset code',
    'EmailRequest',
    'OtpResult',
  ),
  '/auth/password/reset/verify': authOperation(
    'Verify a password reset code',
    'EmailCodeRequest',
    'OtpResult',
  ),
  '/auth/password/reset/complete': authOperation(
    'Complete a password reset',
    'PasswordResetCompleteRequest',
    'OperationResult',
  ),
  '/auth/email/verify/send': authOperation(
    'Send an email verification code',
    'EmailRequest',
    'OtpResult',
  ),
  '/auth/email/verify/confirm': authOperation(
    'Confirm an email verification code',
    'EmailCodeRequest',
    'OperationResult',
  ),
  '/gmail/auth-url': {
    post: {
      summary: 'Create an allowlisted Gmail authorization URL',
      tags: ['Gmail Integration'],
      security: secured,
      requestBody: jsonBody('GmailAuthUrlRequest'),
      responses: {
        '200': {
          description: 'Signed provider authorization URL',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['success', 'authUrl'],
                properties: {
                  success: { type: 'boolean' },
                  authUrl: { type: 'string', format: 'uri' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/gmail/callback': {
    get: {
      summary: 'Complete Gmail OAuth and redirect to the signed app URI',
      tags: ['Gmail Integration'],
      parameters: [
        { in: 'query', name: 'state', schema: { type: 'string' } },
        { in: 'query', name: 'code', schema: { type: 'string' } },
        { in: 'query', name: 'error', schema: { type: 'string' } },
      ],
      responses: { '302': { description: 'Redirect to the allowlisted app URI' } },
    },
  },
  '/gmail/status': {
    get: {
      summary: 'Get canonical Gmail connection status',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '200': response('Gmail connection status', 'GmailConnectionStatus'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '404': { $ref: '#/components/responses/NotFound' },
      },
    },
  },
  '/gmail/disconnect': {
    post: {
      summary: 'Disconnect the authenticated Gmail mailbox',
      tags: ['Gmail Integration'],
      security: secured,
      requestBody: jsonBody('GmailDisconnectRequest'),
      responses: {
        '200': response('Gmail disconnected', 'OperationResult'),
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/gmail/preferences': {
    get: {
      summary: 'Get canonical import lifecycle preferences and source coverage',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '200': response('Canonical import preferences', 'ImportPreferences'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '503': response('Provider validation unavailable', 'Error'),
      },
    },
  },
  '/gmail/preferences/setup-guidance': {
    get: {
      summary: 'Get lightweight initial setup guidance without mailbox validation',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '200': response('Initial setup guidance', 'SetupGuidance'),
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/gmail/preferences/setup-deferral': {
    put: {
      summary: 'Defer or resume initial data setup',
      tags: ['Gmail Integration'],
      security: secured,
      requestBody: jsonBody('SetupDeferralRequest'),
      responses: {
        '200': response('Updated setup guidance', 'SetupGuidance'),
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/gmail/preferences/provider-relevance': {
    put: {
      summary: 'Update whether a delivery provider is relevant to import guidance',
      tags: ['Gmail Integration'],
      security: secured,
      requestBody: jsonBody('ProviderRelevanceRequest'),
      responses: {
        '200': response('Canonical import preferences', 'ImportPreferences'),
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
      },
    },
  },
  '/gmail/preferences/monitoring-consent': {
    put: gmailPreferenceMutation('Set export-ready monitoring consent', 'ConsentRequest').post,
  },
  '/gmail/preferences/ongoing-tracking-consent': {
    put: gmailPreferenceMutation('Set ongoing receipt tracking consent', 'ConsentRequest').post,
  },
  '/gmail/preferences/export-requested': gmailPreferenceMutation(
    'Mark a provider export as requested',
    'ExportProviderRequest',
  ),
  '/gmail/preferences/export-ready': gmailPreferenceMutation(
    'Confirm that a provider export is ready',
    'ExportProviderRequest',
  ),
  '/gmail/preferences/check-export-ready': {
    post: {
      ...gmailPreferenceMutation('Check Gmail for an export-ready notice').post,
      responses: {
        ...gmailPreferenceMutation('Check Gmail for an export-ready notice').post.responses,
        '200': {
          description: 'Detection result and canonical preferences',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['detected', 'preferences'],
                properties: {
                  detected: { type: 'boolean' },
                  preferences: schema('ImportPreferences'),
                },
              },
            },
          },
        },
      },
    },
  },
  '/gmail/import/status': {
    get: {
      summary: 'Check whether the receipt writer is occupied',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '200': {
          description: 'Current writer activity',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['inProgress'],
                properties: { inProgress: { type: 'boolean' } },
              },
            },
          },
        },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/gmail/import': {
    post: {
      summary: 'Queue a historical receipt import from Gmail',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '202': response('Durable import operation', 'ImportOperationEnvelope'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
        '502': response('Provider import failure', 'Error'),
        '503': response('Provider validation unavailable', 'Error'),
      },
    },
  },
  '/gmail/tracking/check': {
    post: {
      summary: 'Queue one explicit ongoing-tracking check',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '202': response('Durable import operation', 'ImportOperationEnvelope'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
      },
    },
  },
  '/gmail/tracking/run-batch': {
    post: {
      summary: 'Run a scheduler-authorized tracking batch',
      tags: ['Gmail Integration'],
      requestBody: jsonBody('TrackingBatchRequest'),
      responses: {
        '200': { description: 'Per-user batch outcomes' },
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/outlook/auth-url': {
    post: {
      summary: 'Create an Outlook mailbox authorization URL using Microsoft OAuth and PKCE',
      tags: ['Outlook Integration'],
      security: secured,
      requestBody: jsonBody('GmailAuthUrlRequest'),
      responses: {
        '200': {
          description: 'Microsoft provider authorization URL',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                additionalProperties: false,
                required: ['success', 'authUrl'],
                properties: {
                  success: { type: 'boolean' },
                  authUrl: { type: 'string', format: 'uri' },
                },
              },
            },
          },
        },
        '400': { $ref: '#/components/responses/ValidationError' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/outlook/callback': {
    get: {
      summary: 'Complete Microsoft mailbox OAuth and redirect to the signed app URI',
      tags: ['Outlook Integration'],
      parameters: [
        { in: 'query', name: 'state', schema: { type: 'string' } },
        { in: 'query', name: 'code', schema: { type: 'string' } },
        { in: 'query', name: 'error', schema: { type: 'string' } },
      ],
      responses: { '302': { description: 'Redirect to the allowlisted app URI' } },
    },
  },
  '/outlook/status': {
    get: {
      summary: 'Get canonical Outlook connection status',
      tags: ['Outlook Integration'],
      security: secured,
      responses: {
        '200': response('Outlook connection status', 'OutlookConnectionStatus'),
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/outlook/disconnect': {
    post: {
      summary: 'Disconnect the authenticated Outlook mailbox',
      tags: ['Outlook Integration'],
      security: secured,
      requestBody: jsonBody('GmailDisconnectRequest'),
      responses: {
        '200': response('Outlook disconnected', 'OperationResult'),
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/outlook/import/status': {
    get: {
      summary: 'Check whether the receipt writer is occupied',
      tags: ['Outlook Integration'],
      security: secured,
      responses: {
        '200': { description: 'Current writer activity' },
        '401': { $ref: '#/components/responses/Unauthorized' },
      },
    },
  },
  '/outlook/import': {
    post: {
      summary: 'Queue a historical supported-receipt import from Outlook',
      tags: ['Outlook Integration'],
      security: secured,
      responses: {
        '202': response('Durable import operation', 'ImportOperationEnvelope'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
        '502': response('Provider import failure', 'Error'),
        '503': response('Provider validation unavailable', 'Error'),
      },
    },
  },
};

export const canonicalErrorExample = ERROR_ENVELOPE_FIXTURE;
