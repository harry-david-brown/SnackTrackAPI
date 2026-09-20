import type {
  RecapExchangeRatesPort,
  RecapRateSnapshot,
  RecapCurrency,
} from '../ports/RecapExchangeRatesPort';

/** Public rates only: no user, receipt, or account information leaves this adapter. */
export class FrankfurterRecapRates implements RecapExchangeRatesPort {
  private last?: RecapRateSnapshot;
  private refreshAt = 0;
  private pending?: Promise<RecapRateSnapshot>;
  constructor(
    private readonly fetchRates: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    private readonly warn: (message: string) => void = () => undefined,
  ) {}
  snapshot(): Promise<RecapRateSnapshot> {
    if (this.now() < this.refreshAt && this.last) return Promise.resolve(this.last);
    if (this.pending) return this.pending;
    this.pending = this.refresh().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async refresh(): Promise<RecapRateSnapshot> {
    try {
      const response = await this.fetchRates(
        'https://api.frankfurter.dev/v1/latest?base=EUR&symbols=CAD,USD,GBP',
        { signal: AbortSignal.timeout(4000) },
      );
      if (!response.ok) throw new Error('Rate request failed');
      const raw: unknown = await response.json();
      if (
        !raw ||
        typeof raw !== 'object' ||
        !('date' in raw) ||
        typeof raw.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) ||
        !('rates' in raw) ||
        !raw.rates ||
        typeof raw.rates !== 'object'
      )
        throw new Error('Invalid rates');
      const date = new Date(`${raw.date}T12:00:00Z`);
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== raw.date)
        throw new Error('Invalid rate date');
      const rates: RecapRateSnapshot['rates'] = { EUR: 1 };
      for (const code of ['CAD', 'USD', 'GBP'] as RecapCurrency[]) {
        const value = (raw.rates as Record<string, unknown>)[code];
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
          throw new Error('Invalid rate');
        rates[code] = value;
      }
      this.last = {
        id: `${raw.date}:${rates.CAD}:${rates.USD}:${rates.GBP}`,
        date: raw.date,
        rates,
      };
      this.refreshAt = this.now() + 86_400_000;
    } catch {
      this.warn('Recap exchange rates unavailable; using last successful snapshot');
      this.refreshAt = this.now() + 60_000;
      this.last ??= { id: 'unavailable', date: '', rates: { EUR: 1 } };
    }
    return this.last;
  }
}
