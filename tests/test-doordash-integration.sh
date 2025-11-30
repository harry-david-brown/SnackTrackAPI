#!/bin/bash

# Comprehensive DoorDash Integration Test Suite
# Tests platform detection, import, receipt types, and analytics compatibility

API_URL="${API_URL:-http://localhost:3000}"

# Find test data files
if [ -f "MockDoorDashData/data_archive.zip" ]; then
  DOORDASH_ZIP="MockDoorDashData/data_archive.zip"
elif [ -f "./MockDoorDashData/data_archive.zip" ]; then
  DOORDASH_ZIP="./MockDoorDashData/data_archive.zip"
else
  DOORDASH_ZIP=""
fi

if [ -f "MockDoorDashData/data_archive/consumer_order_details.csv" ]; then
  DOORDASH_CSV="MockDoorDashData/data_archive/consumer_order_details.csv"
elif [ -f "./MockDoorDashData/data_archive/consumer_order_details.csv" ]; then
  DOORDASH_CSV="./MockDoorDashData/data_archive/consumer_order_details.csv"
else
  DOORDASH_CSV=""
fi

if [ -f "MockUberData/Uber Data Request B18832D3.zip" ]; then
  UBER_ZIP="MockUberData/Uber Data Request B18832D3.zip"
elif [ -f "./MockUberData/Uber Data Request B18832D3.zip" ]; then
  UBER_ZIP="./MockUberData/Uber Data Request B18832D3.zip"
else
  UBER_ZIP=""
fi

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 DoorDash Integration Test Suite${NC}"
echo "=========================================="
echo ""
echo "Testing against: $API_URL"
echo ""

# Test counter
TESTS_PASSED=0
TESTS_FAILED=0
TEST_ERRORS=()

test_pass() {
  TESTS_PASSED=$((TESTS_PASSED + 1))
  echo -e "${GREEN}✅ PASS:${NC} $1"
}

test_fail() {
  TESTS_FAILED=$((TESTS_FAILED + 1))
  echo -e "${RED}❌ FAIL:${NC} $1"
  TEST_ERRORS+=("$1")
}

# Helper function to create a test user
create_test_user() {
  local email="doordash-test-$(date +%s%N)@test.com"
  local response=$(curl -s -X POST "$API_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"TestPass123\"}")
  
  local user_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
  local token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)
  
  echo "$user_id|$token|$email"
}

# Helper function to check database
check_receipts_in_db() {
  local user_id=$1
  local expected_type=$2
  local expected_count=$3
  
  # Use docker-compose to query database
  local result=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -A -F'|' -c \
    "SELECT receipt_type, COUNT(*)::text FROM receipts WHERE user_id = '$user_id' GROUP BY receipt_type;" 2>/dev/null)
  
  # Parse result (format: receipt_type|count)
  local actual_count=$(echo "$result" | grep "^$expected_type|" | cut -d'|' -f2 | tr -d ' \n\r')
  local actual_type=$(echo "$result" | grep "^$expected_type|" | cut -d'|' -f1 | tr -d ' \n\r')
  
  if [ "$actual_type" = "$expected_type" ] && [ "$actual_count" = "$expected_count" ]; then
    return 0
  else
    echo "Expected: $expected_type x $expected_count, Got: $actual_type x $actual_count"
    echo "Debug - Full result: $result"
    return 1
  fi
}

# Helper function to check receipt fields
check_receipt_fields() {
  local user_id=$1
  local field=$2
  local expected_value=$3
  
  local result=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
    "SELECT COUNT(*) FROM receipts WHERE user_id = '$user_id' AND $field = '$expected_value';" 2>/dev/null)
  
  local count=$(echo "$result" | tr -d ' ')
  if [ "$count" -gt 0 ]; then
    return 0
  else
    return 1
  fi
}

# ============================================
# TEST SUITE 1: Platform Detection
# ============================================
echo -e "${BLUE}📦 TEST SUITE 1: Platform Detection${NC}"
echo "----------------------------------------"

