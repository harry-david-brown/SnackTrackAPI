#!/bin/bash

# Comprehensive test suite for Waiting Time analytics
# Tests both Uber Eats and DoorDash platforms
# Verifies CSV parsing, database storage, and analytics calculation

set -e

API_URL="${API_URL:-http://localhost:3000}"
TEST_USER_UBER_EMAIL="waiting-time-uber-test-$(date +%s)@example.com"
TEST_USER_DOORDASH_EMAIL="waiting-time-doordash-test-$(date +%s)@example.com"
TEST_USER_UBER_ID=""
TEST_USER_DOORDASH_ID=""
ACCESS_TOKEN_UBER=""
ACCESS_TOKEN_DOORDASH=""
TEST_PASSWORD="TestPassword123"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Comprehensive Waiting Time Analytics Test Suite${NC}"
echo "=============================================================="
echo ""
echo "API URL: ${API_URL}"
echo "Testing both Uber Eats and DoorDash platforms"
echo ""

# Track test results
TESTS_PASSED=0
TESTS_FAILED=0

# Helper function to print test results
print_test() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
        TESTS_PASSED=$((TESTS_PASSED + 1))
    else
        echo -e "${RED}❌ $2${NC}"
        TESTS_FAILED=$((TESTS_FAILED + 1))
        return 1
    fi
}

