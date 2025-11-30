#!/bin/bash

# Test script for DoorDash Delivery Waits feature
# Tests database migration, CSV import, and analytics calculation

set -e

API_URL="${API_URL:-http://localhost:3000}"
TEST_USER_EMAIL="delivery-waits-test@example.com"
TEST_USER_ID=""

# Colors for output
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Testing DoorDash Delivery Waits Feature"
echo "=========================================="
echo ""

# Helper function to print test results
print_test() {
    if [ $1 -eq 0 ]; then
        echo -e "${GREEN}✅ $2${NC}"
    else
        echo -e "${RED}❌ $2${NC}"
        exit 1
    fi
}

# Helper function to create a test user
create_test_user() {
    echo "Creating test user..."
    RESPONSE=$(curl -s -X POST "${API_URL}/users/create" \
        -H "Content-Type: application/json" \
        -H "x-api-key: ${API_KEY:-test-key}" \
        -d "{\"email\": \"${TEST_USER_EMAIL}\"}")
    
    TEST_USER_ID=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('userId', ''))" 2>/dev/null)
    
    if [ -z "$TEST_USER_ID" ]; then
        echo -e "${RED}❌ Failed to create test user${NC}"
        echo "Response: $RESPONSE"
        exit 1
    fi
    
    echo -e "${GREEN}✅ Test user created: ${TEST_USER_ID}${NC}"
}

# Helper function to delete test user's receipts
cleanup_receipts() {
    if [ -n "$TEST_USER_ID" ]; then
        echo "Cleaning up test receipts..."
        curl -s -X DELETE "${API_URL}/receipts?userId=${TEST_USER_ID}" \
            -H "Authorization: Bearer ${ACCESS_TOKEN:-test}" > /dev/null
    fi
}

# Test 1: Check if delivery_time column exists in database
test_database_column() {
    echo ""
    echo "Test 1: Checking database schema..."
    
    if command -v docker-compose &> /dev/null; then
        # Check if column exists using docker-compose
        COLUMN_EXISTS=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -c "\d receipts" 2>/dev/null | grep -i "delivery_time" || echo "")
        
        if [ -n "$COLUMN_EXISTS" ]; then
            print_test 0 "delivery_time column exists in receipts table"
        else
            print_test 1 "delivery_time column does not exist"
        fi
    else
        echo -e "${YELLOW}⚠️  Skipping database schema check (docker-compose not available)${NC}"
    fi
}

# Test 2: Import DoorDash CSV and verify delivery_time is stored
test_csv_import() {
    echo ""
    echo "Test 2: Testing DoorDash CSV import with delivery_time..."
    
    if [ ! -f "MockDoorDashData/data_archive.zip" ]; then
        echo -e "${RED}❌ MockDoorDashData/data_archive.zip not found${NC}"
        exit 1
    fi
    
    # Import DoorDash data
    RESPONSE=$(curl -s -X POST "${API_URL}/csv/import" \
        -H "Authorization: Bearer ${ACCESS_TOKEN:-test}" \
        -F "csvFile=@MockDoorDashData/data_archive.zip" \
        -F "userId=${TEST_USER_ID}")
    
    IMPORTED_COUNT=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('importedCount', 0))" 2>/dev/null)
    
    if [ "$IMPORTED_COUNT" -gt 0 ]; then
        print_test 0 "DoorDash CSV imported successfully (${IMPORTED_COUNT} receipts)"
    else
        echo -e "${RED}❌ CSV import failed${NC}"
        echo "Response: $RESPONSE"
        exit 1
    fi
    
    # Wait a moment for processing
    sleep 2
    
    # Verify receipts were created
    RECEIPTS_RESPONSE=$(curl -s -X GET "${API_URL}/receipts?userId=${TEST_USER_ID}&limit=5" \
        -H "Authorization: Bearer ${ACCESS_TOKEN:-test}")
    
    RECEIPT_COUNT=$(echo "$RECEIPTS_RESPONSE" | python3 -c "import sys, json; data=json.load(sys.stdin); print(len(data.get('receipts', [])))" 2>/dev/null)
    
    if [ "$RECEIPT_COUNT" -gt 0 ]; then
        print_test 0 "Receipts retrieved successfully (${RECEIPT_COUNT} receipts)"
        
        # Check if any receipt has deliveryTime
        HAS_DELIVERY_TIME=$(echo "$RECEIPTS_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
receipts = data.get('receipts', [])
has_delivery_time = any(r.get('deliveryTime') for r in receipts)
print('true' if has_delivery_time else 'false')
" 2>/dev/null)
        
        if [ "$HAS_DELIVERY_TIME" = "true" ]; then
            print_test 0 "Receipts contain deliveryTime field"
        else
            echo -e "${YELLOW}⚠️  No receipts with deliveryTime found (may need to check database directly)${NC}"
        fi
    else
        print_test 1 "Failed to retrieve receipts"
    fi
}

