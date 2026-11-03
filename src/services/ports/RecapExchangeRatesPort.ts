export type RecapCurrency = 'CAD' | 'USD' | 'EUR' | 'GBP';
export type DisplayCurrency = RecapCurrency | 'MXN' | 'AUD' | 'NZD' | 'JPY';
export interface RecapRateSnapshot {
  id: string;
  date: string;
  /** Units per EUR. */
  rates: Partial<Record<DisplayCurrency, number>>;
}
export interface RecapExchangeRatesPort {
  snapshot(): Promise<RecapRateSnapshot>;
}
