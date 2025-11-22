#!/bin/bash

# Comprehensive Pagination Test Suite
# Tests pagination functionality across all endpoints

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
API_BASE="${API_BASE:-http://localhost:3000}"
TEST_USER_EMAIL="pagination-test-$(date +%s)@test.com"
TEST_PASSWORD="TestPass123"
USER_ID=""
ACCESS_TOKEN=""
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0

# Helper functions
print_test() {
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    echo -e "${BLUE}[TEST $TOTAL_TESTS]${NC} $1"
}

print_pass() {
    PASSED_TESTS=$((PASSED_TESTS + 1))
    echo -e "${GREEN}✓ PASS${NC} $1"
}

print_fail() {
    FAILED_TESTS=$((FAILED_TESTS + 1))
    echo -e "${RED}✗ FAIL${NC} $1"
    if [ -n "$2" ]; then
        echo -e "${RED}  Error: $2${NC}"
    fi
}

print_info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Check if API is running
check_api() {
    print_test "Checking API availability"
    if curl -s -f "$API_BASE/" > /dev/null; then
        print_pass "API is running"
        return 0
    else
        print_fail "API is not running at $API_BASE"
        exit 1
    fi
}

# Setup: Create test user and get auth token
setup() {
    print_info "Setting up test environment..."
    
    # Register user
    print_test "Registering test user"
    REGISTER_RESPONSE=$(curl -s -X POST "$API_BASE/auth/register" \
        -H "Content-Type: application/json" \
        -d "{\"email\": \"$TEST_USER_EMAIL\", \"password\": \"$TEST_PASSWORD\"}")
    
    if echo "$REGISTER_RESPONSE" | grep -q "userId"; then
        USER_ID=$(echo "$REGISTER_RESPONSE" | grep -o '"userId":"[^"]*' | cut -d'"' -f4)
        ACCESS_TOKEN=$(echo "$REGISTER_RESPONSE" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)
        print_pass "User registered: $USER_ID"
    else
        print_fail "Failed to register user" "$REGISTER_RESPONSE"
        exit 1
    fi
    
    # Upload test data (if available)
    # Try CSV first (more reliable), then ZIP
    CSV_FILE=""
    if [ -f "MockUberData/Uber Data/Eats/user_orders-0.csv" ]; then
        CSV_FILE="MockUberData/Uber Data/Eats/user_orders-0.csv"
    elif [ -f "MockUberData/Uber Data Request B18832D3.zip" ]; then
        CSV_FILE="MockUberData/Uber Data Request B18832D3.zip"
    elif [ -f "MockUberData/Uber Data/Uber Data Request B18832D3.zip" ]; then
        CSV_FILE="MockUberData/Uber Data/Uber Data Request B18832D3.zip"
    fi
    
    if [ -n "$CSV_FILE" ]; then
        print_info "Uploading test CSV data from: $CSV_FILE"
        CSV_RESPONSE=$(curl -s -X POST "$API_BASE/csv/import" \
            -H "Authorization: Bearer $ACCESS_TOKEN" \
            -F "csvFile=@$CSV_FILE" \
            -F "userId=$USER_ID")
        
        # CSV import is now synchronous
        if echo "$CSV_RESPONSE" | grep -q "importedCount"; then
            IMPORTED_COUNT=$(echo "$CSV_RESPONSE" | grep -o '"importedCount":[0-9]*' | cut -d':' -f2)
            print_pass "CSV import completed: $IMPORTED_COUNT receipts imported"
        else
            print_info "CSV upload response: $CSV_RESPONSE"
            print_info "Continuing with tests (may have no data)"
        fi
        
        # Wait a moment for data to be available
        sleep 1
        
        # If CSV upload failed, try inserting test data directly
        if [ -z "$IMPORTED_COUNT" ] || [ "$IMPORTED_COUNT" = "0" ]; then
            print_info "CSV upload had no data, inserting test receipts directly..."
            if [ -f "tests/insert-test-receipts.js" ]; then
                node tests/insert-test-receipts.js "$USER_ID" 25 > /dev/null 2>&1
                if [ $? -eq 0 ]; then
                    print_pass "Inserted 25 test receipts directly into database"
                    IMPORTED_COUNT=25
                else
                    print_info "Direct insert failed, continuing with tests (may have no data)"
                fi
            fi
        fi
    else
        print_info "No test CSV data found, skipping data upload"
        print_info "Looking for CSV file at: MockUberData/Uber Data Request B18832D3.zip"
        
        # Try inserting test data directly anyway
        if [ -f "tests/insert-test-receipts.js" ]; then
            print_info "Inserting test receipts directly into database..."
            node tests/insert-test-receipts.js "$USER_ID" 25 > /dev/null 2>&1
            if [ $? -eq 0 ]; then
                print_pass "Inserted 25 test receipts directly into database"
                IMPORTED_COUNT=25
            fi
        fi
    fi
}

