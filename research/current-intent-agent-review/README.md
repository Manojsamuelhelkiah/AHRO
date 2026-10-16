# Current HRO intent and agent review

**Assessment date: 16 October 2026.** Decision package for the existing Onboarding Agent Control Tower. This is an offline assessment, not a rollout or permission change.

## Executive answer

**More intent labels are not the main need.** The reviewed operational catalogue already has **319 canonical atomic definitions and one composite**, reconciled from **320 source atomic outcomes**, across **17 journeys and 88 services**. The one consolidation is mandatory/nonmandatory learning assignment. The fixed **60 commercial/reference concepts** remain a different counting basis.

**One additional atomic outcome is supported as a proposal:** initial establishment of an approved performance-improvement plan. The current inventory records its milestones, review and closure, but not its creation. Saved CIPD source evidence supports this distinction; confidence is medium pending domain-owner review. Do not activate it from this report. Other uncertain candidates need clearer source/record boundaries, not automatic additions. All six old candidate gaps are either already present or access-context reuse.

**Existing agents need clearer responsibilities and real capabilities more than a large new role catalogue.** Recommend **keep all 15 existing roles**, update the responsibilities/capability requirements of 14, and retain Systems Watcher without domain expansion. Propose **five bounded coordinating roles for decision**, not automatic registration: Recruiting; Compensation & Rewards; Time & Attendance; Performance & Talent; and Employee Relations. These derive from distinct decision/evidence boundaries, not an agent-per-intent target. They can be phased, or deferred if deterministic tools/existing systems suffice.

**The 56 explicitly associated services are not 56 executable services.** All **32 explicitly unassociated services** have proposals in the detailed tables. Existing broad associations also need review. No current registered role has a domain execution adapter established by the catalogue. The current invocation path implements two read tools, not business transactions. A narrow offboarding access/equipment communication path exists separately and is not IAM/asset execution.

## Deliverables

- [Complete intent/agent matrix — JSON](intent-agent-matrix.json): exactly 320 unique canonical definition rows (319 atomic + one composite), all source/commercial/example mappings, source fingerprints, alias reconciliation, 88 service reviews, all 15 existing-role recommendations, five proposed-role analyses and gap register.
- [Flat intent/agent matrix — CSV](intent-agent-matrix.csv): one row per canonical definition, with quoted multiline-safe fields. Multi-valued cells are JSON; the full provenance and role arrays are in JSON.
- [Detailed readable tables](review-tables.md): all services grouped by journey, every current role, candidate decisions, proposed-role alternatives and exact affected keys.
- [Typed gap register — JSON](gap-register.json): definition gaps, association gaps, contract inadequacy, tools/integration gaps, unverified execution and unavailable tenant inventory are different categories.
- [Capability evidence ledger](capability-ledger.md): current implementation evidence and limitations.
- [Reconciliation results](reconciliation-results.json): exact counts, duplicate/alias findings, checks and revision fingerprints.

## Baseline and provenance

| Item | Current assessment basis | Counting rule |
|---|---|---|
| Master source | `hro-master-v1`, source generated 2026-09-09 | 320 source atomic outcomes; not 320 independent canonical atomic definitions |
| Operational catalogue | `hro-operational-v1`, definition revision `:1` | 319 atomic + one composite; one shared assignment may appear in two journeys/services |
| Agent catalogue | `hro-agents-v1` | Twelve domain + three supporting roles; research specialist labels and five legacy personas are separate |
| Commercial concepts | 60 retained reference rows | Not an exhaustive operational scope or new commercial cost rows |
| Examples | 136 request definitions: 120 curated offline + 16 retained scenarios | Illustrations only; not database case counts, extra outcomes or completed work |
| Aliases | 325 alias edges / 325 distinct case-folded labels; zero ambiguous labels | Display/identity metadata, not automatic routing approval; do not add candidate synonyms |
| Tenant custom definitions | **Unknown: not accessed** | Current active/retired counts cannot be inferred from an empty pure builder argument |
| Historical customs | Two rows observed in September research | Historical observation only, not today's tenant inventory or canonical additions |
| New outcome proposals | One | Separate from canonical counts and unresolved candidates |
| Proposed new roles | Five | Not current agents and not executed/registered here |

### Why 32 can look like 31

The role catalogue expands explicit service arrays into definition associations. `new-hire-setup` is a composite whose browsing service memberships span onboarding services. Onboarding's association to that composite makes a naïve reverse join appear to cover `worker-master-setup`, although that service has **no explicit association**. Therefore the correct explicit-service baseline is **56 mapped / 32 unmapped**, not a reverse-projected 57/31. The matrix preserves actual associations and separate explicit service associations. Proposed atomic accountability for worker-master setup is Employee Changes, with Onboarding collaborating. The composite itself remains Onboarding-coordinated.

### Contract quality, not invented completeness

