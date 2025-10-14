#!/bin/bash

# Test Redis Caching Performance
# Tests cache hit/miss behavior and performance improvements

API_URL="http://localhost:3000"

echo "🧪 Testing Redis Cache Performance"
echo "================================="
echo ""

# Step 1: Register a test user
echo "1️⃣  Registering test user..."
REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"cache-test@example.com","password":"Test1234"}')

USER_ID=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
ACCESS_TOKEN=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)

if [ -z "$USER_ID" ]; then
  echo "❌ Registration failed"
  exit 1
fi

echo "✅ User registered: $USER_ID"
echo ""

# Step 2: First summary request (cache MISS)
echo "2️⃣  First summary request (cache MISS expected)..."
START=$(date +%s%N)
SUMMARY1=$(curl -s -X GET "$API_URL/validation/user/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
END=$(date +%s%N)
LATENCY1=$((($END - $START) / 1000000))

echo "📊 Response time: ${LATENCY1}ms"
echo ""

# Step 3: Second summary request (cache HIT)
echo "3️⃣  Second summary request (cache HIT expected)..."
START=$(date +%s%N)
SUMMARY2=$(curl -s -X GET "$API_URL/validation/user/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
END=$(date +%s%N)
LATENCY2=$((($END - $START) / 1000000))

echo "📊 Response time: ${LATENCY2}ms"
echo ""

# Step 4: Third summary request (should still be cached)
echo "4️⃣  Third summary request (cache HIT expected)..."
START=$(date +%s%N)
SUMMARY3=$(curl -s -X GET "$API_URL/validation/user/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
END=$(date +%s%N)
LATENCY3=$((($END - $START) / 1000000))

echo "📊 Response time: ${LATENCY3}ms"
echo ""

# Calculate performance improvement
if [ $LATENCY1 -gt 0 ] && [ $LATENCY2 -gt 0 ]; then
  IMPROVEMENT=$(python3 -c "print(round((1 - $LATENCY2 / $LATENCY1) * 100, 1))" 2>/dev/null)
  echo "📈 Performance Analysis:"
  echo "   - Cache MISS: ${LATENCY1}ms"
  echo "   - Cache HIT:  ${LATENCY2}ms"
  echo "   - Cache HIT:  ${LATENCY3}ms"
  echo "   - Improvement: ${IMPROVEMENT}% faster with cache"
  echo ""
fi

# Verify responses are identical
HASH1=$(echo "$SUMMARY1" | md5sum | cut -d' ' -f1)
HASH2=$(echo "$SUMMARY2" | md5sum | cut -d' ' -f1)
HASH3=$(echo "$SUMMARY3" | md5sum | cut -d' ' -f1)

if [ "$HASH1" = "$HASH2" ] && [ "$HASH2" = "$HASH3" ]; then
  echo "✅ Cache consistency verified (all responses identical)"
else
  echo "❌ Cache inconsistency detected"
fi

echo ""
echo "🎉 Cache testing complete!"
echo ""

# Check Docker logs for cache hits/misses
echo "📋 Checking logs for cache behavior..."
docker-compose logs snack-track-api | grep -E "(Cache HIT|Cache MISS)" | tail -10

