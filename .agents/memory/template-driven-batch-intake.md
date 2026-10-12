---
name: Template-driven batch case intake
description: Product requirement for case-type-specific batch upload templates.
---

Batch upload must use different input templates for different case types, with subtype-specific variants where their required inputs differ. Do not substitute a single generic new-hire spreadsheet for all HRO requests.

**Why:** The user explicitly requested that each case type have its own templates for batch creation.

**How to apply:** Distinguish spreadsheet input templates from internal policy/checklist templates. Identify case family and request subtype explicitly, validate against their approved versioned input schema, and route each row to its supported creation workflow. A displayed case-category label or demo scenario is not evidence that a live batch-creation adapter exists. Preserve policy approval, sensitive-data restrictions and explicit release boundaries.

Original import inputs and source identifiers must survive policy rebasing. Reconciliation must compare immutable source receipts across batches, not only a mutable case snapshot or one upload's retry key.

**Why:** Correcting workforce policy must not erase intake provenance or permit the original spreadsheet to create duplicate cases.

**How to apply:** Keep source receipts distinct from execution authority. Exclude opaque input narratives from ordinary policy-read projections; disclose them only through the separately authorized case narrative boundary. Non-onboarding intake creates specialist-review requests, never an implicit onboarding execution adapter.

Discovery of built-in blank templates is separate from permission to submit employee data.

**Why:** New clients need to discover the available transaction types before their intake grants and approved collection policies are configured; gating discovery on intake authority made the selectors appear empty.

**How to apply:** Membership-only discovery applies only to built-in schemas and fictional examples. Keep filled uploads, import history, case records and client-private customizations behind their own appropriate permissions. Always explain unavailable catalog or submission access rather than hiding the reason behind empty controls.