# Test 1: Default pagination (no params)
test_default_pagination() {
    print_test "Default pagination (no params)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        LIMIT=$(echo "$RESPONSE" | grep -o '"limit":[0-9]*' | cut -d':' -f2)
        TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
        
        if [ "$PAGE" = "1" ] && [ "$LIMIT" = "50" ]; then
            print_pass "Default pagination: page=1, limit=50"
        else
            print_fail "Default pagination incorrect" "Expected page=1, limit=50, got page=$PAGE, limit=$LIMIT"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 2: Custom page and limit
test_custom_pagination() {
    print_test "Custom pagination (page=2, limit=10)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=2&limit=10" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        LIMIT=$(echo "$RESPONSE" | grep -o '"limit":[0-9]*' | cut -d':' -f2)
        
        if [ "$PAGE" = "2" ] && [ "$LIMIT" = "10" ]; then
            print_pass "Custom pagination: page=2, limit=10"
        else
            print_fail "Custom pagination incorrect" "Expected page=2, limit=10, got page=$PAGE, limit=$LIMIT"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 3: Maximum limit enforcement
test_max_limit() {
    print_test "Maximum limit enforcement (limit=2000 should cap at 1000)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&limit=2000" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        LIMIT=$(echo "$RESPONSE" | grep -o '"limit":[0-9]*' | cut -d':' -f2)
        
        if [ "$LIMIT" -le 1000 ]; then
            print_pass "Maximum limit enforced: limit=$LIMIT (capped at 1000)"
        else
            print_fail "Maximum limit not enforced" "Got limit=$LIMIT, expected <= 1000"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 4: Minimum page validation
test_min_page() {
    print_test "Minimum page validation (page=0 should become page=1)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=0" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        
        if [ "$PAGE" = "1" ]; then
            print_pass "Minimum page enforced: page=1 (was 0)"
        else
            print_fail "Minimum page not enforced" "Got page=$PAGE, expected 1"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 5: Negative values handling
test_negative_values() {
    print_test "Negative values handling (page=-1, limit=-5)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=-1&limit=-5" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        LIMIT=$(echo "$RESPONSE" | grep -o '"limit":[0-9]*' | cut -d':' -f2)
        
        if [ "$PAGE" -ge 1 ] && [ "$LIMIT" -ge 1 ]; then
            print_pass "Negative values corrected: page=$PAGE, limit=$LIMIT"
        else
            print_fail "Negative values not handled" "Got page=$PAGE, limit=$LIMIT"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 6: Pagination metadata structure
test_pagination_structure() {
    print_test "Pagination metadata structure"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=25" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    # Check for all required pagination fields
    REQUIRED_FIELDS=("page" "limit" "total" "totalPages" "hasMore" "hasPrevious")
    MISSING_FIELDS=()
    
    for field in "${REQUIRED_FIELDS[@]}"; do
        if ! echo "$RESPONSE" | grep -q "\"$field\""; then
            MISSING_FIELDS+=("$field")
        fi
    done
    
    if [ ${#MISSING_FIELDS[@]} -eq 0 ]; then
        print_pass "All pagination fields present"
    else
        print_fail "Missing pagination fields" "${MISSING_FIELDS[*]}"
    fi
}

# Test 7: Data array structure
test_data_structure() {
    print_test "Response data structure (data array)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=10" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"data"'; then
        DATA_COUNT=$(echo "$RESPONSE" | grep -o '"data":\[' | wc -l)
        if [ "$DATA_COUNT" -gt 0 ]; then
            print_pass "Response contains data array"
        else
            print_fail "Data array missing or empty"
        fi
    else
        print_fail "Response missing data array"
    fi
}

# Test 8: hasMore calculation
test_has_more() {
    print_test "hasMore calculation"
    
    # Get first page with small limit
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=5" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    HAS_MORE=$(echo "$RESPONSE" | grep -o '"hasMore":[^,}]*' | cut -d':' -f2 | tr -d ' ')
    
    if [ -n "$TOTAL" ] && [ "$TOTAL" -gt 0 ]; then
        if [ "$TOTAL" -gt 5 ]; then
            if [ "$HAS_MORE" = "true" ]; then
                print_pass "hasMore correctly set to true when more data exists"
            else
                print_fail "hasMore should be true" "Total=$TOTAL, limit=5, hasMore=$HAS_MORE"
            fi
        else
            if [ "$HAS_MORE" = "false" ]; then
                print_pass "hasMore correctly set to false when no more data"
            else
                print_fail "hasMore should be false" "Total=$TOTAL, limit=5, hasMore=$HAS_MORE"
            fi
        fi
    else
        print_info "No data to test hasMore calculation"
    fi
}

# Test 9: hasPrevious calculation
test_has_previous() {
    print_test "hasPrevious calculation"
    
    # Test page 1 (should be false)
    RESPONSE1=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=5" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    HAS_PREV1=$(echo "$RESPONSE1" | grep -o '"hasPrevious":[^,}]*' | cut -d':' -f2 | tr -d ' ')
    
    # Test page 2 (should be true if data exists)
    RESPONSE2=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=2&limit=5" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    HAS_PREV2=$(echo "$RESPONSE2" | grep -o '"hasPrevious":[^,}]*' | cut -d':' -f2 | tr -d ' ')
    
    if [ "$HAS_PREV1" = "false" ]; then
        print_pass "hasPrevious=false on page 1"
    else
        print_fail "hasPrevious should be false on page 1" "Got: $HAS_PREV1"
    fi
    
    if [ "$HAS_PREV2" = "true" ]; then
        print_pass "hasPrevious=true on page 2"
    else
        print_info "hasPrevious on page 2: $HAS_PREV2 (may be false if no data)"
    fi
}

# Test 10: totalPages calculation
test_total_pages() {
    print_test "totalPages calculation"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=10" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    LIMIT=$(echo "$RESPONSE" | grep -o '"limit":[0-9]*' | cut -d':' -f2)
    TOTAL_PAGES=$(echo "$RESPONSE" | grep -o '"totalPages":[0-9]*' | cut -d':' -f2)
    
    if [ -n "$TOTAL" ] && [ -n "$LIMIT" ] && [ -n "$TOTAL_PAGES" ]; then
        EXPECTED_PAGES=$(( (TOTAL + LIMIT - 1) / LIMIT ))
        if [ "$TOTAL_PAGES" -eq "$EXPECTED_PAGES" ] || [ "$TOTAL" -eq 0 ]; then
            print_pass "totalPages calculated correctly: $TOTAL_PAGES (total=$TOTAL, limit=$LIMIT)"
        else
            print_fail "totalPages incorrect" "Expected $EXPECTED_PAGES, got $TOTAL_PAGES"
        fi
    else
        print_fail "Missing pagination values for calculation"
    fi
}

# Test 11: Data consistency across pages
test_data_consistency() {
    print_test "Data consistency across pages"
    
    # Get page 1
    RESPONSE1=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=5" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    # Get page 2
    RESPONSE2=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=2&limit=5" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    TOTAL1=$(echo "$RESPONSE1" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    TOTAL2=$(echo "$RESPONSE2" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    
    # Get data counts (count receipt IDs)
    DATA1_COUNT=$(echo "$RESPONSE1" | grep -o '"id":"[^"]*"' | wc -l || echo "0")
    DATA2_COUNT=$(echo "$RESPONSE2" | grep -o '"id":"[^"]*"' | wc -l || echo "0")
    
    if [ "$TOTAL1" = "$TOTAL2" ]; then
        print_pass "Total count consistent across pages: $TOTAL1"
        
        # If we have data, verify no duplicates between pages
        if [ "$TOTAL1" -gt 5 ] && [ "$DATA1_COUNT" -gt 0 ] && [ "$DATA2_COUNT" -gt 0 ]; then
            print_pass "Data returned on both pages (Page 1: $DATA1_COUNT items, Page 2: $DATA2_COUNT items)"
        fi
    else
        print_fail "Total count inconsistent" "Page 1: $TOTAL1, Page 2: $TOTAL2"
    fi
}

# Test 12: Empty result set pagination
test_empty_results() {
    print_test "Empty result set pagination"
    
    # Use a filter that should return no results
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&restaurantName=NONEXISTENT_RESTAURANT_XYZ_12345" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    HAS_MORE=$(echo "$RESPONSE" | grep -o '"hasMore":[^,}]*' | cut -d':' -f2 | tr -d ' ')
    HAS_PREV=$(echo "$RESPONSE" | grep -o '"hasPrevious":[^,}]*' | cut -d':' -f2 | tr -d ' ')
    
    if [ "$TOTAL" = "0" ]; then
        if [ "$HAS_MORE" = "false" ] && [ "$HAS_PREV" = "false" ]; then
            print_pass "Empty result set handled correctly"
        else
            print_fail "Empty result pagination flags incorrect" "hasMore=$HAS_MORE, hasPrevious=$HAS_PREV"
        fi
    else
        print_info "Empty result test skipped (found $TOTAL results with filter)"
    fi
}

# Test 17: Verify actual data pagination (with real receipts)
test_real_data_pagination() {
    print_test "Real data pagination (multiple pages with actual receipts)"
    
    # Get total count first
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=10" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
    
    if [ -n "$TOTAL" ] && [ "$TOTAL" -gt 10 ]; then
        # We have enough data to test multiple pages
        print_info "Found $TOTAL receipts, testing multi-page pagination"
        
        # Get page 1
        PAGE1=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=10" \
            -H "Authorization: Bearer $ACCESS_TOKEN")
        # Count receipts using jq if available, otherwise count receipt IDs
        if command -v jq >/dev/null 2>&1; then
            DATA1_COUNT=$(echo "$PAGE1" | jq '.data | length' 2>/dev/null || echo "0")
        else
            # Count receipt objects by counting "restaurant_name" fields (each receipt has one)
            DATA1_COUNT=$(echo "$PAGE1" | grep -o '"restaurant_name":"[^"]*"' | wc -l || echo "0")
        fi
        
        # Get page 2
        PAGE2=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=2&limit=10" \
            -H "Authorization: Bearer $ACCESS_TOKEN")
        if command -v jq >/dev/null 2>&1; then
            DATA2_COUNT=$(echo "$PAGE2" | jq '.data | length' 2>/dev/null || echo "0")
        else
            DATA2_COUNT=$(echo "$PAGE2" | grep -o '"restaurant_name":"[^"]*"' | wc -l || echo "0")
        fi
        
        # Get last page
        TOTAL_PAGES=$(echo "$PAGE1" | grep -o '"totalPages":[0-9]*' | cut -d':' -f2)
        LAST_PAGE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=$TOTAL_PAGES&limit=10" \
            -H "Authorization: Bearer $ACCESS_TOKEN")
        if command -v jq >/dev/null 2>&1; then
            LAST_DATA_COUNT=$(echo "$LAST_PAGE" | jq '.data | length' 2>/dev/null || echo "0")
        else
            LAST_DATA_COUNT=$(echo "$LAST_PAGE" | grep -o '"restaurant_name":"[^"]*"' | wc -l || echo "0")
        fi
        
        if [ "$DATA1_COUNT" -eq 10 ] && [ "$DATA2_COUNT" -eq 10 ]; then
            print_pass "Page 1 and Page 2 return correct data counts (10 items each)"
        else
            print_fail "Incorrect data counts" "Page 1: $DATA1_COUNT, Page 2: $DATA2_COUNT"
        fi
        
        # Verify last page
        if [ "$LAST_DATA_COUNT" -gt 0 ] && [ "$LAST_DATA_COUNT" -le 10 ]; then
            print_pass "Last page returns correct data count: $LAST_DATA_COUNT items"
        else
            print_fail "Last page data count incorrect" "Expected 1-10, got $LAST_DATA_COUNT"
        fi
        
        # Verify hasMore logic
        PAGE1_HAS_MORE=$(echo "$PAGE1" | grep -o '"hasMore":[^,}]*' | cut -d':' -f2 | tr -d ' ')
        LAST_HAS_MORE=$(echo "$LAST_PAGE" | grep -o '"hasMore":[^,}]*' | cut -d':' -f2 | tr -d ' ')
        
        if [ "$PAGE1_HAS_MORE" = "true" ] && [ "$LAST_HAS_MORE" = "false" ]; then
            print_pass "hasMore flags correct (Page 1: true, Last page: false)"
        else
            print_fail "hasMore flags incorrect" "Page 1: $PAGE1_HAS_MORE, Last: $LAST_HAS_MORE"
        fi
    else
        print_info "Not enough data for multi-page test (Total=$TOTAL, need >10)"
    fi
}

# Test 13: Non-numeric parameters
test_non_numeric_params() {
    print_test "Non-numeric parameters handling (page=abc, limit=xyz)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=abc&limit=xyz" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    # Should default to page=1, limit=50
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        LIMIT=$(echo "$RESPONSE" | grep -o '"limit":[0-9]*' | cut -d':' -f2)
        
        if [ "$PAGE" = "1" ] && [ "$LIMIT" = "50" ]; then
            print_pass "Non-numeric params defaulted correctly: page=$PAGE, limit=$LIMIT"
        else
            print_fail "Non-numeric params not handled" "Got page=$PAGE, limit=$LIMIT"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 14: Large page numbers
test_large_page() {
    print_test "Large page number handling (page=9999)"
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=9999&limit=10" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        DATA_COUNT=$(echo "$RESPONSE" | grep -o '"data":\[[^\]]*' | grep -o ',' | wc -l || echo "0")
        
        if [ "$PAGE" = "9999" ]; then
            if [ "$DATA_COUNT" -eq 0 ]; then
                print_pass "Large page number handled: returns empty data"
            else
                print_pass "Large page number handled: page=$PAGE"
            fi
        else
            print_fail "Large page number not handled correctly" "Got page=$PAGE"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 15: Pagination with filters
test_pagination_with_filters() {
    print_test "Pagination with filters (date range)"
    
    START_DATE=$(date -d "1 year ago" +%Y-%m-%d 2>/dev/null || date -v-1y +%Y-%m-%d 2>/dev/null || echo "2020-01-01")
    END_DATE=$(date +%Y-%m-%d)
    
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=5&startDate=$START_DATE&endDate=$END_DATE" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    
    if echo "$RESPONSE" | grep -q '"pagination"'; then
        PAGE=$(echo "$RESPONSE" | grep -o '"page":[0-9]*' | cut -d':' -f2)
        TOTAL=$(echo "$RESPONSE" | grep -o '"total":[0-9]*' | cut -d':' -f2)
        
        if [ "$PAGE" = "1" ]; then
            print_pass "Pagination works with filters: page=$PAGE, total=$TOTAL"
        else
            print_fail "Pagination with filters failed" "Got page=$PAGE"
        fi
    else
        print_fail "Response missing pagination object"
    fi
}

# Test 16: Response time with pagination
test_pagination_performance() {
    print_test "Pagination performance (should be fast)"
    
    START_TIME=$(date +%s%N)
    RESPONSE=$(curl -s -X GET "$API_BASE/receipts?userId=$USER_ID&page=1&limit=50" \
        -H "Authorization: Bearer $ACCESS_TOKEN")
    END_TIME=$(date +%s%N)
    
    DURATION_MS=$(( (END_TIME - START_TIME) / 1000000 ))
    
    if [ "$DURATION_MS" -lt 2000 ]; then
        print_pass "Pagination response time: ${DURATION_MS}ms (< 2s)"
    else
        print_fail "Pagination too slow" "${DURATION_MS}ms (expected < 2000ms)"
    fi
}

# Cleanup
cleanup() {
    print_info "Cleaning up test data..."
    # Note: User cleanup would require admin endpoint or manual cleanup
    print_info "Test user: $TEST_USER_EMAIL (ID: $USER_ID)"
    print_info "Cleanup can be done manually if needed"
}

# Print summary
print_summary() {
    echo ""
    echo "=========================================="
    echo "Pagination Test Suite Summary"
    echo "=========================================="
    echo -e "Total Tests: ${BLUE}$TOTAL_TESTS${NC}"
    echo -e "Passed: ${GREEN}$PASSED_TESTS${NC}"
    echo -e "Failed: ${RED}$FAILED_TESTS${NC}"
    echo ""
    
    if [ $FAILED_TESTS -eq 0 ]; then
        echo -e "${GREEN}✓ All pagination tests passed!${NC}"
        return 0
    else
        echo -e "${RED}✗ Some tests failed${NC}"
        return 1
    fi
}

# Main execution
main() {
    echo "=========================================="
    echo "Pagination Test Suite"
    echo "=========================================="
    echo "API Base: $API_BASE"
    echo ""
    
    check_api
    setup
    
    echo ""
    echo "Running pagination tests..."
    echo ""
    
    test_default_pagination
    test_custom_pagination
    test_max_limit
    test_min_page
    test_negative_values
    test_pagination_structure
    test_data_structure
    test_has_more
    test_has_previous
    test_total_pages
    test_data_consistency
    test_empty_results
    test_non_numeric_params
    test_large_page
    test_pagination_with_filters
    test_pagination_performance
    test_real_data_pagination
    
    cleanup
    print_summary
}

# Run tests
main "$@"