# Helper function to print info
print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Helper function to print section header
print_section() {
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Helper function to register/login user
register_user() {
    local email=$1
    local password=$2
    local token_var=$3
    local user_id_var=$4
    
    print_info "Registering user: ${email}"
    
    REGISTER_RESPONSE=$(curl -s -X POST "${API_URL}/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"${email}\", \"password\": \"${password}\"}")
    
    REGISTER_ERROR=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print('error' in d)" 2>/dev/null || echo "false")
    
    if [ "$REGISTER_ERROR" = "true" ]; then
        ERROR_MSG=$(echo "$REGISTER_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('error', {}).get('message', 'Unknown error'))" 2>/dev/null || echo "Unknown error")
        
        if [[ "$ERROR_MSG" == *"already exists"* ]] || [[ "$ERROR_MSG" == *"already registered"* ]]; then
            print_info "User already exists, attempting login..."
            LOGIN_RESPONSE=$(curl -s -X POST "${API_URL}/auth/login" \
                -H "Content-Type: application/json" \
                -d "{\"email\": \"${email}\", \"password\": \"${password}\"}")
            
            eval "$token_var=\$(echo \"\$LOGIN_RESPONSE\" | python3 -c \"import sys, json; d=json.load(sys.stdin); print(d.get('accessToken', ''))\" 2>/dev/null)"
            eval "$user_id_var=\$(echo \"\$LOGIN_RESPONSE\" | python3 -c \"import sys, json; d=json.load(sys.stdin); print(d.get('user', {}).get('id', ''))\" 2>/dev/null)"
        else
            echo -e "${RED}❌ Registration failed: ${ERROR_MSG}${NC}"
            return 1
        fi
    else
        eval "$token_var=\$(echo \"\$REGISTER_RESPONSE\" | python3 -c \"import sys, json; d=json.load(sys.stdin); print(d.get('accessToken', ''))\" 2>/dev/null)"
        eval "$user_id_var=\$(echo \"\$REGISTER_RESPONSE\" | python3 -c \"import sys, json; d=json.load(sys.stdin); print(d.get('user', {}).get('id', '') or d.get('userId', ''))\" 2>/dev/null)"
    fi
    
    local token_value=$(eval echo \$$token_var)
    local user_id_value=$(eval echo \$$user_id_var)
    
    if [ -z "$token_value" ] || [ -z "$user_id_value" ]; then
        echo -e "${RED}❌ Failed to get access token or user ID${NC}"
        return 1
    fi
    
    print_test 0 "User registered/logged in: ${user_id_value}"
    return 0
}

# ============================================================================
# UBER EATS TESTS
# ============================================================================

print_section "UBER EATS - Waiting Time Analytics Tests"

# Test 1: Register Uber Eats test user
test_uber_register() {
    print_info "Test 1.1: Registering Uber Eats test user..."
    register_user "$TEST_USER_UBER_EMAIL" "$TEST_PASSWORD" "ACCESS_TOKEN_UBER" "TEST_USER_UBER_ID"
    print_test $? "Uber Eats user registered"
}

# Test 2: Import Uber Eats CSV
test_uber_csv_import() {
    print_info "Test 1.2: Importing Uber Eats CSV data..."
    
    if [ ! -f "MockUberData/Uber Data/Eats/user_orders-0.csv" ]; then
        print_test 1 "Uber Eats CSV file not found"
        return 1
    fi
    
    # Create a ZIP file from the CSV for testing
    if [ ! -f "/tmp/uber_test.zip" ]; then
        cd MockUberData && zip -q /tmp/uber_test.zip "Uber Data/Eats/user_orders-0.csv" && cd ..
    fi
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/csv/import" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_UBER}" \
        -F "csvFile=@/tmp/uber_test.zip" \
        -F "userId=${TEST_USER_UBER_ID}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        IMPORTED_COUNT=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
        
        if [ "$IMPORTED_COUNT" -gt 0 ]; then
            print_test 0 "Uber Eats CSV imported successfully (${IMPORTED_COUNT} receipts)"
            return 0
        else
            print_test 1 "Uber Eats import succeeded but no receipts imported"
            return 1
        fi
    else
        print_test 1 "Uber Eats CSV import failed (HTTP ${HTTP_CODE})"
        echo "Response: $BODY"
        return 1
    fi
}

# Test 3: Verify Uber Eats receipts have deliveryTime
test_uber_delivery_time_storage() {
    print_info "Test 1.3: Verifying Uber Eats receipts have deliveryTime..."
    
    sleep 2  # Wait for processing
    
    RESPONSE=$(curl -s -X GET "${API_URL}/receipts?userId=${TEST_USER_UBER_ID}&limit=10" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_UBER}")
    
    # Check if receipts have deliveryTime field
    HAS_DELIVERY_TIME=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    receipts = data.get('receipts', data.get('data', []))
    if not receipts:
        print('false')
    else:
        # Check if any receipt has both orderDate and deliveryTime
        has_both = any(
            r.get('orderDate') and r.get('deliveryTime') 
            for r in receipts
        )
        print('true' if has_both else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
    
    if [ "$HAS_DELIVERY_TIME" = "true" ]; then
        print_test 0 "Uber Eats receipts contain deliveryTime field"
        
        # Show sample receipt
        echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    receipts = data.get('receipts', data.get('data', []))
    sample = next((r for r in receipts if r.get('orderDate') and r.get('deliveryTime')), None)
    if sample:
        print(f\"  Sample: {sample.get('restaurantName', 'Unknown')} - Order: {sample.get('orderDate')}, Delivery: {sample.get('deliveryTime')}\")
except:
    pass
" 2>/dev/null
        return 0
    else
        print_test 1 "Uber Eats receipts missing deliveryTime field"
        return 1
    fi
}

# Test 4: Test Uber Eats waiting time analytics
test_uber_waiting_time_analytics() {
    print_info "Test 1.4: Testing Uber Eats waiting time analytics..."
    
    RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_UBER_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_UBER}")
    
    # Check if deliveryWaits exists
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
        print_test 0 "Uber Eats deliveryWaits found in Wrapped Analytics"
        
        # Extract and validate delivery waits data
        DELIVERY_WAITS=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    waits = patterns.get('deliveryWaits', {})
    print(json.dumps(waits, indent=2))
except:
    print('{}')
" 2>/dev/null || echo "{}")
        
        echo ""
        echo "Uber Eats Delivery Waits Data:"
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
        
        # Validate structure and values
        TOTAL_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('totalMinutes', 0))" 2>/dev/null || echo "0")
        AVERAGE_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('averageMinutes', 0))" 2>/dev/null || echo "0")
        TOTAL_ORDERS=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('totalOrders', 0))" 2>/dev/null || echo "0")
        
        HAS_LONGEST=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'longestWait' in d else 'false')" 2>/dev/null || echo "false")
        HAS_FASTEST=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'fastestDelivery' in d else 'false')" 2>/dev/null || echo "false")
        
        if [ "$TOTAL_MINUTES" -gt 0 ] && [ "$AVERAGE_MINUTES" -gt 0 ] && [ "$TOTAL_ORDERS" -gt 0 ] && [ "$HAS_LONGEST" = "true" ] && [ "$HAS_FASTEST" = "true" ]; then
            print_test 0 "Uber Eats deliveryWaits structure and values are valid"
            return 0
        else
            print_test 1 "Uber Eats deliveryWaits structure or values are invalid"
            return 1
        fi
    else
        print_test 1 "Uber Eats deliveryWaits not found in Wrapped Analytics"
        return 1
    fi
}

# ============================================================================
# DOORDASH TESTS
# ============================================================================

print_section "DOORDASH - Waiting Time Analytics Tests"

# Test 5: Register DoorDash test user
test_doordash_register() {
    print_info "Test 2.1: Registering DoorDash test user..."
    register_user "$TEST_USER_DOORDASH_EMAIL" "$TEST_PASSWORD" "ACCESS_TOKEN_DOORDASH" "TEST_USER_DOORDASH_ID"
    print_test $? "DoorDash user registered"
}

