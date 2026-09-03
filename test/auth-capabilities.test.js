const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET =
  process.env.JWT_REFRESH_SECRET || 'test-refresh-secret-at-least-thirty-two-characters';

const { TokenService } = require('../dist/services/auth/TokenService');
const { SessionService } = require('../dist/services/auth/SessionService');
const { ProviderAuthService } = require('../dist/services/auth/ProviderAuthService');
const { OtpService } = require('../dist/services/OtpService');
const {
  createAuthenticateToken,
  createOptionalAuthentication,
} = require('../dist/middleware/auth');
const { createAuthRouter } = require('../dist/routes/auth');
const { createPasswordResetRouter } = require('../dist/routes/authPasswordReset');
const { createEmailVerificationRouter } = require('../dist/routes/authEmailVerification');
const { createCacheFake, createClock, createIdSequence, createProviderFake } = require('./fakes');

const options = {
  accessSecret: 'access-secret-at-least-thirty-two-characters-long',
  refreshSecret: 'refresh-secret-at-least-thirty-two-characters-long',
  accessTokenExpiry: '15m',
  refreshTokenExpiry: '7d',
};
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };
const user = {
  id: '5f586923-18d5-4bc8-b5eb-ea52ae35284c',
  email: 'person@example.com',
  emailVerified: true,
  createdAt: '2026-08-31T00:00:00.000Z',
};

test('token capability distinguishes malformed, expired, and revoked credentials', async () => {
  const cache = createCacheFake();
  const clock = createClock(Date.now());
  const tokens = new TokenService(
    options,
    cache,
    silentLogger,
    clock.nowMs,
    createIdSequence('fixed-jti'),
  );
  const pair = tokens.generateTokens(user);
  assert.equal(tokens.verifyAccessToken(pair.accessToken).userId, user.id);
  await tokens.revokeRefreshToken(pair.refreshToken);
  await assert.rejects(
    tokens.verifyRefreshTokenWithBlacklist(pair.refreshToken),
    (error) => error.code === 'REFRESH_TOKEN_REVOKED',
  );
  assert.throws(
    () => tokens.verifyAccessToken('not-a-jwt'),
    (error) => error.code === 'ACCESS_TOKEN_INVALID',
  );

  const expired = new TokenService(
    { ...options, accessTokenExpiry: '-1s' },
    cache,
    silentLogger,
  ).generateTokens(user).accessToken;
  assert.throws(
    () => tokens.verifyAccessToken(expired),
    (error) => error.code === 'ACCESS_TOKEN_EXPIRED',
  );
});

test('session refresh revokes the presented refresh token before rotating it', async () => {
  const events = [];
  const service = new SessionService(
    { findById: async (id) => (events.push(['find', id]), user) },
    {
      verifyRefreshTokenWithBlacklist: async () => ({ userId: user.id }),
      revokeRefreshToken: async () => events.push(['revoke']),
      generateTokens: () => (events.push(['generate']), { accessToken: 'a', refreshToken: 'r' }),
    },
  );
  assert.deepEqual(await service.refresh('old'), { accessToken: 'a', refreshToken: 'r' });
  assert.deepEqual(events, [['find', user.id], ['revoke'], ['generate']]);
});

const runMiddleware = (middleware, request) =>
  new Promise((resolve) => middleware(request, {}, (error) => resolve(error)));

test('required and optional authentication apply explicit credential policies', async () => {
  const warnings = [];
  const dependencies = {
    tokens: {
      verifyAccessToken: (token) => {
        if (token === 'unexpected') throw new Error('SDK failure');
        if (token !== 'valid') {
          const error = new Error('bad token');
          error.name = 'AuthenticationError';
          error.code = 'ACCESS_TOKEN_INVALID';
          throw error;
        }
        return { userId: user.id, email: user.email, type: 'access' };
      },
    },
    observability: { setUserContext() {} },
    logger: { ...silentLogger, warn: (_message, metadata) => warnings.push(metadata) },
  };

  const missing = await runMiddleware(createAuthenticateToken(dependencies), {
    get: () => undefined,
  });
  assert.equal(missing.code, 'AUTHENTICATION_REQUIRED');

  const validRequest = { get: () => 'Bearer valid' };
  assert.equal(
    await runMiddleware(createOptionalAuthentication(dependencies), validRequest),
    undefined,
  );
  assert.equal(validRequest.user.userId, user.id);

  const unexpected = await runMiddleware(createOptionalAuthentication(dependencies), {
    get: () => 'Bearer unexpected',
    requestId: 'request-1',
  });
  assert.equal(unexpected.code, 'ACCESS_TOKEN_INVALID');
  assert.equal(warnings[0].outcome, 'rejected');
});

const routeLayer = (router, path, method) =>
  router.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);

const invoke = (router, path, method, request) =>
  new Promise((resolve, reject) => {
    const layer = routeLayer(router, path, method);
    assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
    const handlers = layer.route.stack.map(({ handle }) => handle);
    const response = {
      statusCode: 200,
      status(value) {
        this.statusCode = value;
        return this;
      },
      json(value) {
        resolve({ status: this.statusCode, body: value });
      },
    };
    let index = 0;
    const next = (error) => {
      if (error) return reject(error);
      const handler = handlers[index++];
      if (handler) handler(request, response, next);
    };
    next();
  });

