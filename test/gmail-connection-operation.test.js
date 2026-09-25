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
  authorization: {
    register: async () => {}, receive: async () => 'c'.repeat(64), cancel: async () => {},
    consume: async () => ({ userId, state: 'signed-state', code: 'authorization-code' }),
    persist: async (_claim, write) => write({ query: async () => ({ rows: [] }) }),
    ...overrides.authorization,
  },
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
      ports.authorization,
    ),
  };
};

test('Gmail authorization URL validates the app redirect before signing state', async () => {
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
    await service.createAuthorizationUrl(userId, state.redirectUri, 'ongoing_tracking', 'a'.repeat(64), 0),
    'auth-url',
  );
  assert.deepEqual(received, state);
  await assert.rejects(
    service.createAuthorizationUrl(userId, 'javascript:alert(1)', 'receipt_import', 'a'.repeat(64), 0),
    (error) => error.code === 'VALIDATION_ERROR',
  );
});

test('Gmail callback only stages the code; authenticated completion persists then invalidates health', async () => {
  const events = [];
  const { service } = serviceFor({
    users: { updateGmailTokens: async (_id, grant) => events.push(['persist', grant]) },
    health: { invalidate: (id) => events.push(['invalidate', id]) },
  });

  const result = await service.completeAuthorization('signed-state', 'authorization-code');

  assert.equal(result.userId, userId);
  assert.match(result.redirectUri, /^snacktrack:\/\/oauth-callback/);
  assert.match(result.redirectUri, /gmail=pending/);
  assert.match(result.redirectUri, /completionToken=/);
  assert.deepEqual(events, []);
  await service.finishAuthorization(userId, 'c'.repeat(64), 'a'.repeat(64));
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
    service.finishAuthorization(userId, 'c'.repeat(64), 'a'.repeat(64)),
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

for (const rejectedUri of ['https://attacker.test/callback', 'snacktrack://attacker', 'snacktrack://oauth-callback/other', 'snacktrack://oauth-callback?completionToken=injected']) {
  test(`rejects unauthorized callback destination ${rejectedUri}`, async () => {
    const { service } = serviceFor();
    await assert.rejects(service.createAuthorizationUrl(userId, rejectedUri, 'receipt_import', 'a'.repeat(64), 0),
      (error) => error.code === 'VALIDATION_ERROR');
  });
}

test('failed handoff never exchanges a code or invalidates the connection cache', async () => {
  const { service } = serviceFor({
    authorization: { consume: async () => { throw new Error('handoff rejected'); } },
    oauth: { exchangeAuthorizationCode: async () => assert.fail('exchange not authorized') },
    health: { invalidate: () => assert.fail('no committed connection') },
  });
  await assert.rejects(service.finishAuthorization(userId, 'c'.repeat(64), 'a'.repeat(64)), /handoff rejected/);
});

test('Gmail uses PKCE and keeps its verifier inside encrypted state', () => {
  const provider = new GmailOAuthProvider({ stateSecret: 'a-secure-test-secret-that-is-long-enough',
    clientId: 'client', clientSecret: 'secret', callbackRedirectUri: 'https://api.test/gmail/callback' });
  const url = new URL(provider.createAuthorizationUrl(state));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  const decoded = provider.verifyState(url.searchParams.get('state'));
  assert.equal(url.searchParams.get('code_challenge'), require('node:crypto').createHash('sha256').update(decoded.codeVerifier).digest('base64url'));
  assert.equal(url.toString().includes(decoded.codeVerifier), false);
});
