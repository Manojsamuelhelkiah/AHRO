---
name: Task Preview data boundaries
description: Match the user's Preview before making account and client setup assertions.
---

A task Preview and the main Preview can use different application databases
while recognizing the same authentication accounts. A verified login in the
identity provider does not establish membership in both databases.

**Why:** Inspecting task data led to incorrect statements about membership in
the user's main Preview. Matching the actual Preview host and reading its
authenticated setup routes resolved the discrepancy.

**How to apply:** Verify the exact Preview being discussed before reporting
client membership, owner roles, registered agents or installed policies. Never
copy memberships or permissions between workspaces to hide a mismatch. Existing
administrative setup must use the intended Preview's normal authenticated routes.