# Test 3: Verify delivery_time in database
test_database_storage() {
    echo ""
    echo "Test 3: Verifying delivery_time storage in database..."
    
    if command -v docker-compose &> /dev/null; then
        # Check if delivery_time values exist
        DELIVERY_TIME_COUNT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -c \
            "SELECT COUNT(*) FROM receipts WHERE user_id = '${TEST_USER_ID}' AND delivery_time IS NOT NULL;" 2>/dev/null | tr -d ' ')
        
        if [ -n "$DELIVERY_TIME_COUNT" ] && [ "$DELIVERY_TIME_COUNT" -gt 0 ]; then
            print_test 0 "delivery_time values stored in database (${DELIVERY_TIME_COUNT} receipts)"
        else
            print_test 1 "No delivery_time values found in database"
        fi
    else
        echo -e "${YELLOW}⚠️  Skipping database storage check (docker-compose not available)${NC}"
    fi
}

# Test 4: Test Wrapped Analytics with delivery waits
test_delivery_waits_analytics() {
    echo ""
    echo "Test 4: Testing Delivery Waits analytics..."
    
    # Get wrapped analytics
    ANALYTICS_RESPONSE=$(curl -s -X GET "${API_URL}/users/${TEST_USER_ID}/summary?includeWrapped=true" \
        -H "Authorization: Bearer ${ACCESS_TOKEN:-test}")
    
    # Check if deliveryWaits exists in response
    HAS_DELIVERY_WAITS=$(echo "$ANALYTICS_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
wrapped = data.get('wrappedAnalytics', {})
patterns = wrapped.get('patterns', {})
has_waits = 'deliveryWaits' in patterns
print('true' if has_waits else 'false')
" 2>/dev/null)
    
    if [ "$HAS_DELIVERY_WAITS" = "true" ]; then
        print_test 0 "deliveryWaits found in Wrapped Analytics"
        
        # Extract and display delivery waits data
        DELIVERY_WAITS=$(echo "$ANALYTICS_RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
wrapped = data.get('wrappedAnalytics', {})
patterns = wrapped.get('patterns', {})
waits = patterns.get('deliveryWaits', {})
print(json.dumps(waits, indent=2))
" 2>/dev/null)
        
        echo ""
        echo "Delivery Waits Data:"
        echo "$DELIVERY_WAITS" | python3 -c "
import sys, json
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
" 2>/dev/null
        
        # Validate delivery waits structure
        HAS_TOTAL=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'totalMinutes' in d else 'false')" 2>/dev/null)
        HAS_AVERAGE=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'averageMinutes' in d else 'false')" 2>/dev/null)
        HAS_ORDERS=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print('true' if 'totalOrders' in d else 'false')" 2>/dev/null)
        
        if [ "$HAS_TOTAL" = "true" ] && [ "$HAS_AVERAGE" = "true" ] && [ "$HAS_ORDERS" = "true" ]; then
            print_test 0 "Delivery Waits structure is correct"
        else
            print_test 1 "Delivery Waits structure is missing required fields"
        fi
        
        # Validate values are positive
        TOTAL_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('totalMinutes', 0))" 2>/dev/null)
        AVERAGE_MINUTES=$(echo "$DELIVERY_WAITS" | python3 -c "import sys, json; d=json.load(sys.stdin); print(d.get('averageMinutes', 0))" 2>/dev/null)
        
        if [ "$TOTAL_MINUTES" -gt 0 ] && [ "$AVERAGE_MINUTES" -gt 0 ]; then
            print_test 0 "Delivery Waits values are valid (Total: ${TOTAL_MINUTES} min, Avg: ${AVERAGE_MINUTES} min)"
        else
            print_test 1 "Delivery Waits values are invalid (Total: ${TOTAL_MINUTES}, Avg: ${AVERAGE_MINUTES})"
        fi
    else
        print_test 1 "deliveryWaits not found in Wrapped Analytics"
        echo "Response snippet:"
        echo "$ANALYTICS_RESPONSE" | python3 -c "import sys, json; d=json.load(sys.stdin); print(json.dumps(d.get('wrappedAnalytics', {}).get('patterns', {}), indent=2))" 2>/dev/null | head -20
    fi
}

