#!/bin/bash

# DoorDash Platform Detection Test
# Tests various ZIP structures and CSV formats to ensure robust detection

API_URL="${API_URL:-http://localhost:3000}"

# Colors
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}🔍 DoorDash Platform Detection Test${NC}"
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
  local email="detection-test-$(date +%s%N)@test.com"
  local response=$(curl -s -X POST "$API_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"TestPass123\"}")
  
  local user_id=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
  local token=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)
  
  echo "$user_id|$token"
}

# Test 1: DoorDash ZIP with root-level CSV
echo "Test 1: DoorDash ZIP (root-level CSV)..."
if [ -f "MockDoorDashData/data_archive.zip" ]; then
  CREDS=$(create_user)
  USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
  TOKEN=$(echo "$CREDS" | cut -d'|' -f2)
  
  RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@MockDoorDashData/data_archive.zip" \
    -F "userId=$USER_ID")
  
  if echo "$RESPONSE" | grep -q "importedCount"; then
    COUNT=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
    
    # Check receipt type
    TYPE_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
      "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND receipt_type = 'doordash';" 2>/dev/null | tr -d ' ')
    
    if [ "$TYPE_COUNT" = "$COUNT" ] && [ "$COUNT" -gt 0 ]; then
      test_pass "Root-level DoorDash ZIP detected correctly ($COUNT receipts)"
    else
      test_fail "Root-level DoorDash ZIP detection failed"
    fi
  else
    test_fail "Root-level DoorDash ZIP import failed"
  fi
else
  test_fail "DoorDash ZIP file not found"
fi

# Test 2: DoorDash CSV direct import
echo ""
echo "Test 2: DoorDash CSV (direct import)..."
if [ -f "MockDoorDashData/data_archive/consumer_order_details.csv" ]; then
  CREDS=$(create_user)
  USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
  TOKEN=$(echo "$CREDS" | cut -d'|' -f2)
  
  RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@MockDoorDashData/data_archive/consumer_order_details.csv" \
    -F "userId=$USER_ID")
  
  if echo "$RESPONSE" | grep -q "importedCount"; then
    FILE_TYPE=$(echo "$RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin).get('fileType', ''))" 2>/dev/null)
    
    if [ "$FILE_TYPE" = "csv" ]; then
      test_pass "DoorDash CSV format detected correctly"
    else
      test_fail "DoorDash CSV format detection failed (got: $FILE_TYPE)"
    fi
  else
    test_fail "DoorDash CSV import failed"
  fi
else
  test_fail "DoorDash CSV file not found"
fi

# Test 3: Uber Eats ZIP (should not be detected as DoorDash)
echo ""
echo "Test 3: Uber Eats ZIP (should detect as Uber, not DoorDash)..."
if [ -f "MockUberData/Uber Data Request B18832D3.zip" ]; then
  CREDS=$(create_user)
  USER_ID=$(echo "$CREDS" | cut -d'|' -f1)
  TOKEN=$(echo "$CREDS" | cut -d'|' -f2)
  
  RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $TOKEN" \
    -F "csvFile=@MockUberData/Uber Data Request B18832D3.zip" \
    -F "userId=$USER_ID")
  
  if echo "$RESPONSE" | grep -q "importedCount"; then
    TYPE_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
      "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND receipt_type = 'uber_eats';" 2>/dev/null | tr -d ' ')
    
    DOORDASH_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
      "SELECT COUNT(*) FROM receipts WHERE user_id = '$USER_ID' AND receipt_type = 'doordash';" 2>/dev/null | tr -d ' ')
    
    if [ "$TYPE_COUNT" -gt 0 ] && [ "$DOORDASH_COUNT" = "0" ]; then
      test_pass "Uber Eats ZIP correctly detected as Uber (not DoorDash)"
    else
      test_fail "Uber Eats ZIP detection failed (Uber: $TYPE_COUNT, DoorDash: $DOORDASH_COUNT)"
    fi
  else
    test_fail "Uber Eats ZIP import failed"
  fi
else
  test_fail "Uber Eats ZIP file not found"
fi

# Summary
echo ""
echo "======================================"
echo -e "${GREEN}Passed: $PASSED${NC}"
echo -e "${RED}Failed: $FAILED${NC}"

if [ $FAILED -eq 0 ]; then
  exit 0
else
  exit 1
fi


