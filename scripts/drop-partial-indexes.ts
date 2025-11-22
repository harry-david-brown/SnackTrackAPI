/**
 * One-time script to drop partial indexes from production database
 * 
 * Usage:
 *   DATABASE_URL=your_railway_connection_string npx ts-node scripts/drop-partial-indexes.ts
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function dropPartialIndexes() {
  const indexesToDrop = [
    'idx_receipts_has_date',
    'idx_receipts_recent',
    'idx_receipts_has_restaurant'
  ];

  console.log('🗑️  Dropping partial indexes...\n');

  for (const indexName of indexesToDrop) {
    try {
      // Check if index exists first
      const checkResult = await pool.query(`
        SELECT EXISTS (
          SELECT 1 
          FROM pg_indexes 
          WHERE schemaname = 'public' 
          AND tablename = 'receipts' 
          AND indexname = $1
        ) as exists
      `, [indexName]);

      if (checkResult.rows[0].exists) {
        await pool.query(`DROP INDEX IF EXISTS ${indexName}`);
        console.log(`✅ Dropped: ${indexName}`);
      } else {
        console.log(`ℹ️  Not found: ${indexName} (already dropped or never existed)`);
      }
    } catch (error: any) {
      console.error(`❌ Error dropping ${indexName}:`, error.message);
    }
  }

  console.log('\n✅ Done!');
  await pool.end();
}

dropPartialIndexes().catch(console.error);