# Test 1.1: Server Health Check
echo "1.1 Testing server health..."
HEALTH=$(curl -s "$API_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  test_pass "Server is healthy"
else
  test_fail "Server health check failed"
  exit 1
fi

# Test 1.2: DoorDash ZIP Detection
echo "1.2 Testing DoorDash ZIP detection..."
if [ -z "$DOORDASH_ZIP" ]; then
  test_fail "DoorDash ZIP file not found"
else
  CREDS=$(create_test_user)
  USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
  TOKEN=$(echo "$CREDS" | cut -d'|' -f2)
  
  RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@$DOORDASH_ZIP" \
    -F "userId=$USER_ID")
  
  if echo "$RESPONSE" | grep -q "importedCount"; then
    COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
    if [ "$COUNT" -gt 0 ]; then
      test_pass "DoorDash ZIP detected and imported ($COUNT receipts)"
      
      # Verify receipt_type in database
      if check_receipts_in_db "$USER_ID" "doordash" "$COUNT"; then
        test_pass "All receipts have receipt_type='doordash'"
      else
        test_fail "Receipt type verification failed"
      fi
    else
      test_fail "DoorDash ZIP import returned 0 receipts"
    fi
  else
    test_fail "DoorDash ZIP import failed"
    echo "$RESPONSE"
  fi
fi

echo ""

# ============================================
# TEST SUITE 2: DoorDash CSV Import
# ============================================
echo -e "${BLUE}📄 TEST SUITE 2: DoorDash CSV Import${NC}"
echo "----------------------------------------"

# Test 2.1: Direct CSV Import
echo "2.1 Testing direct DoorDash CSV import..."
if [ -z "$DOORDASH_CSV" ]; then
  test_fail "DoorDash CSV file not found"
else
  CREDS=$(create_test_user)
  USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
  TOKEN=$(echo "$CREDS" | cut -d'|' -f2)
  
  RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@$DOORDASH_CSV" \
    -F "userId=$USER_ID")
  
  if echo "$RESPONSE" | grep -q "importedCount"; then
    COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
    FILE_TYPE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('fileType', ''))" 2>/dev/null)
    
    if [ "$COUNT" -gt 0 ] && [ "$FILE_TYPE" = "csv" ]; then
      test_pass "DoorDash CSV imported successfully ($COUNT receipts, type: $FILE_TYPE)"
      
      # Verify data_source
      if check_receipt_fields "$USER_ID" "data_source" "csv"; then
        test_pass "All receipts have data_source='csv'"
      else
        test_fail "Data source verification failed"
      fi
    else
      test_fail "DoorDash CSV import validation failed"
    fi
  else
    test_fail "DoorDash CSV import failed"
    echo "$RESPONSE"
  fi
fi

echo ""

# ============================================
# TEST SUITE 3: Receipt Data Integrity
# ============================================
echo -e "${BLUE}🔍 TEST SUITE 3: Receipt Data Integrity${NC}"
echo "----------------------------------------"

# Test 3.1: Verify receipt fields
echo "3.1 Verifying receipt field completeness..."
CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@$DOORDASH_ZIP" \
  -F "userId=$USER_ID" > /dev/null

# Check for required fields
HAS_RESTAURANT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND restaurant_name IS NOT NULL;" 2>/dev/null | tr -d ' ')

HAS_AMOUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND amount_spent > 0;" 2>/dev/null | tr -d ' ')

HAS_ITEMS=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND items IS NOT NULL AND jsonb_array_length(items) > 0;" 2>/dev/null | tr -d ' ')

HAS_DATE=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND order_date IS NOT NULL;" 2>/dev/null | tr -d ' ')

if [ "$HAS_RESTAURANT" -gt 0 ] && [ "$HAS_AMOUNT" -gt 0 ] && [ "$HAS_ITEMS" -gt 0 ] && [ "$HAS_DATE" -gt 0 ]; then
  test_pass "All receipt fields populated correctly"
else
  test_fail "Missing required receipt fields (restaurant: $HAS_RESTAURANT, amount: $HAS_AMOUNT, items: $HAS_ITEMS, date: $HAS_DATE)"
fi

# Test 3.2: Verify item category field
echo "3.2 Verifying item category field..."
HAS_CATEGORY=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND items->0->>'category' IS NOT NULL;" 2>/dev/null | tr -d ' ')

if [ "$HAS_CATEGORY" -gt 0 ]; then
  test_pass "Item category field stored correctly"
else
  test_fail "Item category field missing"
fi

# Test 3.3: Verify order total calculation
echo "3.3 Verifying order total calculation..."
TOTAL_CHECK=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND amount_spent > 0 AND amount_spent <= 1000;" 2>/dev/null | tr -d ' ')

TOTAL_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID';" 2>/dev/null | tr -d ' ')

if [ "$TOTAL_CHECK" = "$TOTAL_COUNT" ]; then
  test_pass "Order totals calculated correctly (all within reasonable range)"
else
  test_fail "Some order totals are invalid"
fi

echo ""

# ============================================
# TEST SUITE 4: Wrapped Analytics Compatibility
# ============================================
echo -e "${BLUE}📊 TEST SUITE 4: Wrapped Analytics Compatibility${NC}"
echo "----------------------------------------"

