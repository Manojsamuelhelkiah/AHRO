# Synthetic journey coverage and verification

## Scope and environment

The development fork was inspected on 2026-10-14. No production database was
queried or modified, no inventory cases were created, and no case was activated,
progressed or sent through a provider to produce these illustrations.

The owner's subsequent presentation instruction supersedes the initial
journey-level qualifier requirement: **the S-prefixed case number is the only
synthetic marker on the case screens**. Actions, reviews, workstreams, dates and
correspondence use normal case wording. Internal provenance and operational
separation remain unchanged; there are no provider delivery receipts or live
actions created by these read projections.

The read-only inventory script inspected **161 stored records** across the
workspace database and found **132 eligible records**: all 120 curated examples
and all 12 canonical examples. All expected fixed keys are present. It excluded:

| Exclusion | Records |
| --- | ---: |
| Controller-history provenance/state | 3 |
| Authoritative UAT/run-ledger ownership | 5 |
| Not verified fictional inventory (including real/hybrid/other records) | 21 |
| **Total excluded** | **29** |

The report deliberately outputs no contact information or private narrative.
For a fresh development inventory, run:

```sh
pnpm --filter @workspace/api-server exec env NODE_ENV=development SEED_SCRIPT=src/scripts/inspect-synthetic-journey-coverage.ts node run-seed.mjs
```

Despite the existing bundler's `run-seed` name, this particular script performs
only reads and logs aggregate coverage. It does not seed or update anything.

## Family/outcome matrix

Counts include ten curated scenarios and one canonical scenario per family.
Offboarding “completed” means **supported preparation only**, never final exit
closure. Unsupported final closure remains explicitly blocked.

| Family | Completed | Rejected | Blocked | Total |
| --- | ---: | ---: | ---: | ---: |
| Onboarding | 6 | 2 | 3 | 11 |
| Employee Changes | 5 | 2 | 4 | 11 |
| Payroll | 3 | 2 | 6 | 11 |
| Benefits | 3 | 2 | 6 | 11 |
| Leave | 4 | 2 | 5 | 11 |
| Compliance | 2 | 2 | 7 | 11 |
| Offboarding | 4 | 1 | 6 | 11 |
| HR Helpdesk | 5 | 2 | 4 | 11 |
| IT Access | 4 | 1 | 6 | 11 |
| Learning | 4 | 2 | 5 | 11 |
| Mobility | 5 | 1 | 5 | 11 |
| Documents | 5 | 2 | 4 | 11 |
| **Total** | **50** | **21** | **61** | **132** |

### Deterministic scenario coverage

C = completed, R = rejected, B = blocked. Columns 1–5 correspond in order to
the titled entries of each family in `offline-example-inventory.ts`; columns
6–10 correspond to `offline-example-extension.ts`. Each scenario has its own
authored rationale in `synthetic-journey-catalogue.ts`, not a status hash,
random status change or mutable stored narrative. The canonical column maps
to that family's reserved `UAT-DEMO-COVERAGE` scenario.

| Family | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | Canonical |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Onboarding | C | B | R | C | C | C | B | C | R | B | C |
| Employee Changes | C | C | C | B | R | C | B | B | R | B | C |
| Payroll | C | R | B | B | B | C | B | B | R | B | C |
| Benefits | C | C | B | R | B | B | R | B | B | B | C |
| Leave | C | B | C | C | B | R | C | B | B | R | B |
| Compliance | C | B | B | B | B | R | R | B | B | B | C |
| Offboarding | C | B | B | C | C | C | R | B | B | B | B |
| HR Helpdesk | C | C | B | C | R | C | B | B | B | R | C |
| IT Access | C | C | B | C | B | C | R | B | B | B | B |
| Learning | C | C | B | C | B | B | R | B | R | B | C |
| Mobility | C | B | C | C | B | B | C | B | R | B | C |
| Documents | C | C | C | B | B | R | C | B | R | B | C |

## Projection and permission boundaries

- `syntheticJourney` is a distinct optional API read field, generated through the
  OpenAPI workflow. No database schema, case status or operational row is changed.
- Require exact fixed inventory key and fictional identity, Demo tenant,
  non-deliverable contact, no phone or candidate authorization, no operational
  preparation/activation, no controller history and no authoritative run ownership.
- Require current case flow, profile, notes and readiness read access. A missing
  permission removes the entire journey. Mutable/custom prose is never copied
  into the illustration, even for a matching fictional identity.
- Original status, lifecycle, dates, workstreams and readiness stay in their
  operational fields. The UI presents normal case outcomes and actions, marked
  only by the S-reference, with recorded history and original message provenance
  separately identified.
- Genuine workstreams retain recorded owner, status and specific blockers.
  Missing ownership is explicit; `none` agents are rendered with the coordinating
  family agent, not a fabricated human assignment. Restricted ownership remains
  restricted instead of being replaced with a catalogue owner.
- Completed stories have reviewed prerequisites and no pending supported work.
  Rejected stories record the human reason and downstream cancellation. Blocked
  stories stop at the unresolved requirement and name the fictional responsible
  role; they have no fabricated final stage.
- Illustrative communications have no delivery status or send/reply controls.
  Sample source summaries are not verification; illustrative decisions are not
  approvals, professional authority or employee consent.
