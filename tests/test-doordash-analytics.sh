#!/bin/bash

# DoorDash Wrapped Analytics Compatibility Test
# Verifies all analytics work correctly with DoorDash data

API_URL="${API_URL:-http://localhost:3000}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}📊 DoorDash Wrapped Analytics Test${NC}"
echo "======================================"
echo ""

PASSED=0
FAILED=0

test_pass() {
  PASSED=$((PASSED + 1))
  echo -e "${GREEN}✅ PASS:${NC} $1"
}

test_fail() {
  FAILED=$((FAILED + 1))
  echo -e "${RED}❌ FAIL:${NC} $1"
}

create_user() {
  local email="analytics-test-$(date +%s%N)@test.com"
  local response=$(curl -s -X POST "$API_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"TestPass123\"}")
  
  local user_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
  local token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)
  
  echo "$user_id|$token"
}

# Setup: Import DoorDash data
echo "Setting up test data..."
CREDS=$(create_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

if [ ! -f "MockDoorDashData/data_archive.zip" ]; then
  test_fail "DoorDash ZIP file not found"
  exit 1
fi

curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@MockDoorDashData/data_archive.zip" \
  -F "userId=$USER_ID" > /dev/null

echo "✅ Test data imported"
echo ""

# Get Wrapped Analytics
WRAPPED=$(curl -s -X GET "$API_URL/users/$USER_ID/summary?includeWrapped=true" \
  -H "Authorization: Bearer $TOKEN")

# Test 1: Wrapped Analytics Structure
echo "Test 1: Wrapped Analytics Structure..."
HAS_WRAPPED=$(echo "$WRAPPED" | python3 -c "import sys,json; print('wrappedAnalytics' in json.load(sys.stdin))" 2>/dev/null)

if [ "$HAS_WRAPPED" = "True" ]; then
  test_pass "Wrapped Analytics structure present"
else
  test_fail "Wrapped Analytics structure missing"
  exit 1
fi

# Test 2: Shame Analytics
echo ""
echo "Test 2: Shame Analytics..."
HAS_LATE_NIGHT=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('lateNightOrders' in d.get('wrappedAnalytics', {}).get('shame', {}))" 2>/dev/null)
HAS_LAZIEST_DAY=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('laziestDay' in d.get('wrappedAnalytics', {}).get('shame', {}))" 2>/dev/null)
HAS_STREAK=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('longestStreak' in d.get('wrappedAnalytics', {}).get('shame', {}))" 2>/dev/null)

if [ "$HAS_LATE_NIGHT" = "True" ] && [ "$HAS_LAZIEST_DAY" = "True" ] && [ "$HAS_STREAK" = "True" ]; then
  test_pass "All shame analytics present"
else
  test_fail "Missing shame analytics (lateNight: $HAS_LATE_NIGHT, laziestDay: $HAS_LAZIEST_DAY, streak: $HAS_STREAK)"
fi

# Test 3: Comparative Analytics
echo ""
echo "Test 3: Comparative Analytics..."
HAS_SPENT_YEAR=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('spentThisYear' in d.get('wrappedAnalytics', {}).get('comparative', {}))" 2>/dev/null)
HAS_MISSED_INVEST=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('missedInvestment' in d.get('wrappedAnalytics', {}).get('comparative', {}))" 2>/dev/null)
HAS_COST_PER_MEAL=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('costPerMeal' in d.get('wrappedAnalytics', {}).get('comparative', {}))" 2>/dev/null)

if [ "$HAS_SPENT_YEAR" = "True" ] && [ "$HAS_MISSED_INVEST" = "True" ] && [ "$HAS_COST_PER_MEAL" = "True" ]; then
  test_pass "All comparative analytics present"
else
  test_fail "Missing comparative analytics"
fi

# Test 4: Pattern Analytics
echo ""
echo "Test 4: Pattern Analytics..."
HAS_PEAK_HOUR=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('peakHungerHour' in d.get('wrappedAnalytics', {}).get('patterns', {}))" 2>/dev/null)
HAS_WEEKEND=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('weekendWarrior' in d.get('wrappedAnalytics', {}).get('patterns', {}))" 2>/dev/null)

if [ "$HAS_PEAK_HOUR" = "True" ] && [ "$HAS_WEEKEND" = "True" ]; then
  test_pass "All pattern analytics present"
else
  test_fail "Missing pattern analytics"
fi

# Test 5: Data Accuracy
echo ""
echo "Test 5: Data Accuracy Checks..."

# Check late night orders count is non-negative
LATE_NIGHT_COUNT=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('wrappedAnalytics', {}).get('shame', {}).get('lateNightOrders', {}).get('count', -1))" 2>/dev/null)
if [ "$LATE_NIGHT_COUNT" -ge 0 ]; then
  test_pass "Late night orders count is valid ($LATE_NIGHT_COUNT)"
else
  test_fail "Invalid late night orders count"
fi

# Check spent this year is non-negative
SPENT_YEAR=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('wrappedAnalytics', {}).get('comparative', {}).get('spentThisYear', {}).get('totalSpent', -1))" 2>/dev/null)
if [ "$SPENT_YEAR" -ge 0 ]; then
  test_pass "Spent this year is valid ($$SPENT_YEAR)"
else
  test_fail "Invalid spent this year value"
fi

# Check peak hour is valid (0-23)
PEAK_HOUR=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('wrappedAnalytics', {}).get('patterns', {}).get('peakHungerHour', {}).get('hour', -1))" 2>/dev/null)
if [ "$PEAK_HOUR" -ge 0 ] && [ "$PEAK_HOUR" -le 23 ]; then
  test_pass "Peak hour is valid ($PEAK_HOUR:00)"
else
  test_fail "Invalid peak hour value"
fi

# Summary
echo ""
echo "======================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"

if [ $FAILED -eq 0 ]; then
  echo -e "${GREEN}✅ All analytics tests passed!${NC}"
  exit 0
else
  exit 1
fi

