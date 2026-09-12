---
name: Governance authority boundaries
description: Why policy review authority is separate from ordinary case assignments and how provisional policy affects live actions
---

Tenant administration and case-level operational assignments do not confer legal, privacy, or safety policy-review authority. A nomination is not verification.

**Why:** Existing case authority assignments are owner-maintained. Reusing them as specialist approval would let an ordinary administrator self-authorize decisions the user explicitly required to remain blocked.

**How to apply:** Reuse the checklist/context-policy execution engine, but verify the reviewer through a separate trusted assignment before treating a policy revision as approved. Keep policy approval, provider configuration, and real evidence independent. Never infer executable scope from editable prose or human-readable workflow labels.

Active cases must retain their adopted revisions; publishing a replacement is not an implicit case rebase.

**Why:** Provisional planning is allowed without legal approval, and changing a tenant register must not silently change the basis of already-running employment workflows.

**How to apply:** Make revision impact visible, require explicit version-checked adoption at a safe boundary, and retain live revocation checks independently of historical approval receipts. Legacy absence of a snapshot is not permission for a new sensitive live effect.

Approval remains bound to its exact authority grant and its adopted approval state, not merely a reviewer identity or revision number.

**Why:** A replacement role assignment must not resurrect an approval made under a revoked grant. Approving an already-adopted provisional revision must not silently activate a case.

**How to apply:** Evaluate both execution and impact against the adopted revision's approval receipt. Require explicit adoption even when only approval status changed.

Provider status labels, timestamps, and completed checks do not establish real source provenance.

**Why:** Existing simulation deliberately produces realistic connected states and completed provider checks, including timestamps and external references.

**How to apply:** Require server-classified trusted provenance independently of policy approval and human attestations. Historical records without provenance remain untrusted.

Governance reads beneath a tenant advisory lock must use the lock-owning transaction.

**Why:** A snapshot helper that lazily seeds through another database session waits on the caller's lock while the caller awaits the helper, deadlocking both individual and batch intake.

**How to apply:** Seed before acquiring the outer lock, then load the adopted snapshot through the existing transaction after acquiring it.