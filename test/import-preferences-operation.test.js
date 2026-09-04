const test = require('node:test');
const assert = require('node:assert/strict');

const { ImportPreferencesService } = require('../dist/services/import/ImportPreferencesService');

const projection = {
  marker: 'canonical-projection',
  gmailConnection: {
    connectionHealth: 'valid',
    canImport: true,
    connectionMode: 'offline',
  },
  outlookConnection: {
    connectionHealth: 'disconnected',
    canImport: false,
    connectionMode: 'none',
  },
  ongoingTracking: { capability: { canTrack: true } },
};
const connected = {
  user: { id: 'user-id', email: 'user@example.com' },
  health: { status: 'valid', validatedAt: null },
  status: {
    connected: true,
    canImport: true,
    connectionMode: 'offline',
  },
};

const requestedUberExport = {
  provider: 'uber_eats',
  status: 'requested',
  requestedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: null,
  errorCode: null,
  readySource: null,
};

test('tracking consent validates the historical baseline before writing', async () => {
  let wrote = false;
  const service = new ImportPreferencesService(
    {
      setOngoingTrackingConsent: async () => {
        wrote = true;
      },
    },
    { getTrackingBaseline: async () => ({ eligible: false, source: 'none' }) },
    {},
    {},
  );

  await assert.rejects(
    service.setOngoingTrackingConsent('user-id', 'granted', 'v1'),
    (error) => error.code === 'HISTORICAL_BASELINE_REQUIRED',
  );
  assert.equal(wrote, false);
});

test('tracking consent requires a validated durable mailbox before writing', async () => {
  let wrote = false;
  const service = new ImportPreferencesService(
    {
      setOngoingTrackingConsent: async () => {
        wrote = true;
      },
    },
    { getTrackingBaseline: async () => ({ eligible: true, source: 'exports' }) },
    {
      getPreferences: async () => ({
        ...projection,
        gmailConnection: { ...projection.gmailConnection, connectionHealth: 'unavailable' },
        ongoingTracking: { capability: { canTrack: false } },
      }),
    },
    {},
  );

  await assert.rejects(
    service.setOngoingTrackingConsent('user-id', 'granted', 'v1'),
    (error) => error.code === 'MAILBOX_VALIDATION_UNAVAILABLE',
  );
  assert.equal(wrote, false);
});

test('tracking consent commits only after preconditions and returns canonical state', async () => {
  const events = [];
  const service = new ImportPreferencesService(
    {
      setOngoingTrackingConsent: async () => events.push('write'),
    },
    {
      getTrackingBaseline: async () => {
        events.push('baseline');
        return { eligible: true, source: 'exports' };
      },
    },
    {
      getPreferences: async () => {
        events.push('projection');
        return projection;
      },
    },
    {},
  );

  const result = await service.setOngoingTrackingConsent('user-id', 'granted', 'v1');

  assert.equal(result, projection);
  assert.deepEqual(events, ['baseline', 'projection', 'write', 'projection']);
});

test('export-ready check skips provider access when monitoring is not eligible', async () => {
  let providerCalls = 0;
  const service = new ImportPreferencesService(
    {},
    {
      get: async () => ({ monitoringConsentState: 'declined' }),
      getProviderExports: async () => ({
        uber_eats: requestedUberExport,
        doordash: { provider: 'doordash', status: 'not_started' },
      }),
    },
    { getPreferences: async () => projection },
    {
      hasUberExportReadyEmail: async () => {
        providerCalls += 1;
        return true;
      },
    },
  );

  const result = await service.checkExportReady('user-id');

  assert.deepEqual(result, { detected: false, preferences: projection });
  assert.equal(providerCalls, 0);
});

test('export-ready detection records provider lifecycle before projecting state', async () => {
  const events = [];
  const service = new ImportPreferencesService(
    {
      setExportStatus: async (_userId, provider, status, _error, source) => {
        events.push(`write:${provider}:${status}:${source}`);
      },
    },
    {
      get: async () => ({ monitoringConsentState: 'granted' }),
      getProviderExports: async () => ({
        uber_eats: requestedUberExport,
        doordash: { provider: 'doordash', status: 'not_started' },
      }),
    },
    {
      getConnection: async () => connected,
      getPreferences: async () => {
        events.push('projection');
        return projection;
      },
    },
    {
      hasUberExportReadyEmail: async () => {
        events.push('provider');
        return true;
      },
    },
  );

  const result = await service.checkExportReady('user-id');

  assert.deepEqual(result, { detected: true, preferences: projection });
  assert.deepEqual(events, ['projection', 'provider', 'write:uber_eats:file_ready:detected_email', 'projection']);
});

test('provider relevance rejects receipt-backed usage evidence', async () => {
  const service = new ImportPreferencesService(
    { setProviderRelevance: async () => false },
    {},
    { getPreferences: async () => projection },
    {},
    {
      getForUser: async () => ({
        emailProviders: { uberEats: { hasData: true }, doorDash: { hasData: false } },
        exportProviders: { uberEats: { hasData: false }, doorDash: { hasData: false } },
      }),
    },
    undefined,
  );

  await assert.rejects(
    service.setProviderRelevance('user-id', 'uber_eats', 'not_used'),
    (error) => error.code === 'PROVIDER_USAGE_EVIDENCE_EXISTS',
  );
});

test('provider relevance distinguishes an active workflow from usage evidence', async () => {
  const service = new ImportPreferencesService(
    { setProviderRelevance: async () => false },
    {},
    { getPreferences: async () => projection },
    {},
    {
      getForUser: async () => ({
        emailProviders: { uberEats: { hasData: false }, doorDash: { hasData: false } },
        exportProviders: { uberEats: { hasData: false }, doorDash: { hasData: false } },
      }),
    },
    undefined,
  );

  await assert.rejects(
    service.setProviderRelevance('user-id', 'uber_eats', 'not_used'),
    (error) => error.code === 'PROVIDER_WORKFLOW_ACTIVE',
  );
});
