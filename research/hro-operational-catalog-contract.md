# Operational HRO Intent Catalog

## Version and scope

`hro-operational-v1` is a separate read-only product catalog. It reconciles
`hro-master-v1` (research generated 2026-09-09), `research-v1` (the retained
commercial/routing registry), current versioned batch templates and the
`offline-additional-v1` / `offline-complementary-v1` curated fictional inventories.
Additional current operational family mappings use `hro-reconciliation-v1`.

The taxonomy describes reviewed research scope, not every possible HRO request.
The reconciliation records are proposals, not approval of jurisdiction rules,
execution support, permissions or professional decision authority. Research
accountable-agent labels are intentionally not operational authorization metadata.

## Counting and reconciliation

| Class | Count without tenant extensions |
|---|---:|
| Journey browsing groups | 17 |
| Service browsing groups | 88 |
| Original master atomic outcomes | 320 |
| Reusable canonical atomic definitions | 319 |
| Composite definitions | 1 |
| Legacy commercial/registry entries | 60 (unchanged) |
| Fictional sample variations | 136 (120 offline + 16 retained, not definitions) |
| Tenant custom definitions | Scoped, including retired versions |
| Proposed review gaps | Computed separately in the inventory |

Each of the 320 source outcomes and the composite has an explicit source mapping.
The only consolidation is `assign-mandatory-learning` into `assign-learning`:
same responsible capability, same assignment completion record, with mandatory
status represented as context. Both journeys/services and original keys remain
mapped to the one definition. This does not merge assignment with enrollment,
equivalency or completion.

Similar labels that do not prove the same outcome are retained and flagged.
For example, eligibility determination versus answering an eligibility inquiry
may have different authoritative evidence. Scheduling a verification is not
performing one. Salary/employment certificates, absence cancellation/change,
dependent addition/removal, privacy coordination and exit coordination have
broader commercial wording and are not exact execution aliases.

Every current batch-template case family, dedicated separation, screening,
early-tenure, frontline and workforce-transfer family is linked explicitly.
Every curated fictional variation has its own source key/version and related
definition mapping, never a new canonical row. Where a family is ambiguous,
the mapping retains all plausible targets and its rationale. Unsupported future
families are unresolved, not guessed. No actual case data is queried.

The 16 retained scenario definitions are also mapped with a content-derived
source revision. Their launch/evaluation remains retired. The twelve historical
full-coverage examples reuse those definitions and are not counted again.
Expected-behavior narratives, test-center test plans and synthetic case
instances are not authoritative completed outcomes or extra definitions.

The structured inventory carries all mappings and their review status, plus
unresolved/ambiguous/broader mapping gaps and global scope/evidence/schema gaps.
This is the authoritative gap report; counts and exports derive from the same
validated assembly.

## Definition versus instance

A definition is a reusable versioned observable outcome. Human and AI initiation,
standalone invocation and composition are proposed metadata, not permissions.
Grouping is many-to-many browsing metadata. It does not determine ownership,
authorization or a fixed parent. An atomic definition can itself request another
outcome without turning that outcome into a child-only definition.

“Onboard employee” retains `new-hire-setup` as its stable composite key. It
proposes conditional invocation of `provision-role-access`, displayed as “Grant
IT application access”. That same definition is directly requestable and can
be called by a transfer. No duplicate IT definition is created. The proposed
conditions require separately approved role/application requirements and owner
approval. Context mappings carry tenant, subject, jurisdiction, entity, policy,
role, application, expiry and justification. Optional and independent relations
are not automatically mandatory parent-completion gates.

Definitions pin a catalog revision; tenant revisions use a content digest of
their retained registry metadata and update version. Old registry versions are
displayed rather than silently routed or promoted. No runtime resolver changes.
Future semantic revisions must bump catalog/definition versions and retain
prior source mappings; this release does not implement an editing workflow.

## Coverage evidence

Coverage is computed conservatively from the evidence admitted to this catalog:

- **Catalogued:** source definition only, outcome-specific execution not reviewed.
- **Illustrative:** linked curated offline request examples, not successful work.
- **Simulated:** current outcome-specific local execution evidence.
- **Integrated:** current authoritative remote completion evidence.
- **Verified:** independently approved end-to-end outcome evidence.

This release has no approved current simulated/integrated/verified catalog
receipts. The old registry still has its existing simulation labels; they are
not copied into operational maturity. Retired launch/evaluation paths cannot
support a current automation claim. Existing operational preparation, human
decisions and provider capabilities may exist, but require per-outcome audit
before promotion. A custom row's declared legacy maturity also does not promote it.
This is disclosed uncertainty, not an assertion that all workflow code is absent.

## Future instance contract (not implemented)

The versioned in-product contract describes tenant-scoped immutable identity,
pinned definition revision, human/AI initiator and human sponsor, optional
case/subject scope, immutable root/parent instance lineage, correlation and
source request references, input/policy/evidence references and state versions.

Root identity uniqueness includes tenant, initiator, source request and
idempotency key. Child creation is atomic and uniquely fenced by tenant, parent,
composition version, edge, logical invocation slot and idempotency key.
The same key with different inputs is a conflict. Retry is a separate attempt
of the same identity; uncertain external effects are reconciled, not replayed.

The lifecycle distinguishes proposed, accepted, input/approval waits, ready,
running, completed, failed, uncertain and cancellation-requested/cancelled.
Cancellation cannot erase dispatched effects; independent/shared work is not
blindly cancelled. Completed evidence is immutable and corrections supersede it.
Only approved applicable completion dependencies affect parent closure.

Proposed limits are depth 8, children per parent 50 and total tree size 500.
Concurrent reservations must enforce limits transactionally. Cross-tenant,
cross-root and ancestor-cycle links are rejected; bounded iteration requires
its own explicit approved contract. Every future effect uses the existing durable
journal, live scope/policy/authority checks and privacy boundaries.

No instance table, dispatcher, child spawning, event subscription, executor
assignment, policy approval or provider connection is introduced in this phase.

## Read/export and privacy contract

Authenticated tenant-context middleware protects list, detail and export.
The database query is tenant-scoped and the pure assembly filters scope again.
Custom keys occupy a separate identity namespace. Unknown/inaccessible exact
keys return 404; catalog detail never invokes the routing resolver.
Responses are private/no-store, and the browser's existing authenticated
response/cache boundaries apply. Export is exactly the same structured payload
as list for unchanged scoped inputs, including gaps and the future contract.
No case contents, worker identities, provider findings, authors or approvals
are loaded. Catalog endpoints are GET-only.
