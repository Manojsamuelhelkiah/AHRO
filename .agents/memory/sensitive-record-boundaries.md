---
name: Sensitive record boundaries
description: Fail-closed classification and shared lifecycle fencing for onboarding confidentiality.
---
Treat opaque narratives as mixed-class confidential content. Keywords may justify restriction but cannot justify disclosure; a transport or document label does not classify arbitrary accompanying text.

**Why:** Recognizable medical wording does not rule out payroll or BGV material in the same message. Findings can also omit expected keywords entirely.

**How to apply:** Require all relevant live specialist authorities and provider approvals for opaque text. Reserve narrower access for trustworthy structured records and fixed status projections; inspect the final assembled response too.

Opaque onboarding uploads require all applicable lifecycle classes, regardless of their nominal document category.

**Why:** A filename or label cannot prove that medical, identity, or payroll material is absent. Single-class retention can bypass another class's legal hold.

**How to apply:** Use the same conservative class set for collection, storage disclosure, impact previews, cleanup and recovery. Every applicable policy must permit the action, and any applicable hold blocks deletion.

Retention policy changes, legal holds, deletion, and sensitive provider dispatch must share a serialization boundary.

**Why:** Rechecking a revision after deleting bytes or contacting a provider cannot reverse the effect. A separate fence for each subsystem does not prevent a concurrent policy change.

**How to apply:** Revalidate the current case and bind the payload to that exact context inside the fence. Keep it held through irreversible effects, and require renewed confirmation when deletion impact changes.

Nested operations must preserve both tenant lock ownership and transaction ownership.

**Why:** Reentrant advisory locks do not make row locks reentrant across pooled connections. An authorized operation can deadlock awaiting its own nested writer; denial-only tests miss this.

**How to apply:** Share the authority transaction with nested writes. Retain asynchronous lock ownership while children run, then invalidate it before detached work can reuse it. Test authorized paths as well as denials.

Treat opaque case narratives as mixed-class records, not derivatives that disappear when the uploaded file is deleted. Immutable private history that lacks governed retention must block new affected collection as well as automatic deletion.

**Why:** File-only cleanup leaves findings copied into events, approvals, case notes, and workflow snapshots. Guessing a class or rewriting immutable history trades one safety failure for another.

**How to apply:** Cover primary and copied representations, use every applicable approved policy and hold, and measure retention from the newest source. Preserve audit evidence without claiming unresolved records can be deleted.

Do not treat a safe evidence bundle as permission to transmit arbitrary user questions or conversation history.

**Why:** Users can paste unknown private findings that keyword filters cannot reliably classify; approval for a contact/status provider is not approval for every possible sensitive class.

**How to apply:** Select a fixed, locally determined question intent and send only that plus approved typed evidence, or require explicit full-payload disclosure authority. Apply cohort suppression before constructing any external analytics payload.