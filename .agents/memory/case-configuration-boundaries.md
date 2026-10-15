---
name: Case configuration boundaries
description: Keep reusable client configuration out of case pages and avoid repeated provenance callouts.
---

Reusable communication and client configuration belongs in Client Setup, with
front-end selection of named contacts and agents rather than requiring users to
copy system IDs into each case. Case pages should focus on the request, tasks,
conversations and decisions—not a separate operational-preparation process.

Case details must be action-first: the first block explains the current required
action and contains the existing controls to complete straightforward work.
Ask AI follows that block and opens only through "Ask about this case".
Original intake request and supporting records belong below in initially
collapsed sections.

**Why:** The user explicitly wants business users to finish simple transactions
without reading the content below Original intake request.

**How to apply:** Preserve permission, evidence and version guards when moving
controls. Describe blocked, waiting and read-only records honestly. Explicit
tab/section deep links must still reveal the relevant collapsed content.

Do not add an Offboarding/Separations shortcut button to the main Cases header.

**Why:** The user explicitly removed that extra header button as unnecessary.

**How to apply:** Keep the existing Offboarding routes and Client Setup case links;
do not restore the main case-list header shortcut to solve discoverability.

**Why:** The product owner explicitly said the additional Operational preparation
section was not requested and made the already complicated case page unusable.
Repeated fictional-source explanations were also rejected; the S-number is the
intended visible distinction.

**How to apply:** Do not restore preparation/enrollment setup forms as prominent
case-page sections. Keep provenance, verification, permissions and provider fences
internally enforced. Merely saving reusable defaults never starts communication.
A named client administrator may explicitly enable client-wide email for eligible
Access and equipment cases; those cases inherit a version-bound contact snapshot
unless explicitly overridden or paused. Initial requests remain explicit and
case readiness is independently checked before sending.

Saving a case-specific task owner or escalation contact requires active named
client membership and an allowed deliverable address, not case-read, case-edit
or decision permissions on the recipient.

**Why:** Reusable client defaults already permit contact configuration before
execution readiness; case overrides must follow the same configuration boundary
instead of blocking setup on permissions used only by delivery and replies.

**How to apply:** Separate contact validation from live send/reply authorization.
Configuration never grants recipient access or decision authority; retain
case-specific permissions and independently verified identity where actual
disclosure or source-confirmed transitions require them.

Escalation is optional, controlled by the client administrator's escalation
switch; escalation contacts are required only when it is enabled.

**Why:** The user explicitly requested Enable email for client in Client defaults
and rejected mandatory escalation contacts when escalation is not being used.

**How to apply:** Saving settings must work before a case plan is ready without
approving that plan. Client pause also blocks overridden cases' sends; enabling
the client must not erase explicit case pauses or send initial mail.

Email consent and email verification are assumed Yes as client declarations.
Use two small default-checked case indicators; no routine consent forms or
verification process. Unchecking either pauses case email until manual review.

**Why:** The product owner explicitly confirmed that manual review should be an
exception, not a separate process imposed on every case.

**How to apply:** Reusable contact/agent defaults belong in Client Setup. Keep
client declarations distinct from independently verified reply identity.
Rechecking a previously flagged indicator must not bypass manual review.

Demo Organization must come with a generated client policy document that can
be replaced or retired through the normal client policy interface. Do not
return that initial policy upload as a task for the Demo operator.

**Why:** The user explicitly requested a default generated Demo policy and
rejected the growing manual setup checklist.

**How to apply:** Supply the initial document as client setup data, preserve
its generated provenance internally, and keep technical file checks and
separate live-effect permissions intact. Never invent a human approval receipt.
