import type {
  InvestmentContext,
  InvestmentBenchmark,
  MarketPoint,
  MarketSnapshot,
} from '../analytics/shared/historicalInvestment';
export interface MarketHistoryRepositoryPort {
  latest(): Promise<MarketSnapshot | null>;
  find(id: string): Promise<MarketSnapshot | null>;
  publish(snapshot: MarketSnapshot): Promise<boolean>;
}
export interface MarketHistoryProviderPort {
  history(benchmark: InvestmentBenchmark, start: string, end: string): Promise<MarketPoint[]>;
}
export interface InvestmentContextPort {
  context(now: Date, snapshotId?: string): Promise<InvestmentContext>;
}
