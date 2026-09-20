import { DatabaseError } from '../../core/errors';
import type { ImportSourceCoverage } from '../import/ImportLifecycleTypes';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';
import { receiptHasSourceSql, receiptOrderPredicates } from './ReceiptReadPredicates';

interface CoverageRow extends DatabaseRow {
  email_count: unknown;
  export_count: unknown;
  uber_eats_email_count: unknown;
  doordash_email_count: unknown;
  uber_eats_email_earliest: unknown;
  uber_eats_email_latest: unknown;
  doordash_email_earliest: unknown;
  doordash_email_latest: unknown;
  uber_eats_export_count: unknown;
  doordash_export_count: unknown;
  uber_eats_export_earliest: unknown;
  uber_eats_export_latest: unknown;
  doordash_export_earliest: unknown;
  doordash_export_latest: unknown;
}

const nonNegativeInteger = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new DatabaseError(`Invalid import source coverage field: ${field}`);
  }
  return parsed;
};

const optionalIsoDate = (value: unknown, field: string): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) {
    throw new DatabaseError(`Invalid import source coverage date: ${field}`);
  }
  return date.toISOString();
};

/** Typed query adapter for receipt-backed import source truth. */
export class ImportSourceCoverageRepository {
  constructor(private readonly postgres: DatabaseQueryExecutor) {}

  async getForUser(userId: string): Promise<ImportSourceCoverage> {
    const result = await this.postgres.query<CoverageRow>(
      `WITH source_records AS (
         SELECT receipt_type,
           ${receiptHasSourceSql('r', 'email')} AS has_email,
           ${receiptHasSourceSql('r', 'csv')} AS has_export,
           CASE WHEN NOT ${receiptOrderPredicates('r').adjustment} THEN order_date END AS order_date
         FROM receipts r WHERE user_id=$1
       ) SELECT
         COUNT(*) FILTER (WHERE has_email)::int AS email_count,
         COUNT(*) FILTER (WHERE has_export)::int AS export_count,
         COUNT(*) FILTER (
           WHERE has_email AND receipt_type = 'uber_eats'
         )::int AS uber_eats_email_count,
         COUNT(*) FILTER (
           WHERE has_email AND receipt_type = 'doordash'
         )::int AS doordash_email_count,
         MIN(order_date) FILTER (
           WHERE has_email AND receipt_type = 'uber_eats'
         ) AS uber_eats_email_earliest,
         MAX(order_date) FILTER (
           WHERE has_email AND receipt_type = 'uber_eats'
         ) AS uber_eats_email_latest,
         MIN(order_date) FILTER (
           WHERE has_email AND receipt_type = 'doordash'
         ) AS doordash_email_earliest,
         MAX(order_date) FILTER (
           WHERE has_email AND receipt_type = 'doordash'
         ) AS doordash_email_latest,
         COUNT(*) FILTER (
           WHERE has_export AND receipt_type = 'uber_eats'
         )::int AS uber_eats_export_count,
         COUNT(*) FILTER (
           WHERE has_export AND receipt_type = 'doordash'
         )::int AS doordash_export_count,
         MIN(order_date) FILTER (
           WHERE has_export AND receipt_type = 'uber_eats'
         ) AS uber_eats_export_earliest,
         MAX(order_date) FILTER (
           WHERE has_export AND receipt_type = 'uber_eats'
         ) AS uber_eats_export_latest,
         MIN(order_date) FILTER (
           WHERE has_export AND receipt_type = 'doordash'
         ) AS doordash_export_earliest,
         MAX(order_date) FILTER (
           WHERE has_export AND receipt_type = 'doordash'
         ) AS doordash_export_latest
       FROM source_records`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('Import source coverage query returned no aggregate row');

    const emailReceiptCount = nonNegativeInteger(row.email_count, 'email_count');
    const exportReceiptCount = nonNegativeInteger(row.export_count, 'export_count');
    const uberEatsEmailReceiptCount = nonNegativeInteger(row.uber_eats_email_count, 'uber_eats_email_count');
    const doorDashEmailReceiptCount = nonNegativeInteger(row.doordash_email_count, 'doordash_email_count');
    const uberEatsReceiptCount = nonNegativeInteger(
      row.uber_eats_export_count,
      'uber_eats_export_count',
    );
    const doorDashReceiptCount = nonNegativeInteger(
      row.doordash_export_count,
      'doordash_export_count',
    );

    return {
      emailReceiptCount,
      exportReceiptCount,
      hasEmailData: emailReceiptCount > 0,
      hasExportData: exportReceiptCount > 0,
      emailProviders: {
        uberEats: {
          receiptCount: uberEatsEmailReceiptCount,
          hasData: uberEatsEmailReceiptCount > 0,
          earliestOrderDate: optionalIsoDate(row.uber_eats_email_earliest, 'uber_eats_email_earliest'),
          latestOrderDate: optionalIsoDate(row.uber_eats_email_latest, 'uber_eats_email_latest'),
        },
        doorDash: {
          receiptCount: doorDashEmailReceiptCount,
          hasData: doorDashEmailReceiptCount > 0,
          earliestOrderDate: optionalIsoDate(row.doordash_email_earliest, 'doordash_email_earliest'),
          latestOrderDate: optionalIsoDate(row.doordash_email_latest, 'doordash_email_latest'),
        },
      },
      exportProviders: {
        uberEats: {
          receiptCount: uberEatsReceiptCount,
          hasData: uberEatsReceiptCount > 0,
          earliestOrderDate: optionalIsoDate(
            row.uber_eats_export_earliest,
            'uber_eats_export_earliest',
          ),
          latestOrderDate: optionalIsoDate(row.uber_eats_export_latest, 'uber_eats_export_latest'),
        },
        doorDash: {
          receiptCount: doorDashReceiptCount,
          hasData: doorDashReceiptCount > 0,
          earliestOrderDate: optionalIsoDate(
            row.doordash_export_earliest,
            'doordash_export_earliest',
          ),
          latestOrderDate: optionalIsoDate(row.doordash_export_latest, 'doordash_export_latest'),
        },
      },
    };
  }
}
