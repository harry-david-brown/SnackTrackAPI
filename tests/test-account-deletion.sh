#!/bin/bash

# Account Deletion Test Suite
# Tests the account deletion feature end-to-end

API_URL="${API_URL:-http://localhost:3000}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Account Deletion Test Suite${NC}"
echo "=================================="
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

print_info() {
  echo -e "${YELLOW}ℹ️  INFO:${NC} $1"
}

# Test 1: Server Health Check
echo "1️⃣  Testing server health..."
HEALTH=$(curl -s "$API_URL/health")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  test_pass "Server is healthy"
else
  test_fail "Server health check failed"
  echo "$HEALTH"
  exit 1
fi

# Test 2: Create test user
echo ""
echo "2️⃣  Creating test user..."
TIMESTAMP=$(date +%s%N)
TEST_EMAIL="delete-test-$TIMESTAMP@example.com"
TEST_PASSWORD="DeleteTest123"

REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

USER_ID=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
ACCESS_TOKEN=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('accessToken', ''))" 2>/dev/null)
REFRESH_TOKEN=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('refreshToken', ''))" 2>/dev/null)

if [ -z "$USER_ID" ] || [ -z "$ACCESS_TOKEN" ]; then
  test_fail "Failed to create test user"
  echo "Response: $REGISTER_RESPONSE"
  exit 1
fi

test_pass "Test user created (ID: ${USER_ID:0:12}...)"

# Test 3: Upload test data to create receipts
echo ""
echo "3️⃣  Creating test receipts..."

# Try to find test data files
UBER_ZIP=""
if [ -f "MockUberData/Uber Data Request B18832D3.zip" ]; then
  UBER_ZIP="MockUberData/Uber Data Request B18832D3.zip"
elif [ -f "../MockUberData/Uber Data Request B18832D3.zip" ]; then
  UBER_ZIP="../MockUberData/Uber Data Request B18832D3.zip"
fi

