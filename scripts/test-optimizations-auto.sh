#!/bin/bash

# Automated Database Optimization Test
# Tests all optimizations and provides a comprehensive report

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
API_URL="${API_URL:-https://snacktrackapi-production.up.railway.app}"
MAX_RETRIES=5
RETRY_DELAY=3

# Auto-detect environment if not set
if [ -z "$API_URL" ] || [ "$API_URL" = "http://localhost:3000" ]; then
  # Check if we can reach production
  if curl -s --max-time 2 "https://snacktrackapi-production.up.railway.app/health" > /dev/null 2>&1; then
    API_URL="https://snacktrackapi-production.up.railway.app"
    echo -e "${CYAN}Auto-detected: Using production API${NC}"
  else
    API_URL="http://localhost:3000"
    echo -e "${CYAN}Auto-detected: Using local API${NC}"
  fi
fi

# Test results
TESTS_PASSED=0
TESTS_FAILED=0
WARNINGS=0

echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Automated Database Optimization Test                    ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}API URL: ${API_URL}${NC}"
echo ""

# Function to make HTTP request with retries
http_request() {
  local url=$1
  local retries=0
  local response=""
  
  while [ $retries -lt $MAX_RETRIES ]; do
    response=$(curl -s -w "\n%{http_code}" "$url" 2>&1 || echo -e "\n000")
    local http_code=$(echo "$response" | tail -n1)
    
    if [ "$http_code" = "200" ]; then
      echo "$response" | sed '$d'
      return 0
    fi
    
    retries=$((retries + 1))
    if [ $retries -lt $MAX_RETRIES ]; then
      echo -e "${YELLOW}⚠️  Request failed (HTTP $http_code), retrying in ${RETRY_DELAY}s... (${retries}/${MAX_RETRIES})${NC}" >&2
      sleep $RETRY_DELAY
    fi
  done
  
  echo "$response" | sed '$d'
  return 1
}

