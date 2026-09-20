import type { DatabaseConnection } from '../ports/DatabasePort';
import type { MarketHistoryRepositoryPort } from '../ports/MarketHistoryPorts';
import type { MarketSnapshot } from '../analytics/shared/historicalInvestment';
import { decodeMarketSnapshot } from '../market/marketSnapshot';
export class MarketHistoryRepository implements MarketHistoryRepositoryPort {
  constructor(private readonly db: DatabaseConnection) {}
  async latest(): Promise<MarketSnapshot | null> {
    const result = await this.db.query(
      'SELECT payload FROM market_history_snapshots ORDER BY valuation_date DESC LIMIT 1',
    );
    return result.rows[0] ? decodeMarketSnapshot(result.rows[0].payload) : null;
  }
  async find(id: string): Promise<MarketSnapshot | null> {
    const result = await this.db.query(
      'SELECT payload FROM market_history_snapshots WHERE id = $1',
      [id],
    );
    return result.rows[0] ? decodeMarketSnapshot(result.rows[0].payload) : null;
  }
  async claim(token: string): Promise<boolean> {
    const result = await this.db.query(
      `INSERT INTO market_history_refresh_lease(id, token, expires_at) VALUES (1,$1,NOW()+INTERVAL '30 minutes')
      ON CONFLICT(id) DO UPDATE SET token=EXCLUDED.token, expires_at=EXCLUDED.expires_at WHERE market_history_refresh_lease.expires_at < NOW() RETURNING id`,
      [token],
    );
    return result.rows.length === 1;
  }
  async release(token: string): Promise<void> {
    await this.db.query('DELETE FROM market_history_refresh_lease WHERE id=1 AND token=$1', [
      token,
    ]);
  }
  async publish(snapshot: MarketSnapshot, token?: string): Promise<boolean> {
    const validated = decodeMarketSnapshot(snapshot);
    return this.db.withTransaction(async (tx) => {
      if (token) {
        const lease = await tx.query(
          'SELECT id FROM market_history_refresh_lease WHERE id=1 AND token=$1 AND expires_at>NOW() FOR UPDATE',
          [token],
        );
        if (!lease.rows.length) throw new Error('Market refresh lease expired');
      }
      const result = await tx.query(
        `INSERT INTO market_history_snapshots(id, valuation_date, retrieved_at, payload) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT(valuation_date) DO NOTHING RETURNING id`,
        [validated.id, validated.valuationDate, validated.retrievedAt, JSON.stringify(validated)],
      );
      return result.rows.length === 1;
    });
  }
}
