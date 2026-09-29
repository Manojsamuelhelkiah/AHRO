---
name: Hybrid demo controller boundaries
description: Authorized scope and truthfulness rules for one-session onboarding demonstrations.
---

Hybrid demonstrations are restricted to explicitly created synthetic demo runs in Demo Organization. They do not activate the older offline reset samples or authorize changes to real employee cases.

**Why:** The user wants a complete presentation in one session, including real volunteer email and calls, without depending on BGV, payroll, access, or other real business systems.

**How to apply:** Keep simulated business outcomes and demo overrides separate from genuine evidence and historical outcome metrics. Preserve normal authentication, tenant isolation, and malware quarantine. Demo authority must come from protected server-owned run membership, not a synthetic-looking name or a mutable contact field.

Demo Center and its God Mode controls are available to every signed-in Demo Organization member, not only Owners/Admins.

**Why:** On 2026-09-10 the user explicitly replaced the original admin-only policy after it blocked access to the published demo. Requiring role promotion or an owner bootstrap would recreate the rejected experience.

**How to apply:** Accept ordinary member access for demo runs and overrides without promoting anyone's organization role. Keep authentication, Demo Organization scope, run ownership markers, approved-recipient restrictions, and real-case administration safeguards. Do not restore the old admin-only gate when merging access-setup work.

Real communication is opt-in per action, limited to the selected approved volunteer and channel. Simulation is a separate, visibly labelled fallback, not an automatic retry or a replacement for an uncertain provider result.

**Why:** A delayed response may follow a successful real send or call. Automatically retrying or describing that attempt as simulated can duplicate contact and misrepresent what happened.

**How to apply:** Retain durable dispatch claims and provider outcomes, revalidate the volunteer before dispatch, and never let a communication capability enable real HRIS, payroll, or access writes.

An uncertain live attempt and a subsequent simulated fallback are separate actions, not retries of one request.

**Why:** reusing a consumed request identifier for a changed fallback payload can trap the presenter in conflicts; replacing the original outcome would also hide whether real contact occurred.

**How to apply:** keep the original identifier only for an identical retry, retain the live attempt's history, and give the explicit simulated fallback its own identity.

Public shared demo identities need a server-owned registry and a non-bypassable privilege ceiling: effective tenant role stays member, tenant scope stays Demo Organization, and specialist access is valid only for the dedicated administrator on currently marked synthetic cases.

**Why:** Email-allowlisted one-click tickets make each shared principal publicly usable. Any retained membership, normal authority grant, body-supplied case ID, or provider-bound approval can otherwise turn that convenience into access to ordinary cases or governance controls.

**How to apply:** enforce the ceiling in tenant resolution, organization administration, every authority resolver (including final provider checks), and routes whose case ID is outside the URL. Revoke legacy non-synthetic grants at login. Keep the reviewer without specialist authority; do not loosen blocked surfaces until their projections and writes are synthetic-only end to end.

Control Tower intake for a public Demo Administrator is an offline synthetic creation path, not implicit authorization for a live-email demo.

**Why:** Allowing the familiar Create Case form must not silently contact addresses supplied by a public shared identity. Approved-volunteer live demonstrations have a separate explicit authorization flow.

**How to apply:** keep creation and case-scoped access atomic and prohibit automatic outreach or orchestration for this intake path. Explain the distinction in the form and delivery summary.

Restarting a synthetic simulation retires its progression, not its audit evidence. Versions are meaningful only within a generation.

**Why:** Resetting a numeric version alone lets delayed requests from an earlier run match a new run and apply unintended exchanges. Deleting history would misrepresent prior simulated activity.

**How to apply:** require the original generation and version on mutations, preserve the exact request identity and payload across uncertain retries, and retain previous simulated exchanges in append-only case history. A restart must never reset the underlying case or live-provider state.

Controlled volunteer email status is part of the durable public simulation projection: mask the recipient, distinguish sent from unknown delivery, and never allow an unknown or already-sent attempt to be retried automatically.

**Why:** A provider exception after dispatch can leave delivery ambiguous; hiding that state on reload invites duplicate contact and makes the presentation claim more certainty than the provider gave.

**How to apply:** persist the dispatch outcome and expose only safe status/reason fields through simulation GET responses. If a restart races with dispatch, persist the retired/stale transition so a later reply is correlated as stale rather than lost or applied to the new generation.

Demo Administrators may review a read-only audit projection, but that projection must remain synthetic-case scoped and must not include tenant governance controls.

**Why:** The standalone Audit Trail is important for a convincing demonstration, while the shared Demo Organization means organization-wide evidence, exports, integrity details, retention, legal holds, corrections, and retained approval history would expose or control other users' records.

**How to apply:** derive scope on the server from the current registered Demo Administrator, active synthetic-case assignments, and server-generated pseudonymous case references. Include only those case-linked events plus that principal's own unscoped demo actions. Never accept client-supplied case IDs as authority or promote the principal's tenant membership.

Real client tenant selection must use a named, individually authenticated person with explicit client-granted access; the selectable public Demo Administrator sign-in remains pinned to Demo Organization.

**Why:** The user confirmed named sign-in for real tenants. Public one-click demo identities cannot safely hold a client grant, even when a UI offers a tenant or group-mode chooser.

**How to apply:** Show only tenants that granted the named person access; revalidate membership, grant scope and group mode server-side on each request. Preserve the demo profile's current default and do not turn no selection into cross-client access.