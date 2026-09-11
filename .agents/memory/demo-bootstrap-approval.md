---
name: Demo bootstrap operator approval
description: Why first Demo administrator setup uses private deployment approval rather than membership or Clerk metadata.
---

Initial Demo administrator authority must come from explicit trusted project-operator approval of a specific account-bound request, followed by that authenticated account's application confirmation. Deployment configuration is the approval trust channel, not email, domain, first login, or membership.

**Why:** Demo can legitimately have members and no administrator. Requiring an existing administrator would make recovery impossible. Replit's managed Clerk interface does not expose user metadata editing, so a metadata-only setup procedure would leave the operator blocked again.

**How to apply:** Keep setup limited to the initial Demo grant, with expiry and a durable one-time record. Describe `deployment-operator` as the approval source, not as a verified individual operator identity. Never configure an approval or modify a production membership on the user's behalf as part of implementation; the operator privately approves in the intended deployment and the user confirms in the app.

Administrator bootstrap must remain reachable independently of Demo presentation capability.

**Why:** The presentation policy can allow ordinary Demo members to run presentations without granting them administrator privileges. Hiding setup exclusively behind an unavailable-controller screen makes administrator approval unreachable for those members.

**How to apply:** Keep the two capabilities distinct in UI conditions, permission checks, and operator instructions.