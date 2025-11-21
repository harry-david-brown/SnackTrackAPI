#!/bin/bash

# Production Load Test
# Tests production API with database optimizations + Redis caching
# Uses public endpoints and monitoring endpoints

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# Configuration
API_URL="${API_URL:-https://snacktrackapi-production.up.railway.app}"
CONCURRENT_REQUESTS="${1:-100}"
REQUESTS_PER_BATCH=10

echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  Production Load Test                                     ║${NC}"
echo -e "${CYAN}║  Testing: Database Optimizations + Redis Caching          ║${NC}"
echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BLUE}API URL: ${API_URL}${NC}"
echo -e "${BLUE}Concurrent requests: ${CONCURRENT_REQUESTS}${NC}"
echo ""

# Function to make a request and measure time
make_request() {
  local url="$1"
  local id="$2"
  
  local start=$(date +%s%N)
  local http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000")
  local end=$(date +%s%N)
  local duration=$((($end - $start) / 1000000))
  
  echo "$duration" >> /tmp/load-test-times.txt
  
  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    echo "success" >> /tmp/load-test-results.txt
  else
    echo "fail:$http_code" >> /tmp/load-test-results.txt
  fi
}

# Clear previous results
rm -f /tmp/load-test-*.txt
touch /tmp/load-test-times.txt
touch /tmp/load-test-results.txt

# Get a user ID for testing
echo -e "${BLUE}📋 Step 1: Getting test user ID...${NC}"
USER_RESPONSE=$(curl -s "${API_URL}/monitoring/query-performance" 2>/dev/null | jq -r '.userId // empty' 2>/dev/null || echo "")

if [ -z "$USER_RESPONSE" ]; then
  echo -e "${RED}❌ Could not get user ID${NC}"
  exit 1
fi

USER_ID="$USER_RESPONSE"
echo -e "${GREEN}✅ Using user: ${USER_ID}${NC}"
echo ""

# Test endpoints (mix of public and monitoring)
ENDPOINTS=(
  "/health"
  "/monitoring/health"
  "/monitoring/cache"
  "/monitoring/database-optimizations"
  "/monitoring/query-performance?userId=${USER_ID}"
)

echo -e "${BLUE}📊 Step 2: Running ${CONCURRENT_REQUESTS} concurrent requests...${NC}"
echo -e "${YELLOW}  (Testing multiple endpoints)${NC}"
echo ""

START_TIME=$(date +%s)

