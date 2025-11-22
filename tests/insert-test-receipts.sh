#!/bin/bash

# Helper script to insert test receipts directly into the database for pagination testing
# Usage: ./tests/insert-test-receipts.sh <userId> <count>

set -e

USER_ID="$1"
COUNT="${2:-25}"  # Default to 25 receipts

if [ -z "$USER_ID" ]; then
    echo "Usage: $0 <userId> [count]"
    exit 1
fi

# Get database connection from environment or use defaults
DB_URL="${DATABASE_URL:-postgresql://snacktrack:password@localhost:5432/snacktrack_dev}"

echo "Inserting $COUNT test receipts for user: $USER_ID"

# Extract connection details
if [[ $DB_URL =~ postgresql://([^:]+):([^@]+)@([^:]+):([^/]+)/(.+) ]]; then
    DB_USER="${BASH_REMATCH[1]}"
    DB_PASS="${BASH_REMATCH[2]}"
    DB_HOST="${BASH_REMATCH[3]}"
    DB_PORT="${BASH_REMATCH[4]}"
    DB_NAME="${BASH_REMATCH[5]}"
else
    echo "Error: Could not parse DATABASE_URL"
    exit 1
fi

# Use psql to insert test data
export PGPASSWORD="$DB_PASS"

for i in $(seq 1 $COUNT); do
    RESTAURANT_NAME="Test Restaurant $((i % 5 + 1))"
    AMOUNT_CENTS=$((RANDOM % 5000 + 1000))  # Random amount between $10.00 and $50.00
    # Calculate decimal without bc: divide by 100 and format
    AMOUNT_DECIMAL=$(awk "BEGIN {printf \"%.2f\", $AMOUNT_CENTS / 100}")
    DAYS_AGO=$((RANDOM % 90))
    ORDER_DATE=$(date -d "$DAYS_AGO days ago" -Iseconds 2>/dev/null || date -v-${DAYS_AGO}d -Iseconds 2>/dev/null || date -Iseconds)
    
    psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "
        INSERT INTO receipts (
            id, user_id, restaurant_name, amount_spent, currency, 
            receipt_type, data_source, created_at, updated_at, year
        ) VALUES (
            gen_random_uuid(),
            '$USER_ID',
            '$RESTAURANT_NAME',
            $AMOUNT_DECIMAL,
            'USD',
            'uber_eats',
            'csv',
            '$ORDER_DATE',
            NOW(),
            EXTRACT(YEAR FROM '$ORDER_DATE'::timestamp)
        );
    " > /dev/null 2>&1
    
    if [ $((i % 5)) -eq 0 ]; then
        echo -n "."
    fi
done

echo ""
echo "✅ Inserted $COUNT test receipts for user $USER_ID"

