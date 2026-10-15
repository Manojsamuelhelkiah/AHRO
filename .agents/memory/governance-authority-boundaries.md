---
name: Governance authority boundaries
description: Effective policy-management permission and explicit version-bound review govern adoption; provisional policies cannot release live effects.
---

Policy approval requires current effective policy-management permission and a recorded human action. By default, uploading a client policy is the authorized uploader's approval action. Separate review applies only when explicitly required in Client Setup, not as a universal extra step. Tenant labels, case assignments and reviewer routing labels alone do not grant permission or establish professional qualifications.

**Why:** The user explicitly stated that permission to upload a client policy means the upload is approved, and repeated this to reject an extra approval process. The separate specialist-verification mechanism is also retired; ordinary scoped access governance remains.

**How to apply:** Restrict client policy uploads to users authorized to publish policies, and bind the approval record to the actual uploader, immutable document/version and upload time. File safety/extraction checks remain technical checks, not a second human approval. Reuse the existing policy engine and live access evaluator; do not create another specialist registry. Keep provider configuration and real source evidence independent. Never infer executable scope from editable prose, workflow labels or historical specialist receipts.

Active cases must retain their adopted revisions; publishing a replacement is not an implicit case rebase.

**Why:** Provisional planning is allowed without legal approval, and changing a tenant register must not silently change the basis of already-running employment workflows.

**How to apply:** Make revision impact visible, require explicit version-checked adoption at a safe boundary, and retain live revocation checks independently of historical approval receipts. Legacy absence of a snapshot is not permission for a new sensitive live effect.

Approval remains bound to its permission-based human receipt and adopted approval state, with live permission revalidation, not merely a reviewer identity or revision number.

**Why:** Retired specialist receipts cannot authorize new effects, and approving an already-adopted provisional revision must not silently activate a case.

**How to apply:** Evaluate both execution and impact against the adopted revision's approval receipt. Require explicit adoption even when only approval status changed.

Provider status labels, timestamps, and completed checks do not establish real source provenance.

**Why:** Existing simulation deliberately produces realistic connected states and completed provider checks, including timestamps and external references.

**How to apply:** Require server-classified trusted provenance independently of policy approval and human attestations. Historical records without provenance remain untrusted.

Any stateful tenant workflow (including governance, alert episodes, and provider reconciliation) that reads beneath a tenant advisory lock must use the lock-owning transaction.

**Why:** A helper that lazily seeds or reads through another database session waits on the caller's lock while the caller awaits the helper, deadlocking both individual and batch processing.

**How to apply:** Seed before acquiring the outer lock, then load or mutate required state through the existing lock-owning transaction after acquiring it.