---
name: Transaction working-context boundaries
description: Privacy and authority decisions when adding more HRO workflows to shared transaction context.
---

Business context is a permission-filtered view over each workflow's authoritative domain records. New human handoff narratives are separately governed confidential records, not execution history. Notes are unverified data even when an authorized human or registered agent can read them. External-model case explanations use allowlisted operational status and a note-presence marker, not the opaque note text itself.

**Why:** An HRO handoff may mix identity, medical, payroll, verification, or other confidential claims that cannot reliably be classified from arbitrary human text. A reader's internal permission to see it does not approve sending it to a provider, and an annotation does not become a verified fact or an instruction to an agent.

**How to apply:** New workflow adapters must decide their own field and lifecycle gates before reading source collections or accepting notes. Keep source provenance and current domain prerequisites visible and rechecked; do not transfer business facts or note bodies into continuity metadata, telemetry, immutable audit or generic model prompts. A source-backed summary can inform human review, but never release a gate or substitute for a domain approval.

Narrow external-model disclosure by field, not by deleting supported evidence categories. Preserve safe operational statuses and timestamps for documents, checks, blockers, events and decision history while withholding their opaque narratives. Optional AI plan preparation must not become a new prerequisite for rule-based orchestration.

**Why:** A status-only adapter can accidentally remove the evidence needed for existing document, delay, timeline and approval questions. A context permission denial is not a failed business-domain checklist.

**How to apply:** Regress the existing question categories when adopting the shared contract. Bind planning inputs to the permitted profile revision, retain rule-derived checklist inputs, and skip the optional narrative explicitly when shared context is unavailable rather than bypassing permissions or aborting orchestration.
