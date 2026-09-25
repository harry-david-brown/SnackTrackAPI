import { Pool, PoolClient, PoolConfig } from 'pg';
import { logger } from '../../config/logger';
import {
  DatabaseConnection,
  DatabasePoolStatistics,
  DatabaseQueryExecutor,
  DatabaseQueryResult,
  DatabaseRow,
} from '../ports/DatabasePort';

export interface PostgresOptions {
  readonly connectionString: string;
  readonly useSsl: boolean;
  readonly sslCa?: string;
  readonly maxConnections: number;
  readonly minimumConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly connectionTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
}

type PoolFactory = (options: PoolConfig) => Pool;

/** URL SSL parameters otherwise override pg's explicit TLS policy. */
export const databaseConnectionUrl = (connectionString: string): string => {
  const parsed = new URL(connectionString);
  for (const key of [...parsed.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('ssl') || key.toLowerCase() === 'uselibpqcompat') {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
};

const urlRequestsTls = (connectionString: string): boolean => {
  const options = new URL(connectionString).searchParams;
  const mode = options.get('sslmode');
  return Boolean((mode && mode !== 'disable') || ['true', '1'].includes(options.get('ssl') ?? ''));
};

/** Owns the PostgreSQL pool and scoped query/transaction execution only. */
export class PostgresService implements DatabaseConnection {
  private readonly pool: Pool;
  private closePromise: Promise<void> | null = null;

  constructor(
    options: PostgresOptions,
    poolFactory: PoolFactory = (poolOptions) => new Pool(poolOptions),
  ) {
    const useSsl = options.useSsl || urlRequestsTls(options.connectionString);
    this.pool = poolFactory({
      connectionString: databaseConnectionUrl(options.connectionString),
      ssl: useSsl ? { rejectUnauthorized: true, ...(options.sslCa ? { ca: options.sslCa } : {}) } : false,
      max: options.maxConnections,
      min: options.minimumConnections ?? 2,
      idleTimeoutMillis: options.idleTimeoutMs ?? 30000,
      connectionTimeoutMillis: options.connectionTimeoutMs ?? 30000,
      statement_timeout: options.queryTimeoutMs ?? 30000,
      query_timeout: options.queryTimeoutMs ?? 30000,
    });
    this.pool.on('error', (error) => {
      logger.error('Unexpected error on idle PostgreSQL client', {
        error: error.message,
        errorCode: 'DATABASE_POOL_ERROR',
      });
    });
    logger.info('PostgreSQL connection pool initialized', {
      maxConnections: options.maxConnections,
      sslEnabled: useSsl,
    });
  }

  async query<Row extends DatabaseRow = DatabaseRow>(
    text: string,
    params?: unknown[],
  ): Promise<DatabaseQueryResult<Row>> {
    const client = await this.pool.connect();
    try {
      return await client.query<Row>(text, params);
    } finally {
      client.release();
    }
  }

  async withTransaction<Result>(
    operation: (transaction: DatabaseQueryExecutor) => Promise<Result>,
  ): Promise<Result> {
    const client = await this.pool.connect();
    const transaction: DatabaseQueryExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        text: string,
        params?: unknown[],
      ): Promise<DatabaseQueryResult<Row>> => client.query<Row>(text, params),
    };
    try {
      await client.query('BEGIN');
      const result = await operation(transaction);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('PostgreSQL transaction rollback failed', {
          error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Infrastructure-only client scope used by the migration runner. */
  async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  getPoolStats(): DatabasePoolStatistics {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = this.pool.end().then(() => {
        logger.info('PostgreSQL connection pool closed');
      });
    }
    await this.closePromise;
  }
}