# Launch concurrent requests
for i in $(seq 1 $CONCURRENT_REQUESTS); do
  # Rotate through endpoints
  ENDPOINT_INDEX=$((i % ${#ENDPOINTS[@]}))
  ENDPOINT="${ENDPOINTS[$ENDPOINT_INDEX]}"
  URL="${API_URL}${ENDPOINT}"
  
  make_request "$URL" "$i" &
  
  # Limit concurrent background jobs
  if [ $((i % $REQUESTS_PER_BATCH)) -eq 0 ]; then
    wait
    sleep 0.1
  fi
done

# Wait for all remaining background processes
wait

END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

echo -e "${GREEN}✅ Load test complete!${NC}"
echo ""

# Analyze results
echo -e "${BLUE}📊 Step 3: Analyzing results...${NC}"
echo ""

SUCCESSES=$(grep -c "success" /tmp/load-test-results.txt 2>/dev/null || echo "0")
FAILURES=$(($CONCURRENT_REQUESTS - $SUCCESSES))
SUCCESS_RATE=$(awk "BEGIN {printf \"%.2f\", ($SUCCESSES / $CONCURRENT_REQUESTS) * 100}")

# Calculate latency statistics
if [ -f /tmp/load-test-times.txt ] && [ -s /tmp/load-test-times.txt ]; then
  LATENCIES=$(cat /tmp/load-test-times.txt | sort -n)
  
  MIN=$(echo "$LATENCIES" | head -1)
  MAX=$(echo "$LATENCIES" | tail -1)
  
  TOTAL_COUNT=$(echo "$LATENCIES" | wc -l)
  P50_LINE=$((TOTAL_COUNT / 2))
  P95_LINE=$((TOTAL_COUNT * 95 / 100))
  P99_LINE=$((TOTAL_COUNT * 99 / 100))
  
  P50=$(echo "$LATENCIES" | sed -n "${P50_LINE}p")
  P95=$(echo "$LATENCIES" | sed -n "${P95_LINE}p")
  P99=$(echo "$LATENCIES" | sed -n "${P99_LINE}p")
  
  AVG=$(awk '{ total += $1; count++ } END { if (count > 0) print int(total/count); else print 0 }' /tmp/load-test-times.txt)
else
  MIN=0
  MAX=0
  P50=0
  P95=0
  P99=0
  AVG=0
fi

# Display results
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}Load Test Results${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Test Configuration:${NC}"
echo "  - Total requests: $CONCURRENT_REQUESTS"
echo "  - Test duration: ${TOTAL_TIME}s"
if [ "$TOTAL_TIME" -gt 0 ]; then
  echo "  - Requests/second: $(($CONCURRENT_REQUESTS / $TOTAL_TIME))"
fi
echo ""
echo -e "${BLUE}Success Rate:${NC}"
echo "  - Successful: $SUCCESSES ($SUCCESS_RATE%)"
echo "  - Failed: $FAILURES"
echo ""

if [ "$SUCCESSES" -gt 0 ]; then
  echo -e "${BLUE}Response Times (ms):${NC}"
  echo "  - Min: ${MIN}ms"
  echo "  - Avg: ${AVG}ms"
  echo "  - p50 (median): ${P50}ms"
  echo "  - p95: ${P95}ms"
  echo "  - p99: ${P99}ms"
  echo "  - Max: ${MAX}ms"
  echo ""
fi

# Check thresholds
echo -e "${BLUE}Threshold Validation:${NC}"

SUCCESS_RATE_NUM=$(echo "$SUCCESS_RATE" | awk '{print int($1)}')
if [ "$SUCCESS_RATE_NUM" -ge 99 ] 2>/dev/null; then
  echo -e "  ${GREEN}✅ Success rate: $SUCCESS_RATE% (>= 99%)${NC}"
else
  echo -e "  ${YELLOW}⚠️  Success rate: $SUCCESS_RATE% (< 99%)${NC}"
fi

if [ "$P95" -gt 0 ] && [ "$P95" -lt 2000 ]; then
  echo -e "  ${GREEN}✅ p95 latency: ${P95}ms (< 2000ms)${NC}"
elif [ "$P95" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠️  p95 latency: ${P95}ms (> 2000ms)${NC}"
fi

if [ "$P99" -gt 0 ] && [ "$P99" -lt 5000 ]; then
  echo -e "  ${GREEN}✅ p99 latency: ${P99}ms (< 5000ms)${NC}"
elif [ "$P99" -gt 0 ]; then
  echo -e "  ${YELLOW}⚠️  p99 latency: ${P99}ms (> 5000ms)${NC}"
fi

echo ""

# Check for failed requests
FAILED_STATUSES=$(grep "fail:" /tmp/load-test-results.txt 2>/dev/null | cut -d':' -f2 | sort | uniq -c || echo "")
if [ -n "$FAILED_STATUSES" ] && [ "$FAILURES" -gt 0 ]; then
  echo -e "${YELLOW}Failed Request Status Codes:${NC}"
  echo "$FAILED_STATUSES"
  echo ""
fi

# Overall assessment
SUCCESS_RATE_NUM=$(echo "$SUCCESS_RATE" | awk '{print int($1)}')
if [ "$SUCCESS_RATE_NUM" -ge 99 ] 2>/dev/null && [ "$P95" -gt 0 ] && [ "$P95" -lt 2000 ]; then
  echo -e "${GREEN}🎉 PASS: API handled ${CONCURRENT_REQUESTS} concurrent requests!${NC}"
  echo ""
  echo -e "${BLUE}Performance Summary:${NC}"
  echo "  - $SUCCESS_RATE% success rate"
  echo "  - p95 latency: ${P95}ms"
  echo "  - p99 latency: ${P99}ms"
  echo "  - Throughput: $(($CONCURRENT_REQUESTS / $TOTAL_TIME)) req/s"
  echo ""
  echo -e "${GREEN}✅ Database optimizations + Redis caching are working well under load!${NC}"
  exit 0
else
  echo -e "${YELLOW}⚠️  Some performance issues detected${NC}"
  echo ""
  echo "Recommendation: Review failed requests and slow endpoints"
  exit 1
fi

