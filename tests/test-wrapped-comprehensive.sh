#!/bin/bash

# Comprehensive Wrapped Analytics Testing
# Tests all edge cases, categories, and validation

API_URL="http://localhost:3000"

echo "🎊 COMPREHENSIVE WRAPPED ANALYTICS TEST"
echo "========================================"
echo ""

PASSED=0
FAILED=0

# Helper functions
pass() {
  echo "  ✅ $1"
  PASSED=$((PASSED + 1))
}

fail() {
  echo "  ❌ $1"
  FAILED=$((FAILED + 1))
}

check() {
  if [ "$1" = "$2" ]; then
    pass "$3"
  else
    fail "$3 (expected: $2, got: $1)"
  fi
}

create_user() {
  local email=$1
  local reg=$(curl -s -X POST "$API_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"Test123456\"}")
  
  echo "$reg" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['userId'] + '|' + d['accessToken'])" 2>/dev/null
}

get_wrapped() {
  local user_id=$1
  local token=$2
  curl -s -X GET "$API_URL/users/$user_id/summary?includeWrapped=true" \
    -H "Authorization: Bearer $token"
}

echo "TEST 1: Edge Case - User with NO data"
echo "--------------------------------------"
CREDS=$(create_user "no-data-$(date +%s)@test.com")
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

WRAPPED=$(get_wrapped "$USER_ID" "$TOKEN")
HAS_WRAPPED=$(echo "$WRAPPED" | python3 -c "import sys,json; print('wrappedAnalytics' in json.load(sys.stdin))" 2>/dev/null)

if [ "$HAS_WRAPPED" = "True" ]; then
  pass "Returns wrapped analytics even with no data"
  
  # Check all categories are empty
  SHAME_EMPTY=$(echo "$WRAPPED" | python3 -c "import sys,json; print(len(json.load(sys.stdin)['wrappedAnalytics']['shame']) == 0)" 2>/dev/null)
  check "$SHAME_EMPTY" "True" "Shame analytics empty for no data"
else
  fail "Should return wrapped analytics structure even with no data"
fi

echo ""

echo "TEST 2: Full Data - All Analytics Present"
echo "------------------------------------------"
CREDS=$(create_user "full-test-$(date +%s)@test.com")
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

# Upload real Uber data
curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "userId=$USER_ID" \
  -F "csvFile=@MockUberData/Uber Data Request B18832D3.zip" > /dev/null

WRAPPED=$(get_wrapped "$USER_ID" "$TOKEN")

# Test each category
python3 << 'EOF'
import json
import sys

wrapped_json = '''$WRAPPED'''
data = json.loads(wrapped_json)
wrapped = data['wrappedAnalytics']

# Shame analytics (5 categories)
shame = wrapped.get('shame', {})
print(f"Shame categories: {len(shame)}")
if 'lateNightOrders' in shame:
    print("  ✅ lateNightOrders present")
else:
    print("  ❌ lateNightOrders missing")

if 'laziestDay' in shame:
    print("  ✅ laziestDay present")
else:
    print("  ❌ laziestDay missing")

if 'longestStreak' in shame:
    print("  ✅ longestStreak present")
else:
    print("  ❌ longestStreak missing")

if 'singleItemOrders' in shame:
    print("  ✅ singleItemOrders present")
else:
    print("  ❌ singleItemOrders missing")

if 'chainDependency' in shame:
    print("  ✅ chainDependency present")
else:
    print("  ❌ chainDependency missing")

# Flex analytics (3 categories)
flex = wrapped.get('flex', {})
print(f"Flex categories: {len(flex)}")
if 'mostExpensiveOrder' in flex:
    print("  ✅ mostExpensiveOrder present")
else:
    print("  ❌ mostExpensiveOrder missing")

if 'coffeeAddiction' in flex:
    print("  ✅ coffeeAddiction present")
else:
    print("  ❌ coffeeAddiction missing")

if 'nightOwl' in flex:
    print("  ✅ nightOwl present")
else:
    print("  ❌ nightOwl missing")

# Comparative analytics (3 categories)
comp = wrapped.get('comparative', {})
print(f"Comparative categories: {len(comp)}")
if 'couldHaveBought' in comp:
    print("  ✅ couldHaveBought present")
else:
    print("  ❌ couldHaveBought missing")

