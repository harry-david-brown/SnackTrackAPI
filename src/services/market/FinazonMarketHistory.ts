import type { InvestmentBenchmark, MarketPoint } from '../analytics/shared/historicalInvestment';
import type { MarketHistoryProviderPort } from '../ports/MarketHistoryPorts';
const symbols = { sp500: 'SPY', nasdaq: 'QQQ' } as const;
export class FinazonMarketHistory implements MarketHistoryProviderPort {
  constructor(
    private readonly apiKey: string,
    private readonly request: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}
  async history(
    benchmark: InvestmentBenchmark,
    start: string,
    end: string,
  ): Promise<MarketPoint[]> {
    if (!this.apiKey) throw new Error('Market provider credentials are missing');
    const points: MarketPoint[] = [];
    // The live dataset is one-based: page 0 aliases page 1.
    for (let page = 1; page <= 100; page++) {
      const url = new URL('https://api.finazon.io/latest/finazon/us_stocks_essential/time_series');
      url.search = new URLSearchParams({
        ticker: symbols[benchmark],
        interval: '1d',
        adjust: 'all',
        prepost: 'false',
        order: 'asc',
        page: String(page),
        page_size: '1000',
        start_at: String(Date.parse(start) / 1000),
        end_at: String(Date.parse(end) / 1000 + 86399),
      }).toString();
      const value = await this.fetchPage(url);
      if (!value || typeof value !== 'object' || !('data' in value) || !Array.isArray(value.data))
        throw new Error('Invalid market provider response');
      const rows: unknown[] = value.data;
      for (const row of rows) {
        if (
          !row ||
          typeof row !== 'object' ||
          !('t' in row) ||
          typeof row.t !== 'number' ||
          !Number.isFinite(row.t) ||
          !('c' in row) ||
          typeof row.c !== 'number' ||
          !Number.isFinite(row.c) ||
          row.c <= 0
        )
          throw new Error('Invalid market provider observation');
        if ('ticker' in row && row.ticker !== symbols[benchmark])
          throw new Error('Unexpected market series');
        const date = new Date(row.t * 1000).toISOString().slice(0, 10);
        if (date < start || date > end || (points.length && date <= points[points.length - 1].date))
          throw new Error('Unordered market history');
        points.push({ date, close: row.c });
      }
      if (rows.length < 1000) return points;
    }
    throw new Error('Market history pagination limit exceeded');
  }
  private async fetchPage(url: URL): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      let response: Response;
      try {
        response = await this.request(url, {
          headers: { Authorization: `apikey ${this.apiKey}` },
          signal: AbortSignal.timeout(20000),
        });
      } catch {
        if (attempt === 2) throw new Error('Market provider unavailable');
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (response.ok) {
        try {
          return await response.json();
        } catch {
          throw new Error('Invalid market provider response');
        }
      }
      if (response.status !== 429 && response.status < 500)
        throw new Error('Market provider rejected request');
      if (attempt === 2) throw new Error(`Market provider retry limit reached (HTTP ${response.status})`);
      const retry = response.headers.get('Retry-After');
      // Finazon can omit Retry-After on its per-minute quota response.
      // Preserve this page and give the quota a full window to recover.
      if (response.status === 429 && retry === null) {
        await this.sleep(60000);
        continue;
      }
      const seconds =
        retry === null
          ? 0
          : /^\d+$/.test(retry)
            ? Number(retry)
            : Math.max(0, (Date.parse(retry) - Date.now()) / 1000);
      // Do not retry early when the provider asks for a long cooldown; the next scheduled run retries.
      if (!Number.isFinite(seconds) || seconds > 30)
        throw new Error('Market provider cooldown pending');
      await this.sleep(Math.max(seconds * 1000, 1000 * 2 ** attempt));
    }
    throw new Error('Market provider unavailable');
  }
}
