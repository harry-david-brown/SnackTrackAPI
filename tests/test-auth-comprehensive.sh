#!/bin/bash

# Comprehensive Authentication Test Suite
# Tests all authentication flows and edge cases

API_URL="http://localhost:3000"
PASS_COUNT=0
FAIL_COUNT=0

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "================================"
echo "🧪 Comprehensive Authentication Test Suite"
echo "================================"
echo ""

# Helper function to test endpoint
test_endpoint() {
    local test_name="$1"
    local expected_code="$2"
    local actual_code="$3"
    
    if [ "$actual_code" == "$expected_code" ]; then
        echo -e "${GREEN}✅ PASS${NC}: $test_name (HTTP $actual_code)"
        ((PASS_COUNT++))
    else
        echo -e "${RED}❌ FAIL${NC}: $test_name (Expected $expected_code, got $actual_code)"
        ((FAIL_COUNT++))
    fi
}

# Test 1: Register new user with valid credentials
echo -e "${YELLOW}Test 1: Register new user${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email": "testuser'$(date +%s)'@example.com", "password": "ValidPass123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
test_endpoint "Register new user" "201" "$HTTP_CODE"

if [ "$HTTP_CODE" == "201" ]; then
    ACCESS_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['accessToken'])" 2>/dev/null)
    REFRESH_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['refreshToken'])" 2>/dev/null)
    USER_ID=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['userId'])" 2>/dev/null)
    USER_EMAIL=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['email'])" 2>/dev/null)
    echo "   User ID: $USER_ID"
    echo "   Email: $USER_EMAIL"
fi
echo ""

# Test 2: Try to register with same email (should fail)
echo -e "${YELLOW}Test 2: Register duplicate email (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$USER_EMAIL\", \"password\": \"AnotherPass123\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject duplicate email" "400" "$HTTP_CODE"
echo ""

# Test 3: Register with weak password (should fail)
echo -e "${YELLOW}Test 3: Register with weak password (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email": "weak'$(date +%s)'@example.com", "password": "weak"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject weak password" "400" "$HTTP_CODE"
echo ""

# Test 4: Register without password (should fail)
echo -e "${YELLOW}Test 4: Register without password (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email": "nopass@example.com"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject missing password" "400" "$HTTP_CODE"
echo ""

# Test 5: Login with correct credentials
echo -e "${YELLOW}Test 5: Login with correct credentials${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$USER_EMAIL\", \"password\": \"ValidPass123\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
test_endpoint "Login successful" "200" "$HTTP_CODE"

if [ "$HTTP_CODE" == "200" ]; then
    NEW_ACCESS_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['accessToken'])" 2>/dev/null)
    echo "   New token received: ${NEW_ACCESS_TOKEN:0:20}..."
fi
echo ""

# Test 6: Login with wrong password (should fail)
echo -e "${YELLOW}Test 6: Login with wrong password (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\": \"$USER_EMAIL\", \"password\": \"WrongPassword123\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject wrong password" "401" "$HTTP_CODE"
echo ""

# Test 7: Login with non-existent email (should fail)
echo -e "${YELLOW}Test 7: Login with non-existent email (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "doesnotexist@example.com", "password": "SomePass123"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject non-existent user" "401" "$HTTP_CODE"
echo ""

# Test 8: Access protected route without token (should fail)
echo -e "${YELLOW}Test 8: Access protected route without token (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/users/$USER_ID/totalSpent")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject no token" "401" "$HTTP_CODE"
echo ""

# Test 9: Access protected route with valid token
echo -e "${YELLOW}Test 9: Access protected route with valid token${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/users/$USER_ID/totalSpent" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Allow valid token" "200" "$HTTP_CODE"
echo ""

# Test 10: Access another user's data (should fail - ownership validation)
echo -e "${YELLOW}Test 10: Access another user's data (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/users/00000000-0000-0000-0000-000000000000/totalSpent" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject unauthorized access" "403" "$HTTP_CODE"
echo ""

# Test 11: Access with invalid token format (should fail)
echo -e "${YELLOW}Test 11: Access with invalid token (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/users/$USER_ID/totalSpent" \
  -H "Authorization: Bearer invalid.token.here")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject invalid token" "401" "$HTTP_CODE"
echo ""

# Test 12: Refresh access token
echo -e "${YELLOW}Test 12: Refresh access token${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/refresh" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | sed '$d')
test_endpoint "Refresh token successful" "200" "$HTTP_CODE"

if [ "$HTTP_CODE" == "200" ]; then
    REFRESHED_TOKEN=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin)['accessToken'])" 2>/dev/null)
    echo "   Refreshed token: ${REFRESHED_TOKEN:0:20}..."
fi
echo ""

# Test 13: Refresh with invalid refresh token (should fail)
echo -e "${YELLOW}Test 13: Refresh with invalid token (should fail)${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/refresh" \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": "invalid.refresh.token"}')
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Reject invalid refresh token" "401" "$HTTP_CODE"
echo ""

# Test 14: Access user summary (protected route)
echo -e "${YELLOW}Test 14: Access user summary with token${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$API_URL/users/$USER_ID/summary" \
  -H "Authorization: Bearer $ACCESS_TOKEN")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Access user summary" "200" "$HTTP_CODE"
echo ""

# Test 15: Logout
echo -e "${YELLOW}Test 15: Logout${NC}"
RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL/auth/logout" \
  -H "Content-Type: application/json" \
  -d "{\"refreshToken\": \"$REFRESH_TOKEN\"}")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
test_endpoint "Logout successful" "200" "$HTTP_CODE"
echo ""

# Summary
echo "================================"
echo "📊 Test Summary"
echo "================================"
echo -e "${GREEN}Passed: $PASS_COUNT${NC}"
echo -e "${RED}Failed: $FAIL_COUNT${NC}"
echo "Total: $((PASS_COUNT + FAIL_COUNT))"
echo ""

if [ $FAIL_COUNT -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed!${NC}"
    exit 1
fi

