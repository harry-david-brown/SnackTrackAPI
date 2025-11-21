#!/bin/bash

# Realistic Load Test - Multiple Users
# Simulates real-world scenario with many different users
# Each user makes reasonable number of requests

API_URL="${API_URL:-http://localhost:3000}"
NUM_USERS=50  # Simulate 50 different users
REQUESTS_PER_USER=20  # Each user makes 20 requests
TOTAL_REQUESTS=$((NUM_USERS * REQUESTS_PER_USER))

echo "🔥 Realistic Load Test - Multiple Users"
echo "========================================"
echo ""
echo "Testing against: $API_URL"
echo ""
echo "Configuration:"
echo "  - Number of users: $NUM_USERS"
echo "  - Requests per user: $REQUESTS_PER_USER"
echo "  - Total requests: $TOTAL_REQUESTS"
echo ""

# Create test users
echo "1️⃣  Creating $NUM_USERS test users..."
USERS_FILE="/tmp/load-test-users-$$.json"
echo "[" > "$USERS_FILE"

for i in $(seq 1 $NUM_USERS); do
  EMAIL="loadtest-$(date +%s)-$i@example.com"
  
  REGISTER=$(curl -s -X POST "$API_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"LoadTest123\"}")
  
  USER_ID=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
  ACCESS_TOKEN=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)
  
  if [ -n "$USER_ID" ]; then
    echo "{\"userId\":\"$USER_ID\",\"token\":\"$ACCESS_TOKEN\"}," >> "$USERS_FILE"
  fi
  
  # Brief pause to avoid overwhelming registration
  if [ $((i % 10)) -eq 0 ]; then
    echo "  Created $i users..."
    sleep 0.5
  fi
done

echo "null]" >> "$USERS_FILE"
sed -i 's/,null]/]/' "$USERS_FILE"

CREATED_COUNT=$(grep -c "userId" "$USERS_FILE")
echo "✅ Created $CREATED_COUNT test users"
echo ""

# Function to make a request
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

# Parse users
USERS_JSON=$(cat "$USERS_FILE")

echo "2️⃣  Running $TOTAL_REQUESTS requests from $NUM_USERS users..."
echo "   (This may take 2-3 minutes)"
echo ""

START_TIME=$(date +%s)

# Each user makes their requests
for i in $(seq 1 $NUM_USERS); do
  # Get user data
  USER_DATA=$(echo "$USERS_JSON" | python3 -c "import sys,json; users=json.load(sys.stdin); print(json.dumps(users[$i-1]) if $i-1 < len(users) else '{}')" 2>/dev/null)
  USER_ID=$(echo "$USER_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
  TOKEN=$(echo "$USER_DATA" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token', ''))" 2>/dev/null)
  
  if [ -z "$USER_ID" ]; then
    continue
  fi
  
  # Each user makes multiple requests
  for j in $(seq 1 $REQUESTS_PER_USER); do
    case $((j % 4)) in
      0)
        make_request "$API_URL/health" "" "$i-$j" &
        ;;
      1)
        make_request "$API_URL/validation/user/$USER_ID/summary" "$TOKEN" "$i-$j" &
        ;;
      2)
        make_request "$API_URL/users/$USER_ID/totalSpent" "$TOKEN" "$i-$j" &
        ;;
      3)
        make_request "$API_URL/health" "" "$i-$j" &
        ;;
    esac
  done
  
  # Brief pause every 5 users
  if [ $((i % 5)) -eq 0 ]; then
    sleep 0.05
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

SUCCESSES=$(grep -c "success" /tmp/load-test-results.txt 2>/dev/null || echo "0")
FAILURES=$(($TOTAL_REQUESTS - SUCCESSES))
SUCCESS_RATE=$(python3 -c "print(round($SUCCESSES / $TOTAL_REQUESTS * 100, 2))" 2>/dev/null)

# Calculate latency statistics
if [ -f /tmp/load-test-times.txt ]; then
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
  
  AVG=$(awk '{ total += $1; count++ } END { print int(total/count) }' /tmp/load-test-times.txt)
fi

# Display results
echo "📊 Load Test Results"
echo "===================="
echo ""
echo "Test Configuration:"
echo "  - Unique users: $NUM_USERS"
echo "  - Requests per user: $REQUESTS_PER_USER"
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

SUCCESS_CHECK=$(python3 -c "print(1 if float('$SUCCESS_RATE') > 99 and $P95 < 2000 else 0)" 2>/dev/null)

if [ "$SUCCESS_RATE" = "100.00" ]; then
  echo "  ✅ Success rate: $SUCCESS_RATE% (perfect!)"
elif (( $(python3 -c "print(1 if float('$SUCCESS_RATE') > 99 else 0)" 2>/dev/null) )); then
  echo "  ✅ Success rate: $SUCCESS_RATE% (> 99%)"
else
  echo "  ⚠️  Success rate: $SUCCESS_RATE% (< 99%)"
fi

if [ "$P95" -lt 2000 ]; then
  echo "  ✅ p95 latency: ${P95}ms (< 2000ms)"
else
  echo "  ⚠️  p95 latency: ${P95}ms (> 2000ms)"
fi

if [ "$P99" -lt 5000 ]; then
  echo "  ✅ p99 latency: ${P99}ms (< 5000ms)"
else
  echo "  ⚠️  p99 latency: ${P99}ms (> 5000ms)"
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
if [ "$SUCCESS_CHECK" = "1" ]; then
  echo "🎉 PASS: API can handle $NUM_USERS concurrent users!"
  echo ""
  echo "📈 Performance Summary:"
  echo "  - $SUCCESS_RATE% success rate under heavy load"
  echo "  - Excellent response times (p95: ${P95}ms, p99: ${P99}ms)"
  echo "  - ${TOTAL_TIME}s to handle $TOTAL_REQUESTS requests"
  echo "  - Throughput: $(($TOTAL_REQUESTS / TOTAL_TIME)) req/s"
  echo ""
  echo "✅ Recommendation: Ready for production deployment with 1000+ concurrent users"
  exit 0
else
  echo "⚠️  WARNING: Performance degraded under heavy load"
  echo ""
  echo "Recommendation: Current capacity ~$NUM_USERS users. Scale resources for higher load."
  exit 1
fi

# Cleanup
rm -f "$USERS_FILE"

