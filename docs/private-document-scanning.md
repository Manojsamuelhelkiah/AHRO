# Private document scanning in development

Client policy documents use the existing private ClamAV INSTREAM adapter.
Document bytes stay in the application environment; only antivirus signature
downloads contact the official ClamAV mirror.

## Setup

- Install the `clamav` Nix dependency.
- The existing managed API development workflow starts the scanner automatically
  when the local socket below is configured. No additional workflow is needed.
- Set the development environment variable
  `MALWARE_SCANNER_CLAMAV_SOCKET_PATH` to
  `/tmp/hro-private-document-scanner/clamd.sock`.
- Set `MALWARE_SCANNER_CLAMAV_TIMEZONE` to `UTC` in development. The scanner
  process explicitly uses UTC; the application and client time zones are unchanged.
- Do not configure a remote scanner host/port at the same time.
- Restart the API after changing its scanner configuration.
- Run `pnpm --filter @workspace/api-server run probe:malware-scanner`.

The probe must report current official signatures, a clean harmless payload,
and an infected EICAR test payload. EICAR is an antivirus test string, not
executable malware. Do not load documents until all three checks pass.

The daemon uses a private Unix socket, restrictive directory permissions,
bounded scan sizes, and official signature updates. A service or signature
failure remains a blocker, never a clean result. The runtime cache lives
outside Git under `/tmp/hro-private-document-scanner`.
Antivirus subprocesses receive a minimal environment, not the application's
authentication, Gmail, database, or session credentials.

## Existing quarantined uploads

Starting a scanner does not approve or release old imports. Re-upload the
original policy through the normal client-document importer so it is privately
scanned and extracted. Authorized-upload approval then follows the client's
configured review setting. No case is activated and no email is sent by this
operation.

## Workspace and production boundaries

A main Preview and a task Preview may run different application services.
Verify the scanner and API in the intended Preview; a passing task probe does
not establish main Preview readiness.

This workflow is for development only. It does not configure production.
Production needs its separately approved private scanner, current signatures,
and existing startup/readiness gates. Never copy the development socket setting
to production or relax quarantine, TLS, evidence, or provider-effect fences.
