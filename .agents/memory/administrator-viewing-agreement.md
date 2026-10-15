---
name: Administrator case-access agreement
description: Verified administrator case editing is distinct from public demo identity, retained record state and employee-owned consent.
---

An authenticated, active Super Admin session may view and administratively
edit confidential case records in its verified selected client. The user's
expected controls include profiles, checklists and evidence notes, not merely
read access.
Eligibility, the shared account identity, and public Demo sign-in alone are
not active administrative privilege.

**Why:** The user explicitly requires full administrative case controls for the
password-verified Demo Administrator/Super Admin. Treating that verified session
as a read-only public demo persona contradicts this agreement.

**How to apply:** Preserve session-bound, tenant-verified administrative reads
and edits when evolving access policy. This does not manufacture professional
qualifications, source verification, independent review, external execution
authority or employee-owned Vault consent. Retained historical/UAT records
remain subject to their separate immutable-record safeguards; distinguish case
state from account-permission restrictions in the UI. Check real provider MFA
separately from isolated fixture tests.

The user identifies Demo Admin as the owner of Demo Organization.

**Why:** A task workspace's membership query may not reflect the workspace
the user is viewing; absence of an owner row there is not proof that their
Demo workspace has no owner.

**How to apply:** Treat Demo Admin as the intended administrative owner when
explaining setup. Verify the selected workspace and authenticated privileges
before changing access; this does not elevate a public Demo sign-in.
