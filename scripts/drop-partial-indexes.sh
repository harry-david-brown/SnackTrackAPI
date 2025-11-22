#!/bin/bash

# Script to drop partial indexes from Railway PostgreSQL
# 
# Usage:
#   DATABASE_URL=your_railway_connection_string ./scripts/drop-partial-indexes.sh
# 
# Or set it in your environment:
#   export DATABASE_URL=your_railway_connection_string
#   ./scripts/drop-partial-indexes.sh

if [ -z "$DATABASE_URL" ]; then
  echo "❌ Error: DATABASE_URL environment variable not set"
  echo ""
  echo "Get your DATABASE_URL from Railway:"
  echo "  1. Go to Railway dashboard → Your PostgreSQL service"
  echo "  2. Go to 'Variables' tab"
  echo "  3. Copy the DATABASE_URL value"
  echo "  4. Run: DATABASE_URL=your_connection_string ./scripts/drop-partial-indexes.sh"
  exit 1
fi

echo "🗑️  Dropping partial indexes..."
echo ""

# Check if psql is available
if ! command -v psql &> /dev/null; then
  echo "❌ Error: psql not found. Please install PostgreSQL client tools."
  echo ""
  echo "On macOS: brew install postgresql"
  echo "On Ubuntu/Debian: sudo apt-get install postgresql-client"
  exit 1
fi

# Drop indexes
psql "$DATABASE_URL" << EOF
-- Drop partial indexes
DROP INDEX IF EXISTS idx_receipts_has_date;
DROP INDEX IF EXISTS idx_receipts_recent;
DROP INDEX IF EXISTS idx_receipts_has_restaurant;

-- Verify they're gone
SELECT 
  CASE 
    WHEN COUNT(*) = 0 THEN '✅ All partial indexes dropped successfully!'
    ELSE '⚠️  Some partial indexes still exist:'
  END as status,
  string_agg(indexname, ', ') as remaining_indexes
FROM pg_indexes
WHERE schemaname = 'public' 
  AND tablename = 'receipts'
  AND (
    indexname LIKE '%has_date%' OR
    indexname LIKE '%recent%' OR
    indexname LIKE '%has_restaurant%'
  );
EOF

if [ $? -eq 0 ]; then
  echo ""
  echo "✅ Done!"
else
  echo ""
  echo "❌ Error running SQL commands"
  exit 1
fi