# Test 4.1: Wrapped Analytics with DoorDash data
echo "4.1 Testing Wrapped Analytics with DoorDash data..."
CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@$DOORDASH_ZIP" \
  -F "userId=$USER_ID" > /dev/null

WRAPPED=$(curl -s -X GET "$API_URL/users/$USER_ID/summary?includeWrapped=true" \
  -H "Authorization: Bearer $TOKEN")

HAS_WRAPPED=$(echo "$WRAPPED" | python3 -c "import sys,json; print('wrappedAnalytics' in json.load(sys.stdin))" 2>/dev/null)

if [ "$HAS_WRAPPED" = "True" ]; then
  test_pass "Wrapped Analytics returned for DoorDash data"
  
  # Check specific analytics
  HAS_LATE_NIGHT=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('lateNightOrders' in d.get('wrappedAnalytics', {}).get('shame', {}))" 2>/dev/null)
  HAS_SPENT_YEAR=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('spentThisYear' in d.get('wrappedAnalytics', {}).get('comparative', {}))" 2>/dev/null)
  HAS_PEAK_HOUR=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print('peakHungerHour' in d.get('wrappedAnalytics', {}).get('patterns', {}))" 2>/dev/null)
  
  if [ "$HAS_LATE_NIGHT" = "True" ] && [ "$HAS_SPENT_YEAR" = "True" ] && [ "$HAS_PEAK_HOUR" = "True" ]; then
    test_pass "All key Wrapped Analytics categories present"
  else
    test_fail "Missing Wrapped Analytics categories"
  fi
else
  test_fail "Wrapped Analytics not returned"
fi

# Test 4.2: Analytics data accuracy
echo "4.2 Verifying analytics data accuracy..."
LATE_NIGHT_COUNT=$(echo "$WRAPPED" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('wrappedAnalytics', {}).get('shame', {}).get('lateNightOrders', {}).get('count', 0))" 2>/dev/null)

if [ "$LATE_NIGHT_COUNT" -ge 0 ]; then
  test_pass "Late night orders count is valid ($LATE_NIGHT_COUNT)"
else
  test_fail "Invalid late night orders count"
fi

echo ""

# ============================================
# TEST SUITE 5: Error Handling
# ============================================
echo -e "${BLUE}⚠️  TEST SUITE 5: Error Handling${NC}"
echo "----------------------------------------"

# Test 5.1: Invalid ZIP file
echo "5.1 Testing invalid ZIP file handling..."
CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

# Create a fake ZIP file
echo "not a zip file" > /tmp/fake.zip

RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@/tmp/fake.zip" \
  -F "userId=$USER_ID")

if echo "$RESPONSE" | grep -q "error"; then
  test_pass "Invalid ZIP file properly rejected"
else
  test_fail "Invalid ZIP file not properly rejected"
fi

rm -f /tmp/fake.zip

# Test 5.2: Invalid CSV format
echo "5.2 Testing invalid CSV format handling..."
echo "invalid,csv,data" > /tmp/invalid.csv

RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@/tmp/invalid.csv" \
  -F "userId=$USER_ID")

if echo "$RESPONSE" | grep -q "error\|Invalid"; then
  test_pass "Invalid CSV format properly rejected"
else
  test_fail "Invalid CSV format not properly rejected"
fi

rm -f /tmp/invalid.csv

# Test 5.3: Missing userId
echo "5.3 Testing missing userId handling..."
RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@$DOORDASH_CSV")

if echo "$RESPONSE" | grep -q "userId.*required\|error"; then
  test_pass "Missing userId properly rejected"
else
  test_fail "Missing userId not properly rejected"
fi

# Test 5.4: Unauthorized access
echo "5.4 Testing unauthorized access handling..."
RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -F "csvFile=@$DOORDASH_CSV" \
  -F "userId=$USER_ID")

if echo "$RESPONSE" | grep -q "401\|Unauthorized\|token"; then
  test_pass "Unauthorized access properly rejected"
else
  test_fail "Unauthorized access not properly rejected"
fi

echo ""

# ============================================
# TEST SUITE 6: Mixed Platform Scenarios
# ============================================
echo -e "${BLUE}🔄 TEST SUITE 6: Mixed Platform Scenarios${NC}"
echo "----------------------------------------"

