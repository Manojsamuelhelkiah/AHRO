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