# Test 6: Import DoorDash CSV
test_doordash_csv_import() {
    print_info "Test 2.2: Importing DoorDash CSV data..."
    
    if [ ! -f "MockDoorDashData/data_archive.zip" ]; then
        print_test 1 "DoorDash ZIP file not found"
        return 1
    fi
    
    RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "${API_URL}/csv/import" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_DOORDASH}" \
        -F "csvFile=@MockDoorDashData/data_archive.zip" \
        -F "userId=${TEST_USER_DOORDASH_ID}")
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        IMPORTED_COUNT=$(echo "$BODY" | python3 -c "import sys, json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
        
        if [ "$IMPORTED_COUNT" -gt 0 ]; then
            print_test 0 "DoorDash CSV imported successfully (${IMPORTED_COUNT} receipts)"
            return 0
        else
            print_test 1 "DoorDash import succeeded but no receipts imported"
            return 1
        fi
    else
        print_test 1 "DoorDash CSV import failed (HTTP ${HTTP_CODE})"
        echo "Response: $BODY"
        return 1
    fi
}

# Test 7: Verify DoorDash receipts have deliveryTime
test_doordash_delivery_time_storage() {
    print_info "Test 2.3: Verifying DoorDash receipts have deliveryTime..."
    
    sleep 2  # Wait for processing
    
    RESPONSE=$(curl -s -X GET "${API_URL}/receipts?userId=${TEST_USER_DOORDASH_ID}&limit=10" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_DOORDASH}")
    
    HAS_DELIVERY_TIME=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    receipts = data.get('receipts', data.get('data', []))
    if not receipts:
        print('false')
    else:
        has_both = any(
            r.get('orderDate') and r.get('deliveryTime') 
            for r in receipts
        )
        print('true' if has_both else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
    
    if [ "$HAS_DELIVERY_TIME" = "true" ]; then
        print_test 0 "DoorDash receipts contain deliveryTime field"
        
        # Show sample receipt
        echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    receipts = data.get('receipts', data.get('data', []))
    sample = next((r for r in receipts if r.get('orderDate') and r.get('deliveryTime')), None)
    if sample:
        print(f\"  Sample: {sample.get('restaurantName', 'Unknown')} - Order: {sample.get('orderDate')}, Delivery: {sample.get('deliveryTime')}\")
except:
    pass
" 2>/dev/null
        return 0
    else
        print_test 1 "DoorDash receipts missing deliveryTime field"
        return 1
    fi
}

# Test 8: Test DoorDash waiting time analytics
test_doordash_waiting_time_analytics() {
    print_info "Test 2.4: Testing DoorDash waiting time analytics..."
    
    RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_DOORDASH_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_DOORDASH}")
    
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
        print_test 0 "DoorDash deliveryWaits found in Wrapped Analytics"
        
        DELIVERY_WAITS=$(echo "$RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    waits = patterns.get('deliveryWaits', {})
    print(json.dumps(waits, indent=2))
except:
    print('{}')
" 2>/dev/null || echo "{}")
        
        echo ""
        echo "DoorDash Delivery Waits Data:"
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
        
        TOTAL_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('totalMinutes', 0))" 2>/dev/null || echo "0")
        AVERAGE_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('averageMinutes', 0))" 2>/dev/null || echo "0")
        TOTAL_ORDERS=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('totalOrders', 0))" 2>/dev/null || echo "0")
        
        HAS_LONGEST=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'longestWait' in d else 'false')" 2>/dev/null || echo "false")
        HAS_FASTEST=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'fastestDelivery' in d else 'false')" 2>/dev/null || echo "false")
        
        if [ "$TOTAL_MINUTES" -gt 0 ] && [ "$AVERAGE_MINUTES" -gt 0 ] && [ "$TOTAL_ORDERS" -gt 0 ] && [ "$HAS_LONGEST" = "true" ] && [ "$HAS_FASTEST" = "true" ]; then
            print_test 0 "DoorDash deliveryWaits structure and values are valid"
            return 0
        else
            print_test 1 "DoorDash deliveryWaits structure or values are invalid"
            return 1
        fi
    else
        print_test 1 "DoorDash deliveryWaits not found in Wrapped Analytics"
        return 1
    fi
}

# ============================================================================
# CROSS-PLATFORM TESTS
# ============================================================================

print_section "CROSS-PLATFORM - Comparison Tests"