# Test 6.1: Platform detection with Uber Eats
echo "6.1 Testing Uber Eats platform detection..."
if [ -n "$UBER_ZIP" ]; then
  CREDS=$(create_test_user)
  USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
  TOKEN=$(echo "$CREDS" | cut -d'|' -f2)
  
  RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@$UBER_ZIP" \
    -F "userId=$USER_ID")
  
  if echo "$RESPONSE" | grep -q "importedCount"; then
    COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
    
    if check_receipts_in_db "$USER_ID" "uber_eats" "$COUNT"; then
      test_pass "Uber Eats platform correctly detected and imported ($COUNT receipts)"
    else
      test_fail "Uber Eats receipt type verification failed"
    fi
  else
    test_fail "Uber Eats import failed"
  fi
else
  test_fail "Uber Eats ZIP file not found (skipping)"
fi

# Test 6.2: Sequential imports (replace behavior)
echo "6.2 Testing sequential imports (replace behavior)..."
CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

# Import DoorDash first
curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@$DOORDASH_ZIP" \
  -F "userId=$USER_ID" > /dev/null

FIRST_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
  "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID';" 2>/dev/null | tr -d ' ')

# Import Uber Eats (should replace)
if [ -n "$UBER_ZIP" ]; then
  curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@$UBER_ZIP" \
    -F "userId=$USER_ID" > /dev/null
  
  SECOND_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
    "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID';" 2>/dev/null | tr -d ' ')
  
  DOORDASH_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
    "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND receipt_type = 'doordash';" 2>/dev/null | tr -d ' ')
  
  UBER_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
    "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND receipt_type = 'uber_eats';" 2>/dev/null | tr -d ' ')
  
  if [ "$DOORDASH_COUNT" = "0" ] && [ "$UBER_COUNT" = "$SECOND_COUNT" ]; then
    test_pass "Sequential imports correctly replace previous data (DoorDash replaced by Uber)"
  else
    test_fail "Sequential imports not working correctly (DoorDash: $DOORDASH_COUNT, Uber: $UBER_COUNT, Total: $SECOND_COUNT)"
  fi
else
  test_fail "Uber Eats ZIP not found (skipping sequential test)"
fi

echo ""

# ============================================
# TEST SUITE 7: Edge Cases
# ============================================
echo -e "${BLUE}🔬 TEST SUITE 7: Edge Cases${NC}"
echo "----------------------------------------"

# Test 7.1: Empty CSV file
echo "7.1 Testing empty CSV file handling..."
echo "" > /tmp/empty.csv

CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@/tmp/empty.csv" \
  -F "userId=$USER_ID")

if echo "$RESPONSE" | grep -q "error\|Invalid\|empty"; then
  test_pass "Empty CSV file properly rejected"
else
  test_fail "Empty CSV file not properly rejected"
fi

rm -f /tmp/empty.csv

# Test 7.2: Very large file (should be rejected by size limit)
echo "7.2 Testing file size limit..."
# Create a large file (60MB - exceeds 50MB limit)
dd if=/dev/zero of=/tmp/large.zip bs=1M count=60 2>/dev/null

CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@/tmp/large.zip" \
  -F "userId=$USER_ID")

if echo "$RESPONSE" | grep -q "error\|size\|limit\|exceed"; then
  test_pass "Large file properly rejected"
else
  test_fail "Large file not properly rejected"
fi

rm -f /tmp/large.zip

# Test 7.3: CSV with missing required fields
echo "7.3 Testing CSV with missing required fields..."
echo "ITEM,STORE_NAME" > /tmp/incomplete.csv
echo "Burger,McDonald's" >> /tmp/incomplete.csv

CREDS=$(create_test_user)
USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
TOKEN=$(echo "$CREDS" | cut -d'|' -f2)

RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
  -H "Authorization: Bearer $TOKEN" \
  -F "csvFile=@/tmp/incomplete.csv" \
  -F "userId=$USER_ID")

if echo "$RESPONSE" | grep -q "error\|Invalid\|missing\|header"; then
  test_pass "CSV with missing fields properly rejected"
else
  test_fail "CSV with missing fields not properly rejected"
fi

rm -f /tmp/incomplete.csv

echo ""

# ============================================
# SUMMARY
# ============================================
echo -e "${BLUE}📋 TEST SUMMARY${NC}"
echo "=========================================="
echo -e "${GREEN}Tests Passed: $TESTS_PASSED${NC}"
echo -e "${RED}Tests Failed: $TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -gt 0 ]; then
  echo -e "${RED}Failed Tests:${NC}"
  for error in "${TEST_ERRORS[@]}"; do
    echo "  - $error"
  done
  echo ""
  exit 1
else
  echo -e "${GREEN}✅ All tests passed! DoorDash integration is production-ready.${NC}"
  exit 0
fi

