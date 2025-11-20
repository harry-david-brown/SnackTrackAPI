#!/bin/bash

# Test Script for New Logging Structure
# Demonstrates different log levels and formats

BASE_URL="${BASE_URL:-http://localhost:3000}"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Testing New Logging Structure${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if server is running
if ! curl -s "$BASE_URL/health" > /dev/null 2>&1; then
    echo -e "${YELLOW}⚠️  Server not running. Start it with:${NC}"
    echo "   docker-compose up -d"
    echo ""
    exit 1
fi

echo -e "${GREEN}✅ Server is running${NC}"
echo ""

# Function to view logs (exclude ts-node-dev restart messages, show only HTTP requests and errors)
view_logs() {
    echo -e "${BLUE}Viewing recent logs:${NC}"
    # Get last 50 lines, filter for actual application logs (HTTP requests, errors, warnings)
    # Exclude: Restart messages, ts-node-dev messages, old errors
    docker-compose logs snack-track-api 2>&1 | \
        tail -50 | \
        grep -E "GET|POST|PUT|DELETE|\[ERROR\]|\[WARN\]" | \
        grep -v "Restarting\|ts-node-dev\|ver\.\|ReferenceError.*not defined" | \
        tail -10
    echo ""
}

# Test 1: Generate normal traffic
echo -e "${YELLOW}Test 1: Generating Normal Traffic${NC}"
echo "Making requests to various endpoints..."
for i in {1..5}; do
    curl -s "$BASE_URL/health" > /dev/null
    curl -s "$BASE_URL/" > /dev/null
done
sleep 2  # Wait for logs to be written
echo ""
view_logs

# Test 2: Generate 404s (logged as INFO, not ERROR)
echo -e "${YELLOW}Test 2: Generating 404 Not Found${NC}"
echo "Making requests to non-existent endpoints..."
echo -e "${YELLOW}Note: 404s are logged as INFO (not ERROR) - they're expected behavior${NC}"
curl -s "$BASE_URL/nonexistent-endpoint" > /dev/null
curl -s "$BASE_URL/another-invalid" > /dev/null
sleep 2  # Wait for logs to be written
echo ""
view_logs

# Test 2b: Generate actual errors
echo -e "${YELLOW}Test 2b: Generating Actual Errors${NC}"
echo "Sending invalid JSON to trigger an error..."
curl -s -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d '{invalid json}' > /dev/null
sleep 2  # Wait for logs to be written
echo ""
echo -e "${BLUE}Viewing error logs:${NC}"
docker-compose logs snack-track-api 2>&1 | \
    tail -30 | \
    grep -E "\[ERROR\]|Invalid JSON|Error occurred" | \
    grep -v "Restarting\|ts-node-dev\|ver\." | \
    tail -5
echo ""

# Test 3: Test authentication error (monitoring endpoints are now public, so test a protected one)
echo -e "${YELLOW}Test 3: Testing Different Endpoints${NC}"
echo "Making various requests..."
curl -s "$BASE_URL/monitoring/health" > /dev/null
curl -s -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"email":"test-logging@example.com","password":"TestPass123"}' > /dev/null
sleep 2  # Wait for logs to be written
echo ""
view_logs

# Test 4: Show different log levels
echo -e "${YELLOW}Test 4: Understanding Log Levels${NC}"
echo ""
echo "Current log level: ${LOG_LEVEL:-info (default)}"
echo ""
echo "To test different log levels:"
echo "  1. Set LOG_LEVEL in docker-compose.yml or .env"
echo "  2. Restart: docker-compose restart snack-track-api"
echo "  3. Run this script again"
echo ""
echo "Log levels:"
echo "  - error: Only errors"
echo "  - warn:  Errors + warnings"
echo "  - info:  Default (errors, warnings, info)"
echo "  - debug: Everything (full details)"
echo ""

# Test 5: Show log format examples
echo -e "${YELLOW}Test 5: Log Format Examples${NC}"
echo ""
echo "Expected log formats:"
echo ""
echo "HTTP Requests (info level):"
echo "  2025-11-20 19:28:11 [INFO ] GET  200 /health 1ms"
echo "  2025-11-20 19:28:11 [INFO ] POST 201 /auth/register 45ms user=abc12345..."
echo ""
echo "Errors:"
echo "  2025-11-20 19:28:30 [ERROR] Error occurred"
echo "    → Database connection failed"
echo ""
echo "Warnings:"
echo "  2025-11-20 19:28:25 [WARN ] Slow request | url=/api/analytics responseTime=1200 threshold=1000"
echo ""

# Show how to view logs in real-time
echo -e "${YELLOW}How to View Logs:${NC}"
echo ""
echo "1. Real-time logs:"
echo "   ${GREEN}docker-compose logs -f snack-track-api${NC}"
echo ""
echo "2. Recent logs:"
echo "   ${GREEN}docker-compose logs snack-track-api | tail -50${NC}"
echo ""
echo "3. Filter by level:"
echo "   ${GREEN}docker-compose logs snack-track-api | grep '\[ERROR\]'${NC}"
echo "   ${GREEN}docker-compose logs snack-track-api | grep '\[WARN\]'${NC}"
echo ""
echo "4. Filter HTTP requests:"
echo "   ${GREEN}docker-compose logs snack-track-api | grep 'GET\\|POST'${NC}"
echo ""

echo -e "${GREEN}✅ Testing complete!${NC}"
echo ""
echo "Next steps:"
echo "  - Try different LOG_LEVEL values"
echo "  - View logs in real-time with: docker-compose logs -f snack-track-api"
echo "  - See docs/LOG_FORMAT.md for detailed format guide"

