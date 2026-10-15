---
name: Development preview host differences
description: Diagnose an older development preview before changing data or permissions.
---

Do not assume development URLs with the same project identifier serve the same source version.

**Why:** A user screenshot's suffixed development hostname served an older case-list implementation while the workspace's current development hostname served the merged implementation. The two live responses had different status logic; browser cache or permissions were not needed to explain the discrepancy.

**How to apply:** Compare the exact screenshot hostname against the current preview and inspect the relevant live frontend module at both addresses. Establish which source each serves before changing case records, access rules or workflows. Direct the user to the verified current preview when appropriate; do not hardcode temporary development hosts in application code.
