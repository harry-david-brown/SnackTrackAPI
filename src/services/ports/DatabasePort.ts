export type DatabaseRow = Record<string, unknown>;

export interface DatabaseQueryResult<Row extends DatabaseRow = DatabaseRow> {
  readonly rows: Row[];
  readonly rowCount: number | null;
}

/** Persistence port with no dependency on a PostgreSQL driver type. */
export interface DatabaseQueryExecutor {
  query<Row extends DatabaseRow = DatabaseRow>(
    text: string,
    params?: unknown[],
  ): Promise<DatabaseQueryResult<Row>>;
}

export interface DatabaseTransactionRunner {
  withTransaction<Result>(
    operation: (transaction: DatabaseQueryExecutor) => Promise<Result>,
  ): Promise<Result>;
}

export interface DatabaseConnection extends DatabaseQueryExecutor, DatabaseTransactionRunner {
  close(): Promise<void>;
}

export interface DatabasePoolStatistics {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

export interface DatabasePoolInspector {
  getPoolStats(): DatabasePoolStatistics;
}
