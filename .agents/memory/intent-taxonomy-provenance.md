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