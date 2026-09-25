const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, createHash } = require('node:crypto');
const { Pool } = require('pg');
process.env.JWT_SECRET ||= 'test-secret-at-least-thirty-two-characters-long';
process.env.JWT_REFRESH_SECRET ||= 'test-refresh-secret-at-least-thirty-two-characters';
const { ProviderAccountRepository } = require('../dist/services/data/ProviderAccountRepository');
const { UserRepository } = require('../dist/services/data/UserRepository');
const { MailboxAuthorizationRepository } = require('../dist/services/data/MailboxAuthorizationRepository');
const { MailboxSecretCipher } = require('../dist/services/mailbox/MailboxSecretCipher');
const { GmailCredentialCipher } = require('../dist/services/mailbox/GmailCredentialCipher');
const { GmailCredentialMigrationRepository } = require('../dist/services/data/GmailCredentialMigrationRepository');
const { ImportObjectDeletionRepository } = require('../dist/services/data/ImportObjectDeletionRepository');
const { TokenService } = require('../dist/services/auth/TokenService');
const { SessionService } = require('../dist/services/auth/SessionService');
const { PasswordResetService } = require('../dist/services/auth/PasswordResetService');
const { ProviderAuthService } = require('../dist/services/auth/ProviderAuthService');
const { GoogleIdentityTokenVerifier, AppleIdentityTokenVerifier } = require('../dist/services/auth/IdentityProvider');
const { UserModel } = require('../dist/models/User');
const { MigrationRunner } = require('../dist/services/data/MigrationRunner');
const { migrations } = require('../dist/services/data/migrations');
const { OtpService } = require('../dist/services/OtpService');
const { createCacheFake } = require('./fakes');
const logger = { info() {}, warn() {}, error() {} };
const hash = value => createHash('sha256').update(value).digest('hex');
const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL;
const databaseOptions = { skip: databaseUrl ? false : 'MIGRATION_TEST_DATABASE_URL is not configured' };

const withDatabase = async operation => {
  const schema = `security_${process.pid}_${randomBytes(6).toString('hex')}`;
  const administrator = new Pool({ connectionString: databaseUrl, max: 1 });
  await administrator.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: databaseUrl, max: 4, options: `-c search_path=${schema}` });
  const database = {
    query: (sql, params) => pool.query(sql, params),
    withTransaction: async callback => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await callback({ query: (sql, params) => client.query(sql, params) });
        await client.query('COMMIT');
        return result;
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    },
  };
  try {
    await new MigrationRunner({ getClient: () => pool.connect() }, migrations).run();
    await operation(database);
  } finally {
    await pool.end();
    await administrator.query(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.end();
  }
};

test('Gmail backfill encrypts legacy rows idempotently and new writes remain encrypted', databaseOptions, async () => {
  await withDatabase(async database => {
    const cipher = new GmailCredentialCipher(new MailboxSecretCipher('synthetic-test-only-encryption-key'));
    const users = new UserRepository(database, cipher);
    const id = await users.createUserWithPassword('gmail@example.test', 'hash');
    await database.query('UPDATE users SET gmail_access_token=$2, gmail_refresh_token=$3 WHERE id=$1', [id, 'legacy-access', 'legacy-refresh']);
    const backfill = new GmailCredentialMigrationRepository(database, cipher);
    await assert.rejects(users.findByIdWithGmailTokens(id), /migration is required/);
    assert.equal(await backfill.encryptBatch(), 1);
    assert.equal(await backfill.encryptBatch(), 0);
    assert.equal((await users.findByIdWithGmailTokens(id)).gmailRefreshToken, 'legacy-refresh');
    await users.updateGmailTokens(id, { accessToken: 'new-access', refreshToken: 'new-refresh', expiryDate: new Date(), scopes: ['readonly'], connectionMode: 'offline' });
    const row = (await database.query('SELECT gmail_access_token, gmail_refresh_token FROM users WHERE id=$1', [id])).rows[0];
    assert.ok(row.gmail_access_token.startsWith('gmail.v1.'));
    assert.ok(row.gmail_refresh_token.startsWith('gmail.v1.'));
    assert.equal((await users.findByIdWithGmailTokens(id)).gmailAccessToken, 'new-access');
    await users.disconnectGmail(id);
    assert.equal((await users.findByIdWithGmailTokens(id)).gmailAccessToken, undefined);
  });
});

