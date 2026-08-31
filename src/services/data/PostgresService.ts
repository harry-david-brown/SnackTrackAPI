import { Pool, PoolClient } from 'pg';
import { config } from '../../config/AppConfig';

export class PostgresService {
  private pool: Pool;

  constructor() {
    const isProduction = process.env.NODE_ENV === 'production';

    // Configure SSL for production databases (most cloud providers require this)
    const sslConfig = config.shouldUseDatabaseSSL() 
      ? { rejectUnauthorized: false } // Required for most cloud databases (Railway, Heroku, etc.)
      : false;

    this.pool = new Pool({
      connectionString: config.getDatabaseConnectionString(),
      ssl: sslConfig,

      // Connection pool configuration for performance
      max: isProduction ? 20 : 10, // Maximum connections (20 in prod, 10 in dev)
      min: 2, // Minimum connections to keep open
      idleTimeoutMillis: 30000, // Close idle connections after 30s
      connectionTimeoutMillis: 30000, // Timeout if can't connect within 30s (increased for cold starts)

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
          order_date TIMESTAMPTZ,
          amount_spent DECIMAL(10,2) NOT NULL DEFAULT 0,
          items JSONB,
          source_identity TEXT,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
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

      // Migration: Add timezone column to users table (for UTC to local time conversion)
      try {
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/New_York'
        `);
        console.log('✅ Timezone column migration completed');
      } catch (error) {
        console.log('Timezone column already exists or migration failed');
      }

      // Migration: Add Gmail OAuth columns to users table
      try {
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT
        `);
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_access_token TEXT
        `);
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_token_expiry TIMESTAMP
        `);
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_connected BOOLEAN DEFAULT FALSE
        `);
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_email VARCHAR(255)
        `);
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_scopes TEXT[] DEFAULT ARRAY[]::TEXT[]
        `);
        await this.query(`
          ALTER TABLE users ADD COLUMN IF NOT EXISTS gmail_connection_mode VARCHAR(20) DEFAULT 'none'
        `);
        console.log('✅ Gmail OAuth columns migration completed');
      } catch (error) {
        console.log('Gmail OAuth columns already exist or migration failed');
      }

      // Product-level permission and export lifecycle are deliberately stored
      // separately from Google OAuth tokens. Possessing a durable token does
      // not itself authorize background monitoring.
      await this.query(`
        CREATE TABLE IF NOT EXISTS user_import_preferences (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          monitoring_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered'
            CHECK (monitoring_consent_state IN ('not_offered', 'declined', 'granted', 'revoked')),
          monitoring_consent_version VARCHAR(50),
          monitoring_consented_at TIMESTAMP,
          monitoring_revoked_at TIMESTAMP,
          export_status VARCHAR(40) NOT NULL DEFAULT 'not_started'
            CHECK (export_status IN (
              'not_started',
              'requested_monitoring_enabled',
              'requested_monitoring_disabled',
              'file_ready',
              'import_processing',
              'completed',
              'failed'
            )),
          export_requested_at TIMESTAMP,
          export_updated_at TIMESTAMP,
          gmail_import_status VARCHAR(24) NOT NULL DEFAULT 'never_started'
            CHECK (gmail_import_status IN ('never_started', 'importing', 'completed', 'failed')),
          gmail_import_updated_at TIMESTAMPTZ,
          gmail_imported_count INTEGER NOT NULL DEFAULT 0,
          gmail_import_error_code VARCHAR(80),
          gmail_baseline_completed_at TIMESTAMPTZ,
          ongoing_tracking_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered'
            CHECK (ongoing_tracking_consent_state IN ('not_offered', 'declined', 'granted', 'revoked')),
          ongoing_tracking_consent_version VARCHAR(50),
          ongoing_tracking_consented_at TIMESTAMPTZ,
          ongoing_tracking_revoked_at TIMESTAMPTZ,
          tracking_status VARCHAR(24) NOT NULL DEFAULT 'inactive'
            CHECK (tracking_status IN ('inactive', 'setting_up', 'active', 'paused', 'reconnect_required', 'error')),
          last_check_attempt_at TIMESTAMPTZ,
          last_successful_check_at TIMESTAMPTZ,
          last_stats_updated_at TIMESTAMPTZ,
          last_new_order_at TIMESTAMPTZ,
          last_tracking_error_at TIMESTAMPTZ,
          last_tracking_error_code VARCHAR(80),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_user_import_preferences_export_status
        ON user_import_preferences(export_status)
      `);

      // Export request/upload progress belongs to a provider. The legacy
      // aggregate columns above remain temporarily for response compatibility,
      // but new writes use these provider rows as the durable authority.
      await this.query(`
        CREATE TABLE IF NOT EXISTS user_export_provider_preferences (
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider VARCHAR(24) NOT NULL
            CHECK (provider IN ('uber_eats', 'doordash')),
          status VARCHAR(32) NOT NULL DEFAULT 'not_started'
            CHECK (status IN (
              'not_started', 'requested', 'file_ready',
              'import_processing', 'completed', 'failed'
            )),
          requested_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          error_code VARCHAR(80),
          ready_source VARCHAR(24)
            CHECK (ready_source IS NULL OR ready_source IN ('detected_email', 'user_confirmed')),
          PRIMARY KEY (user_id, provider)
        )
      `);
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_user_export_provider_status
        ON user_export_provider_preferences(provider, status)
      `);
      await this.query(`
        ALTER TABLE user_export_provider_preferences
          ADD COLUMN IF NOT EXISTS ready_source VARCHAR(24)
            CHECK (ready_source IS NULL OR ready_source IN ('detected_email', 'user_confirmed'))
      `);
      // Only Uber has an automated data-ready email detector. Other legacy
      // request states are provider-ambiguous and are intentionally not guessed.
      await this.query(`
        INSERT INTO user_export_provider_preferences (user_id, provider, status, updated_at)
        SELECT user_id, 'uber_eats', 'file_ready', COALESCE(export_updated_at, NOW())
        FROM user_import_preferences
        WHERE export_status = 'file_ready'
        ON CONFLICT (user_id, provider) DO NOTHING
      `);

      // Add tracking/import lifecycle columns for databases created before the
      // dashboard state model existed.
      await this.query(`
        ALTER TABLE user_import_preferences
          ADD COLUMN IF NOT EXISTS gmail_import_status VARCHAR(24) NOT NULL DEFAULT 'never_started'
            CHECK (gmail_import_status IN ('never_started', 'importing', 'completed', 'failed')),
          ADD COLUMN IF NOT EXISTS gmail_import_updated_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS gmail_imported_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS gmail_import_error_code VARCHAR(80),
          ADD COLUMN IF NOT EXISTS gmail_baseline_completed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ongoing_tracking_consent_state VARCHAR(24) NOT NULL DEFAULT 'not_offered'
            CHECK (ongoing_tracking_consent_state IN ('not_offered', 'declined', 'granted', 'revoked')),
          ADD COLUMN IF NOT EXISTS ongoing_tracking_consent_version VARCHAR(50),
          ADD COLUMN IF NOT EXISTS ongoing_tracking_consented_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ongoing_tracking_revoked_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS tracking_status VARCHAR(24) NOT NULL DEFAULT 'inactive'
            CHECK (tracking_status IN ('inactive', 'setting_up', 'active', 'paused', 'reconnect_required', 'error')),
          ADD COLUMN IF NOT EXISTS last_check_attempt_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_successful_check_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_stats_updated_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_new_order_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_tracking_error_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS last_tracking_error_code VARCHAR(80)
      `);
      await this.query(`
        ALTER TABLE user_import_preferences
          DROP CONSTRAINT IF EXISTS user_import_preferences_tracking_status_check
      `);
      await this.query(`
        ALTER TABLE user_import_preferences
          ADD CONSTRAINT user_import_preferences_tracking_status_check
          CHECK (tracking_status IN (
            'inactive', 'setting_up', 'active', 'paused', 'reconnect_required', 'error'
          ))
      `);

      await this.query(`
        ALTER TABLE receipts
          ADD COLUMN IF NOT EXISTS external_id TEXT,
          ADD COLUMN IF NOT EXISTS source_identity TEXT,
          ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      `);
      await this.query(`
        UPDATE receipts
        SET first_seen_at = created_at AT TIME ZONE 'UTC'
        WHERE created_at IS NOT NULL
          AND first_seen_at > (created_at AT TIME ZONE 'UTC') + INTERVAL '1 minute'
      `);

      // Give existing Gmail receipts a stable identity, collapse any legacy
      // duplicates, then enforce one row per discovered Gmail order.
      await this.query(`
        UPDATE receipts
        SET source_identity = CASE
          WHEN external_id IS NOT NULL THEN 'external:' || external_id
          WHEN order_date IS NOT NULL THEN
            'fallback:' || LOWER(BTRIM(COALESCE(restaurant_name, 'unknown'))) || '|' ||
            TO_CHAR(order_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI')
          ELSE NULL
        END
        WHERE data_source = 'email' AND source_identity IS NULL
      `);
      await this.query(`
        DELETE FROM receipts duplicate
        USING receipts keeper
        WHERE duplicate.user_id = keeper.user_id
          AND duplicate.data_source = 'email'
          AND keeper.data_source = 'email'
          AND duplicate.source_identity = keeper.source_identity
          AND duplicate.source_identity IS NOT NULL
          AND (
            duplicate.amount_spent < keeper.amount_spent
            OR (duplicate.amount_spent = keeper.amount_spent AND duplicate.id::TEXT > keeper.id::TEXT)
          )
      `);
      await this.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_user_source_identity_unique
        ON receipts(user_id, data_source, source_identity)
        WHERE source_identity IS NOT NULL
      `);

      // Privacy-safe lifecycle audit used for funnel measurement and consent
      // history. It stores state transitions only—never email or receipt data.
      await this.query(`
        CREATE TABLE IF NOT EXISTS user_import_preference_events (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          event_name VARCHAR(60) NOT NULL
            CHECK (event_name IN (
              'monitoring_consent_granted',
              'monitoring_consent_declined',
              'monitoring_consent_revoked',
              'ongoing_tracking_consent_granted',
              'ongoing_tracking_consent_declined',
              'ongoing_tracking_consent_revoked',
              'export_requested',
              'export_file_ready',
              'export_import_processing',
              'export_completed',
              'export_failed',
              'gmail_import_reset'
            )),
          metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.query(`
        BEGIN;
        ALTER TABLE user_import_preference_events
          DROP CONSTRAINT IF EXISTS user_import_preference_events_event_name_check;
        ALTER TABLE user_import_preference_events
          ADD CONSTRAINT user_import_preference_events_event_name_check
          CHECK (event_name IN (
            'monitoring_consent_granted', 'monitoring_consent_declined', 'monitoring_consent_revoked',
            'ongoing_tracking_consent_granted', 'ongoing_tracking_consent_declined', 'ongoing_tracking_consent_revoked',
            'export_requested', 'export_file_ready', 'export_import_processing', 'export_completed', 'export_failed',
            'gmail_import_reset'
          ));
        COMMIT;
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_user_import_preference_events_user_created
        ON user_import_preference_events(user_id, created_at DESC)
      `);

      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_user_import_preference_events_name_created
        ON user_import_preference_events(event_name, created_at DESC)
      `);

      await this.query(`
        CREATE TABLE IF NOT EXISTS gmail_sync_runs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          trigger_type VARCHAR(20) NOT NULL
            CHECK (trigger_type IN ('manual', 'background')),
          outcome VARCHAR(20) NOT NULL DEFAULT 'running'
            CHECK (outcome IN ('running', 'success', 'partial', 'failed')),
          started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          emails_scanned INTEGER NOT NULL DEFAULT 0,
          receipts_processed INTEGER NOT NULL DEFAULT 0,
          new_orders INTEGER NOT NULL DEFAULT 0,
          updated_orders INTEGER NOT NULL DEFAULT 0,
          unchanged_orders INTEGER NOT NULL DEFAULT 0,
          supported_receipts_found INTEGER NOT NULL DEFAULT 0,
          export_covered_receipts INTEGER NOT NULL DEFAULT 0,
          eligible_receipts INTEGER NOT NULL DEFAULT 0,
          deduplicated_receipts INTEGER NOT NULL DEFAULT 0,
          error_code VARCHAR(80)
        )
      `);
      await this.query(`
        ALTER TABLE gmail_sync_runs
          ADD COLUMN IF NOT EXISTS supported_receipts_found INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS export_covered_receipts INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS eligible_receipts INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS deduplicated_receipts INTEGER NOT NULL DEFAULT 0
      `);
      await this.query(`
        UPDATE user_import_preferences
        SET gmail_baseline_completed_at = COALESCE(gmail_import_updated_at, NOW())
        WHERE gmail_baseline_completed_at IS NULL
          AND gmail_import_status = 'completed'
      `);
      await this.query(`
        UPDATE user_import_preferences preferences
        SET gmail_baseline_completed_at = successful_run.completed_at
        FROM (
          SELECT user_id, MAX(completed_at) AS completed_at
          FROM gmail_sync_runs
          WHERE trigger_type = 'manual'
            AND outcome IN ('success', 'partial')
            AND completed_at IS NOT NULL
          GROUP BY user_id
        ) successful_run
        WHERE preferences.user_id = successful_run.user_id
          AND preferences.gmail_baseline_completed_at IS NULL
      `);
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_gmail_sync_runs_user_started
        ON gmail_sync_runs(user_id, started_at DESC)
      `);

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

