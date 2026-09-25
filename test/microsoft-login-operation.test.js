const assert = require('node:assert/strict');
const test = require('node:test');
const { createHash } = require('node:crypto');
const { MicrosoftLoginService } = require('../dist/services/auth/MicrosoftLoginService');
const {
  MicrosoftIdentityVerificationError,
} = require('../dist/services/auth/MicrosoftIdentityVerifier');

const attemptToken = 'a'.repeat(43);
const tokenHash = createHash('sha256').update(attemptToken).digest('hex');
const attempt = {
  id: '11111111-1111-4111-8111-111111111111',
  nonceHash: 'nonce-hash',
  status: 'pending_identity',
  expiresAt: new Date(Date.now() + 60_000),
};
const identity = {
  providerUserId: 'tenant:object',
  email: 'person@example.com',
  suggestedEmail: 'person@example.com',
  emailVerified: true,
};
const user = {
  id: '22222222-2222-4222-8222-222222222222',
  email: 'person@example.com',
  emailVerified: true,
  createdAt: '2026-09-01T00:00:00.000Z',
};
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

const setup = (options = {}) => {
  const events = [];
  const currentAttempt = { ...attempt, ...(options.attempt || {}) };
  const attempts = {
    async cleanupExpired() {
      return 0;
    },
    async create() {
      events.push('attempt_created');
    },
    async findActiveByTokenHash(value) {
      assert.equal(value, tokenHash);
      return options.missingAttempt ? undefined : currentAttempt;
    },
    async requireEmailVerification(id, providerUserId, email) {
      events.push(['email_required', id, providerUserId, email]);
    },
    async setVerificationEmail(id, email) {
      events.push(['email_selected', id, email]);
    },
    async complete(id, providerUserId, email) {
      events.push(['completed', id, providerUserId, email]);
      return user;
    },
    async completeWithExecutor(id, providerUserId, email) {
      events.push(['completed_atomic', id, providerUserId, email]);
      return user;
    },

  };
  const service = new MicrosoftLoginService(
    options.enabled !== false,
    attempts,
    options.noVerifier
      ? null
      : {
          async verify(_token, nonceHash) {
            assert.equal(nonceHash, currentAttempt.nonceHash);
            if (options.verifyError) throw options.verifyError;
            return options.identity || identity;
          },
        },
    {
      async findByProvider() {
        return options.linked ? { userId: user.id } : undefined;
      },
    },
    {
      async storeScopedOTP(scopeId, email) {
        events.push(['code_stored', scopeId, email]);
        return '123456';
      },
      async consumeScopedOTP(_scopeId, _email, code, _type, operation) {
        if (options.codeResult) return options.codeResult;
        assert.equal(code, '123456');
        await operation({ query: async () => ({ rows: [], rowCount: 1 }) });
        events.push('code_consumed');
        return 'consumed';
      },
    },
    {
      isEnabled: () => true,
      async sendProviderLoginVerificationEmail(email) {
        events.push(['email_sent', email]);
      },
    },
    { generateTokens: () => ({ accessToken: 'access', refreshToken: 'refresh' }) },
    silentLogger,
  );
  return { service, events };
};

test('authenticates trusted Microsoft email and returning linked identities', async () => {
  const first = setup();
  const result = await first.service.login('identity-token', attemptToken);
  assert.equal(result.status, 'authenticated');
  assert.equal(result.session.userId, user.id);
  assert.deepEqual(first.events[0], [
    'completed',
    attempt.id,
    identity.providerUserId,
    identity.email,
  ]);

  const returning = setup({
    linked: true,
    identity: { ...identity, email: undefined, suggestedEmail: undefined, emailVerified: false },
  });
  assert.equal((await returning.service.login('identity-token', attemptToken)).status, 'authenticated');
  assert.equal(returning.events[0][3], undefined);
});

test('requires email verification before creating an unverified Microsoft account', async () => {
  const { service, events } = setup({ identity: { ...identity, emailVerified: false } });
  const result = await service.login('identity-token', attemptToken);
  assert.equal(result.status, 'email_verification_required');
  assert.equal(events[0][0], 'email_required');
});

test('requires verification before an untrusted email can link an existing account', async () => {
  const { service, events } = setup({
    identity: { ...identity, emailVerified: false },
    emailCollision: true,
  });
  const result = await service.login('identity-token', attemptToken);
  assert.deepEqual(result, {
    status: 'email_verification_required',
    attemptToken,
    suggestedEmail: 'person@example.com',
  });
  assert.ok(events.find((event) => Array.isArray(event) && event[0] === 'email_required'));
});

test('consumes the scoped code and account-link mutation atomically', async () => {
  const { service, events } = setup({
    attempt: {
      status: 'email_verification_required',
      providerUserId: identity.providerUserId,
      suggestedEmail: identity.email,
    },
  });
  await service.sendVerificationEmail(attemptToken, identity.email);
  const session = await service.confirmVerificationEmail(
    attemptToken,
    identity.email,
    '123456',
  );
  assert.equal(session.userId, user.id);
  assert.ok(events.find((event) => Array.isArray(event) && event[0] === 'completed_atomic'));
  assert.ok(events.indexOf('code_consumed') > events.findIndex((event) => Array.isArray(event) && event[0] === 'completed_atomic'));
});

test('maps invalid Microsoft tokens separately from provider outages and expired attempts', async () => {
  await assert.rejects(
    setup({ verifyError: new MicrosoftIdentityVerificationError('expired') }).service.login(
      'identity-token',
      attemptToken,
    ),
    (error) => error.code === 'MICROSOFT_TOKEN_INVALID',
  );
  await assert.rejects(
    setup({ verifyError: new Error('network unavailable') }).service.login(
      'identity-token',
      attemptToken,
    ),
    (error) => error.code === 'MICROSOFT_AUTH_UNAVAILABLE',
  );
  await assert.rejects(
    setup({ missingAttempt: true }).service.login('identity-token', attemptToken),
    (error) => error.code === 'MICROSOFT_ATTEMPT_EXPIRED',
  );
});

test('disabled or incomplete configuration fails closed without creating an attempt', async () => {
  await assert.rejects(
    setup({ enabled: false, noVerifier: true }).service.createAttempt(),
    (error) => error.code === 'MICROSOFT_AUTH_UNAVAILABLE',
  );
});
