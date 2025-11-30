#!/bin/bash

# Comprehensive test suite for timezone conversion feature
# Tests automatic timezone detection, analytics conversion, and timezone updates

set -e

API_URL="${API_URL:-http://localhost:3000}"
TEST_USER_EMAIL="timezone-test-$(date +%s)@example.com"
TEST_USER_ID=""
ACCESS_TOKEN=""
API_KEY="${API_KEY:-test-key}"

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧪 Comprehensive Timezone Conversion Test Suite${NC}"
echo "=========================================================="
echo ""
echo "API URL: ${API_URL}"
echo "Test User: ${TEST_USER_EMAIL}"
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
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}$1${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

# Check if API is running
check_api_health() {
    print_section "Checking API Health"
    
    if ! curl -s "${API_URL}/health" > /dev/null 2>&1; then
        echo -e "${RED}❌ API is not running at ${API_URL}${NC}"
        echo "   Please start it with: docker-compose up --build -d"
        exit 1
    fi
    
    print_test 0 "API is running"
}

# Test 1: Register user with X-Timezone header
test_timezone_from_header() {
    print_section "Test 1: Timezone Detection from X-Timezone Header"
    
    TEST_EMAIL="timezone-header-$(date +%s)@example.com"
    TEST_TIMEZONE="Europe/London"
    
    print_info "Creating user with X-Timezone header: ${TEST_TIMEZONE}"
    
    RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -H "X-Timezone: ${TEST_TIMEZONE}" \
        -d "{\"email\": \"${TEST_EMAIL}\"}")
    
    USER_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('userId', ''))" 2>/dev/null || echo "")
    RESPONSE_TIMEZONE=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('timezone', ''))" 2>/dev/null || echo "")
    
    if [ -z "$USER_ID" ]; then
        print_test 1 "User creation failed"
        echo "Response: $RESPONSE"
        return 1
    fi
    
    print_test 0 "User created successfully"
    
    if [ "$RESPONSE_TIMEZONE" = "$TEST_TIMEZONE" ]; then
        print_test 0 "Timezone detected from header: ${RESPONSE_TIMEZONE}"
    else
        print_test 1 "Timezone mismatch. Expected: ${TEST_TIMEZONE}, Got: ${RESPONSE_TIMEZONE}"
        return 1
    fi
    
    # Verify in database
    if command -v docker-compose &> /dev/null; then
        DB_TIMEZONE=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -A -c \
            "SELECT timezone FROM users WHERE id = '${USER_ID}';" 2>/dev/null | tr -d '[:space:]')
        
        if [ "$DB_TIMEZONE" = "$TEST_TIMEZONE" ]; then
            print_test 0 "Timezone stored correctly in database: ${DB_TIMEZONE}"
        else
            print_test 1 "Database timezone mismatch. Expected: ${TEST_TIMEZONE}, Got: ${DB_TIMEZONE}"
        fi
    else
        print_info "Skipping database check (docker-compose not available)"
    fi
    
    # Cleanup
    TEST_USER_ID="$USER_ID"
}

# Test 2: Register user with timezone in request body
test_timezone_from_body() {
    print_section "Test 2: Timezone Detection from Request Body"
    
    TEST_EMAIL="timezone-body-$(date +%s)@example.com"
    TEST_TIMEZONE="Asia/Tokyo"
    
    print_info "Creating user with timezone in body: ${TEST_TIMEZONE}"
    
    RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -d "{\"email\": \"${TEST_EMAIL}\", \"timezone\": \"${TEST_TIMEZONE}\"}")
    
    USER_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('userId', ''))" 2>/dev/null || echo "")
    RESPONSE_TIMEZONE=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('timezone', ''))" 2>/dev/null || echo "")
    
    if [ -z "$USER_ID" ]; then
        print_test 1 "User creation failed"
        echo "Response: $RESPONSE"
        return 1
    fi
    
    print_test 0 "User created successfully"
    
    if [ "$RESPONSE_TIMEZONE" = "$TEST_TIMEZONE" ]; then
        print_test 0 "Timezone detected from body: ${RESPONSE_TIMEZONE}"
    else
        print_test 1 "Timezone mismatch. Expected: ${TEST_TIMEZONE}, Got: ${RESPONSE_TIMEZONE}"
        return 1
    fi
}

