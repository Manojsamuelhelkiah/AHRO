# Reviewed email intake

Email intake is a receiving and review channel, not a new operational engine.
Every complete or incomplete email requires an authorized reviewer save followed
by explicit conversion. Conversion creates a held onboarding case, held service
request or dedicated held separation. It never sends an acknowledgement, accepts
an offer, verifies employment or documents, or authorizes external contact.
Mobility and internal-transfer templates remain specialist-review requests;
operational workforce transfers still require their existing reviewed program,
country pathways, population admission and execution gates. Separation closure
remains unavailable pending section 4.6.

## Operator setup

1. Open **Cases → Email intake** (also linked from Settings and Systems). The
   displayed address comes from the connected Gmail profile, not a configured
   label, inferred domain, masked address or assumed alias.
2. A named, current client owner or administrator with effective case-flow
   and profile edit permissions reviews the exact primary mailbox-to-client binding.
   Record the approval reference. Choose zero hours for future mail only, or an
   explicitly approved backfill of up to 48 hours. No complete historical inbox
   import or replay of previously consumed messages is performed.
3. Create a route, or explicitly upgrade/reverify an existing separation route
   in the route selector. Copy the address and the complete random subject
   marker. No alias is provisioned or claimed to work.
4. Send requests to that address with exactly one client route marker in the
   subject. The template catalog shows required fields, allowed choices and
   examples for every supported template across all twelve families. Free-form
   messages can receive uncertain suggestions; they do not default to onboarding.
5. Wait for a successful scan. Readiness requires current approval, the same
   connected profile and a recent successful scan. Backlog, blocked items, saved
   page continuation and fixed non-sensitive failure reasons are shown.

The common Gmail consumer runs via the existing managed inbound monitor and the
existing protected production heartbeat at the API-relative
`/onboarding/webhooks/watcher-tick`. Use the already-approved heartbeat trigger
and its existing authorization, not a new public endpoint or provider account.
In-process intervals alone are insufficient on runtimes that pause without
traffic. Verify heartbeat requests actually execute and advance successful scan
time after publication.

## Review and recovery

* Sender identity, worker address, domain and free-text client names never choose
  the client. Conflicting/unbound messages retain only opaque provider metadata
  for fresh verified platform-administrator triage. Explicit assignment requires
  a current reviewed route and a review reference; it copies no employee facts.
* Correct classification and allowed fields, resolve missing information, save
  the reviewed version, then convert. Supplied employee references stay
  unverified. Service requests have no invented onboarding date.
* Pausing or changing a route fences workers and conversion. Re-enabling receives
  future mail only. Previously received requests need a fresh reviewer save
  against the current route revision. Changed provider accounts or revoked
  approval require explicit independent re-verification.
* Independent repeats are flagged for review, not automatically merged.
  Conversion is serialized on the durable request row; provider identity
  deduplication and immutable converted results survive retries and restarts.
* A saved Gmail page is retried after failure. Successful complete pages advance
  the scan watermark with a small overlap; message ownership tombstones prevent
  replay. Existing candidate, approval, status and self-generated mail ownership
  is excluded. All three Gmail consumers share cross-instance coordination.

## Confidentiality and attachments

Normalized body processing is bounded to 32 KiB, 100 MIME nodes and 12 levels.
Attachment intake is bounded to ten items and 10 MiB total decoded source bytes.
Remote URLs are never fetched, nested attached messages are not recursively
trusted, and sensitive filenames are replaced with generic labels.

Raw sources are reserved durably in private storage only after current all-class
collection checks. Malware results can be clean, infected, unavailable, timeout
or indeterminate. Only integrity-checked clean private body bytes are readable
under fresh confidential access and policy checks. There is no intake attachment
download/evidence-approval endpoint: even clean attachments remain quarantined
and cannot satisfy workflow evidence gates. Bank, medical and identity values
belong in separately approved secure collection, not ordinary intake fields,
notes, notifications or logs.

Source recovery retries reserved/unavailable records with bounded work.
Retention uses the most conservative current applicable all-class policy;
missing approvals prevent destructive cleanup and any active tenant hold blocks
before-case destruction. Cleanup minimizes private fields and storage while
retaining minimal provider deduplication tombstones. The application never deletes
or mutates real Gmail messages.

## Regression checks

`TEST_FILE=src/lib/hro-email-intake.test.ts node artifacts/api-server/run-tests.mjs`
uses denied/stubbed providers and private in-memory storage. It covers the full
template/family matrix, uncertain mail, malicious MIME bounds, explicit routing,
shared senders, tenant isolation, held admission, missing/reviewed fields, stale
edits, duplicate review, revocation, concurrent conversion and saved-page recovery.
Existing candidate, approver and status-consumer tests remain separate.
