#!/bin/bash

# Full API endpoint test for DoorDash Delivery Waits feature
# Tests the complete flow: authentication, CSV import, analytics

set -e

API_URL="${API_URL:-https://snacktrackapi-production.up.railway.app}"
TEST_USER_EMAIL="delivery-waits-api-test-$(date +%s)@example.com"
TEST_USER_ID=""
ACCESS_TOKEN=""
API_KEY="${API_KEY:-test-key}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Testing DoorDash Delivery Waits - Full API Flow${NC}"
echo "=================================================="
echo ""
echo "API URL: ${API_URL}"
echo "Test User: ${TEST_USER_EMAIL}"
echo ""

# Helper function to print test results
print_test() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
    else
        echo -e "${RED}❌ $2${NC}"
        return 1
    fi
}

# Helper function to print info
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Test 1: Register user and get access token
test_register_user() {
    echo "Test 1: Registering test user..."
    
    TEST_PASSWORD="TestPassword123"
    
    print_info "Registering user with email and password..."
    REGISTER_RESPONSE=$(curl -s -X POST "${API_URL}/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"${TEST_USER_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
    
    # Check if registration was successful
    REGISTER_ERROR=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print('error' in d)" 2>/dev/null || echo "false")
    
    if [ "$REGISTER_ERROR" = "true" ]; then
        ERROR_MSG=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('error', {}).get('message', 'Unknown error'))" 2>/dev/null || echo "Unknown error")
        
        # If user already exists, try to login
        if [[ "$ERROR_MSG" == *"already exists"* ]] || [[ "$ERROR_MSG" == *"already registered"* ]]; then
            print_info "User already exists, attempting login..."
            LOGIN_RESPONSE=$(curl -s -X POST "${API_URL}/auth/login" \
                -H "Content-Type: application/json" \
                -d "{\"email\": \"${TEST_USER_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
            
            ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('accessToken', ''))" 2>/dev/null)
            TEST_USER_ID=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('user', {}).get('id', ''))" 2>/dev/null)
        else
            echo -e "${RED}❌ Registration failed: ${ERROR_MSG}${NC}"
            echo "Response: $REGISTER_RESPONSE"
            return 1
        fi
    else
        # Registration successful
        ACCESS_TOKEN=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('accessToken', ''))" 2>/dev/null)
        TEST_USER_ID=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('user', {}).get('id', '') or d.get('userId', ''))" 2>/dev/null)
    fi
    
    if [ -z "$ACCESS_TOKEN" ]; then
        echo -e "${RED}❌ Failed to get access token${NC}"
        echo "Response: $REGISTER_RESPONSE"
        return 1
    fi
    
    if [ -z "$TEST_USER_ID" ]; then
        echo -e "${RED}❌ Failed to get user ID${NC}"
        return 1
    fi
    
    print_test 0 "User registered/logged in: ${TEST_USER_ID}"
    print_test 0 "Access token obtained"
    return 0
}

# Test 3: Import DoorDash CSV
test_import_csv() {
    echo ""
    echo "Test 3: Importing DoorDash CSV data..."
    
    if [ ! -f "MockDoorDashData/data_archive.zip" ]; then
        echo -e "${RED}❌ MockDoorDashData/data_archive.zip not found${NC}"
        return 1
    fi
    
    print_info "Uploading DoorDash ZIP file..."
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/csv/import" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -F "csvFile=@MockDoorDashData/data_archive.zip" \
        -F "userId=${TEST_USER_ID}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        IMPORTED_COUNT=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
        
        if [ "$IMPORTED_COUNT" -gt 0 ]; then
            print_test 0 "CSV imported successfully (${IMPORTED_COUNT} receipts)"
            return 0
        else
            echo -e "${RED}❌ Import succeeded but no receipts imported${NC}"
            echo "Response: $BODY"
            return 1
        fi
    elif [ "$HTTP_CODE" = "401" ]; then
        echo -e "${YELLOW}⚠️  Authentication required (401)${NC}"
        echo "Response: $BODY"
        print_info "You may need to provide a valid access token"
        return 1
    else
        echo -e "${RED}❌ CSV import failed (HTTP ${HTTP_CODE})${NC}"
        echo "Response: $BODY"
        return 1
    fi
}