Mechanical findings: **301** generic outcome descriptions, **290** generic
evidence contracts and **304** generic system contracts among the 320 canonical
definitions. These categories overlap and must not be added together.

The assessment retains every actual outcome/evidence string. Generic “completed with a recorded, observable result,” “dated system record,” “immutable audit event” and “system of record” templates are flagged in each affected row and counted mechanically. Even more specific evidence strings lack approved typed outcome schemas and decision/authority contracts. Proposed domain-level evidence acceptance and systems requirements are explicitly **requirements for review**, not claims of existing contracts. Replacing a generic sentence with an invented detailed outcome would hide this gap, so this review does not do that.

Aliases, exact text duplicates and identifiers are mechanically checked. Semantic equivalence still needs judgment: a benefit eligibility inquiry is not a new-hire eligibility determination, enrollment is not learning assignment, scheduling re-verification is not performing work authorization, and a country overlay is not automatically a new outcome. These distinctions and the sole approved source consolidation are retained.

### All journeys and operational families

Every service in all seventeen journeys has a review row and one proposed atomic coordinator, with collaborators and human decision boundaries. The review includes recruiting; onboarding and worker master; core HR; documents/helpdesk; privacy/data quality/reporting; payroll; rewards; benefits/expenses; time/scheduling; absence; performance; learning/career; talent/succession/retention; engagement/workforce planning/change; ER; wellbeing/compliance; and mobility/restructure/exit.

Current case families are reconciled from the actual catalogue's `case-family` and sample mappings. Dedicated BGV, early-tenure, frontline release, controlled transfer and separation are considered separately. Their current evidence requirements cannot be inferred from a broad family label. Frontline release, candidate status/preparation, calibration, resume review and final exit closure remain unresolved distinctions where evidence/specification is insufficient. Talent at Risk's model integration/validation is a capability workstream, not another retention intent and not changed here.

## Ownership recommendations

Read the detailed tables for the **exact service set**, rationale and every existing-role decision; JSON gives exact current/affected intent keys rather than vague family names.

| Decision | Recommended approach | Why not another agent? |
|---|---|---|
| Worker master, data quality, governed reporting | Extend Employee Changes; share deterministic validation/report tools | Same source-record stewardship; reporting computations do not require a separate decision-making role |
| Engagement, workforce planning, change support | Employee Changes coordinating, Helpdesk/Compliance collaborating | Planning snapshots and safe aggregates can be deterministic; sponsor retains workforce decisions |
| Wellbeing | Extend Benefits for consented nonclinical navigation | Clinical and emergency decisions belong to qualified providers and deterministic escalation |
| Restructuring | Extend Offboarding with independent Compliance and ER decision handoffs | Shared exit/consultation evidence; not an autonomous redundancy agent or permission to close exits |
| Recruiting | Proposed Recruiting coordinator; Helpdesk remains information collaborator | Pre-offer candidate/ATS lifecycle differs from accepted-offer Onboarding |
| Compensation/rewards | Proposed Rewards coordinator, Payroll collaborator | Approval and application of reward plans are not payroll calculation/release |
| Time and attendance | Proposed Time coordinator; Leave and Payroll collaborate | Worked-time/schedule/cutoff evidence differs from leave entitlement |
| Performance/talent/succession/retention | One proposed shared coordinator, with Learning/Rewards collaboration | Shared manager/panel evidence; not a role per rating, skill, signal or successor |
| ER | Proposed restricted ER coordinator | Contested evidence, independent findings and appeals need a distinct stewardship boundary |

Overly broad current associations need correction, not removal of reusable definitions. Compliance cannot be a professional screening/safety/medical/labor decision maker; Learning's orientation mapping includes document acknowledgments, not just courses; Helpdesk's recruiting mapping is not hiring ownership; Payroll's time-setup mapping is not attendance approval; supporting document verification overlaps do not transfer domain accountability. Current composite mappings are not atomic ownership assignments. The matrix preserves these associations and recommends clearer accountable/collaborator semantics in a later versioned review.

## Prioritized decision roadmap

No phase is authorized by this report. Dependencies and observable acceptance outcomes must be agreed before implementation.

