---
name: Operational simulation truthfulness
description: Operational email and agent requests must be visible without claiming real external work.
---

Until a real operational interface is implemented, setup requests and agent actions must be explicitly simulated and recorded in Communications, with their own progress history.

**Why:** The user found activity statements such as assets “booked” and access “coordinated” misleading when no operational message or external action had occurred. Hosting the application in production does not make its vendor adapters real.

**How to apply:** Represent both email-led and agent-led tasks, identify the responsible team without inventing an email address, and distinguish simulated completion from genuine readiness evidence. Never turn these simulation controls into payroll, document, malware, or final-approval authority. For older cases, create missing requests through an explicit action with current timestamps rather than fabricating historical sends.

Internal/external agent identity is separate from whether execution is simulated or live. Any agent presented as internal must have a matching entry in the app's AI Agents catalog.

**Why:** The user requires realistic, inspectable agent attribution rather than a generic “AI Agent” label that cannot be traced to anything in the product.

**How to apply:** Use the same identity source for operational requests and the catalog, preserve the human initiator separately, and record agent identity with new history entries. Never backfill a claimed historical executor when the old record did not capture one; an email recipient is not an external AI agent.