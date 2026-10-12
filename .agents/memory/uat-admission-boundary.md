---
name: Separate UAT admission
description: Existing identities must explicitly reauthenticate for UAT without gaining domain authority
---

UAT uses the existing identity directory, but a Control Tower session alone must never admit it. Public demo tickets and private development administration are not UAT authentication proof.

**Why:** The user selected existing accounts with explicit separate UAT sign-in, not a new identity pool or an admin-only audience.

**How to apply:** Keep the fresh credential proof, actual active workspace membership, and short-lived UAT admission separate from professional grants, model-spending consent, and live-effect permissions. Demo Center and Learning Guide remain Control Tower responsibilities.
