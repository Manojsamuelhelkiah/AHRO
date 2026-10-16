---
name: Intent taxonomy provenance
description: Durable counting and source-linking rules for the HRO intent corpus and future routing work.
---

Treat fixed reference outcomes, grouping parents, external aliases, client custom intents, retired rows, and source-supported candidates as separate classes. Source relationships must be typed as exact-label, family-scope, or curated-decomposition; only exact-label relationships may become aliases.

**Why:** The remembered 69-row baseline has no preserved row-level snapshot, while SAP product documentation and public HR datasets use different granularities. Forcing labels into one count creates unsupported provenance and duplicate outcomes.

**How to apply:** Any corpus count, UI summary, migration, cost model, or runtime registry must state which class it counts. New candidates require product approval and modelling before joining the fixed reference baseline. Keep agent ownership separate from deterministic action/tool execution.

Runtime registries must isolate custom outcomes by registry version. Exact aliases need atomic uniqueness with canonical keys, and every executable action must resolve to one executor whose owner and proven maturity match the outcome contract.

**Why:** A pre-transaction JSON alias check can race, stale-version custom rows can silently diverge from cost-model counts, and an executor name alone does not prove integrated or verified maturity.

**How to apply:** Lock custom rows before merging routing updates, reserve canonical keys and aliases relationally in the same transaction, filter cost-model loaders by the current registry version, and cap maturity at the executor registration's proven level.

Model HRO coverage as journey → service intent → atomic sub-intent, with composite routes explicitly separated from leaves. Keep the operational corpus separate from the commercial cost baseline, and treat jurisdiction/client rules as overlays rather than cloned canonical intents.

**Why:** Broad labels such as onboarding hide independently owned BGV, worker-data, payroll, benefits, access, equipment, learning, readiness, probation, and cancellation outcomes. Expanding the cost baseline to every operational leaf would also double-count composite work.

**How to apply:** Route execution only to leaves or declared composite orchestrations; report mapped/catalogued/simulated/integrated/verified separately. Preserve legacy cost concepts through typed mappings, and resolve country, entity, worker-type, plan, CBA, and effective-date policy at runtime.

An HRO sub-intent is a runtime invocation of a reusable definition, not a
child-only definition. Journey/service placement is browsing metadata, not
exclusive ownership, authorization or a fixed parent. Human and AI initiation
may be described provisionally but never grants execution permission.

**Why:** The user's intent-driven vision requires the same outcome to be directly
requested or invoked by multiple callers; cloning it whenever a caller changes
would inflate the catalog and fragment completion evidence.

**How to apply:** Keep composition conditions, input mappings and completion
dependencies separate from browsing groups. Put actual parent/root linkage on
future instances. Merge only outcomes with the same completion semantics; retain
uncertain distinctions as visible review gaps. Retired simulations and fictional
requests never establish current operational maturity.

In coverage assessments, count explicit service-to-role associations separately
from associations inferred through composite definition memberships.

**Why:** Composite browsing memberships can make a reverse join appear to cover
a service that has no reviewed atomic coordinating owner. Treating that as
coverage conceals ownership gaps.

**How to apply:** Preserve both the actual definition associations and the
explicit service basis in reports. Assign proposed atomic accountability
independently of composite orchestration; neither grants execution authority.

Worker-master completion definitions are vendor-neutral. Definition approval does
not approve a client's source binding, identity merge, effective-date change or
individual transaction, and must never be reused as live execution authority.

**Why:** HR data-owner acceptance was explicitly obtained for the four business
completion rules, within a contract-and-evidence-check scope that excluded
provider connections, writes and permission changes.

**How to apply:** Preserve that separation when adding worker integrations.
Establish client-specific source mappings and fresh ordinary permission-based
human decisions separately. Read-only contract acceptance and a frozen receipt
candidate are not a completed transaction or durable immutable evidence storage.