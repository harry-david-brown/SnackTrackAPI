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
  required: ['provider', 'status', 'requestedAt', 'updatedAt', 'errorCode', 'readySource'],
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
  ImportPreferences: {
    type: 'object',
    additionalProperties: false,
    required: [
      'gmailConnection',
      'monitoring',
      'export',
      'gmailBaseline',
      'ongoingTracking',
      'coverage',
    ],
    properties: {
      gmailConnection: schema('GmailConnectionStatus'),
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
              'durableAccess',
              'needsReconnect',
              'connectionHealth',
              'lastValidatedAt',
              'canMonitor',
            ],
            properties: {
              gmailConnected: { type: 'boolean' },
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
              source: { type: 'string', enum: ['gmail', 'exports', 'none'] },
            },
          },
          capability: {
            type: 'object',
            required: [
              'gmailConnected',
              'durableAccess',
              'needsReconnect',
              'connectionHealth',
              'lastValidatedAt',
              'canTrack',
            ],
            properties: {
              gmailConnected: { type: 'boolean' },
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
          'exportProviders',
        ],
        properties: {
          emailReceiptCount: { type: 'integer', minimum: 0 },
          exportReceiptCount: { type: 'integer', minimum: 0 },
          hasEmailData: { type: 'boolean' },
          hasExportData: { type: 'boolean' },
          exportProviders: {
            type: 'object',
            required: ['uberEats', 'doorDash'],
            properties: { uberEats: sourceCoverage, doorDash: sourceCoverage },
          },
        },
      },
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
      summary: 'Run a historical receipt import from Gmail',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '200': response('Committed import result', 'GmailImportResult'),
        '401': { $ref: '#/components/responses/Unauthorized' },
        '409': { $ref: '#/components/responses/Conflict' },
        '502': response('Provider import failure', 'Error'),
        '503': response('Provider validation unavailable', 'Error'),
      },
    },
  },
  '/gmail/tracking/check': {
    post: {
      summary: 'Run one explicit ongoing-tracking check',
      tags: ['Gmail Integration'],
      security: secured,
      responses: {
        '200': {
          description: 'Committed import result plus canonical preferences',
          content: {
            'application/json': {
              schema: {
                allOf: [
                  schema('GmailImportResult'),
                  {
                    type: 'object',
                    required: ['preferences'],
                    properties: { preferences: schema('ImportPreferences') },
                  },
                ],
              },
            },
          },
        },
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
};

export const canonicalErrorExample = ERROR_ENVELOPE_FIXTURE;
