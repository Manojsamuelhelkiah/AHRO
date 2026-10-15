---
name: Agent permission deferral
description: Temporary Access and equipment communication exception for an active agent owned by its client-administrator initiator.
---

Separate agent read and communication grants are temporarily deferred for Access
and equipment: an active registered agent owned by a named active client owner
or administrator may use that initiating administrator's current case-scoped
read and email-dispatch rights.

**Why:** The user explicitly requested access to identity, payroll and other
required fields now, with separate agent permissions to be implemented later,
after the Offboarding Agent test was blocked by missing delegated grants.

**How to apply:** This is a runtime exception for Access and equipment, not a
global permission grant or an exception for unrelated HRO agents. Retain active
ownership, membership, tenant/case scope, transport and consent checks, human
policy/decision requirements, and explicit request initiation. Revoking the
agent or downgrading its administrator removes the exception immediately.
Neither the exception nor the human's broader rights grants the agent approval,
policy-management, operational execution or final case-closure authority.
