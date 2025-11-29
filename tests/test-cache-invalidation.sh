#!/bin/bash

# Test Cache Invalidation on CSV Upload
# Verifies that cache is cleared when user uploads new data

API_URL="http://localhost:3000"
UBER_ZIP="./MockUberData/Uber Data Request B18832D3.zip"

echo "🧪 Testing Cache Invalidation on CSV Upload"
echo "==========================================="
echo ""

# Step 1: Register a new user (unique email with timestamp)
echo "1️⃣  Registering test user..."
TIMESTAMP=$(date +%s)
TEST_EMAIL="invalidation-test-$TIMESTAMP@example.com"

REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"Test1234\"}")

USER_ID=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
ACCESS_TOKEN=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)

if [ -z "$USER_ID" ]; then
  echo "❌ Registration failed"
  exit 1
fi

echo "✅ User registered: $USER_ID"
echo ""

# Step 2: Get summary (should cache it with 0 receipts)
echo "2️⃣  Getting initial summary (0 receipts)..."
SUMMARY1=$(curl -s -X GET "$API_URL/users/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

RECEIPTS_BEFORE=$(echo "$SUMMARY1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('statistics', {}).get('totalReceipts', 0))" 2>/dev/null)
SPENT_BEFORE=$(echo "$SUMMARY1" | python3 -c "import sys,json; print(json.load(sys.stdin).get('statistics', {}).get('totalSpent', 0))" 2>/dev/null)

echo "📊 Before upload: $RECEIPTS_BEFORE receipts, \$$SPENT_BEFORE spent"
echo ""

# Step 3: Verify cache hit
echo "3️⃣  Getting summary again (should hit cache)..."
SUMMARY2=$(curl -s -X GET "$API_URL/users/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

echo "✅ Second request completed"
echo ""

# Step 4: Upload ZIP file
echo "4️⃣  Uploading Uber ZIP file..."
if [ ! -f "$UBER_ZIP" ]; then
  echo "❌ Uber ZIP file not found at: $UBER_ZIP"
  exit 1
fi

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "csvFile=@$UBER_ZIP" \
  -F "userId=$USER_ID")

IMPORTED=$(echo "$UPLOAD_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
echo "✅ Imported $IMPORTED receipts"
echo ""

# Step 5: Get summary again (should be cache MISS after invalidation)
echo "5️⃣  Getting summary after upload (cache should be invalidated)..."
SUMMARY3=$(curl -s -X GET "$API_URL/users/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

RECEIPTS_AFTER=$(echo "$SUMMARY3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('statistics', {}).get('totalReceipts', 0))" 2>/dev/null)
SPENT_AFTER=$(echo "$SUMMARY3" | python3 -c "import sys,json; print(json.load(sys.stdin).get('statistics', {}).get('totalSpent', 0))" 2>/dev/null)

echo "📊 After upload: $RECEIPTS_AFTER receipts, \$$SPENT_AFTER spent"
echo ""

# Step 6: Verify data changed
if [ "$RECEIPTS_BEFORE" != "$RECEIPTS_AFTER" ]; then
  echo "✅ Cache invalidation successful!"
  echo "   Receipts: $RECEIPTS_BEFORE → $RECEIPTS_AFTER"
  echo "   Total Spent: \$$SPENT_BEFORE → \$$SPENT_AFTER"
else
  echo "❌ Cache may not have been invalidated"
  echo "   Receipts unchanged: $RECEIPTS_BEFORE"
fi

echo ""
echo "📋 Checking logs for cache invalidation..."
docker-compose logs snack-track-api | grep -E "Invalidated" | tail -5
echo ""
echo "🎉 Test complete!"