test('account cascade durably retains upload cleanup, rolls back together, and retries failed deletion', databaseOptions, async () => {
  await withDatabase(async database => {
    const id = await new UserRepository(database).createUserWithPassword('delete@example.test', 'hash');
    const key = `imports/${id}/synthetic.zip`;
    await database.query(`INSERT INTO import_jobs(user_id,kind,trigger_type,status,object_key,import_generation)
      VALUES ($1,'export_file','user','awaiting_upload',$2,1)`, [id, key]);
    await assert.rejects(database.withTransaction(async tx => { await tx.query('DELETE FROM users WHERE id=$1', [id]); throw new Error('rollback'); }));
    assert.equal((await database.query('SELECT * FROM import_object_deletions')).rowCount, 0);
    await database.query('DELETE FROM users WHERE id=$1', [id]);
    assert.equal((await database.query('SELECT * FROM import_jobs')).rowCount, 0);
    const cleanup = new ImportObjectDeletionRepository(database);
    assert.deepEqual(await cleanup.listDue(), [key]);
    await cleanup.recordAttempt(key, false);
    assert.equal((await database.query('SELECT * FROM import_object_deletions')).rowCount, 1);
    await cleanup.recordAttempt(key, true);
    assert.equal((await database.query('SELECT * FROM import_object_deletions')).rowCount, 1, 'successful first deletion still retains the signed-upload grace period');
    await database.query("UPDATE import_object_deletions SET retain_until=NOW()-INTERVAL '1 second'");
    await cleanup.recordAttempt(key, false);
    assert.equal((await database.query('SELECT * FROM import_object_deletions')).rowCount, 1, 'outage must not discard expired work');
    await cleanup.recordAttempt(key, true);
    assert.equal((await database.query('SELECT * FROM import_object_deletions')).rowCount, 0);
  });
});

test('Google authority requires verified Gmail or hosted-domain email; Apple uses signed verification', async () => {
  const google = async payload => new GoogleIdentityTokenVerifier({
    verifyIdToken: async () => ({ getPayload: () => ({ sub: 'google-sub', ...payload }) }),
  }, ['audience']).verify('token');
  assert.equal((await google({ email: 'owner@gmail.com', email_verified: true })).emailVerified, true);
  assert.equal((await google({ email: 'owner@company.test', hd: 'company.test', email_verified: true })).emailVerified, true);
  assert.equal((await google({ email: 'owner@third-party.test', email_verified: true })).emailVerified, false);
  assert.equal((await google({ email: 'owner@gmail.com', email_verified: false })).emailVerified, false);
  for (const flag of [false, 'false', undefined]) {
    const apple = new AppleIdentityTokenVerifier({ verifyIdToken: async () => ({ sub: 'apple-sub', email_verified: flag }) }, ['audience']);
    assert.equal((await apple.verify('token')).emailVerified, false);
  }
});

test('Apple request-body email never becomes identity evidence', async () => {
  let received;
  const service = new ProviderAuthService({ resolve: async identity => { received = identity; throw new Error('stop'); } },
    { generateTokens: () => assert.fail('must not mint tokens') }, {},
    { verify: async () => ({ providerUserId: 'apple-sub', emailVerified: false }) }, logger);
  await assert.rejects(service.loginWithApple('signed-token', { email: 'victim@example.test' }));
  assert.equal(received.email, undefined);
  assert.equal(received.emailVerified, false);
});

test('invalid password-reset requests do not hash a new password', async () => {
  const original = UserModel.hashPassword;
  UserModel.hashPassword = async () => assert.fail('invalid OTP must not cause password hashing');
  try {
    for (const outcome of ['invalid', 'not_pending']) {
      const service = new PasswordResetService({}, { consumeOTP: async () => outcome }, {}, logger);
      await assert.rejects(service.complete('missing@example.test', '000000', 'NewPassword123!'));
    }
  } finally { UserModel.hashPassword = original; }
});

test('provider collisions and concurrent creation never adopt another account or leave orphan users', databaseOptions, async () => {
  await withDatabase(async database => {
    const users = new UserRepository(database);
    const accounts = new ProviderAccountRepository(database);
    const id = await users.createUserWithPassword('victim@example.test', 'attacker-password-hash');
    for (const provider of ['google', 'apple', 'microsoft']) {
      await assert.rejects(accounts.resolve({ provider, providerUserId: `victim-${provider}`,
        email: 'victim@example.test', emailVerified: true }), error => error.code === 'OAUTH_ACCOUNT_CONFLICT');
    }
    assert.equal((await users.findByEmailWithPassword('victim@example.test')).password, 'attacker-password-hash');
    assert.equal((await database.query('SELECT id FROM oauth_accounts WHERE user_id=$1', [id])).rowCount, 0);
    const results = await Promise.allSettled(['one', 'two'].map(name => accounts.resolve({
      provider: 'google', providerUserId: 'same-provider-sub', email: `${name}@gmail.com`, emailVerified: true,
    })));
    assert.ok(results.some(result => result.status === 'fulfilled'));
    assert.equal((await database.query('SELECT id FROM users')).rowCount, 2);
    assert.equal((await database.query('SELECT id FROM oauth_accounts')).rowCount, 1);
  });
});

