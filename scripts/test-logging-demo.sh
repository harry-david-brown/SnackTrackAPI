#!/bin/bash

# Interactive Demo Script for New Logging Structure
# Shows the logging system in action with real examples

BASE_URL="${BASE_URL:-http://localhost:3000}"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Logging System Demo${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Check if server is running
if ! curl -s "$BASE_URL/health" > /dev/null 2>&1; then
    echo -e "${RED}❌ Server not running. Start it with:${NC}"
    echo "   docker-compose up -d"
    exit 1
fi

echo -e "${GREEN}✅ Server is running${NC}"
echo ""
echo "This demo will generate traffic and show you the logs."
echo "Open another terminal and run: ${GREEN}docker-compose logs -f snack-track-api${NC}"
echo "to see logs in real-time!"
echo ""
read -p "Press Enter to continue..."
echo ""

# Clear any old logs from view by getting a timestamp
TIMESTAMP=$(date +%H:%M:%S)
echo -e "${YELLOW}Starting demo at $TIMESTAMP${NC}"
echo ""

# Test 1: Normal requests
echo -e "${BLUE}Test 1: Normal HTTP Requests${NC}"
echo "Making successful requests..."
curl -s "$BASE_URL/health" > /dev/null
curl -s "$BASE_URL/" > /dev/null
curl -s "$BASE_URL/monitoring/health" > /dev/null
sleep 2
echo -e "${GREEN}✅ Check your logs terminal - you should see:${NC}"
echo "   GET  200 /health 1ms"
echo "   GET  200 / 1ms"
echo "   GET  200 /monitoring/health 1ms"
echo ""
read -p "Press Enter to continue..."
echo ""

# Test 2: 404 errors (logged as INFO, not ERROR)
echo -e "${BLUE}Test 2: 404 Not Found (Logged as INFO)${NC}"
echo "Making requests to non-existent endpoints..."
curl -s "$BASE_URL/this-does-not-exist" > /dev/null
curl -s "$BASE_URL/another-missing-endpoint" > /dev/null
sleep 2
echo -e "${GREEN}✅ Check your logs - you should see:${NC}"
echo "   GET  404 /this-does-not-exist 1ms"
echo "   GET  404 /another-missing-endpoint 1ms"
echo -e "${YELLOW}Note: 404s are logged as INFO (not ERROR) - they're expected behavior${NC}"
echo ""
read -p "Press Enter to continue..."
echo ""

# Test 3: Invalid JSON (should trigger error)
echo -e "${BLUE}Test 3: Invalid Request (Should Log Error)${NC}"
echo "Sending invalid JSON..."
curl -s -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d '{invalid json}' > /dev/null
sleep 2
echo -e "${GREEN}✅ Check your logs - you should see an error about invalid JSON${NC}"
echo ""
read -p "Press Enter to continue..."
echo ""

# Test 4: Show current logs
echo -e "${BLUE}Test 4: Viewing Recent Logs${NC}"
echo ""
echo "Recent logs from the last 30 seconds:"
docker-compose logs snack-track-api 2>&1 | \
    tail -50 | \
    grep -E "GET|POST|PUT|DELETE|\[ERROR\]|\[WARN\]" | \
    grep -v "Restarting\|ts-node-dev\|ver\." | \
    tail -15
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "What you should see:"
echo "  ✅ Clean, readable log format"
echo "  ✅ HTTP requests: GET  200 /health 1ms"
echo "  ✅ 404s logged as INFO (not errors)"
echo "  ✅ Actual errors logged with [ERROR]"
echo ""
echo "To view logs in real-time:"
echo "  ${GREEN}docker-compose logs -f snack-track-api${NC}"
echo ""
echo "To filter logs:"
echo "  ${GREEN}docker-compose logs snack-track-api | grep 'GET\\|POST'${NC}"
echo "  ${GREEN}docker-compose logs snack-track-api | grep '\[ERROR\]'${NC}"
echo ""