# Test 3: Register user with default timezone (no header/body)
test_default_timezone() {
    print_section "Test 3: Default Timezone Fallback"
    
    TEST_EMAIL="timezone-default-$(date +%s)@example.com"
    DEFAULT_TIMEZONE="America/New_York"
    
    print_info "Creating user without timezone (should default to ${DEFAULT_TIMEZONE})"
    
    RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -d "{\"email\": \"${TEST_EMAIL}\"}")
    
    USER_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('userId', ''))" 2>/dev/null || echo "")
    RESPONSE_TIMEZONE=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('timezone', ''))" 2>/dev/null || echo "")
    
    if [ -z "$USER_ID" ]; then
        print_test 1 "User creation failed"
        echo "Response: $RESPONSE"
        return 1
    fi
    
    print_test 0 "User created successfully"
    
    if [ "$RESPONSE_TIMEZONE" = "$DEFAULT_TIMEZONE" ]; then
        print_test 0 "Default timezone applied: ${RESPONSE_TIMEZONE}"
    else
        print_test 1 "Default timezone mismatch. Expected: ${DEFAULT_TIMEZONE}, Got: ${RESPONSE_TIMEZONE}"
        return 1
    fi
}

# Test 4: Update user timezone
test_update_timezone() {
    print_section "Test 4: Update User Timezone"
    
    # First create a user
    TEST_EMAIL="timezone-update-$(date +%s)@example.com"
    INITIAL_TIMEZONE="America/New_York"
    NEW_TIMEZONE="Europe/Paris"
    
    print_info "Creating user with initial timezone: ${INITIAL_TIMEZONE}"
    
    CREATE_RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -H "X-Timezone: ${INITIAL_TIMEZONE}" \
        -d "{\"email\": \"${TEST_EMAIL}\"}")
    
    USER_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('userId', ''))" 2>/dev/null || echo "")
    
    if [ -z "$USER_ID" ]; then
        print_test 1 "User creation failed"
        return 1
    fi
    
    print_test 0 "User created"
    
    # Register and login to get token
    TEST_PASSWORD="TestPassword123"
    REGISTER_RESPONSE=$(curl -s -X POST "${API_URL}/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
    
    LOGIN_RESPONSE=$(curl -s -X POST "${API_URL}/auth/login" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"${TEST_EMAIL}\", \"password\": \"${TEST_PASSWORD}\"}")
    
    ACCESS_TOKEN=$(echo "$LOGIN_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('accessToken', ''))" 2>/dev/null || echo "")
    
    if [ -z "$ACCESS_TOKEN" ]; then
        print_info "Skipping timezone update test (authentication required)"
        return 0
    fi
    
    print_info "Updating timezone to: ${NEW_TIMEZONE}"
    
    UPDATE_RESPONSE=$(curl -s -X PUT "${API_URL}/users/${USER_ID}/timezone" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer ${ACCESS_TOKEN}" \
        -d "{\"timezone\": \"${NEW_TIMEZONE}\"}")
    
    UPDATE_TIMEZONE=$(echo "$UPDATE_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('timezone', ''))" 2>/dev/null || echo "")
    
    if [ "$UPDATE_TIMEZONE" = "$NEW_TIMEZONE" ]; then
        print_test 0 "Timezone updated successfully: ${UPDATE_TIMEZONE}"
    else
        print_test 1 "Timezone update failed. Expected: ${NEW_TIMEZONE}, Got: ${UPDATE_TIMEZONE}"
        echo "Response: $UPDATE_RESPONSE"
        return 1
    fi
    
    # Verify in database
    if command -v docker-compose &> /dev/null; then
        DB_TIMEZONE=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -A -c \
            "SELECT timezone FROM users WHERE id = '${USER_ID}';" 2>/dev/null | tr -d '[:space:]')
        
        if [ "$DB_TIMEZONE" = "$NEW_TIMEZONE" ]; then
            print_test 0 "Timezone updated in database: ${DB_TIMEZONE}"
        else
            print_test 1 "Database timezone mismatch. Expected: ${NEW_TIMEZONE}, Got: ${DB_TIMEZONE}"
        fi
    fi
}

