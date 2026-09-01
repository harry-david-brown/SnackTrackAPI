import { DatabaseError, NotFoundError } from '../../core/errors';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import { parseQueryPlanRow } from './QueryPlanParser';

interface OptimizationTableRow extends DatabaseRow {
  tablename: unknown;
  total_size: unknown;
  table_size: unknown;
  indexes_size: unknown;
  row_count: unknown;
}

interface ReceiptIndexRow extends DatabaseRow {
  indexname: unknown;
  indexdef: unknown;
  index_scans: unknown;
  tuples_read: unknown;
  tuples_fetched: unknown;
}

interface OptimizationRow extends DatabaseRow {
  indexname: unknown;
  optimization_type: unknown;
}

interface YearColumnRow extends DatabaseRow {
  column_name: unknown;
  data_type: unknown;
}

interface IndexUsageRow extends DatabaseRow {
  indexname: unknown;
  index_scans: unknown;
  tuples_read: unknown;
  index_size: unknown;
}

interface UserIdRow extends DatabaseRow {
  user_id?: unknown;
  id?: unknown;
}

export interface DatabaseOptimizationStatus {
  readonly tables: ReadonlyArray<{
    readonly name: string;
    readonly totalSize: string;
    readonly tableSize: string;
    readonly indexesSize: string;
    readonly rowCount: number;
  }>;
  readonly receiptsIndexes: ReadonlyArray<{
    readonly name: string;
    readonly definition: string;
    readonly scans: number;
    readonly tuplesRead: number;
    readonly tuplesFetched: number;
  }>;
  readonly optimizations: {
    readonly applied: ReadonlyArray<{
      readonly index: string;
      readonly type: 'GIN index on JSONB items' | 'Year column index';
    }>;
    readonly yearColumn: boolean;
    readonly status: {
      readonly ginIndex: boolean;
      readonly yearColumn: boolean;
    };
  };
  readonly indexUsage: ReadonlyArray<{
    readonly name: string;
    readonly scans: number;
    readonly tuplesRead: number;
    readonly size: string;
  }>;
  readonly _note: {
    readonly ginIndex: string;
    readonly yearColumn: string;
  };
}

export interface SuccessfulQueryDiagnostic {
  readonly name: string;
  readonly query: string;
  readonly executionTimeMs: number;
  readonly planExecutionTimeMs: number;
  readonly planningTimeMs: number;
  readonly totalTimeMs: number;
  readonly rowsReturned: number;
  readonly indexUsed?: boolean;
  readonly ginIndexUsed?: boolean;
  readonly nodeType: string | null;
  readonly indexName: string;
  readonly queryPlan: Readonly<Record<string, unknown>>;
}

export interface FailedQueryDiagnostic {
  readonly name: string;
  readonly error: string;
}

export type QueryDiagnostic = SuccessfulQueryDiagnostic | FailedQueryDiagnostic;

export interface QueryPerformanceResult {
  readonly userId: string;
  readonly timestamp: string;
  readonly note: string;
  readonly tests: readonly QueryDiagnostic[];
  readonly summary: {
    readonly totalTests: number;
    readonly testsWithIndexes: number;
    readonly averageExecutionTime: number;
    readonly fastestQuery: string;
    readonly slowestQuery: string;
  };
}

interface DiagnosticDefinition {
  readonly name: string;
  readonly errorName: string;
  readonly publicQuery: string;
  readonly sql: string;
  readonly parameters: (userId: string, now: Date) => readonly unknown[];
  readonly indexKind: 'standard' | 'gin';
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseError(`Invalid monitoring query field: ${field}`);
  }
  return value;
};

const nonNegativeInteger = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DatabaseError(`Invalid monitoring query field: ${field}`);
  }
  return parsed;
};

