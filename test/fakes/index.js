const createClock = (initialMs = 0) => {
  let currentMs = initialMs;
  return {
    nowMs: () => currentMs,
    now: () => new Date(currentMs),
    advance: (milliseconds) => {
      currentMs += milliseconds;
    },
  };
};

const createIdSequence = (...ids) => {
  let index = 0;
  return () => {
    const value = ids[index++];
    if (!value) throw new Error('Deterministic ID sequence exhausted');
    return value;
  };
};

const createCacheFake = () => {
  const values = new Map();
  const calls = [];
  return {
    values,
    calls,
    isAvailable: () => true,
    exists: async (key) => values.has(key),
    get: async (key) => values.get(key),
    set: async (key, value, ttl) => {
      calls.push(['set', key, value, ttl]);
      values.set(key, value);
    },
    setIfAbsent: async (key, value, ttl) => {
      calls.push(['setIfAbsent', key, value, ttl]);
      if (values.has(key)) return false;
      values.set(key, value);
      return true;
    },
    del: async (key) => {
      calls.push(['del', key]);
      values.delete(key);
    },
    invalidateAllUserCaches: async (userId) => calls.push(['invalidate', userId]),
  };
};

const createLockFake = (options = {}) => {
  const calls = [];
  const handle = {
    userId: options.userId ?? 'user-id',
    ownerToken: options.ownerToken ?? 'owner-token',
    backend: 'memory',
    acquiredAt: 0,
    expiresAt: 60_000,
  };
  return {
    calls,
    handle,
    acquireLock: async (userId) => {
      calls.push(['acquire', userId]);
      return options.busy ? null : handle;
    },
    acquireLockWithWait: async (userId) => {
      calls.push(['acquire-wait', userId]);
      return options.busy ? null : handle;
    },
    assertLockOwned: async (received) => {
      calls.push(['assert', received]);
      if (options.leaseLost) throw new Error('Lease lost');
    },
    releaseLock: async (received) => {
      calls.push(['release', received]);
      return true;
    },
  };
};

const createProviderFake = (result) => ({
  calls: [],
  async verify(token) {
    this.calls.push(token);
    if (result instanceof Error) throw result;
    return result;
  },
});

module.exports = {
  createCacheFake,
  createClock,
  createIdSequence,
  createLockFake,
  createProviderFake,
};
