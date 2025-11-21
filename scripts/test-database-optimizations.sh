#!/bin/bash

# Test Database Optimizations
# This script verifies that all database optimizations have been applied correctly

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Get API URL from environment or use default
API_URL="${API_URL:-http://localhost:3000}"

echo "🧪 Testing Database Optimizations"
echo "=================================="
echo "API URL: $API_URL"
echo ""

# Test 1: Check if optimizations endpoint is accessible
echo "📊 Test 1: Checking optimization status endpoint..."
STATUS_RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL/monitoring/database-optimizations" || echo -e "\n000")

HTTP_CODE=$(echo "$STATUS_RESPONSE" | tail -n1)
BODY=$(echo "$STATUS_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" != "200" ]; then
  echo -e "${RED}❌ Failed: Endpoint returned HTTP $HTTP_CODE${NC}"
  echo "$BODY"
  exit 1
fi

echo -e "${GREEN}✅ Endpoint accessible${NC}"

# Test 2: Check if optimizations are applied
echo ""
echo "🔍 Test 2: Verifying optimizations are applied..."

GIN_INDEX=$(echo "$BODY" | grep -o '"ginIndex":[^,]*' | grep -o 'true\|false' || echo "false")
PARTIAL_INDEXES=$(echo "$BODY" | grep -o '"partialIndexes":[^,]*' | grep -o 'true\|false' || echo "false")
YEAR_COLUMN=$(echo "$BODY" | grep -o '"yearColumn":[^,]*' | grep -o 'true\|false' || echo "false")

echo "  GIN Index on items: $GIN_INDEX"
echo "  Partial Indexes: $PARTIAL_INDEXES"
echo "  Year Column: $YEAR_COLUMN"

if [ "$GIN_INDEX" != "true" ]; then
  echo -e "${YELLOW}⚠️  Warning: GIN index not found${NC}"
fi

if [ "$PARTIAL_INDEXES" != "true" ]; then
  echo -e "${YELLOW}⚠️  Warning: Partial indexes not found${NC}"
fi

if [ "$YEAR_COLUMN" != "true" ]; then
  echo -e "${YELLOW}⚠️  Warning: Year column not found${NC}"
fi

if [ "$GIN_INDEX" = "true" ] && [ "$PARTIAL_INDEXES" = "true" ] && [ "$YEAR_COLUMN" = "true" ]; then
  echo -e "${GREEN}✅ All optimizations are applied${NC}"
else
  echo -e "${YELLOW}⚠️  Some optimizations may be missing. Check the full response above.${NC}"
fi

# Test 3: Check table sizes
echo ""
echo "📈 Test 3: Checking table sizes..."
RECEIPTS_SIZE=$(echo "$BODY" | grep -o '"name":"receipts"[^}]*' | grep -o '"totalSize":"[^"]*"' | cut -d'"' -f4 || echo "unknown")
RECEIPTS_ROWS=$(echo "$BODY" | grep -o '"name":"receipts"[^}]*' | grep -o '"rowCount":[0-9]*' | cut -d':' -f2 || echo "0")

echo "  Receipts table size: $RECEIPTS_SIZE"
echo "  Receipts row count: $RECEIPTS_ROWS"

# Test 4: Check index usage
echo ""
echo "🔎 Test 4: Checking index usage statistics..."
INDEX_COUNT=$(echo "$BODY" | grep -o '"receiptsIndexes":\[' | wc -l || echo "0")

if [ "$INDEX_COUNT" -gt 0 ]; then
  echo -e "${GREEN}✅ Index statistics available${NC}"
  echo ""
  echo "Top indexes by usage:"
  echo "$BODY" | grep -o '"indexUsage":\[[^\]]*\]' | head -5
else
  echo -e "${YELLOW}⚠️  No index usage data available${NC}"
fi

# Test 5: Performance test - Query with GIN index
echo ""
echo "⚡ Test 5: Testing JSONB search performance (GIN index)..."
echo "  This test requires receipts with items data"
echo "  Run this after uploading some CSV data"

# Summary
echo ""
echo "=================================="
echo "📋 Summary"
echo "=================================="
echo "Optimization Status:"
echo "  - GIN Index: $GIN_INDEX"
echo "  - Partial Indexes: $PARTIAL_INDEXES"
echo "  - Year Column: $YEAR_COLUMN"
echo ""
echo "Database Stats:"
echo "  - Receipts table: $RECEIPTS_SIZE"
echo "  - Receipts rows: $RECEIPTS_ROWS"
echo ""

if [ "$GIN_INDEX" = "true" ] && [ "$PARTIAL_INDEXES" = "true" ] && [ "$YEAR_COLUMN" = "true" ]; then
  echo -e "${GREEN}✅ All optimizations verified successfully!${NC}"
  exit 0
else
  echo -e "${YELLOW}⚠️  Some optimizations may need to be applied${NC}"
  echo "  Restart the server to apply optimizations during initialization"
  exit 1
fi

