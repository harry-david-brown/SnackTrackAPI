import {
  DatabasePoolInspector,
  DatabasePoolStatistics,
  DatabaseQueryExecutor,
} from '../ports/DatabasePort';

export type DatabaseReadiness =
  | {
      readonly status: 'connected';
      readonly healthy: true;
      readonly latencyMs: number;
      readonly pool: DatabasePoolStatistics;
    }
  | {
      readonly status: 'slow';
      readonly healthy: false;
      readonly latencyMs: number;
      readonly pool: DatabasePoolStatistics;
    }
  | {
      readonly status: 'down';
      readonly healthy: false;
      readonly latencyMs: null;
      readonly pool: DatabasePoolStatistics;
      readonly errorCode: 'DATABASE_UNAVAILABLE';
    };

/** Owns database readiness policy and operational pool details. */
export class DatabaseHealthService {
  constructor(
    private readonly database: DatabaseQueryExecutor & DatabasePoolInspector,
    private readonly slowThresholdMs = 1000,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async check(): Promise<DatabaseReadiness> {
    const startedAt = this.nowMs();
    try {
      await this.database.query('SELECT 1');
      const latencyMs = Math.max(0, this.nowMs() - startedAt);
      const healthy = latencyMs < this.slowThresholdMs;
      const pool = this.database.getPoolStats();
      return healthy
        ? { status: 'connected', healthy: true, latencyMs, pool }
        : { status: 'slow', healthy: false, latencyMs, pool };
    } catch {
      return {
        status: 'down',
        healthy: false,
        latencyMs: null,
        pool: this.database.getPoolStats(),
        errorCode: 'DATABASE_UNAVAILABLE',
      };
    }
  }
}
