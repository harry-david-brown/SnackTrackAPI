const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateHistoricalInvestment,
  investmentContext,
} = require('../dist/services/analytics/shared/historicalInvestment');
const { isMarketSession, marketSessions } = require('../dist/services/market/marketCalendar');
const { validateSeries, MARKET_HISTORY_START } = require('../dist/services/market/marketSnapshot');
const { FinazonMarketHistory } = require('../dist/services/market/FinazonMarketHistory');
const {
  RefreshMarketHistoryService,
} = require('../dist/services/market/RefreshMarketHistoryService');
const { InvestmentContextService } = require('../dist/services/market/InvestmentContextService');
const { MarketHistoryRepository } = require('../dist/services/data/MarketHistoryRepository');
const id = '12345678-1234-1234-1234-123456789abc';
function snapshot(values = [100, 110, 120]) {
  const dates = ['2026-07-02', '2026-07-06', '2026-07-31'];
  return {
    id,
    provider: 'finazon',
    adjustment: 'all',
    retrievedAt: '2026-08-01T08:00:00Z',
    valuationDate: dates[2],
    series: {
      sp500: dates.map((date, i) => ({ date, close: values[i] })),
      nasdaq: dates.map((date, i) => ({ date, close: values[i] })),
    },
  };
}
const context = (s = snapshot()) =>
  investmentContext('historical', s, new Date('2026-08-01T08:00:00Z'));

