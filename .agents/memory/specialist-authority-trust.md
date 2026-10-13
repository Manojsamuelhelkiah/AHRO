---
name: Human decision permission boundaries
description: Specialist authority is retired; ordinary access and explicit human review do not establish professional qualifications.
---

Specialist authority verification, assignments and bootstrap are retired. Use current tenant/case effective permissions and explicit human decisions, not a replacement role/scope registry. Routing roles and ordinary access do not establish professional competence.

**Why:** The user explicitly selected complete retirement, superseding separate specialist verification requirements. This does not remove policy governance, professional source evidence, privacy safeguards, independent human review or execution fences.

**How to apply:** Human decisions require exact approval-decision permission; policy actions require policy-management permission, alongside existing flow/field permissions. Email setup additionally requires a named current client owner/admin. Retain old specialist evidence as history only. Require explicit fresh revision/evidence-bound review before unexecuted effects; never migrate receipts into approvals, reactivate legacy routes, resume held work or replay completed/ambiguous effects automatically.

Permission revocation must serialize with actual provider dispatch, not just an earlier approval check.

**Why:** A correct check followed by an unfenced write can race a revocation and authorize an effect after the grant has ceased to be valid.

**How to apply:** Keep live verification and the protected mutation inside the shared tenant authority fence. Include grant-versus-revoke and dispatch-versus-revoke cases when extending authority consumers.

Identity-provider ownership of an email address does not authenticate a received message.

**Why:** A forged From header can name a legitimate member. Directory verification alone would then falsely attribute the forged decision to that person.

**How to apply:** Remote decisions require independently verified message-bound transport proof, a separately consented exact uniquely verified named-member email binding, and current scoped effective permissions. Neither a mailbox persona nor a retained specialist assignment supplies that binding. Never trust a sender-supplied Authentication-Results header or an unsigned body; unsupported messages receive an authenticated-app handoff.

Use FK-compatible case locks when a fenced provider callback inserts child records through another database connection.

**Why:** Holding FOR UPDATE on the parent while awaiting a separate child insert deadlocks against that insert's FK KEY SHARE lock.

**How to apply:** Keep the tenant fence for completion/dispatch serialization and use FOR NO KEY UPDATE for the live case check when the case key is not being changed.