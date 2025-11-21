#!/bin/bash

# Automated Database Optimization Test (Local)
# Same as production test but defaults to localhost

set -e

# Override API_URL for local testing
export API_URL="${API_URL:-http://localhost:3000}"

# Run the main test script
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/test-optimizations-auto.sh"

