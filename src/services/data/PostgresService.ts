import { Pool, PoolClient } from 'pg';
import { config } from '../../config/AppConfig';

export class PostgresService {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: config.getDatabaseConnectionString(),
      ssl: config.shouldUseDatabaseSSL(),
    });

    // Handle pool errors
    this.pool.on('error', (err) => {
      console.error('Unexpected error on idle client', err);
    });
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
    await this.pool.end();
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

      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing database tables:', error);
      throw error;
    }
  }
}
