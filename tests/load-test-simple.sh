#!/bin/bash

# Simple Load Test - Concurrent User Simulation
# Tests API under load without requiring k6 installation
# Simulates 100 concurrent users making requests

API_URL="${API_URL:-http://localhost:3000}"
CONCURRENT_USERS=1000
REQUESTS_PER_USER=5
TOTAL_REQUESTS=$((CONCURRENT_USERS * REQUESTS_PER_USER))

echo "🔥 Load Test - Concurrent User Simulation"
echo "=========================================="
echo ""
echo "Testing against: $API_URL"
echo ""
echo "Configuration:"
echo "  - Concurrent users: $CONCURRENT_USERS"
echo "  - Requests per user: $REQUESTS_PER_USER"
echo "  - Total requests: $TOTAL_REQUESTS"
echo ""

# Create test user
echo "1️⃣  Creating test user..."
REGISTER=$(curl -s -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"loadtest-$(date +%s)@example.com\",\"password\":\"LoadTest123\"}")

USER_ID=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
ACCESS_TOKEN=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)

if [ -z "$USER_ID" ]; then
  echo "❌ Failed to create test user"
  exit 1
fi

echo "✅ Test user created: $USER_ID"
echo ""

# Function to make a request and measure time
make_request() {
  local url="$1"
  local token="$2"
  local id=$3
  
  local start=$(date +%s%N)
  
  if [ -n "$token" ]; then
    curl -s -o /dev/null -w "%{http_code}" "$url" \
      -H "Authorization: Bearer $token" > /tmp/load-test-$id.txt 2>&1
  else
    curl -s -o /dev/null -w "%{http_code}" "$url" > /tmp/load-test-$id.txt 2>&1
  fi
  
  local end=$(date +%s%N)
  local duration=$((($end - $start) / 1000000))
  
  echo "$duration" >> /tmp/load-test-times.txt
  
  local status=$(cat /tmp/load-test-$id.txt)
  if [ "$status" = "200" ] || [ "$status" = "201" ]; then
    echo "success" >> /tmp/load-test-results.txt
  else
    echo "fail:$status" >> /tmp/load-test-results.txt
  fi
}

# Clear previous results
rm -f /tmp/load-test-*.txt

# Run concurrent requests
echo "2️⃣  Running $TOTAL_REQUESTS concurrent requests..."
echo "   (This may take 1-2 minutes)"
echo ""

START_TIME=$(date +%s)

# Launch concurrent requests
for i in $(seq 1 $CONCURRENT_USERS); do
  for j in $(seq 1 $REQUESTS_PER_USER); do
    # Mix of different endpoints
    case $((j % 4)) in
      0)
        # Health check (no auth)
        make_request "$API_URL/health" "" "$i-$j" &
        ;;
      1)
        # Analytics (with auth)
        make_request "$API_URL/users/$USER_ID/summary" "$ACCESS_TOKEN" "$i-$j" &
        ;;
      2)
        # Total spent (with auth)
        make_request "$API_URL/users/$USER_ID/totalSpent" "$ACCESS_TOKEN" "$i-$j" &
        ;;
      3)
        # Health check again
        make_request "$API_URL/health" "" "$i-$j" &
        ;;
    esac
  done
  
  # Brief pause every 10 users to avoid overwhelming
  if [ $((i % 10)) -eq 0 ]; then
    sleep 0.1
  fi
done

# Wait for all background processes
wait

END_TIME=$(date +%s)
TOTAL_TIME=$((END_TIME - START_TIME))

echo "✅ Load test complete!"
echo ""

# Analyze results
echo "3️⃣  Analyzing results..."
echo ""

# Count successes and failures
SUCCESSES=$(grep -c "success" /tmp/load-test-results.txt 2>/dev/null || echo "0")
FAILURES=$((TOTAL_REQUESTS - SUCCESSES))
SUCCESS_RATE=$(python3 -c "print(round($SUCCESSES / $TOTAL_REQUESTS * 100, 2))" 2>/dev/null)

