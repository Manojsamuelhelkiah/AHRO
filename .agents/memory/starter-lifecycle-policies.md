---
name: Starter lifecycle policies
description: Safety boundary between editable country templates and approved sensitive-data lifecycle policy.
---

Country defaults must be stored as inactive, review-required proposals outside the approved sensitive lifecycle policy table. They may be edited by current tenant members, but they never satisfy runtime lifecycle gates.

**Why:** A useful client onboarding template must not be represented as legal approval. The approved table requires verified privacy/legal authority and immutable approval evidence, while starter content is only review material.

**How to apply:** Keep provider sharing disabled in starters, label every placeholder and reference as unapproved, use optimistic versioning and tenant fencing, and copy into the existing approved-policy editor without auto-saving. Adoption still requires the normal verified authority flow.