#!/bin/bash

# Interactive Phase 3 Testing Script
# Allows you to test features interactively

BASE_URL="${BASE_URL:-http://localhost:3000}"

echo "=========================================="
echo "Phase 3 Interactive Testing"
echo "=========================================="
echo ""
echo "Choose a test to run:"
echo ""
echo "1. View real-time logs"
echo "2. Test monitoring endpoints"
echo "3. Generate traffic and check metrics"
echo "4. Test error scenarios"
echo "5. Check Sentry status"
echo "6. View structured logs"
echo "7. Test all endpoints"
echo "8. Exit"
echo ""

while true; do
    read -p "Enter choice (1-8): " choice
    
    case $choice in
        1)
            echo "Viewing real-time logs (Ctrl+C to exit)..."
            docker-compose logs -f snack-track-api
            ;;
        2)
            echo "Testing monitoring endpoints..."
            echo "First, let's register a user..."
            RESPONSE=$(curl -s -X POST "$BASE_URL/auth/register" \
                -H "Content-Type: application/json" \
                -d '{"email":"interactive-test@example.com","password":"TestPass123"}')
            TOKEN=$(echo "$RESPONSE" | jq -r '.accessToken')
            
            if [ "$TOKEN" != "null" ] && [ -n "$TOKEN" ]; then
                echo "✅ Registered! Token: ${TOKEN:0:50}..."
                echo ""
                echo "Health Status:"
                curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/monitoring/health" | jq .
                echo ""
                echo "Alert Status:"
                curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/monitoring/alerts" | jq .
            else
                echo "❌ Failed to register. Response:"
                echo "$RESPONSE" | jq .
            fi
            ;;
        3)
            echo "Generating traffic..."
            read -p "How many requests? (default 20): " count
            count=${count:-20}
            
            echo "Making $count requests..."
            for i in $(seq 1 $count); do
                curl -s "$BASE_URL/health" > /dev/null
                echo -n "."
            done
            echo ""
            echo "✅ Traffic generated!"
            echo ""
            echo "Check metrics with:"
            echo "  curl -H \"Authorization: Bearer \$TOKEN\" $BASE_URL/monitoring/health | jq ."
            ;;
        4)
            echo "Testing error scenarios..."
            echo ""
            echo "1. 404 Error:"
            curl -s "$BASE_URL/nonexistent" | head -3
            echo ""
            echo "2. Invalid JSON:"
            curl -s -X POST "$BASE_URL/auth/register" \
                -H "Content-Type: application/json" \
                -d '{invalid}' | head -3
            echo ""
            echo "3. Missing Authentication:"
            curl -s "$BASE_URL/monitoring/health" | head -3
            echo ""
            echo "Check logs: docker-compose logs snack-track-api | grep -i error | tail -10"
            ;;
        5)
            echo "Checking Sentry status..."
            docker-compose logs snack-track-api 2>&1 | grep -i sentry | tail -3
            echo ""
            echo "To enable Sentry:"
            echo "  1. Get DSN from sentry.io"
            echo "  2. Set SENTRY_DSN environment variable"
            echo "  3. Restart: docker-compose restart snack-track-api"
            ;;
        6)
            echo "Recent structured logs:"
            echo ""
            docker-compose logs snack-track-api 2>&1 | grep -E "\[info\]|\[error\]|\[warn\]" | tail -20
            echo ""
            echo "Filter options:"
            echo "  - Info only: docker-compose logs snack-track-api | grep '\[info\]'"
            echo "  - Errors only: docker-compose logs snack-track-api | grep '\[error\]'"
            echo "  - HTTP requests: docker-compose logs snack-track-api | grep 'HTTP Request'"
            ;;
        7)
            echo "Running full test suite..."
            ./scripts/test-phase3.sh
            ;;
        8)
            echo "Exiting..."
            exit 0
            ;;
        *)
            echo "Invalid choice. Please enter 1-8."
            ;;
    esac
    
    echo ""
    echo "----------------------------------------"
    echo ""
done

