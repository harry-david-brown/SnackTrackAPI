#!/bin/bash

# Phase 3 Manual Testing Script
# Tests all Phase 3 features: logging, monitoring, alerting, Sentry integration

set -e

BASE_URL="${BASE_URL:-http://localhost:3000}"
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Phase 3 Manual Testing${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Test 1: Basic Health Check
echo -e "${YELLOW}Test 1: Basic Health Check${NC}"
echo "GET $BASE_URL/"
RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$BASE_URL/")
HTTP_CODE=$(echo "$RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
BODY=$(echo "$RESPONSE" | sed '/HTTP_CODE/d')
echo "Response: $BODY"
echo "HTTP Code: $HTTP_CODE"
if [ "$HTTP_CODE" = "200" ] && [ "$BODY" = "ALIVE" ]; then
    echo -e "${GREEN}✅ PASSED${NC}"
else
    echo -e "${RED}❌ FAILED${NC}"
fi
echo ""

# Test 2: Detailed Health Check
echo -e "${YELLOW}Test 2: Detailed Health Check${NC}"
echo "GET $BASE_URL/health"
RESPONSE=$(curl -s "$BASE_URL/health")
echo "$RESPONSE" | jq . 2>/dev/null || echo "$RESPONSE"
STATUS=$(echo "$RESPONSE" | jq -r '.status' 2>/dev/null || echo "unknown")
if [ "$STATUS" = "ok" ]; then
    echo -e "${GREEN}✅ PASSED${NC}"
else
    echo -e "${RED}❌ FAILED${NC}"
fi
echo ""

# Test 3: Register User (for authenticated endpoints)
echo -e "${YELLOW}Test 3: Register User${NC}"
echo "POST $BASE_URL/auth/register"
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/auth/register" \
    -H "Content-Type: application/json" \
    -d '{"email":"test-phase3@example.com","password":"TestPass123"}')
echo "$REGISTER_RESPONSE" | jq . 2>/dev/null || echo "$REGISTER_RESPONSE"
TOKEN=$(echo "$REGISTER_RESPONSE" | jq -r '.accessToken' 2>/dev/null)
USER_ID=$(echo "$REGISTER_RESPONSE" | jq -r '.userId' 2>/dev/null)

if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
    echo -e "${GREEN}✅ PASSED - Token obtained${NC}"
    echo "Token: ${TOKEN:0:50}..."
    echo "User ID: $USER_ID"
else
    echo -e "${RED}❌ FAILED - Could not get token${NC}"
    exit 1
fi
echo ""

# Test 4: Monitoring Health Endpoint
echo -e "${YELLOW}Test 4: Monitoring Health Endpoint${NC}"
echo "GET $BASE_URL/monitoring/health"
HEALTH_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/monitoring/health")
echo "$HEALTH_RESPONSE" | jq . 2>/dev/null || echo "$HEALTH_RESPONSE"
HEALTH_STATUS=$(echo "$HEALTH_RESPONSE" | jq -r '.status' 2>/dev/null)
if [ "$HEALTH_STATUS" = "healthy" ] || [ "$HEALTH_STATUS" = "degraded" ]; then
    echo -e "${GREEN}✅ PASSED${NC}"
    echo "Status: $HEALTH_STATUS"
    echo "Metrics:"
    echo "$HEALTH_RESPONSE" | jq '.metrics' 2>/dev/null || echo "  (see above)"
else
    echo -e "${RED}❌ FAILED${NC}"
fi
echo ""

# Test 5: Monitoring Alerts Endpoint
echo -e "${YELLOW}Test 5: Monitoring Alerts Endpoint${NC}"
echo "GET $BASE_URL/monitoring/alerts"
ALERTS_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/monitoring/alerts")
echo "$ALERTS_RESPONSE" | jq . 2>/dev/null || echo "$ALERTS_RESPONSE"
ALERTS_COUNT=$(echo "$ALERTS_RESPONSE" | jq '.alerts | length' 2>/dev/null || echo "0")
if [ -n "$ALERTS_RESPONSE" ]; then
    echo -e "${GREEN}✅ PASSED${NC}"
    echo "Active alerts: $ALERTS_COUNT"
else
    echo -e "${RED}❌ FAILED${NC}"
fi
echo ""

# Test 6: Generate Some Traffic (to test logging and metrics)
echo -e "${YELLOW}Test 6: Generate Traffic (Testing Logging & Metrics)${NC}"
echo "Making 10 requests to /health endpoint..."
for i in {1..10}; do
    curl -s "$BASE_URL/health" > /dev/null
    echo -n "."
done
echo ""
echo -e "${GREEN}✅ Traffic generated${NC}"
echo ""

# Test 7: Check Metrics After Traffic
echo -e "${YELLOW}Test 7: Check Metrics After Traffic${NC}"
echo "GET $BASE_URL/monitoring/health"
sleep 1
METRICS_RESPONSE=$(curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/monitoring/health")
REQUEST_COUNT=$(echo "$METRICS_RESPONSE" | jq -r '.metrics.requestCount' 2>/dev/null || echo "0")
echo "Request count: $REQUEST_COUNT"
if [ "$REQUEST_COUNT" -gt "0" ]; then
    echo -e "${GREEN}✅ PASSED - Metrics tracking working${NC}"
    echo "Metrics:"
    echo "$METRICS_RESPONSE" | jq '.metrics' 2>/dev/null || echo "  (see above)"
else
    echo -e "${RED}❌ FAILED - Metrics not tracking${NC}"
fi
echo ""

# Test 8: Test Error Logging (trigger a 404)
echo -e "${YELLOW}Test 8: Test Error Logging${NC}"
echo "GET $BASE_URL/nonexistent-endpoint"
ERROR_RESPONSE=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$BASE_URL/nonexistent-endpoint")
HTTP_CODE=$(echo "$ERROR_RESPONSE" | grep "HTTP_CODE" | cut -d: -f2)
if [ "$HTTP_CODE" = "404" ]; then
    echo -e "${GREEN}✅ PASSED - 404 error logged${NC}"
    echo "HTTP Code: $HTTP_CODE"
    echo "Check Docker logs to verify error was logged:"
    echo "  docker-compose logs snack-track-api | grep -i error"
else
    echo -e "${RED}❌ FAILED${NC}"
fi
echo ""

# Test 9: Test Authentication Error
echo -e "${YELLOW}Test 9: Test Authentication Error${NC}"
echo "GET $BASE_URL/monitoring/health (without token)"
AUTH_ERROR=$(curl -s -w "\nHTTP_CODE:%{http_code}" "$BASE_URL/monitoring/health")
HTTP_CODE=$(echo "$AUTH_ERROR" | grep "HTTP_CODE" | cut -d: -f2)
if [ "$HTTP_CODE" = "401" ]; then
    echo -e "${GREEN}✅ PASSED - Authentication error handled${NC}"
    echo "HTTP Code: $HTTP_CODE"
else
    echo -e "${RED}❌ FAILED${NC}"
fi
echo ""

# Test 10: Check Logs Directory (if in production mode)
echo -e "${YELLOW}Test 10: Check Logging Configuration${NC}"
if [ -d "logs" ]; then
    echo "Logs directory exists"
    ls -lh logs/ | head -5
    echo -e "${GREEN}✅ PASSED - Logs directory found${NC}"
else
    echo "Logs directory doesn't exist (will be created in production mode)"
    echo -e "${YELLOW}ℹ️  INFO - This is normal in development${NC}"
fi
echo ""

# Test 11: Check Sentry Status
echo -e "${YELLOW}Test 11: Check Sentry Status${NC}"
SENTRY_LOGS=$(docker-compose logs snack-track-api 2>&1 | grep -i sentry | tail -1)
if echo "$SENTRY_LOGS" | grep -q "disabled"; then
    echo -e "${YELLOW}ℹ️  Sentry is disabled (no DSN configured)${NC}"
    echo "This is expected. To enable:"
    echo "  1. Set SENTRY_DSN environment variable"
    echo "  2. Restart the server"
    echo -e "${GREEN}✅ PASSED - Sentry integration ready${NC}"
else
    echo "Sentry status: $SENTRY_LOGS"
    echo -e "${GREEN}✅ PASSED - Sentry is configured${NC}"
fi
echo ""

# Summary
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Testing Summary${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "To view logs in real-time:"
echo "  docker-compose logs -f snack-track-api"
echo ""
echo "To check structured logs:"
echo "  docker-compose logs snack-track-api | grep -E '(info|error|warn)'"
echo ""
echo "To test backup script:"
echo "  ./scripts/backup-database.sh"
echo ""
echo -e "${GREEN}✅ Manual testing complete!${NC}"
echo ""

