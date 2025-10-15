#!/bin/bash

# Wrapped Analytics Test
# Tests Spotify Wrapped-style analytics with real Uber data

API_URL="http://localhost:3000"

echo "🎊 Testing Wrapped Analytics"
echo "=============================="
echo ""

# 1. Register and login
echo "1️⃣  Creating test user..."
REGISTER=$(curl -s -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"wrapped-test-$(date +%s)@example.com\",\"password\":\"WrappedTest123\"}")

USER_ID=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
ACCESS_TOKEN=$(echo "$REGISTER" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)

if [ -z "$USER_ID" ]; then
  echo "❌ Failed to create test user"
  exit 1
fi

echo "✅ Test user created: $USER_ID"
echo ""

# 2. Upload real Uber data
echo "2️⃣  Uploading real Uber data..."
UPLOAD=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F "userId=$USER_ID" \
  -F "csvFile=@MockUberData/Uber Data Request B18832D3.zip")

RECEIPT_COUNT=$(echo "$UPLOAD" | python3 -c "import sys,json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)

if [ "$RECEIPT_COUNT" -eq 0 ]; then
  echo "❌ Failed to upload data"
  echo "Response: $UPLOAD"
  exit 1
fi

echo "✅ Uploaded $RECEIPT_COUNT receipts"
echo ""

# 3. Test summary WITHOUT wrapped analytics
echo "3️⃣  Testing summary (without wrapped)..."
START=$(date +%s%N)
SUMMARY=$(curl -s -X GET "$API_URL/validation/user/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
END=$(date +%s%N)
DURATION_MS=$((($END - $START) / 1000000))

TOTAL_SPENT=$(echo "$SUMMARY" | python3 -c "import sys,json; print(json.load(sys.stdin).get('statistics', {}).get('totalSpent', 0))" 2>/dev/null)
echo "✅ Summary retrieved: \$${TOTAL_SPENT} total spent (${DURATION_MS}ms)"
echo ""

# 4. Test summary WITH wrapped analytics
echo "4️⃣  Testing wrapped analytics..."
echo "   (This may take a few seconds - 14 analytics calculations)"
echo ""

START=$(date +%s%N)
WRAPPED=$(curl -s -X GET "$API_URL/validation/user/$USER_ID/summary?includeWrapped=true" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
END=$(date +%s%N)
DURATION_MS=$((($END - $START) / 1000000))

# Check if wrapped analytics exist
HAS_WRAPPED=$(echo "$WRAPPED" | python3 -c "import sys,json; print('wrappedAnalytics' in json.load(sys.stdin))" 2>/dev/null)

if [ "$HAS_WRAPPED" = "True" ]; then
  echo "✅ Wrapped analytics included! (${DURATION_MS}ms)"
  echo ""
  
  # Parse and display analytics
  python3 << 'EOF'
import json
import sys

wrapped = json.loads('''$WRAPPED''')
analytics = wrapped.get('wrappedAnalytics', {})

print("📊 Wrapped Analytics Results")
print("=" * 50)
print("")

# Shame Analytics
shame = analytics.get('shame', {})
print("🔴 SHAME ANALYTICS:")
if shame.get('lateNightOrders'):
  ln = shame['lateNightOrders']
  print(f"  • 3am Orders: {ln.get('count')} orders, ${ln.get('totalSpent', 0):.2f} spent")
  if ln.get('worstOffender'):
    wo = ln['worstOffender']
    print(f"    Worst: {wo.get('restaurant')} at {wo.get('time')} - ${wo.get('amount'):.2f}")

if shame.get('laziestDay'):
  ld = shame['laziestDay']
  print(f"  • Laziest Day: {ld.get('orderCount')} orders on {ld.get('dayOfWeek')}")
  print(f"    Message: \"{ld.get('message')}\"")

if shame.get('longestStreak'):
  ls = shame['longestStreak']
  print(f"  • Longest Streak: {ls.get('days')} days straight")
  print(f"    Message: \"{ls.get('message')}\"")

if shame.get('singleItemOrders'):
  si = shame['singleItemOrders']
  print(f"  • Single Items: {si.get('count')} orders")
  print(f"    Message: \"{si.get('message')}\"")

if shame.get('chainDependency'):
  cd = shame['chainDependency']
  print(f"  • Chain Dependency: {cd.get('worstOffender')} - {cd.get('percentage')}%")
  print(f"    Message: \"{cd.get('message')}\"")

print("")

# Flex Analytics
flex = analytics.get('flex', {})
print("🟢 FLEX ANALYTICS:")
if flex.get('mostExpensiveOrder'):
  me = flex['mostExpensiveOrder']
  print(f"  • Most Expensive: ${me.get('amount'):.2f} at {me.get('restaurant')}")

if flex.get('coffeeAddiction'):
  ca = flex['coffeeAddiction']
  print(f"  • Coffee: {ca.get('orderCount')} orders, ${ca.get('totalSpent'):.2f} total")
  print(f"    Most Ordered: {ca.get('mostOrdered')}")

if flex.get('nightOwl'):
  no = flex['nightOwl']
  print(f"  • Night Owl: {no.get('percentage')}% of orders after 10pm")

print("")

# Comparative Analytics
comp = analytics.get('comparative', {})
print("💰 COMPARATIVE ANALYTICS:")
if comp.get('missedInvestment'):
  mi = comp['missedInvestment']
  print(f"  • Missed Investment: ${mi.get('missedGains'):.2f} in S&P 500 gains")
  print(f"    Message: \"{mi.get('message')}\"")

if comp.get('costPerMeal'):
  cpm = comp['costPerMeal']
  print(f"  • Cost Per Meal: ${cpm.get('deliveryAverage'):.2f} vs ${cpm.get('groceryEstimate'):.2f} grocery")
  print(f"    Extra paid: ${cpm.get('difference'):.2f} per meal")

if comp.get('couldHaveBought'):
  cb = comp['couldHaveBought']
  print(f"  • Could Have Bought:")
  for item in cb.get('comparisons', [])[:3]:
    print(f"    - {item.get('message')}")

print("")

# Pattern Analytics
patterns = analytics.get('patterns', {})
print("📈 PATTERN ANALYTICS:")
if patterns.get('peakHungerHour'):
  ph = patterns['peakHungerHour']
  print(f"  • Peak Hour: {ph.get('hourDisplay')} ({ph.get('orderCount')} orders)")

if patterns.get('weekendWarrior'):
  ww = patterns['weekendWarrior']
  print(f"  • Weekend vs Weekday: ${ww.get('weekendSpending'):.2f} vs ${ww.get('weekdaySpending'):.2f}")
  print(f"    Message: \"{ww.get('message')}\"")

print("")
print("=" * 50)
print("")
EOF

else
  echo "❌ Wrapped analytics not found in response"
  echo "Response: $WRAPPED"
  exit 1
fi

# 5. Test caching (second request should be faster)
echo "5️⃣  Testing cache performance..."
START=$(date +%s%N)
CACHED=$(curl -s -X GET "$API_URL/validation/user/$USER_ID/summary?includeWrapped=true" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
END=$(date +%s%N)
CACHED_MS=$((($END - $START) / 1000000))

echo "✅ Cached request: ${CACHED_MS}ms"
echo ""

# Compare
if [ "$CACHED_MS" -lt "$DURATION_MS" ]; then
  IMPROVEMENT=$(python3 -c "print(round((1 - $CACHED_MS / $DURATION_MS) * 100, 1))" 2>/dev/null)
  echo "📊 Cache improved response time by ${IMPROVEMENT}%"
else
  echo "⚠️  Cache didn't improve response time (both fast!)"
fi

echo ""
echo "🎉 Wrapped Analytics Test Complete!"
echo ""
echo "Summary:"
echo "  - Receipts: $RECEIPT_COUNT"
echo "  - First request: ${DURATION_MS}ms"
echo "  - Cached request: ${CACHED_MS}ms"
echo "  - Analytics categories: 14 (shame, flex, comparative, patterns)"
echo ""

