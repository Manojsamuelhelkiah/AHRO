---
name: Application tenant boundaries
description: Durable rules for client organization isolation with Replit-managed Clerk.
---

Replit-managed Clerk authenticates people but does not provide Clerk Organizations. Client tenancy must therefore be application-owned: users select an organization, and the server accepts that selection only after verifying a persisted membership.

**Why:** User-level authentication alone does not isolate cases, estimates, custom configuration, uploads, or external effects. Defaults such as a shared demo tenant hide missing ownership and can silently cross tenant boundaries.

**How to apply:** Every client-owned row must carry an explicit organization identifier with no runtime default. Scope reads, writes, natural uniqueness, idempotency, caches, background jobs, and child-parent foreign keys by organization. Keep historical demo data in an explicit demo organization.