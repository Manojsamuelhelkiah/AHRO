---
name: Agent inspection boundaries
description: Product distinction between catalogue roles, legacy personas and independent workflow components.
---

Catalogue roles, the legacy onboarding persona registry, and independently implemented workflow components are separate identity and authority sources. Similar names never establish an executor, accountable owner, principal binding or transport association.

**Why:** The product owner explicitly requires both registries and historical references to remain intact. The same short name can identify different things; presenting an existing model call as a registered role's executor would invent runtime authority.

**How to apply:** Use explicit source evidence for every inspection association. Treat legacy team-owner labels as labels, not human ownership. Attribute audit records only as precisely as their stored identifiers allow; principal/version matches do not prove a role or binding generation. Keep static configuration inspection read-only, and preserve capability-specific registration semantics rather than generalizing all registration as setup-only.
