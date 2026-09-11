const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');

const { GmailOAuthProvider } = require('../dist/services/email/GmailOAuthProvider');
const { GmailConnectionService } = require('../dist/services/import/GmailConnectionService');

const userId = '00000000-0000-4000-8000-000000000001';
const state = {
  userId,
  redirectUri: 'snacktrack://oauth-callback',
  purpose: 'ongoing_tracking',
};

const dependencies = (overrides = {}) => ({
  oauth: {
    createAuthorizationUrl: (payload) => `https://accounts.example.test?user=${payload.userId}`,
    verifyState: () => state,
    exchangeAuthorizationCode: async () => ({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiryDate: new Date('2026-09-01T00:00:00.000Z'),
      email: 'consumer@example.test',
      scopes: ['https://www.googleapis.com/auth/gmail.readonly'],
    }),
    ...overrides.oauth,
  },
  users: {
    updateGmailTokens: async () => {},
    disconnectGmail: async () => {},
    ...overrides.users,
  },
  queries: {
    get: async () => ({
      monitoringConsentState: 'not_offered',
      ongoingTrackingConsentState: 'not_offered',
    }),
    ...overrides.queries,
  },
  lifecycle: {
    setMonitoringConsent: async () => {},
    setOngoingTrackingConsent: async () => {},
    markTrackingReconnectRequired: async () => {},
    ...overrides.lifecycle,
  },
  syncRuns: { resetGmailImportStatus: async () => {}, ...overrides.syncRuns },
  health: { invalidate: () => {}, ...overrides.health },
});

const serviceFor = (overrides) => {
  const ports = dependencies(overrides);
  return {
    ports,
    service: new GmailConnectionService(
      ports.oauth,
      ports.users,
      ports.queries,
      ports.lifecycle,
      ports.syncRuns,
      ports.health,
    ),
  };
};

test('Gmail authorization URL validates the app redirect before signing state', () => {
  let received;
  const { service } = serviceFor({
    oauth: {
      createAuthorizationUrl: (payload) => {
        received = payload;
        return 'auth-url';
      },
    },
  });

  assert.equal(
    service.createAuthorizationUrl(userId, state.redirectUri, 'ongoing_tracking'),
    'auth-url',
  );
  assert.deepEqual(received, state);
  assert.throws(
    () => service.createAuthorizationUrl(userId, 'javascript:alert(1)'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('Gmail callback validates scope, persists durable credentials, then invalidates health', async () => {
  const events = [];
  const { service } = serviceFor({
    users: { updateGmailTokens: async (_id, grant) => events.push(['persist', grant]) },
    health: { invalidate: (id) => events.push(['invalidate', id]) },
  });

  const result = await service.completeAuthorization('signed-state', 'authorization-code');

  assert.equal(result.userId, userId);
  assert.match(result.redirectUri, /^snacktrack:\/\/oauth-callback/);
  assert.match(result.redirectUri, /gmail=success/);
  assert.match(result.redirectUri, /connectionMode=offline/);
  assert.equal(events[0][0], 'persist');
  assert.equal(events[0][1].connectionMode, 'offline');
  assert.equal(events[1][0], 'invalidate');
});

test('Gmail callback rejects grants without a Gmail read scope before persistence', async () => {
  let wrote = false;
  const { service } = serviceFor({
    oauth: {
      exchangeAuthorizationCode: async () => ({
        accessToken: 'access-token',
        refreshToken: null,
        expiryDate: new Date(),
        email: 'consumer@example.test',
        scopes: ['openid'],
      }),
    },
    users: {
      updateGmailTokens: async () => {
        wrote = true;
      },
    },
  });

  await assert.rejects(
    service.completeAuthorization('signed-state', 'authorization-code'),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  assert.equal(wrote, false);
});

test('provider-denied Gmail callback redirects without exchanging or persisting credentials', async () => {
  let exchanged = false;
  let wrote = false;
  const { service } = serviceFor({
    oauth: {
      exchangeAuthorizationCode: async () => {
        exchanged = true;
      },
    },
    users: {
      updateGmailTokens: async () => {
        wrote = true;
      },
    },
  });

  const result = await service.completeAuthorization('signed-state', undefined, 'access_denied');

  assert.match(result.redirectUri, /gmail=error/);
  assert.match(result.redirectUri, /error=access_denied/);
  assert.equal(exchanged, false);
  assert.equal(wrote, false);
});

test('disconnect revokes granted lifecycle consent and optionally resets Gmail history', async () => {
  const events = [];
  const { service } = serviceFor({
    queries: {
      get: async () => ({
        monitoringConsentState: 'granted',
        ongoingTrackingConsentState: 'granted',
      }),
    },
    users: { disconnectGmail: async () => events.push('disconnect') },
    lifecycle: {
      setMonitoringConsent: async (_id, stateValue) => events.push(`monitoring:${stateValue}`),
      setOngoingTrackingConsent: async (_id, stateValue) => events.push(`tracking:${stateValue}`),
    },
    syncRuns: { resetGmailImportStatus: async () => events.push('reset') },
    health: { invalidate: () => events.push('invalidate') },
  });

  await service.disconnect(userId, true);

  assert.deepEqual(events, [
    'disconnect',
    'invalidate',
    'monitoring:revoked',
    'tracking:revoked',
    'reset',
  ]);
});

test('admin expiry simulation removes Gmail access and enters reconnect-required tracking', async () => {
  const events = [];
  const { service } = serviceFor({
    users: { markGmailReconnectRequired: async () => events.push('expire') },
    lifecycle: { markTrackingReconnectRequired: async () => events.push('tracking:reconnect_required') },
    health: { invalidate: () => events.push('invalidate') },
  });

  await service.expireForTesting(userId);

  assert.deepEqual(events, ['expire', 'invalidate', 'tracking:reconnect_required']);
});

test('Gmail OAuth state decoder rejects malformed signed payloads', () => {
  const secret = 'a-secure-test-secret-that-is-long-enough';
  const provider = new GmailOAuthProvider({ stateSecret: secret });
  const malformed = jwt.sign(
    { userId, redirectUri: state.redirectUri, purpose: 'unexpected' },
    secret,
    { issuer: 'snacktrack-gmail-oauth' },
  );
  assert.throws(
    () => provider.verifyState(malformed),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});
