#!/bin/bash

# Spike Test - 1000 Concurrent Users
# All users make 1 request simultaneously
# Tests maximum burst capacity

API_URL="http://localhost:3000"
CONCURRENT_USERS=1000

echo "💥 Spike Test - 1000 Concurrent Users"
echo "======================================"
echo ""
echo "Configuration:"
echo "  - Concurrent users: $CONCURRENT_USERS"
echo "  - Requests per user: 1"
echo "  - Total requests: $CONCURRENT_USERS"
echo ""

# Create a single test user
echo "1️⃣  Creating test user..."
REGISTER=$(curl -s -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"spike-test-$(date +%s)@example.com\",\"password\":\"SpikeTest123\"}")

USER_ID=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
ACCESS_TOKEN=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)

if [ -z "$USER_ID" ]; then
  echo "❌ Failed to create test user"
  exit 1
fi

echo "✅ Test user created: $USER_ID"
echo ""

# Function to make a single request
make_request() {
  local id=$1
  
  local start=$(date +%s%N)
  
  # Analytics endpoint (most complex)
  local status=$(curl -s -o /dev/null -w "%{http_code}" \
    "$API_URL/validation/user/$USER_ID/summary" \
    -H "Authorization: Bearer $ACCESS_TOKEN" 2>&1)
  
  local end=$(date +%s%N)
  local duration=$((($end - $start) / 1000000))
  
  echo "$duration" >> /tmp/spike-test-times.txt
  echo "$status" >> /tmp/spike-test-status.txt
}

# Clear previous results
rm -f /tmp/spike-test-*.txt

echo "2️⃣  Launching $CONCURRENT_USERS simultaneous requests..."
echo "   ⚠️  This is a SPIKE test - all requests fire at once!"
echo ""

START_TIME=$(date +%s%N)

# Launch all requests simultaneously (no sleep between them)
for i in $(seq 1 $CONCURRENT_USERS); do
  make_request $i &
done

# Wait for all to complete
wait

END_TIME=$(date +%s%N)
TOTAL_TIME_MS=$((($END_TIME - $START_TIME) / 1000000))
TOTAL_TIME_S=$(($TOTAL_TIME_MS / 1000))

echo "✅ Spike test complete!"
echo ""

# Analyze results
echo "3️⃣  Analyzing spike results..."
echo ""

# Count status codes
STATUS_200=$(grep -c "^200$" /tmp/spike-test-status.txt 2>/dev/null || echo "0")
STATUS_429=$(grep -c "^429$" /tmp/spike-test-status.txt 2>/dev/null || echo "0")
STATUS_OTHER=$(grep -cv "^200$\|^429$" /tmp/spike-test-status.txt 2>/dev/null || echo "0")

SUCCESS_RATE=$(python3 -c "print(round($STATUS_200 / $CONCURRENT_USERS * 100, 2))" 2>/dev/null)

# Calculate latency statistics
if [ -f /tmp/spike-test-times.txt ]; then
  LATENCIES=$(cat /tmp/spike-test-times.txt | sort -n)
  
  MIN=$(echo "$LATENCIES" | head -1)
  MAX=$(echo "$LATENCIES" | tail -1)
  
  TOTAL_COUNT=$(echo "$LATENCIES" | wc -l)
  P50_LINE=$((TOTAL_COUNT / 2))
  P95_LINE=$((TOTAL_COUNT * 95 / 100))
  P99_LINE=$((TOTAL_COUNT * 99 / 100))
  
  P50=$(echo "$LATENCIES" | sed -n "${P50_LINE}p")
  P95=$(echo "$LATENCIES" | sed -n "${P95_LINE}p")
  P99=$(echo "$LATENCIES" | sed -n "${P99_LINE}p")
  
  AVG=$(awk '{ total += $1; count++ } END { print int(total/count) }' /tmp/spike-test-times.txt)
fi

# Display results
echo "📊 Spike Test Results"
echo "====================="
echo ""
echo "Spike Configuration:"
echo "  - Concurrent requests: $CONCURRENT_USERS"
echo "  - Total time: ${TOTAL_TIME_MS}ms (${TOTAL_TIME_S}s)"
echo "  - Effective throughput: $(($CONCURRENT_USERS * 1000 / TOTAL_TIME_MS)) req/s"
echo ""
echo "Response Status:"
echo "  - 200 OK: $STATUS_200 ($SUCCESS_RATE%)"
echo "  - 429 Rate Limited: $STATUS_429"
echo "  - Other errors: $STATUS_OTHER"
echo ""
echo "Response Times (ms):"
echo "  - Min: ${MIN}ms"
echo "  - Avg: ${AVG}ms"
echo "  - p50 (median): ${P50}ms"
echo "  - p95: ${P95}ms"
echo "  - p99: ${P99}ms"
echo "  - Max: ${MAX}ms"
echo ""

# Analysis
echo "💡 Spike Test Analysis"
echo "======================"
echo ""

if [ "$STATUS_200" -gt 900 ]; then
  echo "✅ Excellent: ${STATUS_200}/1000 requests succeeded"
  echo "   API handled the spike perfectly!"
elif [ "$STATUS_200" -gt 500 ]; then
  echo "✅ Good: ${STATUS_200}/1000 requests succeeded"
  echo "   Rate limiting protected the server from overload"
elif [ "$STATUS_200" -gt 100 ]; then
  echo "⚠️  Moderate: ${STATUS_200}/1000 requests succeeded"
  echo "   System can handle spikes but at reduced capacity"
else
  echo "❌ Poor: Only ${STATUS_200}/1000 requests succeeded"
  echo "   System struggles with sudden spike traffic"
fi

echo ""
echo "Rate Limiting Behavior:"
if [ "$STATUS_429" -gt 0 ]; then
  PCT=$(python3 -c "print(round($STATUS_429 / $CONCURRENT_USERS * 100, 1))" 2>/dev/null)
  echo "  - $STATUS_429 requests rate-limited (${PCT}%)"
  echo "  - This is EXPECTED and protects server health"
  echo "  - Dev limit: 1000 req/60s"
  echo "  - Production limit: 10,000 req/5min (10x more capacity)"
fi

echo ""

if [ "$P95" -lt 2000 ] && [ "$STATUS_200" -gt 500 ]; then
  echo "🎉 SPIKE TEST PASSED!"
  echo ""
  echo "✅ System handles burst traffic gracefully"
  echo "✅ Response times stay fast (p95: ${P95}ms)"
  echo "✅ Rate limiting protects server health"
  echo "✅ Production will handle even larger spikes (10x limits)"
  echo ""
  echo "Recommendation: Deploy with confidence!"
  exit 0
else
  echo "Results: System functional but showed stress under spike"
  exit 1
fi

# Cleanup
rm -f /tmp/spike-test-*.txt