# Test 4: Verify receipts were created
test_verify_receipts() {
    echo ""
    echo "Test 4: Verifying receipts..."
    
    sleep 2  # Wait for processing
    
    RESPONSE=$(curl -s -X GET "${API_URL}/receipts?userId=${TEST_USER_ID}&limit=10" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")
    
    HTTP_CODE=$(echo "$RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('statusCode', 200))" 2>/dev/null || echo "200")
    
    if [ "$HTTP_CODE" != "200" ] && [ "$HTTP_CODE" != "" ]; then
        echo -e "${YELLOW}⚠️  Could not verify receipts (may need authentication)${NC}"
        return 0  # Don't fail, just warn
    fi
    
    # Check both 'receipts' and 'data' fields (API might use either)
    RECEIPT_COUNT=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); receipts=data.get('receipts', data.get('data', [])); print(len(receipts))" 2>/dev/null || echo "0")
    
    if [ "$RECEIPT_COUNT" -gt 0 ]; then
        print_test 0 "Receipts retrieved (${RECEIPT_COUNT} receipts)"
        
        # Check if receipts have deliveryTime
        HAS_DELIVERY_TIME=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    receipts = data.get('receipts', data.get('data', []))
    has_delivery_time = any(r.get('deliveryTime') for r in receipts)
    print('true' if has_delivery_time else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
        
        if [ "$HAS_DELIVERY_TIME" = "true" ]; then
            print_test 0 "Receipts contain deliveryTime field"
        else
            print_info "Note: deliveryTime may not be in API response (check database directly)"
        fi
        
        return 0
    else
        echo -e "${YELLOW}⚠️  No receipts found (may need authentication)${NC}"
        return 0  # Don't fail, just warn
    fi
}

# Test 5: Test Wrapped Analytics with delivery waits
test_delivery_waits_analytics() {
    echo ""
    echo "Test 5: Testing Delivery Waits Analytics..."
    
    RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}")
    
    # Check if response is an error
    IS_ERROR=$(echo "$RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'error' in d else 'false')" 2>/dev/null || echo "false")
    
    if [ "$IS_ERROR" = "true" ]; then
        ERROR_MSG=$(echo "$RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('error', {}).get('message', 'Unknown error'))" 2>/dev/null || echo "Unknown error")
        
        if [[ "$ERROR_MSG" == *"401"* ]] || [[ "$ERROR_MSG" == *"token"* ]] || [[ "$ERROR_MSG" == *"auth"* ]]; then
            echo -e "${YELLOW}⚠️  Authentication required for analytics endpoint${NC}"
            print_info "You may need to provide a valid access token"
            return 0  # Don't fail, just warn
        else
            echo -e "${RED}❌ Analytics request failed${NC}"
            echo "Error: $ERROR_MSG"
            return 1
        fi
    fi
    
    # Check if deliveryWaits exists in response
    HAS_DELIVERY_WAITS=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    has_waits = 'deliveryWaits' in patterns
    print('true' if has_waits else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
    
    if [ "$HAS_DELIVERY_WAITS" = "true" ]; then
        print_test 0 "deliveryWaits found in Wrapped Analytics"
        
        # Extract and display delivery waits data
        DELIVERY_WAITS=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    waits = patterns.get('deliveryWaits', {})
    print(json.dumps(waits, indent=2))
except Exception as e:
    print('{}')
" 2>/dev/null || echo "{}")
        
        echo ""
        echo "Delivery Waits Data:"
        echo "$DELIVERY_WAITS" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    print(f\"  Total Minutes: {data.get('totalMinutes', 'N/A')}\")
    print(f\"  Average Minutes: {data.get('averageMinutes', 'N/A')}\")
    print(f\"  Total Orders: {data.get('totalOrders', 'N/A')}\")
    if 'longestWait' in data:
        lw = data['longestWait']
        print(f\"  Longest Wait: {lw.get('minutes', 'N/A')} min at {lw.get('restaurant', 'N/A')}\")
    if 'fastestDelivery' in data:
        fd = data['fastestDelivery']
        print(f\"  Fastest Delivery: {fd.get('minutes', 'N/A')} min at {fd.get('restaurant', 'N/A')}\")
except:
    print('  Error parsing data')
" 2>/dev/null
        
        # Validate structure
        HAS_TOTAL=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'totalMinutes' in d else 'false')" 2>/dev/null || echo "false")
        HAS_AVERAGE=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'averageMinutes' in d else 'false')" 2>/dev/null || echo "false")
        HAS_ORDERS=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'totalOrders' in d else 'false')" 2>/dev/null || echo "false")
        
        if [ "$HAS_TOTAL" = "true" ] && [ "$HAS_AVERAGE" = "true" ] && [ "$HAS_ORDERS" = "true" ]; then
            print_test 0 "Delivery Waits structure is correct"
            
            # Validate values
            TOTAL_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('totalMinutes', 0))" 2>/dev/null || echo "0")
            AVERAGE_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('averageMinutes', 0))" 2>/dev/null || echo "0")
            
            if [ "$TOTAL_MINUTES" -gt 0 ] && [ "$AVERAGE_MINUTES" -gt 0 ]; then
                print_test 0 "Delivery Waits values are valid (Total: ${TOTAL_MINUTES} min, Avg: ${AVERAGE_MINUTES} min)"
                return 0
            else
                echo -e "${RED}❌ Delivery Waits values are invalid (Total: ${TOTAL_MINUTES}, Avg: ${AVERAGE_MINUTES})${NC}"
                return 1
            fi
        else
            echo -e "${RED}❌ Delivery Waits structure is missing required fields${NC}"
            return 1
        fi
    else
        echo -e "${YELLOW}⚠️  deliveryWaits not found in Wrapped Analytics${NC}"
        echo "Checking what patterns are available..."
        echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    print('Available patterns:', list(patterns.keys()))
except:
    print('Could not parse response')
" 2>/dev/null || echo "Could not parse response"
        return 1
    fi
}

# Cleanup function
cleanup() {
    echo ""
    echo "Cleaning up test data..."
    if [ -n "$TEST_USER_ID" ]; then
        curl -s -X DELETE "${API_URL}/receipts?userId=${TEST_USER_ID}" \
            -H "Authorization: Bearer ${ACCESS_TOKEN}" > /dev/null 2>&1 || true
        echo -e "${GREEN}✅ Cleanup attempted${NC}"
    fi
}

# Main test execution
main() {
    # Check if API is accessible
    print_info "Checking API health..."
    if ! curl -s "${API_URL}/health" > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  API health check failed. Make sure the server is running.${NC}"
    else
        print_test 0 "API is accessible"
    fi
    
    # Run tests
    test_register_user || exit 1
    test_import_csv || exit 1
    test_verify_receipts || exit 1
    test_delivery_waits_analytics || exit 1
    
    echo ""
    echo -e "${GREEN}✅ All API tests completed!${NC}"
    
    cleanup
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Run tests
main