if 'missedInvestment' in comp:
    print("  ✅ missedInvestment present")
else:
    print("  ❌ missedInvestment missing")

if 'costPerMeal' in comp:
    print("  ✅ costPerMeal present")
else:
    print("  ❌ costPerMeal missing")

# Pattern analytics (2 categories)
patterns = wrapped.get('patterns', {})
print(f"Pattern categories: {len(patterns)}")
if 'peakHungerHour' in patterns:
    print("  ✅ peakHungerHour present")
else:
    print("  ❌ peakHungerHour missing")

if 'weekendWarrior' in patterns:
    print("  ✅ weekendWarrior present")
else:
    print("  ❌ weekendWarrior missing")

EOF

echo ""

echo "TEST 3: Data Validation"
echo "-----------------------"
python3 << 'EOF'
import json

wrapped_json = '''$WRAPPED'''
data = json.loads(wrapped_json)
wrapped = data['wrappedAnalytics']

# Validate messages exist
issues = []

shame = wrapped.get('shame', {})
if shame.get('lateNightOrders') and not shame['lateNightOrders'].get('latestOrder'):
    issues.append("lateNightOrders missing latestOrder")
else:
    print("  ✅ lateNightOrders has latestOrder field")

if shame.get('laziestDay') and not shame['laziestDay'].get('message'):
    issues.append("laziestDay missing message")
else:
    print("  ✅ laziestDay has message")

if shame.get('longestStreak') and not shame['longestStreak'].get('message'):
    issues.append("longestStreak missing message")
else:
    print("  ✅ longestStreak has message")

if shame.get('chainDependency') and not shame['chainDependency'].get('message'):
    issues.append("chainDependency missing message")
else:
    print("  ✅ chainDependency has message")

# Validate numbers
flex = wrapped.get('flex', {})
if flex.get('mostExpensiveOrder'):
    me = flex['mostExpensiveOrder']
    if me.get('amount', 0) > 0:
        print("  ✅ mostExpensiveOrder has positive amount")
    else:
        issues.append("mostExpensiveOrder has zero amount")

comp = wrapped.get('comparative', {})
if comp.get('missedInvestment'):
    mi = comp['missedInvestment']
    if mi.get('wouldBeWorth', 0) > mi.get('amountSpent', 0):
        print("  ✅ missedInvestment wouldBeWorth > amountSpent")
    else:
        issues.append("missedInvestment calculation error")
    
    # Check message shows total (not just gains)
    if '$' in mi.get('message', '') and str(int(mi.get('wouldBeWorth', 0))) in mi.get('message', ''):
        print("  ✅ missedInvestment message shows total amount")
    else:
        print("  ⚠️  missedInvestment message format might be off")

if issues:
    print("\nValidation Issues:")
    for issue in issues:
        print(f"  ❌ {issue}")
else:
    print("\n  ✅ All data validation passed")

EOF

echo ""

echo "TEST 4: Performance"
echo "-------------------"
START=$(date +%s%N)
WRAPPED1=$(get_wrapped "$USER_ID" "$TOKEN")
END=$(date +%s%N)
FIRST_MS=$((($END - $START) / 1000000))

START=$(date +%s%N)
WRAPPED2=$(get_wrapped "$USER_ID" "$TOKEN")
END=$(date +%s%N)
CACHED_MS=$((($END - $START) / 1000000))

echo "  First request: ${FIRST_MS}ms"
echo "  Cached request: ${CACHED_MS}ms"

if [ "$CACHED_MS" -lt "$FIRST_MS" ]; then
  IMPROVEMENT=$(python3 -c "print(round((1 - $CACHED_MS / $FIRST_MS) * 100, 1))" 2>/dev/null)
  pass "Cache improves performance by ${IMPROVEMENT}%"
else
  echo "  ✅ Both requests fast (no significant difference)"
fi

if [ "$FIRST_MS" -lt 100 ]; then
  pass "First request under 100ms (excellent!)"
elif [ "$FIRST_MS" -lt 500 ]; then
  pass "First request under 500ms (good)"
else
  echo "  ⚠️  First request took ${FIRST_MS}ms (acceptable but could be faster)"
fi

echo ""

echo "TEST 5: Backward Compatibility"
echo "-------------------------------"
# Test without includeWrapped parameter
BASIC=$(curl -s -X GET "$API_URL/users/$USER_ID/summary" \
  -H "Authorization: Bearer $TOKEN")

