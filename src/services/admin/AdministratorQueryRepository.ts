import { DatabaseError } from '../../core/errors';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';

interface AdministratorUserRow extends DatabaseRow {
  id: unknown;
  email: unknown;
  email_verified: unknown;
  timezone: unknown;
  created_at: unknown;
  receipt_count: unknown;
  total_spent: unknown;
  last_receipt_date: unknown;
  total_users: unknown;
}

interface DatabaseAggregateRow extends DatabaseRow {
  total_users: unknown;
  total_receipts: unknown;
  users_with_receipts: unknown;
  total_amount: unknown;
  average_amount: unknown;
}

interface TableSizeRow extends DatabaseRow {
  tablename: unknown;
  size: unknown;
}

interface RecentActivityRow extends DatabaseRow {
  table_name: unknown;
  recent_count: unknown;
}

export interface AdministratorUserSummary {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly timezone: string;
  readonly createdAt: string;
  readonly receiptCount: number;
  readonly totalSpent: number;
  readonly lastReceiptDate: string | null;
}

export interface AdministratorUserPage {
  readonly users: readonly AdministratorUserSummary[];
  readonly total: number;
}

export interface DatabaseStatistics {
  readonly database: {
    readonly totalUsers: number;
    readonly totalReceipts: number;
    readonly usersWithReceipts: number;
    readonly totalAmountAllUsers: number;
    readonly averageReceiptAmount: number;
  };
  readonly tableSizes: ReadonlyArray<{
    readonly table: string;
    readonly size: string;
  }>;
  readonly recentActivity: ReadonlyArray<{
    readonly table: 'users' | 'receipts';
    readonly recentCount: number;
  }>;
}

const requiredString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DatabaseError(`Invalid administrator query field: ${field}`);
  }
  return value;
};

const nonNegativeInteger = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DatabaseError(`Invalid administrator query field: ${field}`);
  }
  return parsed;
};

const nonNegativeNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new DatabaseError(`Invalid administrator query field: ${field}`);
  }
  return parsed;
};

const booleanValue = (value: unknown, field: string): boolean => {
  if (typeof value !== 'boolean') {
    throw new DatabaseError(`Invalid administrator query field: ${field}`);
  }
  return value;
};

const isoDate = (value: unknown, field: string): string => {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  if (!parsed || Number.isNaN(parsed.getTime())) {
    throw new DatabaseError(`Invalid administrator query date: ${field}`);
  }
  return parsed.toISOString();
};

const optionalIsoDate = (value: unknown, field: string): string | null =>
  value === null || value === undefined ? null : isoDate(value, field);

const activityTable = (value: unknown): 'users' | 'receipts' => {
  if (value === 'users' || value === 'receipts') return value;
  throw new DatabaseError('Invalid administrator query field: table_name');
};

/** Typed PostgreSQL adapter for administrator-facing read models. */
export class AdministratorQueryRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async listUsers(limit: number, offset: number): Promise<AdministratorUserPage> {
    const result = await this.postgres.query<AdministratorUserRow>(
      `SELECT
         u.id,
         u.email,
         u.email_verified,
         u.timezone,
         u.created_at,
         COUNT(r.id)::int AS receipt_count,
         COALESCE(SUM(r.amount_spent), 0) AS total_spent,
         MAX(r.order_date) AS last_receipt_date,
         COUNT(*) OVER()::int AS total_users
       FROM users u
       LEFT JOIN receipts r ON r.user_id = u.id
       GROUP BY u.id, u.email, u.email_verified, u.timezone, u.created_at
       ORDER BY u.created_at DESC, u.id
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const users = result.rows.map((row) => ({
      id: requiredString(row.id, 'id'),
      email: requiredString(row.email, 'email'),
      emailVerified: booleanValue(row.email_verified, 'email_verified'),
      timezone:
        row.timezone === null || row.timezone === undefined
          ? 'America/New_York'
          : requiredString(row.timezone, 'timezone'),
      createdAt: isoDate(row.created_at, 'created_at'),
      receiptCount: nonNegativeInteger(row.receipt_count, 'receipt_count'),
      totalSpent: nonNegativeNumber(row.total_spent, 'total_spent'),
      lastReceiptDate: optionalIsoDate(row.last_receipt_date, 'last_receipt_date'),
    }));

    const total =
      result.rows.length === 0
        ? await this.countUsers()
        : nonNegativeInteger(result.rows[0].total_users, 'total_users');
    return { users, total };
  }

  async getDatabaseStatistics(): Promise<DatabaseStatistics> {
    const [aggregateResult, tableSizesResult, recentActivityResult] = await Promise.all([
      this.postgres.query<DatabaseAggregateRow>(`
        SELECT
          (SELECT COUNT(*) FROM users)::int AS total_users,
          COUNT(*)::int AS total_receipts,
          COUNT(DISTINCT user_id)::int AS users_with_receipts,
          COALESCE(SUM(amount_spent), 0) AS total_amount,
          COALESCE(AVG(amount_spent), 0) AS average_amount
        FROM receipts
      `),
      this.postgres.query<TableSizeRow>(`
        SELECT
          tablename,
          pg_size_pretty(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass)) AS size
        FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass) DESC
      `),
      this.postgres.query<RecentActivityRow>(`
        SELECT 'users' AS table_name, COUNT(*)::int AS recent_count
        FROM users
        WHERE created_at > NOW() - INTERVAL '24 hours'
        UNION ALL
        SELECT 'receipts' AS table_name, COUNT(*)::int AS recent_count
        FROM receipts
        WHERE created_at > NOW() - INTERVAL '24 hours'
      `),
    ]);
    const aggregate = aggregateResult.rows[0];
    if (!aggregate)
      throw new DatabaseError('Administrator statistics query returned no aggregate row');

    return {
      database: {
        totalUsers: nonNegativeInteger(aggregate.total_users, 'total_users'),
        totalReceipts: nonNegativeInteger(aggregate.total_receipts, 'total_receipts'),
        usersWithReceipts: nonNegativeInteger(aggregate.users_with_receipts, 'users_with_receipts'),
        totalAmountAllUsers: nonNegativeNumber(aggregate.total_amount, 'total_amount'),
        averageReceiptAmount: nonNegativeNumber(aggregate.average_amount, 'average_amount'),
      },
      tableSizes: tableSizesResult.rows.map((row) => ({
        table: requiredString(row.tablename, 'tablename'),
        size: requiredString(row.size, 'size'),
      })),
      recentActivity: recentActivityResult.rows.map((row) => ({
        table: activityTable(row.table_name),
        recentCount: nonNegativeInteger(row.recent_count, 'recent_count'),
      })),
    };
  }

  private async countUsers(): Promise<number> {
    const result = await this.postgres.query<{ count: unknown } & DatabaseRow>(
      'SELECT COUNT(*)::int AS count FROM users',
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('Administrator user count query returned no row');
    return nonNegativeInteger(row.count, 'count');
  }
}
