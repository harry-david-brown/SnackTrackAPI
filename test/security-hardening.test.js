const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresService } = require('../dist/services/data/PostgresService');
const { MailboxSecretCipher } = require('../dist/services/mailbox/MailboxSecretCipher');
const { GmailCredentialCipher } = require('../dist/services/mailbox/GmailCredentialCipher');
const { AuthenticationAbuseService } = require('../dist/services/auth/AuthenticationAbuseService');
const { createAuthenticationAbuseMiddleware, authenticationBudget } = require('../dist/middleware/authenticationAbuse');
const { AdminRepository } = require('../dist/services/admin/AdminRepository');
const { ImportObjectCleanupService } = require('../dist/services/import/ImportObjectCleanupService');

test('database URL parameters cannot override certificate verification or configured CA', () => {
  let options;
  new PostgresService({ connectionString: 'postgresql://user:password@db.example/app?sslmode=no-verify&sslrootcert=evil&ssl=false&uselibpqcompat=true&application_name=api',
    useSsl: true, sslCa: 'trusted-ca', maxConnections: 1 }, value => { options = value; return { on() {} }; });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true, ca: 'trusted-ca' });
  assert.equal(new URL(options.connectionString).search, '?application_name=api');
});

test('a TLS-requesting URL enables verified TLS even for nonproduction callers', () => {
  let options;
  new PostgresService({ connectionString: 'postgresql://db.example/app?sslmode=require', useSsl: false, maxConnections: 1 },
    value => { options = value; return { on() {} }; });
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
});

test('Gmail envelopes reject tampering, another owner, another token purpose, and plaintext', () => {
  const cipher = new GmailCredentialCipher(new MailboxSecretCipher('test-only-mailbox-key-with-enough-entropy'));
  const envelope = cipher.encrypt('owner', 'refresh', 'synthetic-refresh-token');
  assert.equal(cipher.decrypt('owner', 'refresh', envelope), 'synthetic-refresh-token');
  assert.ok(!envelope.includes('synthetic-refresh-token'));
  assert.notEqual(envelope, cipher.encrypt('owner', 'refresh', 'synthetic-refresh-token'));
  assert.throws(() => cipher.decrypt('other', 'refresh', envelope));
  assert.throws(() => cipher.decrypt('owner', 'access', envelope));
  const parts = envelope.split('.');
  parts[4] = (parts[4][0] === 'A' ? 'B' : 'A') + parts[4].slice(1);
  assert.throws(() => cipher.decrypt('owner', 'refresh', parts.join('.')));
  assert.throws(() => cipher.decrypt('owner', 'refresh', 'legacy-plaintext'));
});

test('account abuse budgets are shared across IPs and API instances without plaintext keys', async () => {
  const counts = new Map();
  const store = { consume: async (key, maximum) => {
    const value = (counts.get(key) || 0) + 1; counts.set(key, value);
    return value > maximum ? 60 : 0;
  } };
  const instances = [new AuthenticationAbuseService(store, 'shared-key'), new AuthenticationAbuseService(store, 'shared-key')];
  const budget = { scope: 'login', ipMaximum: 50, accountMaximum: 2, windowSeconds: 60 };
  assert.equal(await instances[0].consume(budget, '192.0.2.1', 'account@example.test'), 0);
  assert.equal(await instances[1].consume(budget, '192.0.2.2', 'account@example.test'), 0);
  assert.equal(await instances[0].consume(budget, '192.0.2.3', 'account@example.test'), 60);
  assert.ok([...counts.keys()].every(key => !key.includes('account@example.test') && !key.includes('192.0.2.')));
});

test('auth middleware covers case/trailing slash variants, normalizes email, and fails closed', async () => {
  assert.ok(authenticationBudget('/AUTH/LOGIN/'));
  assert.ok(authenticationBudget('/ADMIN/v1/INVITATIONS/random/ACCEPT/'));
  assert.ok(authenticationBudget('/auth/password/reset/complete'));
  assert.equal(authenticationBudget('/auth/refresh'), undefined);
  const req = { method: 'POST', path: '/AUTH/LOGIN/', ip: '192.0.2.1', socket: {}, body: { email: ' OWNER@Example.Test ' } };
  let status, payload, input;
  const headers = {};
  const res = { setHeader: (name, value) => { headers[name] = value; }, status(value) { status = value; return this; }, json(value) { payload = value; } };
  await createAuthenticationAbuseMiddleware({ consume: async (...args) => { input = args; return 60; } })(req, res, () => assert.fail('over-budget authentication executed'));
  assert.equal(input[2], 'owner@example.test');
  assert.equal(status, 429);
  assert.equal(headers['Retry-After'], 60);
  await createAuthenticationAbuseMiddleware({ consume: async () => { throw new Error('Redis unavailable'); } })(req, res, () => assert.fail('authentication failed open'));
  assert.equal(status, 503);
  assert.equal(payload.code, 'AUTH_RATE_LIMIT_UNAVAILABLE');
});

test('invalid admin invitation/reset tokens never perform password hashing', async () => {
  const repository = new AdminRepository({ withTransaction: callback => callback({ query: async () => ({ rows: [] }) }) });
  const hash = async () => assert.fail('must validate the one-use token first');
  await assert.rejects(repository.acceptInvitation('invalid', hash));
  await assert.rejects(repository.resetPassword('invalid', hash));
});

test('object cleanup records storage failures for retry and continues with other objects', async () => {
  const attempts = [];
  const service = new ImportObjectCleanupService({ listDue: async () => ['unavailable', 'available'],
    recordAttempt: async (...args) => attempts.push(args) }, { delete: async key => { if (key === 'unavailable') throw new Error('storage unavailable'); } });
  assert.deepEqual(await service.run(), { deleted: 1, failed: 1 });
  assert.deepEqual(attempts, [['unavailable', false], ['available', true]]);
});
