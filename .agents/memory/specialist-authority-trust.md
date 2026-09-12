---
name: Specialist authority trust
description: Trust limits for governance bootstrap, remote decisions, and historical authority migration.
---

Workspace membership, contact-role labels, and intended email personas do not establish specialist competence. Operator attestation is not directory verification or external governance approval.

**Why:** Authenticated workspace access proves who can enter the application, not who may authorize payroll, legal decisions, or medical clearance. An allowlisted shared mailbox cannot reliably identify the individual responder.

**How to apply:** Permit email decisions only with explicit governance authorization and independently verified identity-provider ownership of the exact responder address; otherwise direct responders to authenticated decision intake. Bootstrap requires explicit externally approved governance evidence through the protected operator procedure; never approve real governance merely to demonstrate the UI. Preserve old approvals as history and require a new authority-bound review before new effects, without retroactively asserting verified authority.

Revocation must serialize with both authority grants and actual provider dispatch, not just an earlier approval check.

**Why:** A correct check followed by an unfenced write can race a revocation and authorize an effect after the grant has ceased to be valid.

**How to apply:** Keep live verification and the protected mutation inside the shared tenant authority fence. Include grant-versus-revoke and dispatch-versus-revoke cases when extending authority consumers.

Identity-provider ownership of an email address does not authenticate a received message.

**Why:** A forged From header can name a legitimate specialist. Directory verification alone would then falsely attribute the forged decision to that person.

**How to apply:** Remote decisions require independently verified message-bound transport proof as well as current scoped assignment. Never trust a sender-supplied Authentication-Results header or an unsigned message body; unsupported messages must receive an explicit authenticated-app handoff.

Use FK-compatible case locks when a fenced provider callback inserts child records through another database connection.

**Why:** Holding FOR UPDATE on the parent while awaiting a separate child insert deadlocks against that insert's FK KEY SHARE lock.

**How to apply:** Keep the tenant fence for completion/dispatch serialization and use FOR NO KEY UPDATE for the live case check when the case key is not being changed.