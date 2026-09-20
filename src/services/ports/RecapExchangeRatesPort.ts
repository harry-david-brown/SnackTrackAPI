export type RecapCurrency = 'CAD' | 'USD' | 'EUR' | 'GBP';
export interface RecapRateSnapshot {
  id: string;
  date: string;
  /** Units per EUR. */
  rates: Partial<Record<RecapCurrency, number>>;
}
export interface RecapExchangeRatesPort {
  snapshot(): Promise<RecapRateSnapshot>;
}
