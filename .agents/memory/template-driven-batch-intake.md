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

Email-template normalization must not infer workforce semantics from descriptive labels.

**Why:** The reported email used “External FTE” as a worker category and “Low” for site exposure, but the product's choices are different concepts. Plausible-looking conversions would invent facts the source did not supply.

**How to apply:** Normalize only unambiguous representation differences. New semantic aliases require an explicit supported rule, not a model guess, hire-template assumption or sender-derived default. Show source problems separately from absent facts, and preserve human edits when retrying extraction.

Complete fictional email examples must leave optional tenant-specific operational identifiers blank rather than invent an enabled binding.

**Why:** A plausible fictional job-profile identifier is syntactically valid but can make held intake conversion fail because no such enabled client profile exists.

**How to apply:** Include the field in the copyable example, but require the requester to supply a genuinely enabled tenant reference if applicable. Do not query or infer private tenant configuration to populate public example values.
