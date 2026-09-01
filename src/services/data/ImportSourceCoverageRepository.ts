import { DatabaseError } from '../../core/errors';
import type { ImportSourceCoverage } from '../import/ImportLifecycleTypes';
import { DatabaseQueryExecutor, DatabaseRow } from '../ports/DatabasePort';

interface CoverageRow extends DatabaseRow {
  email_count: unknown;
  export_count: unknown;
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
      `SELECT
         COUNT(*) FILTER (WHERE data_source = 'email')::int AS email_count,
         COUNT(*) FILTER (WHERE data_source = 'csv')::int AS export_count,
         COUNT(*) FILTER (
           WHERE data_source = 'csv' AND receipt_type = 'uber_eats'
         )::int AS uber_eats_export_count,
         COUNT(*) FILTER (
           WHERE data_source = 'csv' AND receipt_type = 'doordash'
         )::int AS doordash_export_count,
         MIN(order_date) FILTER (
           WHERE data_source = 'csv' AND receipt_type = 'uber_eats'
         ) AS uber_eats_export_earliest,
         MAX(order_date) FILTER (
           WHERE data_source = 'csv' AND receipt_type = 'uber_eats'
         ) AS uber_eats_export_latest,
         MIN(order_date) FILTER (
           WHERE data_source = 'csv' AND receipt_type = 'doordash'
         ) AS doordash_export_earliest,
         MAX(order_date) FILTER (
           WHERE data_source = 'csv' AND receipt_type = 'doordash'
         ) AS doordash_export_latest
       FROM receipts
       WHERE user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DatabaseError('Import source coverage query returned no aggregate row');

    const emailReceiptCount = nonNegativeInteger(row.email_count, 'email_count');
    const exportReceiptCount = nonNegativeInteger(row.export_count, 'export_count');
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
