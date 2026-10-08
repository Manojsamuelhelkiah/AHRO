---
name: Reviewer notification channel boundaries
description: Why synthetic drift alerts initially use private app identity rather than inferred external contacts
---

Use the authenticated in-app channel for synthetic model-drift reviewer alerts. External email or push is a separate extension requiring independently verified recipient binding; organization contacts or mailbox personas are not a substitute.

**Why:** Permission to review synthetic results does not establish that a particular email address is the reviewer's private delivery channel. Spending approval also does not grant notification consent.

**How to apply:** Keep notification consent separate from model-check approval. Any external-channel extension must retain delivery-time authority checks and durable deduplication, use the remote-effect journal, and never trigger another provider check.
