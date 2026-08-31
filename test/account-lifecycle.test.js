const test = require('node:test');
const assert = require('node:assert/strict');

const { redisConfig } = require('../dist/config/redis');
const { ImportLockService } = require('../dist/services/import/ImportLockService');
const { AccountDeletionService } = require('../dist/services/account/AccountDeletionService');

test('an expired lock owner cannot release a newer Redis lock', async (t) => {
  const values = new Map();
  const originals = {
    isAvailable: redisConfig.isAvailable,
    isEnabled: redisConfig.isEnabled,
    setNX: redisConfig.setNX,
    deleteIfValueMatches: redisConfig.deleteIfValueMatches,
  };
  t.after(() => Object.assign(redisConfig, originals));

  redisConfig.isAvailable = () => true;
  redisConfig.isEnabled = () => true;
  redisConfig.setNX = async (key, value) => {
    if (values.has(key)) return false;
    values.set(key, value);
    return true;
  };
  redisConfig.deleteIfValueMatches = async (key, expectedValue) => {
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
      if (sql.startsWith('SELECT email')) return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id', ownerToken: 'owner', backend: 'memory', acquiredAt: 0, expiresAt: 1,
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
    { getClient: async () => client }, cache, health, tokenRevoker, lock
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
      if (sql.startsWith('SELECT email')) return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      if (sql === 'DELETE FROM users WHERE id = $1') throw new Error('delete failed');
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id', ownerToken: 'owner', backend: 'memory', acquiredAt: 0, expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => {},
    releaseLock: async () => { events.push('LOCK_RELEASE'); return true; },
  };
  const service = new AccountDeletionService(
    { getClient: async () => client },
    { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') },
    { invalidate: () => events.push('HEALTH_INVALIDATE') },
    { revokeRefreshToken: async () => events.push('TOKEN_REVOKE') },
    lock
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
      if (sql.startsWith('SELECT email')) return { rows: [{ email: 'person@example.com' }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
    release: () => events.push('CLIENT_RELEASE'),
  };
  const lockHandle = {
    userId: 'user-id', ownerToken: 'owner', backend: 'memory', acquiredAt: 0, expiresAt: 1,
  };
  const lock = {
    acquireLockWithWait: async () => lockHandle,
    assertLockOwned: async () => { throw new Error('lease lost'); },
    releaseLock: async () => { events.push('LOCK_RELEASE'); return false; },
  };
  const service = new AccountDeletionService(
    { getClient: async () => client },
    { invalidateAllUserCaches: async () => events.push('CACHE_INVALIDATE') },
    { invalidate: () => events.push('HEALTH_INVALIDATE') },
    { revokeRefreshToken: async () => events.push('TOKEN_REVOKE') },
    lock
  );

  await assert.rejects(service.deleteAccount('user-id'), /lease lost/);
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(events.includes('LOCK_RELEASE'));
  assert.equal(events.includes('COMMIT'), false);
  assert.equal(events.includes('CACHE_INVALIDATE'), false);
});