test('OTP recovery revokes both device sessions and provider links in the recovery transaction', databaseOptions, async () => {
  await withDatabase(async database => {
    const users = new UserRepository(database);
    const accounts = new ProviderAccountRepository(database);
    const user = await accounts.resolve({ provider: 'google', providerUserId: 'sub', email: 'owner@gmail.com', emailVerified: true });
    const tokens = new TokenService({ accessSecret: process.env.JWT_SECRET, refreshSecret: process.env.JWT_REFRESH_SECRET,
      accessTokenExpiry: '15m', refreshTokenExpiry: '7d' }, createCacheFake(), logger);
    const pairs = [tokens.generateTokens(user), tokens.generateTokens(user)];
    const sessions = new SessionService(users, tokens);
    const codes = new OtpService(database, () => 123456);
    await codes.storeOTP(user.email, 'password_reset');
    await assert.rejects(codes.consumeOTP(user.email, '123456', 'password_reset', async transaction => {
      await users.updatePassword(user.email, 'rolled-back-hash', transaction);
      throw new Error('recovery mutation failed');
    }), /recovery mutation failed/);
    assert.equal((await users.findById(user.id)).sessionVersion, 0);
    assert.equal((await database.query('SELECT id FROM oauth_accounts WHERE user_id=$1', [user.id])).rowCount, 1);
    await new PasswordResetService(users, codes, {}, logger).complete(user.email, '123456', 'NewPassword123!');
    const recovered = await users.findByEmailWithPassword(user.email);
    assert.equal(recovered.sessionVersion, 1);
    assert.equal(await UserModel.comparePassword('NewPassword123!', recovered.password), true);
    assert.equal((await database.query('SELECT id FROM oauth_accounts WHERE user_id=$1', [user.id])).rowCount, 0);
    for (const pair of pairs) {
      await assert.rejects(sessions.refresh(pair.refreshToken), error => error.code === 'REFRESH_TOKEN_INVALID');
      await assert.rejects(sessions.verifyAccessSession(tokens.verifyAccessToken(pair.accessToken)), error => error.code === 'ACCESS_TOKEN_INVALID');
    }
    // Legacy generation-zero tokens are also invalid after recovery.
    await assert.rejects(sessions.verifyAccessSession({ userId: user.id, email: user.email, type: 'access' }));
    await sessions.verifyAccessSession(tokens.verifyAccessToken(tokens.generateTokens(recovered).accessToken));
    await assert.rejects(accounts.resolve({ provider: 'google', providerUserId: 'sub', email: user.email, emailVerified: true }),
      error => error.code === 'OAUTH_ACCOUNT_CONFLICT');
  });
});