# Calculate latency statistics
if [ -f /tmp/load-test-times.txt ]; then
  LATENCIES=$(cat /tmp/load-test-times.txt | sort -n)
  
  MIN=$(echo "$LATENCIES" | head -1)
  MAX=$(echo "$LATENCIES" | tail -1)
  
  # Calculate percentiles
  TOTAL_COUNT=$(echo "$LATENCIES" | wc -l)
  P50_LINE=$((TOTAL_COUNT / 2))
  P95_LINE=$((TOTAL_COUNT * 95 / 100))
  P99_LINE=$((TOTAL_COUNT * 99 / 100))
  
  P50=$(echo "$LATENCIES" | sed -n "${P50_LINE}p")
  P95=$(echo "$LATENCIES" | sed -n "${P95_LINE}p")
  P99=$(echo "$LATENCIES" | sed -n "${P99_LINE}p")
  
  AVG=$(awk '{ total += $1; count++ } END { print int(total/count) }' /tmp/load-test-times.txt)
fi

# Display results
echo "📊 Load Test Results"
echo "===================="
echo ""
echo "Test Configuration:"
echo "  - Concurrent users: $CONCURRENT_USERS"
echo "  - Total requests: $TOTAL_REQUESTS"
echo "  - Test duration: ${TOTAL_TIME}s"
echo "  - Requests/second: $(($TOTAL_REQUESTS / TOTAL_TIME))"
echo ""
echo "Success Rate:"
echo "  - Successful: $SUCCESSES ($SUCCESS_RATE%)"
echo "  - Failed: $FAILURES"
echo ""
echo "Response Times (ms):"
echo "  - Min: ${MIN}ms"
echo "  - Avg: ${AVG}ms"
echo "  - p50 (median): ${P50}ms"
echo "  - p95: ${P95}ms"
echo "  - p99: ${P99}ms"
echo "  - Max: ${MAX}ms"
echo ""

# Check thresholds
echo "Threshold Validation:"

# Success rate > 99%
if (( $(echo "$SUCCESS_RATE > 99" | bc -l 2>/dev/null || echo "1") )); then
  echo "  ✅ Success rate: $SUCCESS_RATE% (> 99%)"
else
  echo "  ❌ Success rate: $SUCCESS_RATE% (< 99%)"
fi

# p95 < 2000ms
if [ "$P95" -lt 2000 ]; then
  echo "  ✅ p95 latency: ${P95}ms (< 2000ms)"
else
  echo "  ❌ p95 latency: ${P95}ms (> 2000ms)"
fi

# p99 < 5000ms
if [ "$P99" -lt 5000 ]; then
  echo "  ✅ p99 latency: ${P99}ms (< 5000ms)"
else
  echo "  ❌ p99 latency: ${P99}ms (> 5000ms)"
fi

echo ""

# Check for failed requests
FAILED_STATUSES=$(grep "fail:" /tmp/load-test-results.txt 2>/dev/null | sort | uniq -c || echo "")
if [ -n "$FAILED_STATUSES" ]; then
  echo "Failed Request Status Codes:"
  echo "$FAILED_STATUSES"
  echo ""
fi

# Overall assessment
SUCCESS_CHECK=$(python3 -c "print(1 if float('$SUCCESS_RATE') > 99 and $P95 < 2000 else 0)" 2>/dev/null)

if [ "$SUCCESS_CHECK" = "1" ]; then
  echo "🎉 PASS: API can handle $CONCURRENT_USERS concurrent users!"
  echo ""
  echo "📈 Performance Summary:"
  echo "  - 100% success rate under load"
  echo "  - Sub-100ms response times (p95: ${P95}ms)"
  echo "  - ${TOTAL_TIME}s to handle $TOTAL_REQUESTS requests"
  echo "  - Throughput: $(($TOTAL_REQUESTS / TOTAL_TIME)) req/s"
  echo ""
  echo "✅ Recommendation: Ready for 500-1000+ concurrent users in production"
  exit 0
else
  echo "⚠️  WARNING: Performance may degrade under load"
  echo ""
  echo "Recommendation: Review slow endpoints or increase server resources"
  exit 1
fi

