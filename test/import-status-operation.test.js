const test = require('node:test');
const assert = require('node:assert/strict');

const { ImportStatusService } = require('../dist/services/import/ImportStatusService');
const {
  ImportSourceCoverageRepository,
} = require('../dist/services/data/ImportSourceCoverageRepository');

const connectedUser = {
  id: 'user-id',
  email: 'account@example.com',
  timezone: 'America/Toronto',
  gmailConnected: true,
  gmailEmail: 'receipts@example.com',
  gmailRefreshToken: 'refresh-token',
  gmailConnectionMode: 'offline',
  gmailScopes: ['https://www.googleapis.com/auth/gmail.readonly'],
};

const preferences = {
  userId: 'user-id',
  monitoringConsentState: 'granted',
  monitoringConsentVersion: 'v1',
  monitoringConsentedAt: '2026-01-01T00:00:00.000Z',
  monitoringRevokedAt: null,
  gmailImportStatus: 'never_started',
  gmailImportUpdatedAt: null,
  gmailImportedCount: 0,
  gmailImportErrorCode: null,
  gmailBaselineCompletedAt: null,
  ongoingTrackingConsentState: 'granted',
  ongoingTrackingConsentVersion: 'v1',
  ongoingTrackingConsentedAt: '2026-01-01T00:00:00.000Z',
  ongoingTrackingRevokedAt: null,
  trackingStatus: 'active',
  lastCheckAttemptAt: null,
  lastSuccessfulCheckAt: null,
  lastStatsUpdatedAt: null,
  lastNewOrderAt: null,
  lastTrackingErrorAt: null,
  lastTrackingErrorCode: null,
};

const providers = {
  uber_eats: {
    provider: 'uber_eats',
    status: 'not_started',
    requestedAt: null,
    updatedAt: null,
    errorCode: null,
    readySource: null,
  },
  doordash: {
    provider: 'doordash',
    status: 'completed',
    requestedAt: null,
    updatedAt: '2026-01-02T00:00:00.000Z',
    errorCode: null,
    readySource: null,
  },
};

test('import status projection treats DoorDash export receipts as a historical baseline', async () => {
  const timezoneUpdates = [];
  const service = new ImportStatusService(
    {
      findByIdWithGmailTokens: async () => connectedUser,
      updateTimezone: async (_userId, timezone) => timezoneUpdates.push(timezone),
    },
    { validate: async () => ({ status: 'valid', validatedAt: '2026-01-03T00:00:00.000Z' }) },
    {
      get: async () => preferences,
      getProviderExports: async () => providers,
      getOrdersAddedThisWeek: async () => 4,
    },
    {
      getForUser: async () => ({
        emailReceiptCount: 0,
        exportReceiptCount: 3,
        hasEmailData: false,
        hasExportData: true,
        exportProviders: {
          uberEats: {
            receiptCount: 0,
            hasData: false,
            earliestOrderDate: null,
            latestOrderDate: null,
          },
          doorDash: {
            receiptCount: 3,
            hasData: true,
            earliestOrderDate: '2025-12-01T00:00:00.000Z',
            latestOrderDate: '2025-12-03T00:00:00.000Z',
          },
        },
      }),
    },
  );

  const result = await service.getPreferences('user-id', 'America/Vancouver');

  assert.deepEqual(result.ongoingTracking.baseline, { eligible: true, source: 'exports' });
  assert.equal(result.ongoingTracking.effectiveState, 'active');
  assert.equal(result.monitoring.capability.canMonitor, true);
  assert.equal(result.export.providers.doorDash.status, 'completed');
  assert.deepEqual(timezoneUpdates, ['America/Vancouver']);
});

test('connection projection gives rejected credentials reconnect precedence', async () => {
  let reads = 0;
  const service = new ImportStatusService(
    {
      findByIdWithGmailTokens: async () => {
        reads += 1;
        return connectedUser;
      },
      updateTimezone: async () => {},
    },
    { validate: async () => ({ status: 'reconnect_required', validatedAt: null }) },
    {},
    {},
  );

  const { status } = await service.getConnection('user-id', true);

  assert.equal(reads, 2);
  assert.equal(status.connected, true);
  assert.equal(status.canImport, false);
  assert.equal(status.needsReconnect, true);
  assert.equal(status.connectionHealth, 'reconnect_required');
});

test('source coverage repository validates and maps aggregate database fields', async () => {
  const repository = new ImportSourceCoverageRepository({
    query: async () => ({
      rows: [
        {
          email_count: '2',
          export_count: 1,
          uber_eats_export_count: 0,
          doordash_export_count: '1',
          uber_eats_export_earliest: null,
          uber_eats_export_latest: null,
          doordash_export_earliest: new Date('2026-01-01T00:00:00.000Z'),
          doordash_export_latest: '2026-01-02T00:00:00.000Z',
        },
      ],
    }),
  });

  const result = await repository.getForUser('user-id');

  assert.equal(result.emailReceiptCount, 2);
  assert.equal(result.exportProviders.doorDash.receiptCount, 1);
  assert.equal(result.exportProviders.doorDash.earliestOrderDate, '2026-01-01T00:00:00.000Z');
});

test('source coverage repository rejects malformed database rows', async () => {
  const repository = new ImportSourceCoverageRepository({
    query: async () => ({
      rows: [
        {
          email_count: '-1',
          export_count: 0,
          uber_eats_export_count: 0,
          doordash_export_count: 0,
          uber_eats_export_earliest: null,
          uber_eats_export_latest: null,
          doordash_export_earliest: null,
          doordash_export_latest: null,
        },
      ],
    }),
  });

  await assert.rejects(
    repository.getForUser('user-id'),
    (error) => error.code === 'DATABASE_ERROR',
  );
});