# Test 1: Server Health Check
echo -e "${BLUE}📡 Test 1: Server Health Check${NC}"
if http_request "$API_URL/health" > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ Server is accessible${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "  ${RED}❌ Server is not accessible${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo -e "${RED}Cannot continue testing. Please check if the server is running.${NC}"
  exit 1
fi
echo ""

# Test 2: Optimization Status Endpoint
echo -e "${BLUE}📊 Test 2: Optimization Status Endpoint${NC}"
OPT_STATUS=$(http_request "$API_URL/monitoring/database-optimizations" 2>&1)

if [ $? -eq 0 ] && echo "$OPT_STATUS" | grep -q "optimizations"; then
  echo -e "  ${GREEN}✅ Endpoint is accessible${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "  ${RED}❌ Endpoint returned error${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo "$OPT_STATUS"
  exit 1
fi
echo ""

# Test 3: Check GIN Index
echo -e "${BLUE}🔍 Test 3: GIN Index on JSONB Items${NC}"
GIN_INDEX=$(echo "$OPT_STATUS" | grep -o '"ginIndex":[^,]*' | grep -o 'true\|false' || echo "false")

if [ "$GIN_INDEX" = "true" ]; then
  echo -e "  ${GREEN}✅ GIN index is applied${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "  ${RED}❌ GIN index is missing${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 4: Check Partial Indexes
echo -e "${BLUE}📈 Test 4: Partial Indexes${NC}"
PARTIAL_INDEXES=$(echo "$OPT_STATUS" | grep -o '"partialIndexes":[^,]*' | grep -o 'true\|false' || echo "false")

if [ "$PARTIAL_INDEXES" = "true" ]; then
  echo -e "  ${GREEN}✅ Partial indexes are applied${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "  ${RED}❌ Partial indexes are missing${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 5: Check Year Column
echo -e "${BLUE}📅 Test 5: Year Column${NC}"
YEAR_COLUMN=$(echo "$OPT_STATUS" | grep -o '"yearColumn":[^,]*' | grep -o 'true\|false' || echo "false")

if [ "$YEAR_COLUMN" = "true" ]; then
  echo -e "  ${GREEN}✅ Year column exists${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo -e "  ${RED}❌ Year column is missing${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 6: Database Performance
echo -e "${BLUE}⚡ Test 6: Database Performance${NC}"
START_TIME=$(date +%s%N)
if http_request "$API_URL/health" > /dev/null 2>&1; then
  END_TIME=$(date +%s%N)
  LATENCY_MS=$(( (END_TIME - START_TIME) / 1000000 ))
  
  echo "  Latency: ${LATENCY_MS}ms"
  
  if [ "$LATENCY_MS" -lt 100 ]; then
    echo -e "  ${GREEN}✅ Excellent performance (< 100ms)${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  elif [ "$LATENCY_MS" -lt 500 ]; then
    echo -e "  ${GREEN}✅ Good performance (< 500ms)${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  elif [ "$LATENCY_MS" -lt 1000 ]; then
    echo -e "  ${YELLOW}⚠️  Acceptable performance (< 1s)${NC}"
    TESTS_PASSED=$((TESTS_PASSED + 1))
    WARNINGS=$((WARNINGS + 1))
  else
    echo -e "  ${RED}❌ Slow performance (> 1s)${NC}"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
else
  echo -e "  ${RED}❌ Performance test failed${NC}"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi
echo ""

# Test 7: Table Statistics
echo -e "${BLUE}📊 Test 7: Database Statistics${NC}"
RECEIPTS_ROWS=$(echo "$OPT_STATUS" | grep -o '"rowCount":[0-9]*' | head -1 | cut -d':' -f2 || echo "0")
RECEIPTS_SIZE=$(echo "$OPT_STATUS" | grep -o '"totalSize":"[^"]*"' | head -1 | cut -d'"' -f4 || echo "unknown")

if [ "$RECEIPTS_ROWS" != "0" ]; then
  echo "  Receipts: $RECEIPTS_ROWS rows, $RECEIPTS_SIZE"
  echo -e "  ${GREEN}✅ Database has data${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo "  Receipts: No data yet"
  echo -e "  ${YELLOW}⚠️  Database is empty (this is okay for new deployments)${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# Test 8: Index Count
echo -e "${BLUE}🔎 Test 8: Index Verification${NC}"
INDEX_COUNT=$(echo "$OPT_STATUS" | grep -o '"receiptsIndexes":\[' | wc -l || echo "0")
TOTAL_INDEXES=$(echo "$OPT_STATUS" | grep -o '"name":"[^"]*"' | wc -l || echo "0")

if [ "$TOTAL_INDEXES" -gt 5 ]; then
  echo "  Total indexes found: $TOTAL_INDEXES"
  echo -e "  ${GREEN}✅ Multiple indexes detected${NC}"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  echo "  Total indexes: $TOTAL_INDEXES"
  echo -e "  ${YELLOW}⚠️  Fewer indexes than expected${NC}"
  WARNINGS=$((WARNINGS + 1))
fi
echo ""

# Summary Report
echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Test Summary                                             ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "Tests Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests Failed: ${RED}$TESTS_FAILED${NC}"
if [ "$WARNINGS" -gt 0 ]; then
  echo -e "Warnings: ${YELLOW}$WARNINGS${NC}"
fi
echo ""

# Detailed Status
echo -e "${BLUE}Optimization Status:${NC}"
echo "  - GIN Index: $GIN_INDEX"
echo "  - Partial Indexes: $PARTIAL_INDEXES"
echo "  - Year Column: $YEAR_COLUMN"
echo ""

if [ "$RECEIPTS_ROWS" != "0" ]; then
  echo -e "${BLUE}Database Stats:${NC}"
  echo "  - Receipts: $RECEIPTS_ROWS rows"
  echo "  - Size: $RECEIPTS_SIZE"
  echo ""
fi

# Final Result
if [ "$TESTS_FAILED" -eq 0 ]; then
  if [ "$GIN_INDEX" = "true" ] && [ "$PARTIAL_INDEXES" = "true" ] && [ "$YEAR_COLUMN" = "true" ]; then
    echo -e "${GREEN}✅ All optimizations are active and working!${NC}"
    echo ""
    echo "Next steps:"
    echo "  - Monitor performance as data grows"
    echo "  - Check index usage statistics regularly"
    echo "  - Consider partitioning when receipts > 10M rows"
    exit 0
  else
    echo -e "${YELLOW}⚠️  Some optimizations may need to be applied${NC}"
    echo ""
    echo "The server may need to be restarted to apply optimizations."
    echo "Optimizations run during database initialization on startup."
    exit 1
  fi
else
  echo -e "${RED}❌ Some tests failed. Please check the errors above.${NC}"
  exit 1
fi

