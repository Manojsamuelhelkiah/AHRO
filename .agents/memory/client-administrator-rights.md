---
name: Client administrator rights
description: Client admins have full administrative permissions in their own client, not platform-wide privileges.
---

Active named client owners and administrators receive full administrative rights
within their own client. Ordinary members still require scoped grants. Platform
Super Admin remains the separate cross-client administrator.

**Why:** The user explicitly chose client-only administrative rights after a
named login was blocked by per-case/profile grant requirements. Client admins
should not need individual grants for ordinary administration.

**How to apply:** Use current app-owned membership roles, not names, directory
labels, or public Demo shortcuts. Role downgrade and revocation must remove the
exception. Apply it consistently to case access and Settings controls, including
batch permission evaluation. Agents still need their own explicit permissions.
Independent review, evidence, consent, retained-record and external-execution
safeguards remain separate; administrative access is not proof those gates passed.