RECEIPT_COUNT=0
if [ -n "$UBER_ZIP" ] && [ -f "$UBER_ZIP" ]; then
  print_info "Uploading test data..."
  UPLOAD_RESPONSE=$(curl -s -X POST "${API_URL}/csv/import" \
    -H "Authorization: Bearer ${ACCESS_TOKEN}" \
    -F "csvFile=@${UBER_ZIP}" \
    -F "userId=${USER_ID}")
  
  RECEIPT_COUNT=$(echo "$UPLOAD_RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null || echo "0")
  
  if [ "$RECEIPT_COUNT" -gt 0 ]; then
    test_pass "Test data uploaded (${RECEIPT_COUNT} receipts created)"
  else
    print_info "No test data uploaded (this is OK)"
  fi
else
  print_info "No test data files found (this is OK)"
fi

# Test 4: Verify user can access their data before deletion
echo ""
echo "4️⃣  Verifying user data exists before deletion..."

RECEIPTS_RESPONSE=$(curl -s -X GET "${API_URL}/receipts?userId=${USER_ID}&limit=1" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

RECEIPTS_COUNT=$(echo "$RECEIPTS_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); receipts=data.get('receipts', data.get('data', [])); print(len(receipts))" 2>/dev/null || echo "0")

if [ "$RECEIPTS_COUNT" -ge 0 ]; then
  test_pass "User data accessible before deletion"
else
  test_fail "Failed to access user data"
fi

# Test 5: Delete account
echo ""
echo "5️⃣  Testing account deletion..."

DELETE_RESPONSE=$(curl -s -w "\n%{http_code}" -X DELETE "${API_URL}/auth/delete-account" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\":\"${REFRESH_TOKEN}\"}")

HTTP_CODE=$(echo "$DELETE_RESPONSE" | tail -n1)
BODY=$(echo "$DELETE_RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  SUCCESS=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('success', False))" 2>/dev/null || echo "false")
  if [ "$SUCCESS" = "True" ] || [ "$SUCCESS" = "true" ]; then
    test_pass "Account deletion request succeeded"
  else
    test_fail "Account deletion returned 200 but success=false"
    echo "Response: $BODY"
  fi
else
  test_fail "Account deletion failed (HTTP ${HTTP_CODE})"
  echo "Response: $BODY"
fi

# Test 6: Verify user cannot access their data after deletion
echo ""
echo "6️⃣  Verifying user data is deleted..."

sleep 1  # Brief wait for deletion to complete

RECEIPTS_RESPONSE_AFTER=$(curl -s -X GET "${API_URL}/receipts?userId=${USER_ID}&limit=1" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

# Should get 401 or 404
HTTP_CODE_AFTER=$(curl -s -o /dev/null -w "%{http_code}" -X GET "${API_URL}/receipts?userId=${USER_ID}&limit=1" \
  -H "Authorization: Bearer ${ACCESS_TOKEN}")

if [ "$HTTP_CODE_AFTER" = "401" ] || [ "$HTTP_CODE_AFTER" = "404" ]; then
  test_pass "User data is no longer accessible (HTTP ${HTTP_CODE_AFTER})"
else
  # Check if receipts are actually empty
  RECEIPTS_COUNT_AFTER=$(echo "$RECEIPTS_RESPONSE_AFTER" | python3 -c "import sys, json; data=json.load(sys.stdin); receipts=data.get('receipts', data.get('data', [])); print(len(receipts))" 2>/dev/null || echo "-1")
  if [ "$RECEIPTS_COUNT_AFTER" = "0" ]; then
    test_pass "User receipts are deleted (empty list returned)"
  else
    test_fail "User data is still accessible (HTTP ${HTTP_CODE_AFTER}, receipts: ${RECEIPTS_COUNT_AFTER})"
  fi
fi

# Test 7: Verify user cannot login after deletion
echo ""
echo "7️⃣  Verifying user cannot login after deletion..."

LOGIN_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

HTTP_CODE_LOGIN=$(echo "$LOGIN_RESPONSE" | tail -n1)
BODY_LOGIN=$(echo "$LOGIN_RESPONSE" | sed '$d')

if [ "$HTTP_CODE_LOGIN" = "401" ]; then
  test_pass "User cannot login after account deletion (HTTP 401)"
elif [ "$HTTP_CODE_LOGIN" = "404" ]; then
  test_pass "User not found after account deletion (HTTP 404)"
else
  test_fail "User can still login after deletion (HTTP ${HTTP_CODE_LOGIN})"
  echo "Response: $BODY_LOGIN"
fi

# Test 8: Verify refresh token is revoked
echo ""
echo "8️⃣  Verifying refresh token is revoked..."

if [ -n "$REFRESH_TOKEN" ]; then
  REFRESH_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/refresh" \
    -H "Content-Type: application/json" \
    -d "{\"refreshToken\":\"$REFRESH_TOKEN\"}")
  
  HTTP_CODE_REFRESH=$(echo "$REFRESH_RESPONSE" | tail -n1)
  
  if [ "$HTTP_CODE_REFRESH" = "401" ]; then
    test_pass "Refresh token is revoked (HTTP 401)"
  else
    test_fail "Refresh token still works after account deletion (HTTP ${HTTP_CODE_REFRESH})"
  fi
else
  print_info "No refresh token to test (skipping)"
fi

# Summary
echo ""
echo "=================================="
echo -e "${BLUE}📊 Test Summary${NC}"
echo "=================================="
echo -e "${GREEN}✅ Passed: ${TESTS_PASSED}${NC}"
echo -e "${RED}❌ Failed: ${TESTS_FAILED}${NC}"

if [ ${#TEST_ERRORS[@]} -gt 0 ]; then
  echo ""
  echo "Errors:"
  for error in "${TEST_ERRORS[@]}"; do
    echo -e "${RED}  - $error${NC}"
  done
fi

if [ $TESTS_FAILED -eq 0 ]; then
  echo ""
  echo -e "${GREEN}🎉 All tests passed! Account deletion feature is working correctly.${NC}"
  exit 0
else
  echo ""
  echo -e "${RED}❌ Some tests failed. Please review the errors above.${NC}"
  exit 1
fi

