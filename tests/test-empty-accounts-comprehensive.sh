#!/bin/bash

# Comprehensive test suite for empty account handling
# Tests both DoorDash and Uber Eats accounts with no orders

set -e

API_URL="${API_URL:-http://localhost:3000}"
TEST_USER_EMAIL="test-empty-accounts-$(date +%s)@test.com"
TEST_PASSWORD="Test-Password-123"
USER_ID=""
ACCESS_TOKEN=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

print_test() {
    echo -e "${BLUE}🧪 TEST: $1${NC}"
}

print_success() {
    echo -e "${GREEN}✅ PASS: $1${NC}"
}

print_error() {
    echo -e "${RED}❌ FAIL: $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ️  INFO: $1${NC}"
}

# Cleanup function
cleanup() {
    if [ ! -z "$USER_ID" ] && [ ! -z "$ACCESS_TOKEN" ]; then
        print_info "Cleaning up test user..."
        curl -s -X DELETE "$API_URL/database/users/$USER_ID" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -H "X-API-Key: $API_KEY" > /dev/null || true
    fi
}
trap cleanup EXIT

# Check API health
print_test "Checking API health..."
if ! curl -s -f "$API_URL/health" > /dev/null; then
    print_error "API health check failed. Is the server running at $API_URL?"
    exit 1
fi
print_success "API is healthy"

# Register test user
print_test "Registering test user..."
REGISTER_RESPONSE=$(curl -s -X POST "$API_URL/auth/register" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d "{
        \"email\": \"$TEST_USER_EMAIL\",
        \"password\": \"$TEST_PASSWORD\"
    }")

if echo "$REGISTER_RESPONSE" | jq -e '.error' > /dev/null 2>&1; then
    print_error "User registration failed: $(echo $REGISTER_RESPONSE | jq -r '.error')"
    exit 1
fi

USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.userId')
if [ -z "$USER_ID" ] || [ "$USER_ID" = "null" ]; then
    print_error "Failed to get userId from registration"
    exit 1
fi
print_success "User registered: $USER_ID"

# Login to get access token
print_test "Logging in..."
LOGIN_RESPONSE=$(curl -s -X POST "$API_URL/auth/login" \
    -H "Content-Type: application/json" \
    -H "X-API-Key: $API_KEY" \
    -d "{
        \"email\": \"$TEST_USER_EMAIL\",
        \"password\": \"$TEST_PASSWORD\"
    }")

ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | jq -r '.accessToken')
if [ -z "$ACCESS_TOKEN" ] || [ "$ACCESS_TOKEN" = "null" ]; then
    print_error "Failed to get access token"
    exit 1
fi
print_success "Logged in successfully"

# ============================================================================
# TEST 1: DoorDash ZIP with consumer_profile_details.csv (no orders)
# ============================================================================
print_test "TEST 1: DoorDash ZIP with consumer_profile_details.csv (no orders)"

print_info "Creating DoorDash ZIP with profile_details.csv..."
cat > /tmp/consumer_profile_details.csv << 'EOF'
"FIRST_NAME","LAST_NAME","EMAIL","PHONE_NUMBER","DATE_JOINED","DEFAULT_ADDRESS","CONSUMER_LAST_DELIVERY_TIME","SUBMARKET_NAME","NUM_DELIVERIES","NUM_STORES","EDIT_TYPE","OLD_VALUE","WORK_EMAIL_ADDRESS"
"John","Doe","john@example.com","+1234567890","2024-01-01 00:00:00","123 Main St","\N","New York",\N,\N,"\N","\N","\N"
EOF

cd /tmp
zip -q test-doordash-profile.zip consumer_profile_details.csv
rm consumer_profile_details.csv

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-API-Key: $API_KEY" \
    -F "csvFile=@/tmp/test-doordash-profile.zip" \
    -F "userId=$USER_ID")

ERROR_MESSAGE=$(echo "$UPLOAD_RESPONSE" | jq -r '.error // empty')
ERROR_DETAILS=$(echo "$UPLOAD_RESPONSE" | jq -r '.details[0] // empty')

if [ "$ERROR_MESSAGE" != "No valid orders found in file" ]; then
    print_error "Expected 'No valid orders found in file', got: $ERROR_MESSAGE"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

print_success "DoorDash profile ZIP correctly returns 'No valid orders found in file'"
rm -f /tmp/test-doordash-profile.zip

