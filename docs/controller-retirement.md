# Historical controller retirement

The run manager, setup approval, volunteer registry mutations, delivery
exceptions, UI routes, and API contracts are deleted. Retirement is not a purge
and does not reclassify any real person as a fictional employee.

## Inventory and retained data

| Records | Exact scope | Why retained / access |
| --- | --- | --- |
| Run JSON | `onb_settings.key LIKE 'demo-controller.run.v1:%'`, tenant-scoped | Consent, selected recipient, original provider results and case references are historical privacy/audit evidence. No run router or writer remains. Shared sensitive-lifecycle discovery still includes these records. Raw JSON is not returned by general settings APIs. |
| Setup requests and one-time grants | `demo_controller_setup_requests`, including `completed_at` and before/after membership fields | Evidence of who requested/received an administrative grant. Archival schema definitions remain to prevent accidental schema-tool drops; no setup router, operator-secret reader or approval code remains. Existing membership is not revoked by subsystem deletion. |
| Volunteer registry | `onb_settings.key = 'demo_volunteers'` | Historical contact/consent evidence only. It is not a delivery allowlist or accepted mutation input. No registry service or seed script remains. Tenant lifecycle/hold rules govern subsequent deletion. |
| Linked cases | `onb_cases.controller_retired = true` | Forward migration marks cases from durable controller provenance, authorization, profile/checkpoint, notes or an exact same-tenant run case ID. Original candidate authorization, provenance and workforce jurisdiction are preserved. Case reads remain under current tenant, case-grant and sensitive-record authorization. No ordinary mutation, simulation or orchestration may revive them. |
| Email/call results | Linked `onb_communications`, `onb_voice_sessions`, `onb_effect_journal`; simulation dispatch JSON and UAT `externalEffects.kind = 'dispatch-approved-demo-email'` | Sent and ambiguous results, transcripts and reply correlation remain truthful. Unknown does not become “not sent.” Signed callbacks may retain provider evidence, never execute a run action. Historical email replies are recorded subject to privacy policy and never advance simulation or fall through to candidate orchestration. UAT reads/exports preserve receipts; stale action retries are rejected before ledger lookup, and cleanup leaves historical delivery outcomes unchanged. |
| Audits, consent, policy, documents, storage | Case-linked audit/event, governance/lifecycle, candidate-upload, document/provider records and private object references | Independent retention schedules, legal holds, evidence custody and current access control still apply. No bytes, legal-held rows, volunteer cases or audit history were deleted. |

Run `SEED_SCRIPT=src/scripts/inventory-retired-controller.ts pnpm --filter
@workspace/api-server exec node run-seed.mjs` for a read-only, count-only inventory.
It does not expose contacts, request approval values, tokens, bodies, object URLs
or secret values. Counts are not authorization and cannot trigger delivery.

## Migration and release

`0106_controller_retirement` is an immutable forward journaled migration. It
adds a non-authorizing retirement flag and backfills exact same-tenant
controller ownership; it does not delete or rewrite evidence. Because it has a
data mutation, automatic migration safety must not be bypassed. Use the existing
reviewed runner, first without approval to obtain its exact tag/hash challenge,
then with the reviewed approval. Production application is a separate operator
release step, not performed by development verification.

Drain/stop every old API worker and its heartbeat traffic before application,
then apply the reviewed migration and start only the new build. An old binary
must never run alongside the retirement release. A provider request already
accepted before drain cannot be undone; retain its journal as sent/unknown and
reconcile manually, never resend. The durable dispatch journal is not cleared.
The new provider boundary re-reads the current case under the existing fence,
so stale payloads and retained run references cannot restore dispatch authority.

## Physical cleanup

Development aggregate inventory after reviewed retirement: three historical run
records, no setup requests/grants, one historical volunteer registry, three
retired linked cases, two communications and four provider-journal records.
These are counts, not a claim of production inventory or deletion. The
read-only inventory script reports the current deployment's counts separately;
never publish private recipients, consent payloads or object references.

No blanket cleanup is authorized. Tenant privacy/legal reviewers must establish
the applicable schedule, holds and evidence dependencies before any later
physical deletion (including archival setup/run rows or object bytes). Use a
new reviewed migration or governed deletion process, not an edit to historical
migrations. Until then retained rows and storage remain private historical
evidence, not operational state. Public Demo identities, Demo Organization,
ordinary offline samples, UAT and shared recipient/provider configuration stay
in place.
