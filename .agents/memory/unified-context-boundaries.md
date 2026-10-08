---
name: Unified HRO context boundaries
description: Scope, privacy and authority decisions for shared transaction context
---

The first unified context manager covers all existing HRO workflows, not only onboarding or named-agent invocations.

**Why:** The user explicitly selected all existing HRO workflows as the first-release scope.

**How to apply:** Extend shared execution boundaries rather than introducing separate context managers for each domain.

Unified context is execution scope and continuity metadata, never professional authority, a permission snapshot, or a replacement workflow engine. Recovery must use current domain records and preserve completed-effect fences.

**Why:** Workflow unification must not let a historical context record authorize new disclosure, replay an uncertain provider effect, or override independently governed evidence.

**How to apply:** Keep prompt/evidence construction behind existing live domain authorization. Do not persist prompts, answers, source documents or contact details in context history. Reject an oversized authorized prompt rather than silently truncating mandatory evidence or inventing a summary.

Operator investigation must remain a separately granted, live human metadata capability, not a consequence of tenant administration or specialist authority. Shared public demo identities may never use organization-wide context history, even if accidentally granted that capability.

**Why:** Operational continuity must be inspectable without disclosing business evidence or enabling a historical record to authorize recovery effects.

**How to apply:** Correlation navigation stays inside the same current tenant and permission boundary. Treat absence of finalization as unfinished regardless of age; do not turn it into confirmed failure or a manual provider replay.

Execution-history seek cursors must retain PostgreSQL timestamp precision, not JavaScript Date precision, and must remain usable when retention deletes their boundary row.

**Why:** PostgreSQL stores microseconds while JavaScript Date keeps milliseconds; rounding a seek boundary can silently skip attempts. Retention runs independently of investigation.

**How to apply:** Use an exact database timestamp plus a deterministic tie-breaker for seeks, bind the cursor to the tenant, principal and filters, and recheck current metadata authority on each page.