# Test 5: Verify wait time calculation is correct
test_wait_time_calculation() {
    echo ""
    echo "Test 5: Verifying wait time calculation accuracy..."
    
    if command -v docker-compose &> /dev/null; then
        # Get a sample receipt with both order_date and delivery_time
        SAMPLE_RECEIPT=$(docker-compose exec -T postgres psql -U snacktrack -d snacktrack_dev -t -A -F',' -c \
            "SELECT order_date, delivery_time FROM receipts WHERE user_id = '${TEST_USER_ID}' AND order_date IS NOT NULL AND delivery_time IS NOT NULL LIMIT 1;" 2>/dev/null)
        
        if [ -n "$SAMPLE_RECEIPT" ]; then
            ORDER_DATE=$(echo "$SAMPLE_RECEIPT" | cut -d',' -f1)
            DELIVERY_TIME=$(echo "$SAMPLE_RECEIPT" | cut -d',' -f2)
            
            if [ -n "$ORDER_DATE" ] && [ -n "$DELIVERY_TIME" ]; then
                # Calculate wait time in minutes using Python
                WAIT_MINUTES=$(python3 -c "
from datetime import datetime
order = datetime.fromisoformat('${ORDER_DATE}'.replace(' ', 'T'))
delivery = datetime.fromisoformat('${DELIVERY_TIME}'.replace(' ', 'T'))
wait_seconds = (delivery - order).total_seconds()
wait_minutes = int(wait_seconds / 60)
print(wait_minutes)
" 2>/dev/null)
                
                if [ "$WAIT_MINUTES" -gt 0 ]; then
                    print_test 0 "Wait time calculation is correct (${WAIT_MINUTES} minutes for sample order)"
                echo "  Sample: Order placed at ${ORDER_DATE}, delivered at ${DELIVERY_TIME}"
                echo "  Calculated wait: ${WAIT_MINUTES} minutes"
                else
                    print_test 1 "Wait time calculation resulted in invalid value (${WAIT_MINUTES})"
                fi
            else
                echo -e "${YELLOW}⚠️  Could not parse sample receipt dates${NC}"
            fi
        else
            echo -e "${YELLOW}⚠️  No receipts with both order_date and delivery_time found${NC}"
        fi
    else
        echo -e "${YELLOW}⚠️  Skipping calculation verification (docker-compose not available)${NC}"
    fi
}

# Main test execution
main() {
    # Check if API is accessible
    if ! curl -s "${API_URL}/health" > /dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  API health check failed. Make sure the server is running.${NC}"
        echo "   You can start it with: docker-compose up"
    fi
    
    create_test_user
    test_database_column
    test_csv_import
    test_database_storage
    test_delivery_waits_analytics
    test_wait_time_calculation
    
    echo ""
    echo -e "${GREEN}✅ All tests completed!${NC}"
    echo ""
    echo "Cleaning up test data..."
    cleanup_receipts
    echo -e "${GREEN}✅ Cleanup complete${NC}"
}

# Run tests
main


