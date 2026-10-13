---
name: Member identity presentation boundaries
description: Directory labels and internal-account presentation must stay separate from authority and account cleanup.
---

Directory names and emails are readable display information, not authorization, professional credentials or verified recipient bindings. Missing profiles and directory failures must be described honestly.

**Why:** The user requested identity clarity while preserving the ordinary-access model and all stored memberships and grants.

**How to apply:** Future member and governance surfaces must preserve immutable identifiers and existing access checks. Never invent names to hide a provider outage.

Internal/test-account presentation is not an account cleanup policy. A name or a `user_` prefix does not establish that an account is synthetic.

**Why:** The known development smoke identity must remain usable by test infrastructure while being distinguished from accountable human owners and initiating humans.

**How to apply:** Use trusted exact identity configuration, never naming heuristics; do not delete, revoke or automatically reassign retained records merely to improve labels.
