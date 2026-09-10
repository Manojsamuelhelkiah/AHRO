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