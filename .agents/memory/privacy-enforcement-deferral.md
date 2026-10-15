---
name: Privacy enforcement deferral
description: Product owner's temporary scope decision for data sensitivity and privacy workflow requirements.
---

The product owner requested deferral of data-sensitivity and privacy workflow
requirements across both development and the published application, until they
choose to activate those requirements at a later stage.

**Why:** Requiring those rules during early functional testing created repeated
conflicts and made the application difficult to use.

**How to apply:** Do not quietly restore classification, privacy-policy or
retention-readiness blockers during unrelated work. Keep unresolved requirements
unapproved. Preserve authentication, permissions, tenant isolation, private-file
access, malware checks, real-channel identity, personal ownership/withdrawal,
provider admission and evidence truthfulness. Activation is a later explicit
configuration decision, not a consequence of refreshing or publishing.

Do not couple record viewing to a retention-cleanup pause.

**Why:** Existing-record conversations need authorized read access even when
privacy-driven deletion is deferred. Using one eligibility check for both can
turn a safety pause into a product-wide access denial.

**How to apply:** Distinguish existing-record access from destructive cleanup at
the privacy boundary; retain independent live permissions and scope checks for
reads and notes, and keep cleanup paused.