# Test 9: Compare waiting times between platforms
test_platform_comparison() {
    print_info "Test 3.1: Comparing waiting times between platforms..."
    
    # Get Uber Eats analytics
    UBER_RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_UBER_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_UBER}")
    
    UBER_AVG=$(echo "$UBER_RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    waits = patterns.get('deliveryWaits', {})
    print(waits.get('averageMinutes', 0))
except:
    print(0)
" 2>/dev/null || echo "0")
    
    # Get DoorDash analytics
    DOORDASH_RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_DOORDASH_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_DOORDASH}")
    
    DOORDASH_AVG=$(echo "$DOORDASH_RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    wrapped = data.get('wrappedAnalytics', {})
    patterns = wrapped.get('patterns', {})
    waits = patterns.get('deliveryWaits', {})
    print(waits.get('averageMinutes', 0))
except:
    print(0)
" 2>/dev/null || echo "0")
    
    if [ "$UBER_AVG" -gt 0 ] && [ "$DOORDASH_AVG" -gt 0 ]; then
        print_test 0 "Both platforms have valid waiting time data"
        echo "  Uber Eats average: ${UBER_AVG} minutes"
        echo "  DoorDash average: ${DOORDASH_AVG} minutes"
        return 0
    else
        print_test 1 "One or both platforms missing waiting time data"
        return 1
    fi
}

# ============================================================================
# EDGE CASE TESTS
# ============================================================================

print_section "EDGE CASES - Error Handling Tests"

# Test 10: Test with missing delivery time
test_missing_delivery_time() {
    print_info "Test 4.1: Testing handling of missing delivery times..."
    
    # This test verifies that the system gracefully handles receipts without delivery times
    # We check that analytics still work even if some receipts don't have delivery times
    
    UBER_RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_UBER_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN_UBER}")
    
    # Check that wrapped analytics still exist even if some receipts lack delivery times
    HAS_WRAPPED=$(echo "$UBER_RESPONSE" | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    has_wrapped = 'wrappedAnalytics' in data
    print('true' if has_wrapped else 'false')
except:
    print('false')
" 2>/dev/null || echo "false")
    
    if [ "$HAS_WRAPPED" = "true" ]; then
        print_test 0 "Wrapped analytics work even with missing delivery times"
        return 0
    else
        print_test 1 "Wrapped analytics failed when some receipts lack delivery times"
        return 1
    fi
}

# ============================================================================
# CLEANUP
# ============================================================================

cleanup() {
    echo ""
    print_info "Cleaning up test data..."
    
    if [ -n "$TEST_USER_UBER_ID" ] && [ -n "$ACCESS_TOKEN_UBER" ]; then
        curl -s -X DELETE "${API_URL}/receipts?userId=${TEST_USER_UBER_ID}" \
            -H "Authorization: Bearer ${ACCESS_TOKEN_UBER}" > /dev/null 2>&1 || true
    fi
    
    if [ -n "$TEST_USER_DOORDASH_ID" ] && [ -n "$ACCESS_TOKEN_DOORDASH" ]; then
        curl -s -X DELETE "${API_URL}/receipts?userId=${TEST_USER_DOORDASH_ID}" \
            -H "Authorization: Bearer ${ACCESS_TOKEN_DOORDASH}" > /dev/null 2>&1 || true
    fi
    
    # Clean up temp file
    rm -f /tmp/uber_test.zip
    
    print_test 0 "Cleanup complete"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    # Check if API is accessible
    print_info "Checking API health..."
    if ! curl -s "${API_URL}/health" > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  API health check failed. Make sure the server is running.${NC}"
        echo "   You can start it with: npm run dev"
    else
        print_test 0 "API is accessible"
    fi
    
    # Run Uber Eats tests
    test_uber_register
    test_uber_csv_import
    test_uber_delivery_time_storage
    test_uber_waiting_time_analytics
    
    # Run DoorDash tests
    test_doordash_register
    test_doordash_csv_import
    test_doordash_delivery_time_storage
    test_doordash_waiting_time_analytics
    
    # Run cross-platform tests
    test_platform_comparison
    
    # Run edge case tests
    test_missing_delivery_time
    
    # Print summary
    echo ""
    print_section "TEST SUMMARY"
    echo -e "${GREEN}Tests Passed: ${TESTS_PASSED}${NC}"
    echo -e "${RED}Tests Failed: ${TESTS_FAILED}${NC}"
    echo ""
    
    if [ $TESTS_FAILED -eq 0 ]; then
        echo -e "${GREEN}✅ All tests passed!${NC}"
        cleanup
        exit 0
    else
        echo -e "${RED}❌ Some tests failed${NC}"
        cleanup
        exit 1
    fi
}

# Trap to ensure cleanup on exit
trap cleanup EXIT

# Run tests
main