| Priority / stream | Proposed work | Dependencies and product decision | Observable acceptance |
|---|---|---|---|
| P0 — catalogue/mapping correction | Review all 32 explicit service gaps and all existing-role boundaries; separate composite propagation, atomic accountability and supporting collaboration | Product owner approves service scopes and role proposals; explicit mapping changes require catalogue version and existing-binding review | Every service has a reviewed accountable/collaborator decision; no composite falsely implies sole atomic ownership; no dangling or stale mappings |
| P0 — evidence truthfulness | Treat older 60-row and simulated claims as historical only; use actual two-tool allowlist, not older one-tool documentation | Adopt current definition/agent versions and this evidence ledger | Reports distinguish catalogue, read-only tools, workflow preparation, communication and independently verified domain completion |
| P1 — outcome contracts | Replace generic contracts through approved domain review, starting with worker master, access, pay, ER and new performance-plan proposal | Domain owners specify record/state, typed inputs, source identity, policy applicability, professional decision and immutable evidence | Each selected outcome has a version-bound testable contract; generic audit event alone cannot pass completion |
| P1 — tenant completeness | Review an authorized tenant-scoped export separately, including active/retired custom definitions and revisions | Named tenant/data owner approves scope and disclosure; do not query all tenants | Explicit reconciled custom count/status, exact identity/alias conflicts, outcome contracts and association decisions; unknown remains unknown until then |
| P1 — existing-agent capability improvements | Prioritize core-HR data checks, source-grounded Helpdesk, readiness dependency review and human/provider handoffs before new autonomous effects | Approve one bounded use case, source-system owner and typed outcome contract; retain safety/authentication boundaries and deferred privacy state | Current read/prepare capabilities are usable and accurately labelled; any future write has authority, idempotency, source readback and uncertainty reconciliation |
| P2 — new roles | Decide individually whether to register the five proposed coordinators, phase them, or use existing platforms/deterministic tools | Approve each role's distinct scope, accountable sponsor, alternatives, permissions proposal and source-system plan; no predetermined target count | No duplicate responsibility; exact intent keys and human decision boundary approved; registration still grants neither tools nor execution |
| P2 — future integration and verification | Select one approved authoritative system path per capability; independently validate outcome receipts | Configured source/provider, approved policy, effect-journal fencing, live scope, safe disclosure, human decision, recovery and revocation checks | Dated current object/version and receipt prove the requested outcome; independent review permits an explicit support-status change; no sample or test fixture counts as live completion |
| P3 — unresolved intent boundaries | Resolve candidate stage response, interview prep, calibration, frontline release, resume review and closure specification | Inspect primary sources and agree whether each has a distinct authoritative record; section 4.6 required for final exit closure | Each candidate is accepted as new, mapped as contextual reuse, excluded with reason, or remains openly unresolved; no synonymous/country duplicates |

### Decisions required now

1. Is recruiting, discretionary rewards, worked-time coordination, talent evaluation coordination and restricted ER in the intended product scope? Approve/decline each proposed role independently.
2. Accept the proposed extensions for Employee Changes, Benefits and Offboarding, and choose actual accountable human sponsors.
3. Approve a domain review of initial performance-improvement-plan establishment; do not promote its proposed key yet.
4. Choose the first narrow authoritative system/contract to validate. No useful end-to-end automation percentage can be computed from association counts.
5. Decide whether to supply an authorized tenant custom export. Until then, no claim of tenant-exhaustive completeness is supportable.

## Reproduction and validation

From the repository root, without services or database access:

```sh
artifacts/onboarding-agent/node_modules/.bin/tsx research/current-intent-agent-review/build-review.ts
```

This compares committed outputs byte-for-byte against fresh assembly of the actual pure catalogue/role functions and reviewed proposals. It validates source/master CSV identity, counts, all canonical definitions, every source/commercial target, all service proposals, exact role/candidate/gap identifiers, supported current alias metadata, duplicate source descriptions, definition/catalogue revisions and six negative probes. The package fingerprints the inspected source files, including source captures. A stale output or source/revision mismatch fails; inspect the change before approving a refresh.

To regenerate after an explicitly reviewed evidence/decision update:

```sh
artifacts/onboarding-agent/node_modules/.bin/tsx research/current-intent-agent-review/build-review.ts --write
```

This writes **only this assessment directory's datasets/tables**. It never updates catalogues, versions, permissions, bindings, providers, workflows or data. No UI/browser testing or workflow restart is needed for this documentation-only deliverable.

To generate the portable HTML assessment with all definitions and embedded
JSON/CSV downloads:

```sh
node research/current-intent-agent-review/export-review.mjs
```

That reading copy is written under the already-ignored
`generated-artifacts/hro-intent-agent-review/` directory.

## Supersession and limitations

This package supersedes **current scope/coverage/role recommendation claims** in `research/hro-intent-agent-architecture.md`, `research/notes.md`, and the earlier gap/source draft guidance where inconsistent. Historical files, source links, commercial assumptions and legacy data remain intact for provenance; they are not rewritten to make past claims appear current. A warning in the older readable reports points here. The existing registry JSON is retained unchanged because runtime code still imports it.

This is a decision-ready review of the inspected source scope, **not proof of universal HRO completeness**, legal compliance, verified provider availability or current tenant execution. No new UI, model call, registration, intent activation, commercial baseline, workflow/permission change, outbound communication or business transaction is delivered. The active catalogue-panel cleanup and Talent at Risk model work are not modified. Privacy workflow deferral, tenant isolation, private evidence and all existing human decision/safety boundaries remain unchanged.