      // Create oauth_accounts table
      await this.query(`
        CREATE TABLE IF NOT EXISTS oauth_accounts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider VARCHAR(50) NOT NULL,
          provider_user_id VARCHAR(255) NOT NULL,
          email VARCHAR(255),
          access_token TEXT,
          refresh_token TEXT,
          token_expiry TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(provider, provider_user_id)
        )
      `);

      // Create indexes for oauth_accounts
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id ON oauth_accounts(user_id)
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

    // 2. Add year column for easier partitioning/archiving
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

    // 3. Add delivery_time column for DoorDash delivery wait analytics
    try {
      await this.query(`
        ALTER TABLE receipts 
        ADD COLUMN IF NOT EXISTS delivery_time TIMESTAMPTZ
      `);
      console.log('✅ Delivery time column added (or already exists)');
    } catch (error: any) {
      if (error.code !== '42701') { // 42701 = duplicate_column
        console.error('❌ Delivery time column migration failed:', error.message);
        throw error; // Re-throw critical errors
      }
    }

    // 3.1 Receipt dates represent instants. Older databases used a timezone-
    // naive column even though the application consistently treated values as
    // UTC; convert those values explicitly so reads are host independent.
    try {
      await this.query(`
        DO $$
        DECLARE
          order_date_needs_conversion BOOLEAN;
          year_trigger_existed BOOLEAN;
        BEGIN
          SELECT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'receipts'
              AND column_name = 'order_date'
              AND data_type = 'timestamp without time zone'
          ) INTO order_date_needs_conversion;

          IF order_date_needs_conversion THEN
            -- PostgreSQL will not alter a column referenced by a trigger
            -- definition. Preserve whether the trigger existed, remove it for
            -- the conversion, and restore it in this same atomic DO block.
            SELECT EXISTS (
              SELECT 1 FROM pg_trigger
              WHERE tgrelid = 'receipts'::regclass
                AND tgname = 'trigger_update_receipt_year'
                AND NOT tgisinternal
            ) INTO year_trigger_existed;

            IF year_trigger_existed THEN
              DROP TRIGGER trigger_update_receipt_year ON receipts;
            END IF;

            ALTER TABLE receipts
              ALTER COLUMN order_date TYPE TIMESTAMPTZ
              USING order_date AT TIME ZONE 'UTC';

            IF year_trigger_existed THEN
              CREATE TRIGGER trigger_update_receipt_year
              BEFORE INSERT OR UPDATE OF order_date ON receipts
              FOR EACH ROW
              EXECUTE FUNCTION update_receipt_year();
            END IF;
          END IF;

          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = 'receipts'
              AND column_name = 'delivery_time'
              AND data_type = 'timestamp without time zone'
          ) THEN
            ALTER TABLE receipts
              ALTER COLUMN delivery_time TYPE TIMESTAMPTZ
              USING delivery_time AT TIME ZONE 'UTC';
          END IF;
        END $$;
      `);
      console.log('✅ Receipt timestamps use timezone-aware columns');
    } catch (error: any) {
      console.error('❌ Receipt timezone migration failed:', error.message);
      throw error;
    }

    // 3.5 Add external_id column for receipt deduplication (Uber UUIDs)
    try {
      await this.query(`
        ALTER TABLE receipts 
        ADD COLUMN IF NOT EXISTS external_id TEXT
      `);
      await this.query(`
        CREATE INDEX IF NOT EXISTS idx_receipts_external_id ON receipts(external_id)
      `);
      console.log('✅ External ID column and index added (or already exists)');
    } catch (error: any) {
      if (error.code !== '42701') { // 42701 = duplicate_column
        console.error('❌ External ID column migration failed:', error.message);
        throw error;
      }
    }

    // 3.6 Add unique constraint for user_id + external_id deduplication
    // This enables database-level duplicate prevention for receipts with external IDs
    try {
      await this.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_user_external_id_unique
        ON receipts(user_id, external_id) 
        WHERE external_id IS NOT NULL
      `);
      console.log('✅ Unique constraint on user_id + external_id added (or already exists)');
    } catch (error: any) {
      if (error.code !== '42P07') { // 42P07 = duplicate_object (index already exists)
        console.warn('⚠️  Unique constraint creation warning:', error.message);
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