# Test 5: Analytics with different timezones (3am regret)
test_analytics_timezone_conversion() {
    print_section "Test 5: Analytics Timezone Conversion (3am Regret)"
    
    # Create user in London timezone
    TEST_EMAIL="analytics-tz-$(date +%s)@example.com"
    TEST_TIMEZONE="Europe/London"
    
    print_info "Creating user with timezone: ${TEST_TIMEZONE}"
    
    CREATE_RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -H "X-Timezone: ${TEST_TIMEZONE}" \
        -d "{\"email\": \"${TEST_EMAIL}\"}")
    
    USER_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('userId', ''))" 2>/dev/null || echo "")
    
    if [ -z "$USER_ID" ]; then
        print_test 1 "User creation failed"
        return 1
    fi
    
    print_test 0 "User created"
    
    # Insert test receipts with UTC times that should be late night in London
    # Receipt at 3am UTC = 3am GMT (late night in London)
    # Receipt at 10am UTC = 10am GMT (not late night)
    
    print_info "Inserting test receipts via database..."
    
    if command -v docker-compose &> /dev/null; then
        # Insert receipt at 3am UTC (should be 3am in London = late night)
        docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -c \
            "INSERT INTO receipts (user_id, restaurant_name, order_date, amount_spent, items, receipt_type, data_source) \
             VALUES ('${USER_ID}', 'Late Night Pizza', '2025-01-15 03:00:00+00', 25.50, '[]'::jsonb, 'uber_eats', 'csv');" > /dev/null 2>&1
        
        # Insert receipt at 10am UTC (should be 10am in London = not late night)
        docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -c \
            "INSERT INTO receipts (user_id, restaurant_name, order_date, amount_spent, items, receipt_type, data_source) \
             VALUES ('${USER_ID}', 'Morning Coffee', '2025-01-15 10:00:00+00', 5.00, '[]'::jsonb, 'uber_eats', 'csv');" > /dev/null 2>&1
        
        print_test 0 "Test receipts inserted"
        
        # Get analytics
        print_info "Fetching wrapped analytics..."
        ANALYTICS_RESPONSE=$(curl -s -X GET "${API_URL}/users/${USER_ID}/summary?includeWrapped=true" \
            -H "X-API-Key: ${API_KEY}")
        
        HAS_LATE_NIGHT=$(echo "$ANALYTICS_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print('lateNightOrders' in data.get('wrappedAnalytics', {}).get('shame', {}))" 2>/dev/null || echo "False")
        LATE_NIGHT_COUNT=$(echo "$ANALYTICS_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('wrappedAnalytics', {}).get('shame', {}).get('lateNightOrders', {}).get('count', 0))" 2>/dev/null || echo "0")
        
        if [ "$HAS_LATE_NIGHT" = "True" ] && [ "$LATE_NIGHT_COUNT" = "1" ]; then
            print_test 0 "Late night orders calculated correctly (1 order at 3am London time)"
        else
            print_test 1 "Late night orders calculation incorrect. Found: ${LATE_NIGHT_COUNT}, Expected: 1"
            echo "Analytics response: $ANALYTICS_RESPONSE" | head -c 500
            echo ""
        fi
    else
        print_info "Skipping analytics test (docker-compose not available for receipt insertion)"
    fi
}

