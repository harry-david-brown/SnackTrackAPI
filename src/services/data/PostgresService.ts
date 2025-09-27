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
          account_type VARCHAR(50) NOT NULL DEFAULT 'Gmail',
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
          restaurant_name VARCHAR(255),
          order_date TIMESTAMP,
          amount_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
          subtotal DECIMAL(10,2),
          tax DECIMAL(10,2),
          tip DECIMAL(10,2),
          delivery_fee DECIMAL(10,2),
          service_fee DECIMAL(10,2),
          items JSONB,
          email_from VARCHAR(255),
          email_to VARCHAR(255),
          email_subject VARCHAR(500),
          email_body TEXT,
          parsed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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

      // Add new receipt columns if they don't exist (migration)
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS receipt_type VARCHAR(50) DEFAULT 'unknown'
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS restaurant_name VARCHAR(255)
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS order_date TIMESTAMP
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS subtotal DECIMAL(10,2)
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tax DECIMAL(10,2)
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tip DECIMAL(10,2)
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(10,2)
      `);
      
      await this.query(`
        ALTER TABLE receipts ADD COLUMN IF NOT EXISTS service_fee DECIMAL(10,2)
      `);

      // Convert items from TEXT[] to JSONB if needed (handle existing data)
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
        CREATE INDEX IF NOT EXISTS idx_receipts_restaurant_name ON receipts(restaurant_name)
      `);

      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing database tables:', error);
      throw error;
    }
  }
}
