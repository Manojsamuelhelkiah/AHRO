#!/usr/bin/env bash
set -euo pipefail

# Reuse the managed API workflow instead of adding another workflow. Starting
# the API does not wait for signature downloads: file intake remains fail-closed.
socket="${MALWARE_SCANNER_CLAMAV_SOCKET_PATH:-${MALWARE_SCANNER_CLAMAV_SOCKET:-}}"
if [[ "${NODE_ENV:-}" == "development" &&
      "$socket" == "/tmp/hro-private-document-scanner/clamd.sock" &&
      -z "${MALWARE_SCANNER_CLAMAV_HOST:-}" &&
      -z "${MALWARE_SCANNER_CLAMAV_PORT:-}" ]]; then
  script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
  bash "$script_dir/private-document-scanner.sh" &
fi

cleanup() {
  trap - EXIT INT TERM
  # jobs -pr only lists this shell's still-running children; never signal a
  # recycled PID from a scanner that failed its initial signature download.
  for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

pnpm run start &
api_pid=$!
wait "$api_pid"
