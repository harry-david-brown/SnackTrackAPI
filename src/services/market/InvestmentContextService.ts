import {
  investmentContext,
  type InvestmentContext,
} from '../analytics/shared/historicalInvestment';
import type {
  InvestmentContextPort,
  MarketHistoryRepositoryPort,
} from '../ports/MarketHistoryPorts';
export class InvestmentContextService implements InvestmentContextPort {
  constructor(
    private readonly enabled: boolean,
    private readonly repository: MarketHistoryRepositoryPort,
    private readonly warn: (message: string) => void,
  ) {}
  async context(now: Date, snapshotId?: string): Promise<InvestmentContext> {
    if (!this.enabled) return investmentContext('fixed', null, now);
    try {
      return investmentContext(
        'historical',
        snapshotId ? await this.repository.find(snapshotId) : await this.repository.latest(),
        now,
      );
    } catch {
      this.warn('Historical investment data unavailable');
      return investmentContext('historical', null, now);
    }
  }
}
