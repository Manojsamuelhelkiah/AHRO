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