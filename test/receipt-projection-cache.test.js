const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { UserRepository } = require('../dist/services/data/UserRepository');
const { GetUserSummaryService } = require('../dist/services/user/GetUserSummaryService');
const {
  GetDashboardInsightsService,
} = require('../dist/services/user/GetDashboardInsightsService');
const { WrappedAnalyticsService } = require('../dist/services/analytics/WrappedAnalyticsService');
const { buildDashboardInsightEdition } = require('../dist/services/analytics/dashboard');
const { decemberCanonicalOrders } = require('./helpers/order-events-fixture');

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('new revision joined stale work')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function harness(kind, cacheAvailable = true) {
  let profile = {
    id: 'fixture-user',
    email: 'fixture@example.test',
    timezone: 'America/Toronto',
    receiptProjectionRevision: '10',
  };
  let rows = await decemberCanonicalOrders(),
    reads = 0;
  const entries = new Map(),
    writes = [];
  let readGate, writeGate;
  const users = {
    findProjectionProfileById: async () => (profile ? { ...profile } : undefined),
    updateTimezone: async (_id, timezone) => {
      profile = { ...profile, timezone, receiptProjectionRevision: '11' };
    },
  };
  const receipts = {
    findByUserId: async () => {
      reads++;
      const snapshot = structuredClone(rows),
        gate = readGate;
      readGate = undefined;
      if (gate) {
        gate.entered.resolve();
        await gate.resume.promise;
      }
      return snapshot;
    },
  };
  const get = async (key) => (cacheAvailable ? (entries.get(key) ?? null) : null);
  const set = async (key, value) => {
    const gate = writeGate;
    writeGate = undefined;
    if (gate) {
      gate.entered.resolve();
      await gate.resume.promise;
    }
    writes.push(key);
    if (cacheAvailable) entries.set(key, value);
  };
  const cache = {
    getUserSummary: get,
    cacheUserSummary: set,
    getDashboardInsightEdition: get,
    cacheDashboardInsightEdition: set,
    invalidateAllUserCaches: async () => entries.clear(),
  };
  const wrapped = new WrappedAnalyticsService({ getPercentileRanks: async () => null });
  const service =
    kind === 'dashboard'
      ? new GetDashboardInsightsService(users, receipts, cache)
      : new GetUserSummaryService(users, receipts, wrapped, cache);
  const execute = () =>
    service.execute({
      userId: 'fixture-user',
      includeWrapped: kind === 'wrapped',
      devDayOffset: 0,
    });
  const gate = () => ({ entered: deferred(), resume: deferred() });
  return {
    execute,
    entries,
    writes,
    users,
    cache,
    blockRead() {
      return (readGate = gate());
    },
    blockWrite() {
      return (writeGate = gate());
    },
    removeAccount() {
      profile = undefined;
    },
    changeData() {
      const extra = structuredClone(
        rows.find(
          (r) => r.resolution.orderOutcome.fulfillment === 'completed' && r.amountSpent > 0,
        ),
      );
      extra.id = 'new-order';
      extra.amountSpent = 10;
      Object.assign(extra.resolution.orderOutcome, {
        netAmount: 10,
        originalCharge: 10,
        events: [],
      });
      rows = [...rows, extra];
      profile.receiptProjectionRevision = '11';
    },
    get reads() {
      return reads;
    },
    verify(result, count) {
      if (kind === 'dashboard') {
        const expectedRows = count === 5 ? rows.slice(0, 5) : rows;
        assert.deepEqual(
          result,
          buildDashboardInsightEdition(
            expectedRows,
            'America/Toronto',
            'fixture-user',
            new Date(result.generatedAt),
          ),
        );
      } else {
        assert.equal(result.statistics.totalReceipts, count);
        assert.equal(result.statistics.totalSpent, count === 5 ? 157.02 : 167.02);
        if (kind === 'wrapped') {
          assert.equal(result.wrappedAnalytics.orderMetrics.attempts, count);
          assert.equal(
            result.wrappedAnalytics.orderMetrics.currencies[0].netSpend,
            result.statistics.totalSpent,
          );
        }
      }
    },
  };
}

