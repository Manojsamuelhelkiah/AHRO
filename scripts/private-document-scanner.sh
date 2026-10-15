#!/usr/bin/env bash
# Private development scanner. No document bytes leave the Unix socket.
set -euo pipefail
umask 077
# clamd VERSION reports ctime without a zone. Match the API's explicitly
# configured UTC interpretation without changing the application's time zone.

if [[ "${NODE_ENV:-development}" != "development" ]]; then
  echo "The local development scanner cannot configure a production service." >&2
  exit 1
fi
for executable in clamd freshclam flock; do
  command -v "$executable" >/dev/null || {
    echo "Missing scanner dependency: $executable" >&2
    exit 1
  }
done

runtime=/tmp/hro-private-document-scanner
mkdir -p "$runtime"
[[ "$(stat -c %u "$runtime")" == "$(id -u)" && ! -L "$runtime" ]] || {
  echo "Scanner runtime directory ownership is unsafe." >&2
  exit 1
}
chmod 700 "$runtime"
exec 9>"$runtime/service.lock"
flock -n 9 || {
  echo "A private scanner already owns this runtime directory." >&2
  exit 1
}
mkdir -p "$runtime/signatures"
user="$(id -un)"
# Antivirus subprocesses must not inherit Clerk, Gmail, database, or session
# credentials from their API parent.
scanner_env=(env -i "PATH=$PATH" "HOME=$runtime" "TZ=UTC" "LANG=C" "LC_ALL=C"
  "SSL_CERT_FILE=${SSL_CERT_FILE:-/etc/ssl/certs/ca-certificates.crt}")

cat > "$runtime/freshclam.conf" <<EOF
DatabaseDirectory $runtime/signatures
DatabaseOwner $user
DatabaseMirror database.clamav.net
Checks 12
Foreground yes
ConnectTimeout 20
ReceiveTimeout 120
MaxAttempts 2
TestDatabases yes
EOF

cat > "$runtime/clamd.conf" <<EOF
DatabaseDirectory $runtime/signatures
LocalSocket $runtime/clamd.sock
LocalSocketMode 600
FixStaleSocket yes
Foreground yes
User $user
PidFile $runtime/clamd.pid
TemporaryDirectory $runtime
MaxThreads 2
MaxQueue 6
StreamMaxLength 10M
MaxScanSize 50M
MaxFileSize 10M
MaxRecursion 16
MaxFiles 1000
MaxScanTime 12000
AlertExceedsMax yes
SelfCheck 3600
ReadTimeout 20
CommandReadTimeout 20
LogClean no
LogVerbose no
EOF

cleanup() {
  trap - EXIT INT TERM
  for pid in $(jobs -pr); do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM

# Only official signatures are accepted. A failed update never creates a
# substitute clean scanner or a test-only signature database.
echo "Updating private ClamAV signatures..."
"${scanner_env[@]}" freshclam --config-file="$runtime/freshclam.conf" &
wait "$!"

"${scanner_env[@]}" freshclam --config-file="$runtime/freshclam.conf" --daemon --foreground &
updater_pid=$!
"${scanner_env[@]}" clamd --config-file="$runtime/clamd.conf" &
scanner_pid=$!
echo "Private scanner starting; document uploads remain blocked until health checks pass."
# Either process exiting ends the service; the daemon must not silently keep
# running without its signature updater.
wait -n "$updater_pid" "$scanner_pid"
echo "A private scanner process stopped." >&2
exit 1