test('mailbox handoffs reject other accounts, wrong devices, callback replay, concurrent redemption, and recovery races', databaseOptions, async () => {
  await withDatabase(async database => {
    const users = new UserRepository(database);
    const a = await users.createUser('a@example.test');
    const b = await users.createUser('b@example.test');
    const repository = new MailboxAuthorizationRepository(database, new MailboxSecretCipher('long-test-encryption-key'));
    const verifier = 'a'.repeat(64);
    for (const provider of ['gmail', 'outlook']) {
      const state = `state-${provider}`;
      await repository.register(a, provider, `https://provider.test/auth?state=${state}`, hash(verifier), 0);
      const token = await repository.receive(provider, state, 'provider-code');
      await assert.rejects(repository.receive(provider, state, 'provider-code'));
      await assert.rejects(repository.consume(b, provider, token, verifier));
      await assert.rejects(repository.consume(a, provider, token, 'b'.repeat(64)));
      const results = await Promise.allSettled([repository.consume(a, provider, token, verifier), repository.consume(a, provider, token, verifier)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const claim = results.find(result => result.status === 'fulfilled').value;
      assert.equal(claim.code, 'provider-code');
      await assert.rejects(repository.persist(claim, async () => { throw new Error('write failed'); }), /write failed/);
      await repository.persist(claim, tx => tx.query('UPDATE users SET timezone=$2 WHERE id=$1', [a, 'UTC']));
      await assert.rejects(repository.persist(claim, async () => assert.fail('a claim is persisted only once')));
      await repository.register(a, provider, `https://provider.test/auth?state=generation-${provider}`, hash(verifier), 0);
      const generationToken = await repository.receive(provider, `generation-${provider}`, 'code');
      const generationClaim = await repository.consume(a, provider, generationToken, verifier);
      await database.query('UPDATE users SET import_generation=import_generation+1 WHERE id=$1', [a]);
      await assert.rejects(repository.persist(generationClaim, async () => assert.fail('stale generation must not persist')));
      await repository.register(a, provider, `https://provider.test/auth?state=disconnect-${provider}`, hash(verifier), 0);
      const disconnectToken = await repository.receive(provider, `disconnect-${provider}`, 'code');
      const disconnectClaim = await repository.consume(a, provider, disconnectToken, verifier);
      await repository.cancel(a, provider);
      await assert.rejects(repository.persist(disconnectClaim, async () => assert.fail('disconnect must cancel a pending grant')));
    }
    await repository.register(a, 'gmail', 'https://provider.test/auth?state=before-recovery', hash(verifier), 0);
    const token = await repository.receive('gmail', 'before-recovery', 'code');
    await users.updatePassword('a@example.test', 'new-hash');
    await assert.rejects(repository.consume(a, 'gmail', token, verifier));
    await assert.rejects(repository.register(a, 'gmail', 'https://provider.test/auth?state=stale-session', hash(verifier), 0));
    await repository.register(a, 'gmail', 'https://provider.test/auth?state=expired', hash(verifier), 1);
    const expiredToken = await repository.receive('gmail', 'expired', 'code');
    await database.query('UPDATE mailbox_authorization_attempts SET expires_at=NOW()-INTERVAL \'1 second\'');
    await assert.rejects(repository.consume(a, 'gmail', expiredToken, verifier));
  });
});

test('provider login waiting behind recovery cannot mint a session for a deleted link', databaseOptions, async () => {
  await withDatabase(async database => {
    const identity = { provider: 'google', providerUserId: 'race-sub', email: 'race@gmail.com', emailVerified: true };
    const user = await new ProviderAccountRepository(database).resolve(identity);
    let requestedLock;
    const lockRequested = new Promise(resolve => { requestedLock = resolve; });
    const loginDatabase = { ...database, withTransaction: callback => database.withTransaction(transaction => callback({
      query: (sql, params) => {
        if (sql.includes('FOR UPDATE')) requestedLock();
        return transaction.query(sql, params);
      },
    })) };
    let login;
    await database.withTransaction(async transaction => {
      await transaction.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [user.id]);
      login = new ProviderAccountRepository(loginDatabase).resolve(identity).then(
        () => ({ success: true }), error => ({ error }),
      );
      await lockRequested;
      await new UserRepository(transaction).updatePassword(user.email, 'replacement-hash');
    });
    assert.equal((await login).error.code, 'OAUTH_ACCOUNT_CONFLICT');
  });
});

const { createGmailOAuthRouter } = require('../dist/routes/gmailOAuth');
const { createOutlookRouter } = require('../dist/routes/outlook');
for (const provider of ['gmail', 'outlook']) {
  test(`${provider} handoff route requires authentication and uses token identity`, async () => {
    const calls = [];
    const authenticate = (request, _response, next) => {
      if (!request.user) return next(new Error('authentication required'));
      next();
    };
    const dependencies = { authenticate, connections: {
      finishAuthorization: async (...args) => calls.push(args),
      createAuthorizationUrl: async (...args) => { calls.push(args); return 'https://provider.test/authorize'; },
    }, logger };
    const router = provider === 'gmail' ? createGmailOAuthRouter(dependencies) : createOutlookRouter(dependencies);
    const invoke = (path, request) => new Promise((resolve, reject) => {
      const handlers = router.stack.find(layer => layer.route?.path === path).route.stack;
      let index = 0;
      const next = error => error ? reject(error) : handlers[index++].handle(request, { json: resolve }, next);
      next();
    });
    await assert.rejects(invoke('/complete', { body: { completionToken: 'c'.repeat(64), verifier: 'a'.repeat(64) } }), /authentication required/);
    await invoke('/complete', { user: { userId: 'account-a' }, body: { userId: 'account-b', completionToken: 'c'.repeat(64), verifier: 'a'.repeat(64) } });
    assert.deepEqual(calls, [['account-a', 'c'.repeat(64), 'a'.repeat(64)]]);
    await assert.rejects(invoke('/auth-url', { user: { userId: 'account-a' }, body: { redirectUri: 'snacktrack://oauth-callback' } }),
      error => error.code === 'VALIDATION_ERROR');
    await invoke('/auth-url', { user: { userId: 'account-a', sessionVersion: 4 }, body: {
      redirectUri: 'snacktrack://oauth-callback', handoffChallenge: 'a'.repeat(64), purpose: 'receipt_import',
    } });
    assert.deepEqual(calls[1], ['account-a', 'snacktrack://oauth-callback', 'receipt_import', 'a'.repeat(64), 4]);
  });
}
