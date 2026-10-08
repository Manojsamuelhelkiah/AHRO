---
name: Template-driven batch case intake
description: Product requirement for case-type-specific batch upload templates.
---

Batch upload must use different input templates for different case types, with subtype-specific variants where their required inputs differ. Do not substitute a single generic new-hire spreadsheet for all HRO requests.

**Why:** The user explicitly requested that each case type have its own templates for batch creation.

**How to apply:** Distinguish spreadsheet input templates from internal policy/checklist templates. Identify case family and request subtype explicitly, validate against their approved versioned input schema, and route each row to its supported creation workflow. A displayed case-category label or demo scenario is not evidence that a live batch-creation adapter exists. Preserve policy approval, sensitive-data restrictions and explicit release boundaries.