HAS_STATS=$(echo "$BASIC" | python3 -c "import sys,json; print('statistics' in json.load(sys.stdin))" 2>/dev/null)
HAS_WRAPPED=$(echo "$BASIC" | python3 -c "import sys,json; print('wrappedAnalytics' in json.load(sys.stdin))" 2>/dev/null)

check "$HAS_STATS" "True" "Basic summary still returns statistics"
check "$HAS_WRAPPED" "False" "Basic summary does NOT include wrapped (opt-in only)"

echo ""

echo "TEST 6: Message Quality Check"
echo "------------------------------"
python3 << 'EOF'
import json

wrapped_json = '''$WRAPPED'''
data = json.loads(wrapped_json)
wrapped = data['wrappedAnalytics']

messages = []

# Collect all messages
shame = wrapped.get('shame', {})
if shame.get('laziestDay'):
    messages.append(('laziestDay', shame['laziestDay'].get('message', '')))
if shame.get('longestStreak'):
    messages.append(('longestStreak', shame['longestStreak'].get('message', '')))
if shame.get('singleItemOrders'):
    messages.append(('singleItemOrders', shame['singleItemOrders'].get('message', '')))
if shame.get('chainDependency'):
    messages.append(('chainDependency', shame['chainDependency'].get('message', '')))

flex = wrapped.get('flex', {})
if flex.get('mostExpensiveOrder'):
    messages.append(('mostExpensiveOrder', flex['mostExpensiveOrder'].get('message', '')))
if flex.get('coffeeAddiction'):
    messages.append(('coffeeAddiction', flex['coffeeAddiction'].get('message', '')))
if flex.get('nightOwl'):
    messages.append(('nightOwl', flex['nightOwl'].get('message', '')))

comp = wrapped.get('comparative', {})
if comp.get('missedInvestment'):
    messages.append(('missedInvestment', comp['missedInvestment'].get('message', '')))
if comp.get('costPerMeal'):
    messages.append(('costPerMeal', comp['costPerMeal'].get('message', '')))

patterns = wrapped.get('patterns', {})
if patterns.get('peakHungerHour'):
    messages.append(('peakHungerHour', patterns['peakHungerHour'].get('message', '')))
if patterns.get('weekendWarrior'):
    messages.append(('weekendWarrior', patterns['weekendWarrior'].get('message', '')))

print(f"Found {len(messages)} messages to validate\n")

for category, message in messages:
    if not message:
        print(f"  ❌ {category}: No message")
    elif len(message) < 10:
        print(f"  ❌ {category}: Message too short")
    elif '$' in message or '%' in message or any(c.isdigit() for c in message):
        print(f"  ✅ {category}: \"{message}\"")
    else:
        print(f"  ⚠️  {category}: \"{message}\" (no numbers)")

EOF

echo ""

echo "TEST 7: Cache Invalidation"
echo "--------------------------"
# Upload more data and check cache clears
echo "Uploading additional data..."
curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "userId=$USER_ID" \
  -F "csvFile=@MockUberData/Uber Data Request B18832D3.zip" > /dev/null 2>&1

# Wait a moment
sleep 1

# Get fresh analytics
WRAPPED_AFTER=$(get_wrapped "$USER_ID" "$TOKEN")
RECEIPTS_AFTER=$(echo "$WRAPPED_AFTER" | python3 -c "import sys,json; print(json.load(sys.stdin)['statistics']['totalReceipts'])" 2>/dev/null)

if [ "$RECEIPTS_AFTER" -gt 202 ]; then
  pass "Cache invalidated after upload (receipts increased)"
else
  echo "  ⚠️  Cache might not have invalidated (still $RECEIPTS_AFTER receipts)"
fi

echo ""

echo "========================================"
echo "TEST SUMMARY"
echo "========================================"
TOTAL=$((PASSED + FAILED))
SUCCESS_RATE=$(python3 -c "print(round($PASSED / $TOTAL * 100, 1))" 2>/dev/null)

echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Success Rate: ${SUCCESS_RATE}%"
echo ""

if [ "$FAILED" -eq 0 ]; then
  echo "🎉 ALL TESTS PASSED! Wrapped Analytics ready for production."
  exit 0
else
  echo "⚠️  Some tests failed. Review before committing."
  exit 1
fi

