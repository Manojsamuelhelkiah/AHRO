---
name: Group stewardship boundaries
description: Ownership changes must not revive dormant access or create professional authority.
---

Changing a user group's steward is an administrative handoff, not an access grant. Retain group identity, members, attachments, and expiry settings, but require fresh independent membership review before retained paths become live under the new steward.

**Why:** Replacing an inactive owner with an active owner can revive every dormant group path, including legacy self-memberships, even when no membership or policy was added. Invalidating only sensitive approvals would miss non-sensitive access restoration.

**How to apply:** Treat stewardship transfers and reversals as fresh review boundaries, including low-sensitivity paths. Serialize with organization membership changes and recheck both acting and destination owners. Do not infer policy-maintainer appointments, specialist verification, or new group membership from ownership.

Administrative request eligibility and durable group-steward eligibility are distinct. Request-scoped administrative rights do not permanently change an account's tenant role or make a stored steward eligible.

**Why:** Persistent access liveness must not change according to whichever administrator happens to be making a request.

**How to apply:** Evaluate administrative action rights in request scope; independently retain persistent steward activity, destination-owner checks, membership review, and effective-access safeguards.

An admission review requirement must survive ordinary membership updates, expiry edits, and remove/re-add cycles, even after the linked policy becomes non-sensitive.

**Why:** Suspending a membership at the transfer endpoint is insufficient if a normal membership PUT can clear the admission gate. That silently bypasses the new steward's independent review.

**How to apply:** Enforce the retained admission requirement at every membership mutation and at effective-access evaluation. A no-op update must preserve approval evidence; a material change must require fresh review.
