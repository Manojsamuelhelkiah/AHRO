#!/bin/bash
set -euo pipefail

trap 'echo "POST-MERGE SETUP FAILED at line $LINENO. Workflows will not be reconciled against a potentially stale database." >&2' ERR

pnpm install --frozen-lockfile
echo "Validating API routes..."
pnpm --filter @workspace/api-server run validate:routes
pnpm --filter @workspace/api-server run db:reconcile