test('contributions buy independently, holiday orders use next session, and cutoff excludes later orders', () => {
  const result = calculateHistoricalInvestment(
    [
      { date: '2026-07-02', amount: 100 },
      { date: '2026-07-04', amount: 110 },
      { date: '2026-08-01', amount: 500 },
      { date: '2026-07-02', amount: -20 },
    ],
    'CAD',
    context(),
  );
  assert.equal(result.contributed, 210);
  assert.equal(result.contributionCount, 2);
  assert.equal(result.outcomes.sp500.value, 240);
  assert.equal(result.outcomes.sp500.gain, 30);
  assert.equal(result.selectedBenchmark, 'sp500');
});
test('winner is a complete portfolio, not a mix of winning contribution returns', () => {
  const s = snapshot();
  s.series.nasdaq = [
    { date: '2026-07-02', close: 90 },
    { date: '2026-07-06', close: 150 },
    { date: '2026-07-31', close: 140 },
  ];
  const result = calculateHistoricalInvestment(
    [
      { date: '2026-07-02', amount: 90 },
      { date: '2026-07-06', amount: 150 },
    ],
    'USD',
    context(s),
  );
  assert.equal(result.selectedBenchmark, 'nasdaq');
  assert.equal(result.outcomes.nasdaq.value, 280);
  assert.equal(result.outcomes.sp500.value, 271.64);
});
test('no gain, missing coverage, invalid dates, and unknown currency omit rather than simulate 7%', () => {
  const contributions = [{ date: '2026-07-02', amount: 100 }];
  assert.equal(
    calculateHistoricalInvestment(contributions, 'CAD', context(snapshot([100, 90, 80]))),
    undefined,
  );
  assert.equal(
    calculateHistoricalInvestment(contributions, 'CAD', context(snapshot([100, 100, 100]))),
    undefined,
  );
  assert.equal(
    calculateHistoricalInvestment([{ date: '2020-01-01', amount: 100 }], 'CAD', context()),
    undefined,
  );
  assert.equal(
    calculateHistoricalInvestment([{ date: 'bad', amount: 100 }], 'CAD', context()),
    undefined,
  );
  assert.equal(calculateHistoricalInvestment(contributions, 'UNKNOWN', context()), undefined);
});
test('freshness expires at 62 days; fixed mode is distinct from unavailable historical mode', async () => {
  assert.equal(
    investmentContext('historical', snapshot(), new Date('2026-10-02')).freshness,
    'stale',
  );
  assert.equal(investmentContext('historical', null, new Date()).mode, 'historical');
  const unavailable = new InvestmentContextService(
    true,
    {
      latest: async () => {
        throw new Error('offline');
      },
    },
    () => {},
  );
  assert.equal((await unavailable.context(new Date())).freshness, 'unavailable');
  const fixed = new InvestmentContextService(
    false,
    {
      latest: async () => {
        throw new Error('must not read');
      },
    },
    () => {},
  );
  assert.equal((await fixed.context(new Date())).mode, 'fixed');
});
test('known exchange closures and missing session validation', () => {
  for (const date of [
    '2026-07-03',
    '2026-04-03',
    '2012-10-29',
    '2001-09-12',
    '2025-01-09',
    '2026-06-19',
  ])
    assert.equal(isMarketSession(date), false, date);
  assert.equal(isMarketSession('2021-12-31'), true);
  const points = marketSessions(MARKET_HISTORY_START, '1999-03-31').map((date) => ({
    date,
    close: 100,
  }));
  assert.deepEqual(validateSeries(points, '1999-03-31'), points);
  assert.throws(
    () =>
      validateSeries(
        points.filter((_, i) => i !== 3),
        '1999-03-31',
      ),
    /Incomplete/,
  );
});
test('Finazon paginates and requests adjusted regular-session data', async () => {
  const calls = [];
  const rows = Array.from({ length: 1000 }, (_, i) => ({
    t: Date.parse('2020-01-01') / 1000 + i * 86400,
    c: 100 + i,
  }));
  const provider = new FinazonMarketHistory('test-key', async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ data: calls.length === 1 ? rows : [] }));
  });
  const result = await provider.history('nasdaq', '2020-01-01', '2023-01-01');
  assert.equal(result.length, 1000);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.searchParams.get('adjust'), 'all');
  assert.equal(calls[0].url.searchParams.get('prepost'), 'false');
  assert.equal(calls[1].url.searchParams.get('page'), '1');
});
test('Finazon respects retry-after and rejects malformed data without leaking provider bodies', async () => {
  let calls = 0;
  const sleeps = [];
  const provider = new FinazonMarketHistory(
    'secret',
    async () =>
      ++calls === 1
        ? new Response('', { status: 429, headers: { 'Retry-After': '2' } })
        : new Response(JSON.stringify({ data: [{ t: Date.parse('2026-07-01') / 1000, c: 100 }] })),
    async (ms) => sleeps.push(ms),
  );
  await provider.history('sp500', '2026-07-01', '2026-07-31');
  assert.deepEqual(sleeps, [2000]);
  const bad = new FinazonMarketHistory(
    'secret',
    async () => new Response(JSON.stringify({ data: [{ t: 1, c: 0 }] })),
  );
  await assert.rejects(
    bad.history('sp500', '2026-07-01', '2026-07-31'),
    /Invalid market provider observation/,
  );
  const rejected = new FinazonMarketHistory(
    'secret',
    async () => new Response('SPY QQQ secret', { status: 403 }),
  );
  await assert.rejects(
    rejected.history('sp500', '2026-07-01', '2026-07-31'),
    (e) => !/SPY|QQQ|secret/.test(e.message),
  );
});
test('refresh publishes both complete histories and skips current snapshots', async () => {
  let current = null,
    reads = 0,
    released = 0;
  const repository = {
    claim: async () => true,
    release: async () => {
      released++;
    },
    latest: async () => current,
    publish: async (s) => {
      current = s;
      return true;
    },
  };
  const provider = {
    history: async (_, start, end) => {
      reads++;
      return marketSessions(start, end).map((date) => ({ date, close: 100 }));
    },
  };
  const service = new RefreshMarketHistoryService(repository, provider);
  assert.equal((await service.execute(new Date('2026-08-02'))).status, 'published');
  assert.equal(current.valuationDate, '2026-07-31');
  assert.equal((await service.execute(new Date('2026-08-03'))).status, 'current');
  assert.equal(reads, 2);
  assert.equal(released, 2);
});
test('partial failures preserve the prior snapshot and release the lease', async () => {
  let published = false,
    released = false,
    calls = 0;
  const repository = {
    claim: async () => true,
    release: async () => {
      released = true;
    },
    latest: async () => null,
    publish: async () => {
      published = true;
    },
  };
  const service = new RefreshMarketHistoryService(repository, {
    history: async (_, start, end) => {
      if (++calls === 2) throw new Error('offline');
      return marketSessions(start, end).map((date) => ({ date, close: 100 }));
    },
  });
  await assert.rejects(service.execute(new Date('2026-08-02')), /offline/);
  assert.equal(published, false);
  assert.equal(released, true);
  const busy = new RefreshMarketHistoryService(
    { ...repository, claim: async () => false },
    {
      history: async () => {
        throw new Error('must not fetch');
      },
    },
  );
  assert.equal((await busy.execute()).status, 'already_running');
});
test('expired refresh lease cannot publish, including after a successor acquires it', async () => {
  let inserted = false;
  const db = {
    withTransaction: async (fn) =>
      fn({
        query: async (sql) => {
          if (sql.startsWith('INSERT')) inserted = true;
          return { rows: [], rowCount: 0 };
        },
      }),
  };
  const repository = new MarketHistoryRepository(db);
  const s = snapshot();
  s.series = Object.fromEntries(
    ['sp500', 'nasdaq'].map((b) => [
      b,
      marketSessions(MARKET_HISTORY_START, s.valuationDate).map((date) => ({ date, close: 100 })),
    ]),
  );
  await assert.rejects(repository.publish(s, 'expired-token'), /lease expired/);
  assert.equal(inserted, false);
});
