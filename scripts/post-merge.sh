#!/bin/bash
set -euo pipefail

trap 'echo "POST-MERGE SETUP FAILED at line $LINENO. Workflows will not be reconciled against a potentially stale database." >&2' ERR

pnpm install --frozen-lockfile
pnpm --filter @workspace/api-server run db:reconcile
