import { randomUUID } from 'crypto';
import type {
  MarketHistoryProviderPort,
  MarketHistoryRepositoryPort,
} from '../ports/MarketHistoryPorts';
import type { MarketSnapshot } from '../analytics/shared/historicalInvestment';
import { marketSessions } from './marketCalendar';
import { MARKET_HISTORY_START, validateSeries } from './marketSnapshot';
interface RefreshRepository extends Omit<MarketHistoryRepositoryPort, 'publish'> {
  claim(token: string): Promise<boolean>;
  release(token: string): Promise<void>;
  publish(snapshot: MarketSnapshot, token: string): Promise<boolean>;
}
export class RefreshMarketHistoryService {
  constructor(
    private readonly repository: RefreshRepository,
    private readonly provider: MarketHistoryProviderPort,
  ) {}
  async execute(
    now = new Date(),
  ): Promise<{
    status: string;
    valuationDate?: string;
    snapshotId?: string;
    ageDays?: number;
    observations?: number;
  }> {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0))
      .toISOString()
      .slice(0, 10);
    const sessions = marketSessions(`${end.slice(0, 7)}-01`, end),
      valuationDate = sessions[sessions.length - 1];
    const token = randomUUID();
    if (!(await this.repository.claim(token))) return { status: 'already_running' };
    try {
      const current = await this.repository.latest();
      if (current && current.valuationDate >= valuationDate)
        return {
          status: 'current',
          valuationDate: current.valuationDate,
          snapshotId: current.id,
          ageDays: Math.floor((now.getTime() - Date.parse(current.valuationDate)) / 86400000),
          observations: current.series.sp500.length,
        };
      const sp500 = validateSeries(
        await this.provider.history('sp500', MARKET_HISTORY_START, valuationDate),
        valuationDate,
      );
      const nasdaq = validateSeries(
        await this.provider.history('nasdaq', MARKET_HISTORY_START, valuationDate),
        valuationDate,
      );
      const snapshot: MarketSnapshot = {
        id: randomUUID(),
        provider: 'finazon',
        adjustment: 'all',
        retrievedAt: now.toISOString(),
        valuationDate,
        series: { sp500, nasdaq },
      };
      const published = await this.repository.publish(snapshot, token);
      return {
        status: published ? 'published' : 'already_published',
        valuationDate,
        snapshotId: snapshot.id,
        ageDays: Math.floor((now.getTime() - Date.parse(valuationDate)) / 86400000),
        observations: sp500.length,
      };
    } finally {
      await this.repository.release(token);
    }
  }
}
