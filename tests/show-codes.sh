#!/bin/bash

# Quick script to show verification codes from docker logs
# Usage: ./tests/show-codes.sh

echo "Checking docker logs for verification codes..."
echo "================================================"
echo ""

# Show verification codes
echo "Email Verification Codes:"
docker-compose logs --tail=100 snack-track-api 2>/dev/null | grep -iE "\[DEV\].*verification code" | tail -5

echo ""
echo "Password Reset Codes:"
docker-compose logs --tail=100 snack-track-api 2>/dev/null | grep -iE "\[DEV\].*password reset code" | tail -5

echo ""
echo "To follow logs in real-time:"
echo "  docker-compose logs -f snack-track-api | grep -i 'code'"