# ============================================================================
# TEST 2: Uber Eats ZIP with no CSV file (empty account)
# ============================================================================
print_test "TEST 2: Uber Eats ZIP with no CSV file (empty account)"

print_info "Creating Uber Eats ZIP with only folder structure (no CSV)..."
cd /tmp
mkdir -p "Uber Data/Eats"
zip -q test-uber-empty.zip "Uber Data/Eats/"
rm -rf "Uber Data"

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-API-Key: $API_KEY" \
    -F "csvFile=@/tmp/test-uber-empty.zip" \
    -F "userId=$USER_ID")

ERROR_MESSAGE=$(echo "$UPLOAD_RESPONSE" | jq -r '.error // empty')

if [ "$ERROR_MESSAGE" != "No valid orders found in file" ]; then
    print_error "Expected 'No valid orders found in file', got: $ERROR_MESSAGE"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

print_success "Uber Eats empty ZIP correctly returns 'No valid orders found in file'"
rm -f /tmp/test-uber-empty.zip

# ============================================================================
# TEST 3: Uber Eats ZIP with empty CSV (headers only)
# ============================================================================
print_test "TEST 3: Uber Eats ZIP with empty CSV (headers only)"

print_info "Creating Uber Eats ZIP with empty CSV (headers only)..."
cat > /tmp/user_orders-0.csv << 'EOF'
Restaurant_Name,Request_Time_Local,Final_Delivery_Time_Local,Order_Status,Item_Name,Item_quantity,Customizations,Customization_Cost_Local,Special_Instructions,Item_Price,Order_Price,Currency
EOF

cd /tmp
mkdir -p "Uber Data/Eats"
mv user_orders-0.csv "Uber Data/Eats/"
zip -q test-uber-headers-only.zip "Uber Data/Eats/user_orders-0.csv"
rm -rf "Uber Data"

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-API-Key: $API_KEY" \
    -F "csvFile=@/tmp/test-uber-headers-only.zip" \
    -F "userId=$USER_ID")

ERROR_MESSAGE=$(echo "$UPLOAD_RESPONSE" | jq -r '.error // empty')

if [ "$ERROR_MESSAGE" != "No valid orders found in file" ]; then
    print_error "Expected 'No valid orders found in file', got: $ERROR_MESSAGE"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

print_success "Uber Eats headers-only ZIP correctly returns 'No valid orders found in file'"
rm -f /tmp/test-uber-headers-only.zip

# ============================================================================
# TEST 4: DoorDash ZIP with valid orders (should still work)
# ============================================================================
print_test "TEST 4: DoorDash ZIP with valid orders (regression test)"

print_info "Creating DoorDash ZIP with valid order data..."
cat > /tmp/consumer_order_details.csv << 'EOF'
ITEM,CATEGORY,STORE_NAME,UNIT_PRICE,QUANTITY,SUBTOTAL,CREATED_AT,DELIVERY_TIME,DELIVERY_ADDRESS
Burger,Food,McDonald's,5.99,1,5.99,2024-01-01 12:00:00,2024-01-01 12:30:00,123 Main St
Fries,Food,McDonald's,2.99,1,2.99,2024-01-01 12:00:00,2024-01-01 12:30:00,123 Main St
EOF

cd /tmp
zip -q test-doordash-valid.zip consumer_order_details.csv
rm consumer_order_details.csv

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-API-Key: $API_KEY" \
    -F "csvFile=@/tmp/test-doordash-valid.zip" \
    -F "userId=$USER_ID")

IMPORTED_COUNT=$(echo "$UPLOAD_RESPONSE" | jq -r '.importedCount // 0')
ERROR_MESSAGE=$(echo "$UPLOAD_RESPONSE" | jq -r '.error // empty')

if [ ! -z "$ERROR_MESSAGE" ]; then
    print_error "Expected successful import, got error: $ERROR_MESSAGE"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

if [ "$IMPORTED_COUNT" != "1" ]; then
    print_error "Expected 1 receipt imported, got: $IMPORTED_COUNT"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

print_success "DoorDash valid ZIP still works correctly (imported $IMPORTED_COUNT receipt)"
rm -f /tmp/test-doordash-valid.zip

# ============================================================================
# TEST 5: Uber Eats ZIP with valid orders (should still work)
# ============================================================================
print_test "TEST 5: Uber Eats ZIP with valid orders (regression test)"

