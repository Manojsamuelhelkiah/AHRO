---
name: Independent employee verification ownership
description: Personal Vault ownership and all-required BGV reuse product constraints
---

Employee Vault is a standalone employee-owned product, not an employer portal.
Registration must never grant employer membership, administration or verifier
authority. Tenant opt-out must not destroy or transfer the personal account.

**Why:** The product was explicitly requested for anyone to register without an
employer invitation and retain reusable evidence independently of employment.

**How to apply:** Future HRO consumers should evaluate the employee's consented
evidence through shared services and keep only appropriate dated employer
receipts, rather than copying or claiming ownership of the personal Vault.

All employer-required checks are the reuse basis. Identity-only verification
does not mean full BGV when additional checks are required. No unspecified
commercial source should be selected or represented as a working integration.

**Why:** The user selected reuse of all employer-required checks and explicitly
left the commercial provider undecided.

**How to apply:** Fail closed on incomplete/unapproved requirements and source
configuration. Scope, expiry, independent case binding and employee consent
must be explicit; an opaque Vault ID or candidate-email match is not permission.

Privacy withdrawal must not be rejected because employer sensitive-collection
policies are unavailable. It may invalidate authority using minimal numeric
state, but must not rewrite opaque case narratives under a missing policy/hold.

**Why:** Testing showed that a normal approval-reopen path could roll back
revocation when collection policy was absent, leaving consent active.

**How to apply:** Keep withdrawal separate from new disclosure/collection.
Preserve the date of prior disclosure rather than pretending it can be undone.

Independent-owner changes can affect several employers. Acquire all physical
lifecycle fences on one session without nesting different HRO tenant contexts;
never detach an employer-scoped execution to give it cross-tenant authority.

**Why:** A browser journey with two employers exposed a tenant-context mismatch
that single-employer tests missed. One pooled session also avoids a lifetime
portfolio of employers exhausting the connection pool.

**How to apply:** Independent Vault root mutations and tenant operations remain
different execution boundaries, even when they share the same physical locks.

Provider coverage does not imply jurisdictional processing approval. Capture
the approved country at collection and require it at verification/disclosure;
never infer an old document's collection authority from today's configuration.

**Why:** A supported issuer country alone otherwise allows reuse outside the
independent processor/privacy approval's country.

**How to apply:** Country changes require separately reviewed processing and
new evidence collection; employee withdrawal remains available regardless.
