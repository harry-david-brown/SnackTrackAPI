#!/bin/bash

# Unified Database Optimization Test Runner
# Automatically detects environment and runs appropriate tests

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}🚀 Database Optimization Test Runner${NC}"
echo ""

# Check if API_URL is explicitly set
if [ -n "$API_URL" ]; then
  echo "Using API_URL: $API_URL"
  "$SCRIPT_DIR/test-optimizations-auto.sh"
  exit $?
fi

# Auto-detect: Try production first
echo "Auto-detecting environment..."
if curl -s --max-time 3 "https://snacktrackapi-production.up.railway.app/health" > /dev/null 2>&1; then
  echo -e "${GREEN}✅ Production server is accessible${NC}"
  export API_URL="https://snacktrackapi-production.up.railway.app"
  "$SCRIPT_DIR/test-optimizations-auto.sh"
  exit $?
fi

# Fallback to local
echo -e "${GREEN}✅ Using local server${NC}"
export API_URL="http://localhost:3000"
"$SCRIPT_DIR/test-optimizations-auto.sh"
exit $?

