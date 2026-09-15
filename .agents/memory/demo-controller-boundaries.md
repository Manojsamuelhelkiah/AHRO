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

Offline synthetic Demo Administrator intake still requires tenant lifecycle-policy records because it accepts candidate-provided identity/contact material, even though that branch cannot start communications, providers, readiness, SLA, or orchestration effects.

**Why:** The synthetic marker fences operational effects but does not make retained PII non-sensitive. The recorded work jurisdiction must therefore have the same approved lifecycle coverage as an ordinary case; the isolated browser fixture supplies that policy coverage without weakening the production gate.

**How to apply:** Keep the offline path server-owned and limited to the registered Demo Administrator plus Demo Organization plus the offline synthetic marker. Require the normal lifecycle gate for both offline and ordinary cases, while continuing to prohibit automatic outreach or orchestration for the offline path.

Restarting a synthetic simulation retires its progression, not its audit evidence. Versions are meaningful only within a generation.

**Why:** Resetting a numeric version alone lets delayed requests from an earlier run match a new run and apply unintended exchanges. Deleting history would misrepresent prior simulated activity.

**How to apply:** require the original generation and version on mutations, preserve the exact request identity and payload across uncertain retries, and retain previous simulated exchanges in append-only case history. A restart must never reset the underlying case or live-provider state.