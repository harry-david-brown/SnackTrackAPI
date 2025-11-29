#!/bin/bash

# Gmail Integration Test Script
# Tests all Gmail integration endpoints

set -e  # Exit on error

# Configuration
BASE_URL="${API_URL:-http://localhost:3000}"
TEST_EMAIL="gmail-test-$(date +%s)@example.com"
TEST_PASSWORD="TestPassword123!"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Helper functions
print_header() {
    echo -e "\n${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}\n"
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ️  $1${NC}"
}

# Start tests
print_header "Gmail Integration Tests"
echo "Base URL: $BASE_URL"
echo "Test Email: $TEST_EMAIL"

# Test 1: Register a test user
print_header "Test 1: Register Test User"
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$TEST_EMAIL\",\"password\":\"$TEST_PASSWORD\"}")

ACCESS_TOKEN=$(echo "$REGISTER_RESPONSE" | jq -r '.accessToken')
USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.userId')

if [ "$ACCESS_TOKEN" != "null" ] && [ -n "$ACCESS_TOKEN" ]; then
    print_success "User registered successfully"
    echo "   User ID: $USER_ID"
    echo "   Access Token: ${ACCESS_TOKEN:0:20}..."
else
    print_error "Failed to register user"
    echo "$REGISTER_RESPONSE"
    exit 1
fi

# Test 2: Check Gmail connection status (should be disconnected)
print_header "Test 2: Check Gmail Status (Should be Disconnected)"
STATUS_RESPONSE=$(curl -s -X GET "$BASE_URL/gmail/status" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

CONNECTED=$(echo "$STATUS_RESPONSE" | jq -r '.connected')

if [ "$CONNECTED" == "false" ]; then
    print_success "Gmail status check successful (not connected)"
    echo "$STATUS_RESPONSE" | jq '.'
else
    print_error "Unexpected Gmail status"
    echo "$STATUS_RESPONSE"
fi

# Test 3: Try to import without connecting (should fail)
print_header "Test 3: Import Without Connection (Should Fail)"
IMPORT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/gmail/import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replaceExisting": false}')

HTTP_CODE=$(echo "$IMPORT_RESPONSE" | tail -n1)
RESPONSE_BODY=$(echo "$IMPORT_RESPONSE" | head -n-1)

if [ "$HTTP_CODE" == "400" ] || [ "$HTTP_CODE" == "401" ]; then
    print_success "Import correctly rejected (no Gmail connection)"
    echo "   HTTP Code: $HTTP_CODE"
else
    print_error "Import should have failed without Gmail connection"
    echo "   HTTP Code: $HTTP_CODE"
    echo "$RESPONSE_BODY"
fi

# Test 4: Get connection URL
print_header "Test 4: Gmail Connect URL"
print_info "To connect Gmail, open this URL in a browser (while logged in):"
echo -e "\n   ${GREEN}$BASE_URL/gmail/connect${NC}"
echo -e "\n   Or use curl to get the redirect URL:"
echo -e "   curl -i -H \"Authorization: Bearer $ACCESS_TOKEN\" \"$BASE_URL/gmail/connect\"\n"

print_info "Since this is a test environment, we'll simulate a connection..."

# Test 5: Simulate Gmail import with mock data (if mock mode is enabled)
print_header "Test 5: Test Import with Mock Data"
print_info "Note: This will only work if mock data mode is enabled in the application"

# Check if we can trigger an import (will use mock data if no real connection)
MOCK_IMPORT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/gmail/import" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"replaceExisting": false}')

MOCK_HTTP_CODE=$(echo "$MOCK_IMPORT_RESPONSE" | tail -n1)
MOCK_RESPONSE_BODY=$(echo "$MOCK_IMPORT_RESPONSE" | head -n-1)

if [ "$MOCK_HTTP_CODE" == "200" ]; then
    print_success "Mock import successful (or Gmail was connected)"
    echo "$MOCK_RESPONSE_BODY" | jq '.'
else
    print_info "Mock import not available (expected - need real Gmail connection)"
    echo "   HTTP Code: $MOCK_HTTP_CODE"
fi

# Test 6: Test disconnect endpoint
print_header "Test 6: Disconnect Gmail"
DISCONNECT_RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$BASE_URL/gmail/disconnect" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

DISCONNECT_HTTP_CODE=$(echo "$DISCONNECT_RESPONSE" | tail -n1)
DISCONNECT_BODY=$(echo "$DISCONNECT_RESPONSE" | head -n-1)

if [ "$DISCONNECT_HTTP_CODE" == "200" ]; then
    print_success "Gmail disconnected successfully"
    echo "$DISCONNECT_BODY" | jq '.'
else
    print_info "Disconnect response: HTTP $DISCONNECT_HTTP_CODE"
    echo "$DISCONNECT_BODY"
fi

# Test 7: Verify disconnection
print_header "Test 7: Verify Gmail Disconnected"
VERIFY_RESPONSE=$(curl -s -X GET "$BASE_URL/gmail/status" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

VERIFY_CONNECTED=$(echo "$VERIFY_RESPONSE" | jq -r '.connected')

if [ "$VERIFY_CONNECTED" == "false" ]; then
    print_success "Gmail successfully disconnected"
    echo "$VERIFY_RESPONSE" | jq '.'
else
    print_error "Gmail still appears to be connected"
    echo "$VERIFY_RESPONSE"
fi

# Test 8: Check authentication requirement
print_header "Test 8: Authentication Requirement"
NO_AUTH_RESPONSE=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL/gmail/status")

NO_AUTH_HTTP_CODE=$(echo "$NO_AUTH_RESPONSE" | tail -n1)

if [ "$NO_AUTH_HTTP_CODE" == "401" ]; then
    print_success "Endpoints correctly require authentication"
    echo "   HTTP Code: $NO_AUTH_HTTP_CODE"
else
    print_error "Endpoints should require authentication"
    echo "   HTTP Code: $NO_AUTH_HTTP_CODE"
fi

# Cleanup: Delete test user (optional)
print_header "Cleanup (Optional)"
print_info "Test user created: $TEST_EMAIL (ID: $USER_ID)"
print_info "You can delete this user via the admin API if needed:"
echo "   curl -X DELETE \"$BASE_URL/database/users/$USER_ID\" -H \"X-API-Key: your-api-key\""

# Summary
print_header "Test Summary"
print_success "All Gmail integration tests completed!"
echo ""
echo "Endpoints tested:"
echo "  ✅ GET  /gmail/status"
echo "  ✅ POST /gmail/import"
echo "  ✅ POST /gmail/disconnect"
echo "  ✅ Authentication requirements"
echo ""
echo "Manual test required:"
echo "  ⚠️  GET  /gmail/connect (requires browser interaction)"
echo "  ⚠️  GET  /gmail/callback (automatic redirect)"
echo ""
print_info "For full integration testing with real Gmail:"
echo "  1. Configure GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env"
echo "  2. Visit $BASE_URL/gmail/connect (while logged in)"
echo "  3. Authorize the application"
echo "  4. Run: POST /gmail/import"
echo ""