print_info "Creating Uber Eats ZIP with valid order data..."
cat > /tmp/user_orders-0.csv << 'EOF'
Restaurant_Name,Request_Time_Local,Final_Delivery_Time_Local,Order_Status,Item_Name,Item_quantity,Customizations,Customization_Cost_Local,Special_Instructions,Item_Price,Order_Price,Currency
McDonald's,2024-01-01 12:00:00,2024-01-01 12:30:00,completed,Burger,1,,0.00,,5.99,8.98,USD
McDonald's,2024-01-01 12:00:00,2024-01-01 12:30:00,completed,Fries,1,,0.00,,2.99,8.98,USD
EOF

cd /tmp
mkdir -p "Uber Data/Eats"
mv user_orders-0.csv "Uber Data/Eats/"
zip -q test-uber-valid.zip "Uber Data/Eats/user_orders-0.csv"
rm -rf "Uber Data"

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-API-Key: $API_KEY" \
    -F "csvFile=@/tmp/test-uber-valid.zip" \
    -F "userId=$USER_ID")

IMPORTED_COUNT=$(echo "$UPLOAD_RESPONSE" | jq -r '.importedCount // 0')
ERROR_MESSAGE=$(echo "$UPLOAD_RESPONSE" | jq -r '.error // empty')

if [ ! -z "$ERROR_MESSAGE" ]; then
    print_error "Expected successful import, got error: $ERROR_MESSAGE"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

if [ "$IMPORTED_COUNT" != "1" ]; then
    print_error "Expected 1 receipt imported, got: $IMPORTED_COUNT"
    echo "Full response: $UPLOAD_RESPONSE"
    exit 1
fi

print_success "Uber Eats valid ZIP still works correctly (imported $IMPORTED_COUNT receipt)"
rm -f /tmp/test-uber-valid.zip

# ============================================================================
# TEST 6: Verify error message format includes hint
# ============================================================================
print_test "TEST 6: Verify error message format includes hint"

print_info "Re-testing DoorDash profile ZIP to verify error format..."
cat > /tmp/consumer_profile_details.csv << 'EOF'
"FIRST_NAME","LAST_NAME","EMAIL","PHONE_NUMBER","DATE_JOINED","DEFAULT_ADDRESS","CONSUMER_LAST_DELIVERY_TIME","SUBMARKET_NAME","NUM_DELIVERIES","NUM_STORES","EDIT_TYPE","OLD_VALUE","WORK_EMAIL_ADDRESS"
"Jane","Smith","jane@example.com","+1234567890","2024-01-01 00:00:00","456 Oak St","\N","Los Angeles",\N,\N,"\N","\N","\N"
EOF

cd /tmp
zip -q test-doordash-profile2.zip consumer_profile_details.csv
rm consumer_profile_details.csv

UPLOAD_RESPONSE=$(curl -s -X POST "$API_URL/csv/import" \
    -H "Authorization: Bearer $ACCESS_TOKEN" \
    -H "X-API-Key: $API_KEY" \
    -F "csvFile=@/tmp/test-doordash-profile2.zip" \
    -F "userId=$USER_ID")

ERROR_MESSAGE=$(echo "$UPLOAD_RESPONSE" | jq -r '.error // empty')
HINT=$(echo "$UPLOAD_RESPONSE" | jq -r '.hint // empty')

if [ "$ERROR_MESSAGE" != "No valid orders found in file" ]; then
    print_error "Expected 'No valid orders found in file', got: $ERROR_MESSAGE"
    exit 1
fi

if [ -z "$HINT" ]; then
    print_error "Expected hint in response, but got none"
    exit 1
fi

print_success "Error response includes correct error message and hint"
rm -f /tmp/test-doordash-profile2.zip

# ============================================================================
# All tests passed!
# ============================================================================
echo ""
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ ALL TESTS PASSED!${NC}"
echo -e "${GREEN}════════════════════════════════════════════════════════════${NC}"
echo ""
echo "Summary:"
echo "  ✅ DoorDash profile_details.csv (no orders) - handled correctly"
echo "  ✅ Uber Eats ZIP with no CSV - handled correctly"
echo "  ✅ Uber Eats ZIP with headers only - handled correctly"
echo "  ✅ DoorDash valid orders - still works (regression test)"
echo "  ✅ Uber Eats valid orders - still works (regression test)"
echo "  ✅ Error message format - includes hint"
echo ""
print_success "All features working perfectly! Ready for production."

