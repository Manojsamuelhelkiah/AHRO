#!/bin/bash
set -euo pipefail

trap 'echo "POST-MERGE SETUP FAILED at line $LINENO. Workflows will not be reconciled against a potentially stale database." >&2' ERR

pnpm install --frozen-lockfile
echo "Validating API routes..."
pnpm --filter @workspace/api-server run validate:routes
pnpm --filter @workspace/api-server run db:reconcile
echo "Ensuring the approved Demo Talent at Risk examples are available..."
WORKFORCE_EXAMPLES_IF_READY=true NODE_ENV=development SEED_SCRIPT=src/scripts/provision-workforce-risk-examples.ts pnpm --filter @workspace/api-server exec node run-seed.mjs
