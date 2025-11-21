#!/bin/bash

# Database Performance Test
# Tests query performance with and without optimizations

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

API_URL="${API_URL:-http://localhost:3000}"

echo "⚡ Database Performance Test"
echo "============================"
echo ""

# Test 1: Get optimization status
echo -e "${BLUE}📊 Getting optimization status...${NC}"
OPT_STATUS=$(curl -s "$API_URL/monitoring/database-optimizations")

# Extract key metrics
RECEIPTS_ROWS=$(echo "$OPT_STATUS" | grep -o '"rowCount":[0-9]*' | head -1 | cut -d':' -f2 || echo "0")
RECEIPTS_SIZE=$(echo "$OPT_STATUS" | grep -o '"totalSize":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")

echo "  Receipts: $RECEIPTS_ROWS rows, $RECEIPTS_SIZE"
echo ""

# Test 2: Check if we have test data
if [ "$RECEIPTS_ROWS" -eq "0" ]; then
  echo -e "${YELLOW}⚠️  No receipts found. Upload some CSV data first to test performance.${NC}"
  echo ""
  echo "To test performance:"
  echo "  1. Register a user"
  echo "  2. Upload CSV data"
  echo "  3. Run this script again"
  exit 0
fi

# Test 3: Performance benchmarks
echo -e "${BLUE}🔍 Running performance tests...${NC}"
echo ""

# Test query performance via health endpoint (includes DB query)
echo "Test 1: Database connection latency"
START=$(date +%s%N)
curl -s "$API_URL/health" > /dev/null
END=$(date +%s%N)
LATENCY=$(( (END - START) / 1000000 ))
echo "  Latency: ${LATENCY}ms"

if [ "$LATENCY" -lt 100 ]; then
  echo -e "  ${GREEN}✅ Excellent (< 100ms)${NC}"
elif [ "$LATENCY" -lt 500 ]; then
  echo -e "  ${GREEN}✅ Good (< 500ms)${NC}"
elif [ "$LATENCY" -lt 1000 ]; then
  echo -e "  ${YELLOW}⚠️  Acceptable (< 1s)${NC}"
else
  echo -e "  ${RED}❌ Slow (> 1s)${NC}"
fi

echo ""

# Test 4: Check index usage
echo -e "${BLUE}📈 Index Usage Statistics${NC}"
INDEX_USAGE=$(echo "$OPT_STATUS" | grep -A 20 '"indexUsage"')

# Count indexes with scans
INDEXES_WITH_SCANS=$(echo "$INDEX_USAGE" | grep -o '"scans":[0-9]*' | grep -v ':0' | wc -l || echo "0")
TOTAL_INDEXES=$(echo "$INDEX_USAGE" | grep -o '"scans":[0-9]*' | wc -l || echo "0")

echo "  Total indexes: $TOTAL_INDEXES"
echo "  Indexes with usage: $INDEXES_WITH_SCANS"

if [ "$INDEXES_WITH_SCANS" -gt 0 ]; then
  echo -e "  ${GREEN}✅ Indexes are being used${NC}"
else
  echo -e "  ${YELLOW}⚠️  No index usage yet (may need more queries)${NC}"
fi

echo ""

# Test 5: Optimization checklist
echo -e "${BLUE}✅ Optimization Checklist${NC}"

GIN_INDEX=$(echo "$OPT_STATUS" | grep -o '"ginIndex":[^,]*' | grep -o 'true\|false' || echo "false")
PARTIAL_INDEXES=$(echo "$OPT_STATUS" | grep -o '"partialIndexes":[^,]*' | grep -o 'true\|false' || echo "false")
YEAR_COLUMN=$(echo "$OPT_STATUS" | grep -o '"yearColumn":[^,]*' | grep -o 'true\|false' || echo "false")

check_opt() {
  if [ "$1" = "true" ]; then
    echo -e "  ${GREEN}✅ $2${NC}"
  else
    echo -e "  ${RED}❌ $2${NC}"
  fi
}

check_opt "$GIN_INDEX" "GIN index on JSONB items"
check_opt "$PARTIAL_INDEXES" "Partial indexes for filtered queries"
check_opt "$YEAR_COLUMN" "Year column for partitioning"

echo ""

# Summary
echo "============================"
echo "📋 Summary"
echo "============================"
echo "Database Performance:"
echo "  - Connection latency: ${LATENCY}ms"
echo "  - Receipts: $RECEIPTS_ROWS rows"
echo ""
echo "Optimizations:"
echo "  - GIN Index: $GIN_INDEX"
echo "  - Partial Indexes: $PARTIAL_INDEXES"
echo "  - Year Column: $YEAR_COLUMN"
echo ""

if [ "$GIN_INDEX" = "true" ] && [ "$PARTIAL_INDEXES" = "true" ] && [ "$YEAR_COLUMN" = "true" ]; then
  echo -e "${GREEN}✅ All optimizations are active!${NC}"
  echo ""
  echo "Next steps:"
  echo "  - Monitor query performance as data grows"
  echo "  - Check index usage statistics regularly"
  echo "  - Consider partitioning when receipts > 10M rows"
  exit 0
else
  echo -e "${YELLOW}⚠️  Some optimizations need to be applied${NC}"
  echo ""
  echo "To apply optimizations:"
  echo "  1. Restart the server (optimizations run on startup)"
  echo "  2. Check logs for optimization messages"
  echo "  3. Run this test again"
  exit 1
fi

