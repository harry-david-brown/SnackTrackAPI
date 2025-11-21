/**
 * Database Optimization Migrations
 * 
 * This file contains database optimizations that can be safely applied
 * without breaking existing API/frontend functionality.
 * 
 * Optimizations:
 * 1. Additional indexes for better query performance
 * 2. GIN index on JSONB items column for item searches
 * 3. Partial indexes for common query patterns
 * 4. Table statistics and maintenance
 * 5. Optional: Year column for easier partitioning/archiving
 */

import { Pool } from 'pg';

export class DatabaseOptimizations {
  constructor(private pool: Pool) {}

  /**
   * Apply all safe optimizations
   * These are additive - they won't break existing functionality
   */
  async applyOptimizations(): Promise<void> {
    console.log('🔧 Applying database optimizations...');

    try {
      // 1. Add GIN index on JSONB items column for item searches
      await this.addItemsGinIndex();

      // 2. Add partial indexes for common query patterns
      await this.addPartialIndexes();

      // 3. Add year column for easier partitioning/archiving (optional)
      await this.addYearColumn();

      // 4. Add covering index for analytics queries
      await this.addAnalyticsCoveringIndex();

      // 5. Update table statistics
      await this.updateStatistics();

      console.log('✅ Database optimizations applied successfully');
    } catch (error) {
      console.error('❌ Error applying optimizations:', error);
      throw error;
    }
  }

  /**
   * Add GIN index on items JSONB column
   * This enables fast searches within the items array
   * Example: Find all receipts containing "coffee" in items
   */
  private async addItemsGinIndex(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_items_gin 
        ON receipts USING GIN (items)
      `);
      console.log('✅ GIN index on items column created');
    } catch (error: any) {
      if (error.code !== '42P07') { // Index already exists
        throw error;
      }
    }
  }

  /**
   * Add partial indexes for common query patterns
   * These are smaller and faster than full indexes
   */
  private async addPartialIndexes(): Promise<void> {
    try {
      // Index for receipts with order_date (most queries filter by date)
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_has_date 
        ON receipts(user_id, order_date DESC) 
        WHERE order_date IS NOT NULL
      `);

      // Index for recent receipts (last 2 years) - most common query
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_recent 
        ON receipts(user_id, order_date DESC) 
        WHERE order_date >= NOW() - INTERVAL '2 years'
      `);

      // Index for receipts with restaurant names (for analytics)
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_has_restaurant 
        ON receipts(user_id, restaurant_name) 
        WHERE restaurant_name IS NOT NULL
      `);

      console.log('✅ Partial indexes created');
    } catch (error: any) {
      if (error.code !== '42P07') {
        throw error;
      }
    }
  }

  /**
   * Add year column for easier partitioning/archiving
   * This is a computed column that extracts year from order_date
   */
  private async addYearColumn(): Promise<void> {
    try {
      // Add year column if it doesn't exist
      await this.pool.query(`
        ALTER TABLE receipts 
        ADD COLUMN IF NOT EXISTS year INTEGER
      `);

      // Create index on year
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_year 
        ON receipts(year, user_id)
      `);

      // Populate year column for existing rows
      await this.pool.query(`
        UPDATE receipts 
        SET year = EXTRACT(YEAR FROM order_date)::INTEGER 
        WHERE year IS NULL AND order_date IS NOT NULL
      `);

      // Create trigger to auto-populate year on insert/update
      await this.pool.query(`
        CREATE OR REPLACE FUNCTION update_receipt_year()
        RETURNS TRIGGER AS $$
        BEGIN
          IF NEW.order_date IS NOT NULL THEN
            NEW.year := EXTRACT(YEAR FROM NEW.order_date)::INTEGER;
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
      `);

      await this.pool.query(`
        DROP TRIGGER IF EXISTS trigger_update_receipt_year ON receipts;
        CREATE TRIGGER trigger_update_receipt_year
        BEFORE INSERT OR UPDATE OF order_date ON receipts
        FOR EACH ROW
        EXECUTE FUNCTION update_receipt_year();
      `);

      console.log('✅ Year column and trigger created');
    } catch (error: any) {
      // Year column might already exist, that's fine
      if (error.code !== '42701' && error.code !== '42P07') {
        console.warn('⚠️  Year column migration skipped:', error.message);
      }
    }
  }

  /**
   * Add covering index for analytics queries
   * This index includes all columns needed for analytics, avoiding table lookups
   */
  private async addAnalyticsCoveringIndex(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_analytics_covering 
        ON receipts(user_id, order_date DESC) 
        INCLUDE (restaurant_name, amount_spent, items, receipt_type, data_source)
        WHERE order_date IS NOT NULL
      `);
      console.log('✅ Analytics covering index created');
    } catch (error: any) {
      if (error.code !== '42P07') {
        // PostgreSQL < 11 doesn't support INCLUDE, that's okay
        console.log('ℹ️  Covering index skipped (PostgreSQL < 11 or index exists)');
      }
    }
  }

  /**
   * Update table statistics for better query planning
   */
  private async updateStatistics(): Promise<void> {
    try {
      await this.pool.query('ANALYZE receipts');
      await this.pool.query('ANALYZE users');
      console.log('✅ Table statistics updated');
    } catch (error) {
      console.warn('⚠️  Statistics update failed:', error);
    }
  }

  /**
   * Get database size information
   */
  async getDatabaseSize(): Promise<any> {
    const result = await this.pool.query(`
      SELECT 
        schemaname,
        tablename,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) as total_size,
        pg_size_pretty(pg_relation_size(schemaname||'.'||tablename)) as table_size,
        pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename) - pg_relation_size(schemaname||'.'||tablename)) as indexes_size,
        pg_stat_get_live_tuples(c.oid) as row_count
      FROM pg_tables t
      JOIN pg_class c ON c.relname = t.tablename
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(schemaname||'.'||tablename) DESC
    `);
    return result.rows;
  }

  /**
   * Get index usage statistics
   */
  async getIndexUsage(): Promise<any> {
    const result = await this.pool.query(`
      SELECT 
        schemaname,
        tablename,
        indexname,
        idx_scan as index_scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched
      FROM pg_stat_user_indexes
      WHERE schemaname = 'public'
      ORDER BY idx_scan DESC
    `);
    return result.rows;
  }
}