const optimizationType = (value: unknown): 'GIN index on JSONB items' | 'Year column index' => {
  if (value === 'GIN index on JSONB items' || value === 'Year column index') return value;
  throw new DatabaseError('Invalid monitoring query field: optimization_type');
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : 'Unknown query diagnostic failure';

const successful = (test: QueryDiagnostic): test is SuccessfulQueryDiagnostic =>
  'executionTimeMs' in test;

const DIAGNOSTICS: readonly DiagnosticDefinition[] = [
  {
    name: 'Get all receipts for user (ORDER BY order_date DESC)',
    errorName: 'Get all receipts for user',
    publicQuery: 'SELECT * FROM receipts WHERE user_id = $1 ORDER BY order_date DESC',
    sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM receipts
      WHERE user_id = $1
      ORDER BY order_date DESC`,
    parameters: (userId) => [userId],
    indexKind: 'standard',
  },
  {
    name: 'Sum total spent (aggregation)',
    errorName: 'Sum total spent',
    publicQuery: 'SELECT COALESCE(SUM(amount_spent), 0) FROM receipts WHERE user_id = $1',
    sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT COALESCE(SUM(amount_spent), 0) AS total
      FROM receipts
      WHERE user_id = $1`,
    parameters: (userId) => [userId],
    indexKind: 'standard',
  },
  {
    name: 'Date range query (last 30 days)',
    errorName: 'Date range query',
    publicQuery:
      'SELECT * FROM receipts WHERE user_id = $1 AND order_date BETWEEN $2 AND $3 ORDER BY order_date DESC',
    sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM receipts
      WHERE user_id = $1
        AND order_date BETWEEN $2 AND $3
      ORDER BY order_date DESC`,
    parameters: (userId, now) => {
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - 30);
      return [userId, start, now];
    },
    indexKind: 'standard',
  },
  {
    name: 'JSONB items search (GIN index test)',
    errorName: 'JSONB items search',
    publicQuery:
      'SELECT * FROM receipts WHERE user_id = $1 AND items @> \'[{"name": "test"}]\'::jsonb',
    sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT * FROM receipts
      WHERE user_id = $1
        AND items @> '[{"name": "test"}]'::jsonb
      LIMIT 10`,
    parameters: (userId) => [userId],
    indexKind: 'gin',
  },
];

/** Typed PostgreSQL adapter for operational database diagnostics. */
export class MonitoringQueryRepository {
  constructor(
    private readonly postgres: DatabaseQueryExecutor,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async getDatabaseOptimizationStatus(): Promise<DatabaseOptimizationStatus> {
    const [tableResult, receiptIndexResult, optimizationResult, yearColumnResult, usageResult] =
      await Promise.all([
        this.postgres.query<OptimizationTableRow>(`
          SELECT
            t.tablename,
            pg_size_pretty(pg_total_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass)) AS total_size,
            pg_size_pretty(pg_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass)) AS table_size,
            pg_size_pretty(
              pg_total_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass)
              - pg_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass)
            ) AS indexes_size,
            COALESCE(s.n_live_tup, 0)::bigint AS row_count
          FROM pg_tables t
          LEFT JOIN pg_stat_user_tables s
            ON s.schemaname = t.schemaname AND s.relname = t.tablename
          WHERE t.schemaname = 'public'
          ORDER BY pg_total_relation_size(format('%I.%I', t.schemaname, t.tablename)::regclass) DESC
        `),
        this.postgres.query<ReceiptIndexRow>(`
          SELECT
            i.indexname,
            i.indexdef,
            COALESCE(s.idx_scan, 0)::bigint AS index_scans,
            COALESCE(s.idx_tup_read, 0)::bigint AS tuples_read,
            COALESCE(s.idx_tup_fetch, 0)::bigint AS tuples_fetched
          FROM pg_indexes i
          LEFT JOIN pg_stat_user_indexes s
            ON i.schemaname = s.schemaname AND i.indexname = s.indexrelname::text
          WHERE i.schemaname = 'public' AND i.tablename = 'receipts'
          ORDER BY i.indexname
        `),
        this.postgres.query<OptimizationRow>(`
          SELECT
            indexname,
            CASE
              WHEN indexname LIKE '%items_gin%' THEN 'GIN index on JSONB items'
              WHEN indexname LIKE '%year%' THEN 'Year column index'
            END AS optimization_type
          FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'receipts'
            AND (indexname LIKE '%items_gin%' OR indexname LIKE '%year%')
        `),
        this.postgres.query<YearColumnRow>(`
          SELECT column_name, data_type
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'receipts'
            AND column_name = 'year'
        `),
        this.postgres.query<IndexUsageRow>(`
          SELECT
            indexrelname AS indexname,
            idx_scan::bigint AS index_scans,
            idx_tup_read::bigint AS tuples_read,
            pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
          FROM pg_stat_user_indexes
          WHERE schemaname = 'public' AND relname = 'receipts'
          ORDER BY idx_scan DESC
        `),
      ]);

    const applied = optimizationResult.rows.map((row) => ({
      index: requiredString(row.indexname, 'indexname'),
      type: optimizationType(row.optimization_type),
    }));
    const yearColumns = yearColumnResult.rows.map((row) => ({
      name: requiredString(row.column_name, 'column_name'),
      dataType: requiredString(row.data_type, 'data_type'),
    }));
    const hasYearColumn = yearColumns.some(({ name }) => name === 'year');

    return {
      tables: tableResult.rows.map((row) => ({
        name: requiredString(row.tablename, 'tablename'),
        totalSize: requiredString(row.total_size, 'total_size'),
        tableSize: requiredString(row.table_size, 'table_size'),
        indexesSize: requiredString(row.indexes_size, 'indexes_size'),
        rowCount: nonNegativeInteger(row.row_count, 'row_count'),
      })),
      receiptsIndexes: receiptIndexResult.rows.map((row) => ({
        name: requiredString(row.indexname, 'indexname'),
        definition: requiredString(row.indexdef, 'indexdef'),
        scans: nonNegativeInteger(row.index_scans, 'index_scans'),
        tuplesRead: nonNegativeInteger(row.tuples_read, 'tuples_read'),
        tuplesFetched: nonNegativeInteger(row.tuples_fetched, 'tuples_fetched'),
      })),
      optimizations: {
        applied,
        yearColumn: hasYearColumn,
        status: {
          ginIndex: applied.some(({ index }) => index.includes('items_gin')),
          yearColumn: hasYearColumn,
        },
      },
      indexUsage: usageResult.rows.map((row) => ({
        name: requiredString(row.indexname, 'indexname'),
        scans: nonNegativeInteger(row.index_scans, 'index_scans'),
        tuplesRead: nonNegativeInteger(row.tuples_read, 'tuples_read'),
        size: requiredString(row.index_size, 'index_size'),
      })),
      _note: {
        ginIndex: 'GIN index enables fast searches within JSONB items column',
        yearColumn: 'Year column enables future partitioning and archiving strategies',
      },
    };
  }

  async getQueryPerformance(requestedUserId?: string): Promise<QueryPerformanceResult> {
    const userId = await this.resolveUserId(requestedUserId);
    const diagnosticNow = new Date(this.nowMs());
    const tests: QueryDiagnostic[] = [];
    for (const definition of DIAGNOSTICS) {
      tests.push(await this.runDiagnostic(definition, userId, diagnosticNow));
    }

    const successfulTests = tests.filter(successful);
    const sortedByExecutionTime = [...successfulTests].sort(
      (left, right) => left.executionTimeMs - right.executionTimeMs,
    );
    const totalExecutionTime = successfulTests.reduce((sum, test) => sum + test.executionTimeMs, 0);

    return {
      userId,
      timestamp: diagnosticNow.toISOString(),
      note: 'These queries bypass Redis cache and show raw database performance. If no userId was provided, a user with receipts was automatically selected.',
      tests,
      summary: {
        totalTests: tests.length,
        testsWithIndexes: successfulTests.filter(
          (test) => test.indexUsed === true || test.ginIndexUsed === true,
        ).length,
        averageExecutionTime:
          successfulTests.length > 0 ? totalExecutionTime / successfulTests.length : 0,
        fastestQuery: sortedByExecutionTime[0]?.name ?? 'N/A',
        slowestQuery: sortedByExecutionTime[sortedByExecutionTime.length - 1]?.name ?? 'N/A',
      },
    };
  }

  private async resolveUserId(requestedUserId?: string): Promise<string> {
    let userId = requestedUserId;
    if (!userId) {
      const result = await this.postgres.query<UserIdRow>(`
        SELECT DISTINCT user_id
        FROM receipts
        WHERE user_id IS NOT NULL
        ORDER BY user_id
        LIMIT 1
      `);
      if (result.rows.length === 0) throw new NotFoundError('User with receipts');
      userId = requiredString(result.rows[0].user_id, 'user_id');
    }

    const userResult = await this.postgres.query<UserIdRow>('SELECT id FROM users WHERE id = $1', [
      userId,
    ]);
    if (userResult.rows.length === 0) throw new NotFoundError('User', userId);
    requiredString(userResult.rows[0].id, 'id');
    return userId;
  }

  private async runDiagnostic(
    definition: DiagnosticDefinition,
    userId: string,
    now: Date,
  ): Promise<QueryDiagnostic> {
    try {
      const startedAt = this.nowMs();
      const result = await this.postgres.query(definition.sql, [
        ...definition.parameters(userId, now),
      ]);
      const executionTimeMs = Math.max(0, this.nowMs() - startedAt);
      const plan = parseQueryPlanRow(result.rows[0]);
      const indexResult =
        definition.indexKind === 'gin'
          ? { ginIndexUsed: plan.ginItemsIndexUsed }
          : { indexUsed: plan.indexUsed };

      return {
        name: definition.name,
        query: definition.publicQuery,
        executionTimeMs,
        planExecutionTimeMs: plan.executionTimeMs,
        planningTimeMs: plan.planningTimeMs,
        totalTimeMs: plan.executionTimeMs + plan.planningTimeMs,
        rowsReturned: plan.rowsReturned,
        ...indexResult,
        nodeType: plan.nodeType,
        indexName: plan.indexName ?? 'N/A',
        queryPlan: plan.root,
      };
    } catch (error) {
      return { name: definition.errorName, error: errorMessage(error) };
    }
  }
}
