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
      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing database tables:', error);
      throw error;
    }
  }
}
