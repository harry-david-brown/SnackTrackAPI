import { Pool, PoolClient } from 'pg';
import { config } from '../../config/AppConfig';

export class PostgresService {
  private pool: Pool;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';
    
    this.pool = new Pool({
      connectionString: config.getDatabaseConnectionString(),
      ssl: config.shouldUseDatabaseSSL(),
      
      // Connection pool configuration for performance
      max: isProduction ? 20 : 10, // Maximum connections (20 in prod, 10 in dev)
      min: 2, // Minimum connections to keep open
      idleTimeoutMillis: 30000, // Close idle connections after 30s
      connectionTimeoutMillis: 10000, // Timeout if can't connect within 10s
      
      // Query configuration
      statement_timeout: 30000, // Kill queries running longer than 30s
      query_timeout: 30000, // Same as statement_timeout
    });

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
      process.exit(-1); // Exit process on critical pool errors
    });

    // Log pool stats in development
    if (!isProduction) {
      this.pool.on('connect', () => {
        console.log('📊 PostgreSQL client connected to pool');
      });
      
      this.pool.on('remove', () => {
        console.log('📊 PostgreSQL client removed from pool');
      });
    }

    console.log(`✅ PostgreSQL connection pool initialized (max: ${isProduction ? 20 : 10} connections)`);
  }

  async query(text: string, params?: any[]): Promise<any> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(text, params);
      return result;
    } finally {
      client.release();
    }
  }

  /**
   * Get the underlying connection pool
   * Used by services that need direct pool access (e.g., analytics)
   */
  getPool(): Pool {
    return this.pool;
  }

  async getClient(): Promise<PoolClient> {
    return await this.pool.connect();
  }

  async close(): Promise<void> {
    console.log('🔌 Closing database connection pool...');
    await this.pool.end();
    console.log('✅ Database connection pool closed');
  }

  /**
   * Get connection pool statistics for monitoring
   */
  getPoolStats() {
    return {
      totalCount: this.pool.totalCount,
      idleCount: this.pool.idleCount,
      waitingCount: this.pool.waitingCount,
    };
  }

  /**
   * Check if database is healthy
   */
  async healthCheck(): Promise<{ healthy: boolean; latency: number }> {
    const start = Date.now();
    try {
      await this.query('SELECT 1');
      const latency = Date.now() - start;
      return { healthy: true, latency };
    } catch (error) {
      return { healthy: false, latency: -1 };
    }
  }

  // Initialize database tables
  async initializeTables(): Promise<void> {
    try {
      // Create users table
      await this.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create receipts table
      await this.query(`
        CREATE TABLE IF NOT EXISTS receipts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          receipt_type VARCHAR(50) NOT NULL DEFAULT 'unknown',
          data_source VARCHAR(20) NOT NULL DEFAULT 'csv',
          restaurant_name VARCHAR(255),
          order_date TIMESTAMP,
          amount_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
          items JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Create indexes for better performance
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_user_id ON receipts(user_id)
      `);
      
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_created_at ON receipts(created_at)
      `);

      // Migration: Convert items from TEXT[] to JSONB if needed
      try {
        await this.query(`
          ALTER TABLE receipts ALTER COLUMN items TYPE JSONB USING items::JSONB
        `);
      } catch (error) {
        // If conversion fails, items might already be JSONB or empty
        console.log('Items column conversion skipped (already correct type)');
      }

      // Create indexes for new columns (after migrations)
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_order_date ON receipts(order_date)
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_receipt_type ON receipts(receipt_type)
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_data_source ON receipts(data_source)
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_restaurant_name ON receipts(restaurant_name)
      `);

      // Migration: Add password column to users table (for authentication)
      try {
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255)
        `);
        console.log('✅ Password column migration completed');
      } catch (error) {
        console.log('Password column already exists or migration failed');
      }

      // Migration: Add email_verified column to users table
      try {
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE NOT NULL
        `);
        await this.query(`
          CREATE INDEX IF NOT EXISTS idx_users_email_verified ON users(email_verified)
        `);
        console.log('✅ Email verified column migration completed');
      } catch (error) {
        console.log('Email verified column already exists or migration failed');
      }

      // Create verification_codes table
      await this.query(`
        CREATE TABLE IF NOT EXISTS verification_codes (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email VARCHAR(255) NOT NULL,
          code_hash VARCHAR(255) NOT NULL,
          code_type VARCHAR(50) NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          attempts INTEGER DEFAULT 0,
          max_attempts INTEGER DEFAULT 5,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          used_at TIMESTAMP NULL
        )
      `);

      // Create indexes for verification_codes
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_verification_email_type 
        ON verification_codes(email, code_type)
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_verification_expires 
        ON verification_codes(expires_at)
      `);

      console.log('✅ Verification codes table initialized');

      // Phase 2: Performance Optimization Indexes
      console.log('📊 Adding performance optimization indexes...');
      
      // Composite index for user analytics queries (most common query pattern)
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_user_date_composite 
        ON receipts(user_id, order_date DESC)
      `);

      // Index for email lookups
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_users_email_lower 
        ON users(LOWER(email))
      `);

      // Index for date range queries (Wrapped analytics)
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_order_date_user 
        ON receipts(order_date, user_id)
      `);

      // Index for restaurant analytics
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_restaurant_user 
        ON receipts(restaurant_name, user_id)
      `);

      // Index for amount-based queries (most expensive, etc.)
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_amount_user 
        ON receipts(amount_spent DESC, user_id)
      `);

      console.log('✅ Performance indexes created');

      // Phase 3: Additional Optimizations
      console.log('🔧 Applying additional database optimizations...');
      await this.applyAdditionalOptimizations();

      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing database tables:', error);
      throw error;
    }
  }

  /**
   * Apply additional optimizations for scalability
   */
  private async applyAdditionalOptimizations(): Promise<void> {
    // 1. Add GIN index on JSONB items column for item searches
    try {
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_items_gin 
        ON receipts USING GIN (items)
      `);
    } catch (error: any) {
      if (error.code !== '42P07') {
        console.warn('⚠️  GIN index creation warning:', error.message);
      }
    }

    // 2. Add partial indexes for common query patterns
    // Index for receipts with order_date (most queries filter by date)
    try {
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_has_date 
        ON receipts(user_id, order_date DESC) 
        WHERE order_date IS NOT NULL
      `);
    } catch (error: any) {
      if (error.code !== '42P07') {
        console.warn('⚠️  Partial index (has_date) creation warning:', error.message);
      }
    }

    // Index for recent receipts (last 2 years) - most common query
    try {
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_recent 
        ON receipts(user_id, order_date DESC) 
        WHERE order_date >= NOW() - INTERVAL '2 years'
      `);
    } catch (error: any) {
      if (error.code !== '42P07') {
        console.warn('⚠️  Partial index (recent) creation warning:', error.message);
      }
    }

    // Index for receipts with restaurant names (for analytics)
    try {
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_has_restaurant 
        ON receipts(user_id, restaurant_name) 
        WHERE restaurant_name IS NOT NULL
      `);
    } catch (error: any) {
      if (error.code !== '42P07') {
        console.warn('⚠️  Partial index (has_restaurant) creation warning:', error.message);
      }
    }

    // 3. Add year column for easier partitioning/archiving
    // This is critical, so we'll try multiple times if needed
    try {
      await this.query(`
        ALTER TABLE receipts 
        ADD COLUMN IF NOT EXISTS year INTEGER
      `);
      console.log('✅ Year column added (or already exists)');
    } catch (error: any) {
      if (error.code !== '42701') { // 42701 = duplicate_column
        console.error('❌ Year column migration failed:', error.message);
        throw error; // Re-throw critical errors
      }
    }

    try {
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_year 
        ON receipts(year, user_id)
      `);
      console.log('✅ Year column index created (or already exists)');
    } catch (error: any) {
      if (error.code !== '42P07') {
        console.warn('⚠️  Year index creation warning:', error.message);
      }
    }

    // Populate year column for existing rows
    try {
      const updateResult = await this.query(`
        UPDATE receipts 
        SET year = EXTRACT(YEAR FROM order_date)::INTEGER 
        WHERE year IS NULL AND order_date IS NOT NULL
      `);
      if (updateResult.rowCount && updateResult.rowCount > 0) {
        console.log(`✅ Populated year column for ${updateResult.rowCount} existing rows`);
      }
    } catch (error: any) {
      console.warn('⚠️  Year column backfill warning:', error.message);
    }

    // Create trigger to auto-populate year on insert/update
    try {
      await this.query(`
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

      await this.query(`
        DROP TRIGGER IF EXISTS trigger_update_receipt_year ON receipts;
        CREATE TRIGGER trigger_update_receipt_year
        BEFORE INSERT OR UPDATE OF order_date ON receipts
        FOR EACH ROW
        EXECUTE FUNCTION update_receipt_year();
      `);
      console.log('✅ Year column trigger created');
    } catch (error: any) {
      console.warn('⚠️  Year trigger creation warning:', error.message);
    }

    // 4. Update table statistics for better query planning
    try {
      await this.query('ANALYZE receipts');
      await this.query('ANALYZE users');
    } catch (error: any) {
      console.warn('⚠️  Statistics update warning:', error.message);
    }

    console.log('✅ Additional optimizations applied');
  }
}
