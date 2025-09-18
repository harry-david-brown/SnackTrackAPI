import { Pool, PoolClient } from 'pg';

export class PostgresService {
  private pool: Pool;

  constructor() {
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
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
          email_from VARCHAR(255),
          email_to VARCHAR(255),
          email_subject VARCHAR(500),
          email_body TEXT,
          amount_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
          items TEXT[],
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

      console.log('✅ Database tables initialized successfully');
    } catch (error) {
      console.error('❌ Error initializing database tables:', error);
      throw error;
    }
  }
}
