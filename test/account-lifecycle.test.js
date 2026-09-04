const test = require('node:test');
const assert = require('node:assert/strict');

const { redisLockStore } = require('../dist/config/redis');
const { ImportLockService } = require('../dist/services/import/ImportLockService');
const { AccountDeletionService } = require('../dist/services/account/AccountDeletionService');
const { AccountResetService } = require('../dist/services/data/AccountResetService');

const transactional = (client) => ({
  withTransaction: async (operation) => {
    await client.query('BEGIN');
    try {
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
});

test('an expired lock owner cannot release a newer Redis lock', async (t) => {
  const values = new Map();
  const originals = {
    isAvailable: redisLockStore.isAvailable,
    isEnabled: redisLockStore.isEnabled,
    setNX: redisLockStore.setNX,
    deleteIfValueMatches: redisLockStore.deleteIfValueMatches,
  };
  t.after(() => Object.assign(redisLockStore, originals));

  redisLockStore.isAvailable = () => true;
  redisLockStore.isEnabled = () => true;
  redisLockStore.setNX = async (key, value) => {
    if (values.has(key)) return false;
    values.set(key, value);
    return true;
  };
  redisLockStore.deleteIfValueMatches = async (key, expectedValue) => {
    if (values.get(key) !== expectedValue) return false;
    values.delete(key);
    return true;
  };

  const staleHandle = await ImportLockService.acquireLock('user-id');
  assert.ok(staleHandle);
  values.set('import_lock:user-id', 'new-owner-token');

  assert.equal(await ImportLockService.releaseLock(staleHandle), false);
  assert.equal(values.get('import_lock:user-id'), 'new-owner-token');

  values.clear();
  const firstUserLock = await ImportLockService.acquireLock('user-id');
  assert.ok(firstUserLock);
  assert.equal(await ImportLockService.acquireLock('user-id'), null);
  const ownerBeforeWait = values.get('import_lock:user-id');
  assert.equal(await ImportLockService.acquireLockWithWait('user-id', 0, 1), null);
  assert.equal(values.get('import_lock:user-id'), ownerBeforeWait);
  const cancellation = new AbortController();
  cancellation.abort();
  assert.equal(
    await ImportLockService.acquireLockWithWait('user-id', 1000, 10, cancellation.signal),
    null,
  );
  assert.equal(values.get('import_lock:user-id'), ownerBeforeWait);
  const otherUserLock = await ImportLockService.acquireLock('other-user-id');
  assert.ok(otherUserLock);
  assert.equal(await ImportLockService.releaseLock(firstUserLock), true);
  assert.equal(await ImportLockService.releaseLock(otherUserLock), true);
});

test('account deletion commits before cache cleanup and releases the user lock', async () => {
  const events = [];
  const client = {
    query: async (sql) => {
      events.push(sql);
      if (sql.startsWith('SELECT email'))
        return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => {},
    releaseLock: async (handle) => {
      assert.equal(handle, lockHandle);
      events.push('LOCK_RELEASE');
      return true;
    },
  };
  const cache = { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') };
  const health = { invalidate: () => events.push('HEALTH_INVALIDATE') };
  const tokenRevoker = { revokeRefreshToken: async () => events.push('TOKEN_REVOKE') };
  const service = new AccountDeletionService(
    transactional(client),
    cache,
    health,
    tokenRevoker,
    lock,
  );

  assert.deepEqual(await service.deleteAccount('user-id', 'refresh-token'), { deleted: true });
  assert.ok(events.indexOf('COMMIT') < events.indexOf('CACHE_INVALIDATE'));
  assert.ok(events.indexOf('COMMIT') < events.indexOf('TOKEN_REVOKE'));
  assert.ok(events.includes('DELETE FROM verification_codes WHERE email = $1'));
  assert.ok(events.includes('DELETE FROM users WHERE id = $1'));
  assert.ok(events.includes('LOCK_RELEASE'));
});

test('account deletion rolls back and releases the lock when deletion fails', async () => {
  const events = [];
  const client = {
    query: async (sql) => {
      events.push(sql);
      if (sql.startsWith('SELECT email'))
        return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      if (sql === 'DELETE FROM users WHERE id = $1') throw new Error('delete failed');
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => {},
    releaseLock: async () => {
      events.push('LOCK_RELEASE');
      return true;
    },
  };
  const service = new AccountDeletionService(
    transactional(client),
    { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') },
    { invalidate: () => events.push('HEALTH_INVALIDATE') },
    { revokeRefreshToken: async () => events.push('TOKEN_REVOKE') },
    lock,
  );

  await assert.rejects(service.deleteAccount('user-id'), /delete failed/);
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(events.includes('LOCK_RELEASE'));
  assert.equal(events.includes('CACHE_INVALIDATE'), false);
});

test('account deletion rolls back when lock ownership is lost before commit', async () => {
  const events = [];
  const client = {
    query: async (sql) => {
      events.push(sql);
      if (sql.startsWith('SELECT email'))
        return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => {
      throw new Error('lease lost');
    },
    releaseLock: async () => {
      events.push('LOCK_RELEASE');
      return false;
    },
  };
  const service = new AccountDeletionService(
    transactional(client),
    { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') },
    { invalidate: () => events.push('HEALTH_INVALIDATE') },
    { revokeRefreshToken: async () => events.push('TOKEN_REVOKE') },
    lock,
  );

  await assert.rejects(service.deleteAccount('user-id'), /lease lost/);
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(events.includes('LOCK_RELEASE'));
  assert.equal(events.includes('COMMIT'), false);
  assert.equal(events.includes('CACHE_INVALIDATE'), false);
});

test('account deletion is idempotent when the relational account is already absent', async () => {
  const events = [];
  const client = {
    query: async (sql) => {
      events.push(sql);
      if (sql.startsWith('SELECT email')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const service = new AccountDeletionService(
    transactional(client),
    { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') },
    { invalidate: () => events.push('HEALTH_INVALIDATE') },
    { revokeRefreshToken: async () => events.push('TOKEN_REVOKE') },
    {
      acquireLockWithWait: async () => lockHandle,
      assertLockOwned: async () => {},
      releaseLock: async () => true,
    },
  );

  assert.deepEqual(await service.deleteAccount('user-id', 'refresh-token'), { deleted: true });
  assert.equal(events.includes('DELETE FROM users WHERE id = $1'), false);
  assert.ok(events.includes('COMMIT'));
  assert.ok(events.includes('CACHE_INVALIDATE'));
  assert.ok(events.includes('TOKEN_REVOKE'));
});

test('account deletion reports committed success when best-effort cleanup fails', async () => {
  const warnings = [];
  const client = {
    query: async (sql) => {
      if (sql.startsWith('SELECT email'))
        return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => {},
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const service = new AccountDeletionService(
    transactional(client),
    {
      invalidateAllUserCaches: async () => {
        throw new Error('cache unavailable');
      },
    },
    {
      invalidate: () => {
        throw new Error('health cache unavailable');
      },
    },
    {
      revokeRefreshToken: async () => {
        throw new Error('revocation unavailable');
      },
    },
    {
      acquireLockWithWait: async () => lockHandle,
      assertLockOwned: async () => {},
      releaseLock: async () => true,
    },
    { warn: (_message, metadata) => warnings.push(metadata) },
  );

  assert.deepEqual(await service.deleteAccount('user-id', 'refresh-token'), { deleted: true });
  assert.deepEqual(
    warnings.map(({ effect, outcome, attempt }) => ({ effect, outcome, attempt })),
    [
      {
        effect: 'connection_health_invalidation',
        outcome: 'post_commit_cleanup_retrying',
        attempt: 1,
      },
      {
        effect: 'connection_health_invalidation',
        outcome: 'post_commit_cleanup_failed',
        attempt: 2,
      },
      { effect: 'cache_invalidation', outcome: 'post_commit_cleanup_retrying', attempt: 1 },
      { effect: 'cache_invalidation', outcome: 'post_commit_cleanup_failed', attempt: 2 },
      {
        effect: 'refresh_token_revocation',
        outcome: 'post_commit_cleanup_retrying',
        attempt: 1,
      },
      {
        effect: 'refresh_token_revocation',
        outcome: 'post_commit_cleanup_failed',
        attempt: 2,
      },
    ],
  );
});

test('account deletion retries an idempotent post-commit effect once', async () => {
  let cacheAttempts = 0;
  const warnings = [];
  const client = {
    query: async (sql) =>
      sql.startsWith('SELECT email')
        ? { rows: [{ email: 'person@example.com' }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    release: () => {},
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const service = new AccountDeletionService(
    transactional(client),
    {
      invalidateAllUserCaches: async () => {
        cacheAttempts += 1;
        if (cacheAttempts === 1) throw new Error('transient cache failure');
      },
    },
    { invalidate: () => undefined },
    { revokeRefreshToken: async () => undefined },
    {
      acquireLockWithWait: async () => lockHandle,
      assertLockOwned: async () => undefined,
      releaseLock: async () => true,
    },
    { warn: (_message, metadata) => warnings.push(metadata) },
  );

  assert.deepEqual(await service.deleteAccount('user-id'), { deleted: true });
  assert.equal(cacheAttempts, 2);
  assert.deepEqual(
    warnings.map(({ effect, outcome, attempt }) => ({ effect, outcome, attempt })),
    [{ effect: 'cache_invalidation', outcome: 'post_commit_cleanup_retrying', attempt: 1 }],
  );
});

test('onboarding reset rolls back and releases the user lock when a reset step fails', async () => {
  const events = [];
  const client = {
    query: async (sql) => {
      events.push(sql);
      if (sql.includes('DELETE FROM receipts')) throw new Error('receipt reset failed');
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id',
    ownerToken: 'owner',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => {},
    releaseLock: async () => {
      events.push('LOCK_RELEASE');
      return true;
    },
  };
  const service = new AccountResetService(
    transactional(client),
    { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') },
    { invalidate: () => events.push('HEALTH_INVALIDATE') },
    lock,
  );

  await assert.rejects(service.resetForOnboarding('user-id'), /receipt reset failed/);

  assert.ok(events.includes('ROLLBACK'));
  assert.ok(events.includes('LOCK_RELEASE'));
  assert.equal(events.includes('COMMIT'), false);
  assert.equal(events.includes('CACHE_INVALIDATE'), false);
  assert.equal(events.includes('HEALTH_INVALIDATE'), false);
});
