# Research Notes: Comprehensive HRO Intent Taxonomy

> For current canonical reconciliation, contract-quality findings and agent
> recommendations, use the [2026-10-16 assessment](current-intent-agent-review/README.md).
> These source-generation notes remain provenance, not proof of execution.

**Status:** complete
**Depth:** Deep

## Plan

- **Question:** What comprehensive, atomic HRO intent hierarchy should the product support, and how should every leaf map to an accountable agent, systems, risk, actions, evidence, and execution maturity?
- **Scope:** Global cross-industry hire-to-retire HRO service delivery. Include employee, manager, HR, candidate, contingent-worker, retiree, and alumni requests. Treat local statutory variants as policy overlays rather than duplicating every country rule.
- **Audience:** HRO product owners, solution architects, service-delivery leaders, and implementation teams.
- **Deliverable:** Source-linked report plus machine-readable JSON, CSV, and formatted Excel matrix suitable for import into the product corpus.

## Focus Areas

| # | Area | Status | Sources |
|---|---|---|---|
| 1 | Recruiting, preboarding, onboarding, and early tenure | complete | 5 screened; 3 fetched |
| 2 | Core HR, worker data, organization, documents, and HR service delivery | complete | 5 screened; 3 fetched |
| 3 | Payroll, compensation, benefits, time, absence, and rewards | complete | 6 screened; 3 fetched |
| 4 | Performance, learning, careers, succession, engagement, and workforce planning | complete | 6 screened; 3 fetched |
| 5 | Employee relations, compliance, safety, mobility, separation, retirement, and alumni | complete | 6 screened; 3 fetched |

## Coverage Checklist

- [x] Every lifecycle domain has parent journeys, service intents, and atomic leaf intents: 17 journeys, 88 services, and 320 leaves.
- [x] Onboarding is decomposed into 13 services and 63 request, verification, setup, provisioning, communication, completion, probation, and cancellation outcomes.
- [x] Every leaf has one accountable specialist agent and optional normalized collaborators across 41 capabilities.
- [x] Every leaf identifies systems, read/write actions, approval/risk controls, and completion evidence.
- [x] All 60 current reference concepts map exactly once: 59 atomic leaves and one honest composite onboarding route; custom intents remain additive.
- [x] Duplicate labels and aliases are separated from canonical routable outcomes, with no alias/canonical collisions.
- [x] Current executable coverage is distinguished from target catalog coverage: one simulated leaf, one simulated composite route, and no integrated or verified routes.
- [x] Import-ready JSON, CSV, and Excel representations now describe every canonical leaf; application import and runtime executor expansion remain implementation work.

## Findings Log

- The recommended baseline contains 17 journeys, 88 service intents, 320 atomic leaves, one composite route, and 41 accountable agent capabilities.
- Onboarding contains 63 leaves, including separate BGV documents/consent/results/notices/disputes, worker/pay/time/benefit setup, IAM, workplace, learning, readiness, probation, and cancellation cleanup.
- The existing 60 reference concepts remain accounted for without claiming that the broad `new-hire-setup` orchestration is atomic.
- The external registry contains 37 deduplicated saved or registered sources: 12 Tier 1, 6 Tier 2, and 19 Tier 3/supporting sources.
- Product coverage remains materially behind catalog coverage: 319 leaves are unsupported, one leaf is simulated, one composite route is simulated, and none are integrated or production verified.

## Conflicts & Open Questions

- “Comprehensive” cannot mean every country-specific statutory variant; jurisdiction rules will be represented as overlays on canonical intents.
- Some HRO operating models place recruiting, IT access, facilities, travel, expenses, and occupational health outside HR. The matrix will retain cross-functional intents but name the accountable boundary.

## Gaps

- Jurisdiction, legal-entity, worker-type, union/CBA, plan, and effective-date rules require client-specific overlays.
- The product still needs a governed import path for the 320-leaf catalog and registered executors beyond the two simulations.