test('authentication route factories validate once and delegate to narrow capabilities', async () => {
  const pass = (_req, _res, next) => next();
  const auth = createAuthRouter({
    credentials: {
      register: async (email, password, timezone) => ({ email, password, timezone }),
      login: async (email) => ({ email }),
    },
    providers: {
      loginWithGoogle: async (token) => ({ token }),
      loginWithApple: async (token, firstSignIn) => ({ token, firstSignIn }),
    },
    microsoft: {
      createAttempt: async () => ({ attemptToken: 'attempt', nonce: 'nonce', expiresIn: 600 }),
      login: async () => ({ status: 'authenticated', session: { provider: 'microsoft' } }),
      sendVerificationEmail: async () => ({ success: true, expiresIn: 900, resendAfter: 60 }),
      confirmVerificationEmail: async () => ({ provider: 'microsoft-confirmed' }),
    },
    sessions: {
      refresh: async (token) => ({ accessToken: token, refreshToken: 'new' }),
      revoke: async () => {},
    },
    accountDeletion: { deleteAccount: async () => ({ deleted: true }) },
    authenticate: pass,
    rateLimitRegistration: pass,
    rateLimitMicrosoftAttempt: pass,
    rateLimitMicrosoftEmail: pass,
    rateLimitMicrosoftConfirmation: pass,
  });
  const google = await invoke(auth, '/google', 'post', { body: { idToken: 'provider-token' } });
  assert.deepEqual(google, { status: 200, body: { token: 'provider-token' } });
  await assert.rejects(
    invoke(auth, '/google', 'post', { body: { idToken: 42 } }),
    (error) => error.code === 'VALIDATION_ERROR',
  );
  const microsoft = await invoke(auth, '/microsoft', 'post', {
    body: { identityToken: 'signed-token', attemptToken: 'private-attempt' },
  });
  assert.deepEqual(microsoft, { status: 200, body: { provider: 'microsoft' } });

  const passwords = createPasswordResetRouter({
    passwords: {
      request: async () => ({ success: true }),
      verify: async () => {},
      complete: async () => {},
    },
    rateLimitRequestByIp: pass,
    rateLimitRequestByEmail: pass,
    rateLimitVerification: pass,
  });
  await assert.rejects(
    invoke(passwords, '/verify', 'post', {
      body: { email: 'person@example.com', code: 'bad' },
    }),
    (error) => error.code === 'VALIDATION_ERROR',
  );

  const verification = createEmailVerificationRouter({
    verification: { send: async () => {}, confirm: async () => {} },
    rateLimitSend: pass,
    rateLimitConfirmation: pass,
  });
  assert.equal(
    (
      await invoke(verification, '/confirm', 'post', {
        body: { email: 'person@example.com', code: '123456' },
      })
    ).status,
    200,
  );
});

test('provider authentication validates identity payloads and links a verified account', async () => {
  const links = [];
  const google = createProviderFake({
    providerUserId: 'google-user',
    email: user.email,
    emailVerified: true,
  });
  const service = new ProviderAuthService(
    {
      findByEmail: async () => undefined,
      createUser: async () => user.id,
      findById: async () => ({ ...user, emailVerified: false }),
      updateEmailVerified: async () => true,
    },
    {
      findByProvider: async () => undefined,
      create: async (record) => (links.push(record), 'link-id'),
    },
    { generateTokens: () => ({ accessToken: 'a', refreshToken: 'r' }) },
    google,
    {
      verify: async () => {
        throw new Error('unused');
      },
    },
    silentLogger,
  );
  const result = await service.loginWithGoogle('identity-token');
  assert.equal(result.user.emailVerified, true);
  assert.equal(links[0].provider, 'google');
  assert.deepEqual(google.calls, ['identity-token']);
});

test('OTP protected mutations consume the code atomically and roll back on mutation failure', async () => {
  const hash = await bcrypt.hash('123456', 4);
  const events = [];
  const row = {
    id: 'acffbafb-2b86-46be-907b-a8b9c6468b20',
    code_hash: hash,
    attempts: 0,
    max_attempts: 5,
  };
  const database = {
    query: async () => ({ rows: [], rowCount: 0 }),
    withTransaction: async (operation) => {
      events.push('BEGIN');
      const transaction = {
        query: async (sql) => {
          events.push(sql);
          if (sql.includes('FROM verification_codes')) return { rows: [row], rowCount: 1 };
          return { rows: [], rowCount: 1 };
        },
      };
      try {
        const result = await operation(transaction);
        events.push('COMMIT');
        return result;
      } catch (error) {
        events.push('ROLLBACK');
        throw error;
      }
    },
    close: async () => {},
  };
  const codes = new OtpService(database);
  await assert.rejects(
    codes.consumeOTP('person@example.com', '123456', 'password_reset', async () => {
      throw new Error('password update failed');
    }),
    /password update failed/,
  );
  assert.equal(events.includes('ROLLBACK'), true);
  assert.equal(
    events.some((event) => String(event).startsWith('UPDATE verification_codes SET used_at')),
    false,
  );

  events.length = 0;
  assert.equal(
    await codes.consumeOTP('person@example.com', '123456', 'password_reset', async () => {
      events.push('PASSWORD_UPDATED');
    }),
    'consumed',
  );
  assert.ok(events.indexOf('PASSWORD_UPDATED') < events.indexOf('COMMIT'));
  assert.equal(
    events.some((event) => String(event).startsWith('UPDATE verification_codes SET used_at')),
    true,
  );
});