# Test 6: Header priority (X-Timezone should override body)
test_timezone_priority() {
    print_section "Test 6: Timezone Detection Priority"
    
    TEST_EMAIL="timezone-priority-$(date +%s)@example.com"
    HEADER_TIMEZONE="America/Los_Angeles"
    BODY_TIMEZONE="Asia/Tokyo"
    
    print_info "Creating user with both header (${HEADER_TIMEZONE}) and body (${BODY_TIMEZONE}) timezone"
    print_info "Header should take priority"
    
    RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -H "X-Timezone: ${HEADER_TIMEZONE}" \
        -d "{\"email\": \"${TEST_EMAIL}\", \"timezone\": \"${BODY_TIMEZONE}\"}")
    
    USER_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('userId', ''))" 2>/dev/null || echo "")
    RESPONSE_TIMEZONE=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('timezone', ''))" 2>/dev/null || echo "")
    
    if [ "$RESPONSE_TIMEZONE" = "$HEADER_TIMEZONE" ]; then
        print_test 0 "Header timezone takes priority: ${RESPONSE_TIMEZONE}"
    else
        print_test 1 "Priority test failed. Expected: ${HEADER_TIMEZONE}, Got: ${RESPONSE_TIMEZONE}"
        return 1
    fi
}

# Test 7: Invalid timezone format
test_invalid_timezone() {
    print_section "Test 7: Invalid Timezone Format Handling"
    
    TEST_EMAIL="timezone-invalid-$(date +%s)@example.com"
    INVALID_TIMEZONE="Invalid/Timezone/Format"
    
    print_info "Testing with invalid timezone format: ${INVALID_TIMEZONE}"
    
    RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "X-API-Key: ${API_KEY}" \
        -H "X-Timezone: ${INVALID_TIMEZONE}" \
        -d "{\"email\": \"${TEST_EMAIL}\"}")
    
    # Should fall back to default
    RESPONSE_TIMEZONE=$(echo "$RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(data.get('timezone', ''))" 2>/dev/null || echo "")
    
    if [ "$RESPONSE_TIMEZONE" = "America/New_York" ]; then
        print_test 0 "Invalid timezone rejected, default applied: ${RESPONSE_TIMEZONE}"
    else
        print_test 1 "Invalid timezone handling failed. Got: ${RESPONSE_TIMEZONE}"
        return 1
    fi
}

# Test 8: Database schema verification
test_database_schema() {
    print_section "Test 8: Database Schema Verification"
    
    if ! command -v docker-compose &> /dev/null; then
        print_info "Skipping database schema check (docker-compose not available)"
        return 0
    fi
    
    print_info "Checking if timezone column exists in users table..."
    
    COLUMN_EXISTS=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -c "\d users" 2>/dev/null | grep -i "timezone" || echo "")
    
    if [ -n "$COLUMN_EXISTS" ]; then
        print_test 0 "Timezone column exists in users table"
        
        # Check column type
        COLUMN_TYPE=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -A -c \
            "SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'timezone';" 2>/dev/null | tr -d '[:space:]')
        
        if [ "$COLUMN_TYPE" = "character varying" ] || [ "$COLUMN_TYPE" = "varchar" ] || [ "$COLUMN_TYPE" = "charactervarying" ]; then
            print_test 0 "Timezone column has correct type: ${COLUMN_TYPE}"
        else
            print_test 1 "Timezone column has unexpected type: ${COLUMN_TYPE}"
        fi
        
        # Check default value
        DEFAULT_VALUE=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -A -c \
            "SELECT column_default FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'timezone';" 2>/dev/null | tr -d "'" | tr -d '[:space:]')
        
        if echo "$DEFAULT_VALUE" | grep -q "America/New_York"; then
            print_test 0 "Timezone column has correct default: America/New_York"
        else
            print_info "Timezone default: ${DEFAULT_VALUE}"
        fi
    else
        print_test 1 "Timezone column not found in users table"
        return 1
    fi
}

# Main test execution
main() {
    check_api_health
    test_database_schema
    test_timezone_from_header
    test_timezone_from_body
    test_default_timezone
    test_timezone_priority
    test_invalid_timezone
    test_update_timezone
    test_analytics_timezone_conversion
    
    # Print summary
    print_section "Test Summary"
    echo -e "${GREEN}✅ Tests Passed: ${TESTS_PASSED}${NC}"
    if [ $TESTS_FAILED -gt 0 ]; then
        echo -e "${RED}❌ Tests Failed: ${TESTS_FAILED}${NC}"
        exit 1
    else
        echo -e "${GREEN}🎉 All tests passed!${NC}"
        exit 0
    fi
}

# Run tests
main

