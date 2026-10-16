#!/bin/bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

cat >"$temp_dir/pnpm" <<'EOF'
#!/bin/bash
set -euo pipefail

printf '%s\n' "$*" >>"$POST_MERGE_TEST_LOG"

if [[ "$*" == *"exec node run-seed.mjs" && "${WORKFORCE_EXAMPLES_IF_READY:-}" != "true" ]]; then
  echo "Post-merge example population must use optional source-readiness gating" >&2
  exit 43
fi

if [[ "${POST_MERGE_FAIL_ROUTES:-0}" == "1" && "$*" == *"run validate:routes" ]]; then
  exit 42
fi
EOF
chmod +x "$temp_dir/pnpm"

run_post_merge() {
  PATH="$temp_dir:$PATH" \
    POST_MERGE_TEST_LOG="$1" \
    POST_MERGE_FAIL_ROUTES="${2:-0}" \
    bash "$repo_root/scripts/post-merge.sh"
}

failure_log="$temp_dir/failure.log"
if run_post_merge "$failure_log" 1 >/dev/null 2>&1; then
  echo "Expected route validation failure to make post-merge setup fail" >&2
  exit 1
fi

if grep -q "run db:reconcile" "$failure_log"; then
  echo "Database reconciliation ran after route validation failed" >&2
  exit 1
fi

success_log="$temp_dir/success.log"
run_post_merge "$success_log" >/dev/null

expected_calls=$(cat <<'EOF'
install --frozen-lockfile
--filter @workspace/api-server run validate:routes
--filter @workspace/api-server run db:reconcile
--filter @workspace/api-server exec node run-seed.mjs
EOF
)
actual_calls="$(cat "$success_log")"

if [[ "$actual_calls" != "$expected_calls" ]]; then
  echo "Post-merge commands did not run in the expected order" >&2
  diff -u <(printf '%s\n' "$expected_calls") <(printf '%s\n' "$actual_calls") >&2 || true
  exit 1
fi

echo "post-merge ordering tests passed"