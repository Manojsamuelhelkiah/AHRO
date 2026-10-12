---
name: Workforce transfer boundaries
description: Transfer evidence, country-specific authority, and cutover approval semantics
---

Workforce transfers are governed programs, not new-hire or internal-transfer case labels. Human-executed migration can be recorded as source-attested reconciliation, but must never be described as an application-dispatched provider action.

**Why:** Existing new-hire offer/BGV gates do not establish jurisdiction-specific transfer obligations, and recording a cutover plan cannot prove actual payroll continuity.

**How to apply:** Keep Legal-reviewed applicability independent of new-hire defaults. Require current country-specific authority and lawful sharing approval before retaining source rows. Derive outcome metrics from dated facts under an approved definition revision, not caller-supplied success flags.

Consolidated work lists may show programs beside individual cases, but must keep their counts, native statuses, and metrics separate. Population summaries describe only readable countries; missing expected headcounts remain unknown.

**Why:** The consolidated Cases view is a navigation convenience, not a change to transfer authority or a source of individual-case completion evidence. The recorded legal Day 1 is a plan, not evidence that cutover happened.

**How to apply:** Preserve separate program navigation and country-scoped summaries in any future unified work-list or reporting change. Do not infer program-to-case links from worker identity or names.

Cutover sign-offs bind the readiness evidence generation; collecting another sign-off must not itself invalidate other sign-offs.

**Why:** A single general edit version either permits stale evidence approvals or makes multi-owner approval impossible.

**How to apply:** Separate optimistic-write versioning from readiness generations, invalidate approvals when evidence or population changes, and revalidate current authority and retention at go/no-go. Retention must use the existing hold-aware deletion workflow, not an independent expiry cascade.

Jurisdiction-specific retention must distinguish new source evidence from lifecycle administration.

**Why:** Treating one country's deletion as fresh source activity delays already-due sibling-country jobs by another full retention period. Shared records and embedded cohorts also retain country-linked data even after worker rows are removed.

**How to apply:** Evaluate all retained representations, scrub embedded country references during partial deletion, and test simultaneously due jurisdictions at the same clock time. Lifecycle-only removal must not refresh source custody age.