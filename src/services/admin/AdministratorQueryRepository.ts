import { DatabaseError } from '../../core/errors';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import { adminReceiptReportSql } from './AdminReceiptReportSql';
import {
  adminReceiptScalarCost,
  decodeAdminReceiptSources,
  decodeAdminReceiptSummary,
  type AdminReceiptReport,
  type AdminReceiptSummary,
} from './AdminReceiptSummary';
import type { AdminReceiptReadPort } from '../ports/AdminReceiptPorts';

interface AdministratorUserRow extends DatabaseRow {
  id: unknown;
  email: unknown;
  email_verified: unknown;
  timezone: unknown;
  created_at: unknown;
  receipt_summary: unknown;
  last_receipt_date: unknown;
  total_users: unknown;
}

interface DatabaseAggregateRow extends DatabaseRow {
  total_users: unknown;
  total_receipts: unknown;
  users_with_receipts: unknown;
  receipt_summary: unknown;
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
  /** Deprecated scalar: null when currencies or incomplete evidence prevent a single total. */
  readonly totalSpent: number | null;
  readonly currencyCode: string | null;
  readonly receiptSummary: AdminReceiptSummary;
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
    readonly totalAmountAllUsers: number | null;
    /** Deprecated name; average net cost per established attempt, not per source document. */
    readonly averageReceiptAmount: number | null;
    readonly currencyCode: string | null;
    readonly receiptSummary: AdminReceiptSummary;
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
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
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
export class AdministratorQueryRepository implements AdminReceiptReadPort {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async getReceiptReport(userId: string): Promise<AdminReceiptReport> {
    const result = await this.postgres.query(adminReceiptReportSql('$1::uuid'), [userId]);
    const row = result.rows[0];
    if (!row) throw new DatabaseError('Administrator receipt query returned no aggregate row');
    return {
      summary: decodeAdminReceiptSummary(row.receipt_summary),
      sources: decodeAdminReceiptSources(row.receipt_sources),
    };
  }

  async listUsers(limit: number, offset: number): Promise<AdministratorUserPage> {
    const result = await this.postgres.query<AdministratorUserRow>(
      `WITH page AS (
         SELECT id,email,email_verified,timezone,created_at FROM users
         ORDER BY created_at DESC,id LIMIT $1 OFFSET $2
       ), totals AS (SELECT COUNT(*)::int AS total_users FROM users)
       SELECT page.*, totals.total_users, report.receipt_summary,
         (SELECT MAX(r.order_date) FROM receipts r WHERE r.user_id=page.id) AS last_receipt_date
       FROM totals LEFT JOIN page ON TRUE
       LEFT JOIN LATERAL (${adminReceiptReportSql('page.id')}) report ON page.id IS NOT NULL
       ORDER BY page.created_at DESC,page.id`,
      [limit, offset],
    );

    const users = result.rows
      .filter((row) => row.id !== null)
      .map((row) => {
        const receiptSummary = decodeAdminReceiptSummary(row.receipt_summary);
        const cost = adminReceiptScalarCost(receiptSummary);
        return {
          id: requiredString(row.id, 'id'),
          email: requiredString(row.email, 'email'),
          emailVerified: booleanValue(row.email_verified, 'email_verified'),
          timezone:
            row.timezone === null || row.timezone === undefined
              ? 'America/New_York'
              : requiredString(row.timezone, 'timezone'),
          createdAt: isoDate(row.created_at, 'created_at'),
          receiptCount: receiptSummary.receiptRecords,
          totalSpent: cost.total,
          currencyCode: cost.currencyCode,
          receiptSummary,
          lastReceiptDate: optionalIsoDate(row.last_receipt_date, 'last_receipt_date'),
        };
      });

    if (!result.rows[0]) throw new DatabaseError('Administrator user query returned no total row');
    const total = nonNegativeInteger(result.rows[0].total_users, 'total_users');
    return { users, total };
  }

  async getDatabaseStatistics(): Promise<DatabaseStatistics> {
    const [aggregateResult, tableSizesResult, recentActivityResult] = await Promise.all([
      this.postgres.query<DatabaseAggregateRow>(`
        SELECT
          (SELECT COUNT(*) FROM users)::int AS total_users,
          (SELECT COUNT(*) FROM receipts)::int AS total_receipts,
          (SELECT COUNT(DISTINCT user_id) FROM receipts)::int AS users_with_receipts,
          report.receipt_summary
        FROM (${adminReceiptReportSql()}) report
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
    const receiptSummary = decodeAdminReceiptSummary(aggregate.receipt_summary);
    const cost = adminReceiptScalarCost(receiptSummary);

    return {
      database: {
        totalUsers: nonNegativeInteger(aggregate.total_users, 'total_users'),
        totalReceipts: nonNegativeInteger(aggregate.total_receipts, 'total_receipts'),
        usersWithReceipts: nonNegativeInteger(aggregate.users_with_receipts, 'users_with_receipts'),
        totalAmountAllUsers: cost.total,
        averageReceiptAmount: cost.average,
        currencyCode: cost.currencyCode,
        receiptSummary,
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
}
