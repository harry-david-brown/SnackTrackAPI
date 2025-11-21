#!/bin/bash

# Test Database Query Performance
# This script tests actual database query performance, bypassing Redis cache
# It shows whether indexes are being used and actual execution times

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
USER_ID="${1}"

# userId is optional - endpoint will auto-select a user with receipts
if [ -n "$2" ]; then
  API_URL="$2"
fi

echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Database Query Performance Test                          ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}API URL: ${API_URL}${NC}"
if [ -n "$USER_ID" ]; then
  echo -e "${BLUE}User ID: ${USER_ID}${NC}"
else
  echo -e "${BLUE}User ID: ${YELLOW}(auto-selecting user with receipts)${NC}"
fi
echo ""

# Make the request
echo -e "${BLUE}Running performance tests...${NC}"
if [ -n "$USER_ID" ]; then
  RESPONSE=$(curl -s "${API_URL}/monitoring/query-performance?userId=${USER_ID}")
else
  RESPONSE=$(curl -s "${API_URL}/monitoring/query-performance")
fi

# Check if request was successful
if echo "$RESPONSE" | grep -q '"error"'; then
  ERROR=$(echo "$RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
  echo -e "${RED}❌ Error: ${ERROR}${NC}"
  exit 1
fi

# Parse and display results
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}Query Performance Results${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""

# Extract summary
TOTAL_TESTS=$(echo "$RESPONSE" | grep -o '"totalTests":[0-9]*' | cut -d':' -f2)
INDEXED_TESTS=$(echo "$RESPONSE" | grep -o '"testsWithIndexes":[0-9]*' | cut -d':' -f2)
AVG_TIME=$(echo "$RESPONSE" | grep -o '"averageExecutionTime":[0-9.]*' | cut -d':' -f2)
FASTEST=$(echo "$RESPONSE" | grep -o '"fastestQuery":"[^"]*"' | cut -d'"' -f4)
SLOWEST=$(echo "$RESPONSE" | grep -o '"slowestQuery":"[^"]*"' | cut -d'"' -f4)

echo -e "${BLUE}Summary:${NC}"
echo "  Total Tests: $TOTAL_TESTS"
echo "  Tests Using Indexes: $INDEXED_TESTS"
echo "  Average Execution Time: ${AVG_TIME}ms"
echo "  Fastest Query: $FASTEST"
echo "  Slowest Query: $SLOWEST"
echo ""

# Display individual test results
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}Individual Query Results${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""

# Extract each test (simplified parsing)
TESTS=$(echo "$RESPONSE" | grep -o '"name":"[^"]*"' | cut -d'"' -f4)

IFS=$'\n'
for TEST_NAME in $TESTS; do
  echo -e "${BLUE}📊 ${TEST_NAME}${NC}"
  
  # Extract execution time
  EXEC_TIME=$(echo "$RESPONSE" | grep -A 50 "\"name\":\"${TEST_NAME}\"" | grep -o '"executionTimeMs":[0-9.]*' | head -1 | cut -d':' -f2)
  PLAN_TIME=$(echo "$RESPONSE" | grep -A 50 "\"name\":\"${TEST_NAME}\"" | grep -o '"planExecutionTimeMs":[0-9.]*' | head -1 | cut -d':' -f2)
  ROWS=$(echo "$RESPONSE" | grep -A 50 "\"name\":\"${TEST_NAME}\"" | grep -o '"rowsReturned":[0-9]*' | head -1 | cut -d':' -f2)
  INDEX_USED=$(echo "$RESPONSE" | grep -A 50 "\"name\":\"${TEST_NAME}\"" | grep -o '"indexUsed":[^,}]*' | head -1 | grep -o 'true\|false')
  INDEX_NAME=$(echo "$RESPONSE" | grep -A 50 "\"name\":\"${TEST_NAME}\"" | grep -o '"indexName":"[^"]*"' | head -1 | cut -d'"' -f4)
  NODE_TYPE=$(echo "$RESPONSE" | grep -A 50 "\"name\":\"${TEST_NAME}\"" | grep -o '"nodeType":"[^"]*"' | head -1 | cut -d'"' -f4)
  
  if [ -n "$EXEC_TIME" ]; then
    echo "  Execution Time: ${EXEC_TIME}ms"
    if [ -n "$PLAN_TIME" ]; then
      echo "  Plan Execution Time: ${PLAN_TIME}ms"
    fi
    echo "  Rows Returned: ${ROWS}"
    echo "  Node Type: ${NODE_TYPE}"
    
    if [ "$INDEX_USED" = "true" ]; then
      echo -e "  Index Used: ${GREEN}✅ Yes${NC} (${INDEX_NAME})"
    else
      echo -e "  Index Used: ${RED}❌ No${NC}"
      if [ -n "$INDEX_NAME" ] && [ "$INDEX_NAME" != "N/A" ]; then
        echo "  Index Name: $INDEX_NAME"
      fi
    fi
  else
    ERROR=$(echo "$RESPONSE" | grep -A 10 "\"name\":\"${TEST_NAME}\"" | grep -o '"error":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ -n "$ERROR" ]; then
      echo -e "  ${RED}❌ Error: ${ERROR}${NC}"
    fi
  fi
  echo ""
done

# Performance assessment
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}Performance Assessment${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""

if [ "$INDEXED_TESTS" = "$TOTAL_TESTS" ]; then
  echo -e "${GREEN}✅ All queries are using indexes!${NC}"
elif [ "$INDEXED_TESTS" -gt 0 ]; then
  echo -e "${YELLOW}⚠️  Some queries are using indexes (${INDEXED_TESTS}/${TOTAL_TESTS})${NC}"
else
  echo -e "${RED}❌ No queries are using indexes!${NC}"
  echo "  This suggests the optimizations may not be working correctly."
fi

# Check average execution time
AVG_INT=$(echo "$AVG_TIME" | cut -d'.' -f1)
if [ -n "$AVG_INT" ] && [ "$AVG_INT" -lt 50 ]; then
  echo -e "${GREEN}✅ Excellent performance (< 50ms average)${NC}"
elif [ -n "$AVG_INT" ] && [ "$AVG_INT" -lt 200 ]; then
  echo -e "${GREEN}✅ Good performance (< 200ms average)${NC}"
elif [ -n "$AVG_INT" ] && [ "$AVG_INT" -lt 500 ]; then
  echo -e "${YELLOW}⚠️  Acceptable performance (< 500ms average)${NC}"
else
  echo -e "${RED}❌ Slow performance (> 500ms average)${NC}"
fi

echo ""
echo -e "${BLUE}Note:${NC} These queries bypass Redis cache and show raw database performance."
echo -e "${BLUE}Tip:${NC} Compare these results over time to track performance improvements."