- Operational success, readiness, SLA and evidence calculations consume no
  journey fields. Existing offline volume inclusion rules are unchanged.
  A KPI regression compares the same operational inputs with and without all
  journey projections, both with excluded examples and with authorized offline
  volume inclusion, and requires identical results.
- Final offboarding closure, closed archives and alumni creation remain
  unsupported pending the missing approved section 4.6 requirements.
- Actions resolve the latest catalogue identities and versions. All twelve
  domain agents are represented; applicable supporting stages name Document
  Verification Agent, Assets & Workplace Agent and Systems Watcher Agent.
  Supporting responsibility does not create a registered principal invocation
  or restore the catalogue's unavailable operational capabilities.

## Served Case Health diagnosis

The published URL obtained from deployment metadata was
`https://hro-agent-nexus.replit.app`. Its public root HTML referenced
`/assets/index-CqXI4MeR.js`. Fetching that exact served bundle found:

| Text | Occurrences |
| --- | ---: |
| `Offline sample` | 1 |
| `Manual Demo data` | 1 |
| `Awaiting prerequisites` | 0 |
| `Synthetic journey` | 0 |

The two old strings occur in the compiled Case Health conditional itself.
This proves the published app was serving an older frontend build; it is not
merely an assumption about a local browser cache. The development root serves
Vite source modules from `artifacts/onboarding-agent`, and the API workflow was
rebuilt from this fork. Published availability is separate: these changes have
not been published by this task and do not replace the currently published
bundle. They must be merged into the main app before a subsequent publication
can serve them.

## Automated verification

- Exhaustive catalogue tests cover all 132 distinct scenarios, three outcomes
  per family, deterministic output, ordered dates, dependencies, completed
  prerequisites, rejected cancellation, blocked open actions and offboarding
  limits. Projection does not mutate input or satisfy unchanged checklist/email gates.
- Eligibility tests cover prepared/activated rows, wrong tenant/key/identity,
  deliverable or hybrid contacts, candidate authorization, controller provenance,
  checkpoints and historical markers, run ownership, custom and malicious prose.
- Database-backed API tests use a private schema invisible to background workers.
  All 120 curated list/detail projections agree; reads leave stored rows unchanged.
  Denied profile/notes/readiness fields, preparation/activation and run ownership
  suppress the journey. Operational statuses/readiness remain unchanged and
  retired execution endpoints still return 410 for every illustrated outcome.
- Existing fictional presentation tests confirm field redaction and preservation
  of authorized genuine recorded owners and specific blockers.
- UI rendering tests cover every family/outcome across overview, health, tasks,
  next actions, timeline and illustrative communications, and genuine-workstream
  cleanup without invented ownership. The final suite has 207 passing tests.
  Regression assertions reject synthetic/fictional/illustrative banners in
  journey rendering and verify normal correspondence without delivery controls.
- Catalogue tests assert current agent key, display name and version on every
  stage and representation of all fifteen catalogue roles across the inventory.
- Final affected checks: 3 journey/isolation/KPI tests, 3 fictional-projection
  tests, 7 case-list/detail batch API tests, 2 agent-catalogue tests and 207 UI
  tests passed. Canonical workspace typechecking passed; the final test additions
  and small intake/list copy changes also passed their affected package
  typechecks. No new hardcoded credentials were detected.

## Signed-in development browser verification

Existing Demo Reviewer ordinary-member access was used without case/permission
mutation, Super Admin access, sends or production activity. Thirty-six
representatives (one completed, rejected and blocked case per family), plus
canonical voluntary-offboarding S3237, were visited at each of 390×844,
820×1180 and 1440×1000: **111 case-detail visits**. Outcome, rationale, Case
Health, no-pending/specific open actions and horizontal overflow checks passed.
Ordered stage/date/agent/role assertions additionally covered 30 representatives.
Completed S3591, rejected S3651 and blocked S3654 had Tasks, Activity and
Communications inspected: read-only correspondence and timeline remained
separate from recorded activity/messages, with no send, approval, delivery,
retry, reply or simulation controls.

Canonical S3237 retained the section 4.6 closure blocker at all three widths.
Completed-preparation S3665 correctly retained the final closure hold without
pending supported preparation or archive/alumni creation.

The final desktop list showed 132 individual cases / zero programs, compact
single-line rows, matching visible outcome chips, S-references and no Offline
badge/banner. A full browser comparison of all 37 selected row statuses and
the exclusion total exceeded the browser's 45-second query limit and **is not
claimed as passed**. The list/detail API regression proves projection equality
for all 120 curated cases, and KPI isolation is separately unit-tested.
The final small list label edit replaces the generic “Case stages” text with
the current stage title using the same truncated single-line cell.
Permission-related resource 403s were observed without breaking the inspected
case screens; no permission checks were bypassed.

This verification is of the **development fork**, not the published release.
- The canonical root `pnpm run typecheck` includes generated libraries and all
  workspace artifacts/scripts.

The application workflows start successfully. Logs also contain existing
unrelated external-audit alert failures and sensitive-lifecycle policy blocks
in the readiness worker; these safeguards were not bypassed for the journey
presentation. The pre-existing broad browser-regression workflow had previously
failed before opening pages because its ffmpeg executable was missing; it is
not evidence of this journey's browser behavior.