for (const kind of ['summary', 'wrapped', 'dashboard']) {
  for (const cacheAvailable of [true, false])
    test(`${kind}: requests after a receipt commit cannot join old work, including cache ${cacheAvailable ? 'enabled' : 'unavailable'}`, async () => {
      const h = await harness(kind, cacheAvailable),
        blocked = h.blockRead();
      const old = h.execute();
      try {
        await blocked.entered.promise;
        h.changeData();
        await h.cache.invalidateAllUserCaches('fixture-user');
        const current = await within(h.execute());
        h.verify(current, 6);
        assert.equal(h.reads, 2);
        blocked.resume.resolve();
        h.verify(await old, 5);
        assert.equal(
          h.writes.length,
          1,
          'old calculation must not publish after a changed profile is observed',
        );
        assert.match(h.writes[0], /:r11/);
        h.verify(await h.execute(), 6);
        assert.equal(h.reads, cacheAvailable ? 2 : 3);
      } finally {
        blocked.resume.resolve();
        await old;
      }
    });

  test(`${kind}: late publication after invalidation stays in an obsolete namespace`, async () => {
    const h = await harness(kind),
      blocked = h.blockWrite();
    const old = h.execute();
    try {
      await blocked.entered.promise;
      h.changeData();
      await h.cache.invalidateAllUserCaches('fixture-user');
      h.verify(await within(h.execute()), 6);
      blocked.resume.resolve();
      h.verify(await old, 5);
      assert.ok([...h.entries.keys()].some((key) => key.includes(':r10')));
      h.verify(await h.execute(), 6);
      assert.equal(h.reads, 2, 'old value cannot replace the current cached value');
    } finally {
      blocked.resume.resolve();
      await old;
    }
  });

  test(`${kind}: failed invalidation and unchanged-revision coalescing cannot confuse versions`, async () => {
    const h = await harness(kind),
      blocked = h.blockRead();
    const a = h.execute();
    await blocked.entered.promise;
    const b = h.execute();
    blocked.resume.resolve();
    const [first, joined] = await Promise.all([a, b]);
    assert.equal(first, joined);
    assert.equal(h.reads, 1);
    h.changeData(); // Deliberately retain the old cache, simulating a lost post-commit invalidation.
    h.verify(await h.execute(), 6);
    assert.equal(h.reads, 2);
  });
}

test('an account deleted during projection does not receive a new cache entry and subsequent reads are not found', async () => {
  const h = await harness('wrapped'),
    blocked = h.blockRead();
  const old = h.execute();
  await blocked.entered.promise;
  h.removeAccount();
  blocked.resume.resolve();
  await old;
  assert.equal(h.writes.length, 0);
  await assert.rejects(h.execute(), (error) => error.code === 'NOT_FOUND');
});

test('projection repository reads profile and exact revision together without expanding the public account model', async () => {
  const id = randomUUID();
  let parameters;
  const row = {
    id,
    email: 'fixture@example.test',
    timezone: 'UTC',
    receipt_projection_revision: '9007199254740993',
  };
  const repository = new UserRepository({
    query: async (sql, params) => {
      assert.match(sql, /receipt_projection_revision::text/);
      parameters = params;
      return { rows: [row] };
    },
  });
  assert.deepEqual(await repository.findProjectionProfileById(id), {
    id,
    email: row.email,
    timezone: 'UTC',
    receiptProjectionRevision: '9007199254740993',
  });
  assert.deepEqual(parameters, [id]);
  for (const value of [undefined, null, -1, 42, '01', '-1', '12:other', '9223372036854775808']) {
    row.receipt_projection_revision = value;
    await assert.rejects(repository.findProjectionProfileById(id));
  }
  assert.equal(
    await new UserRepository({ query: async () => ({ rows: [] }) }).findProjectionProfileById(id),
    undefined,
  );
});
