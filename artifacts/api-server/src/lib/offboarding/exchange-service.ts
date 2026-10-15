import { randomBytes, randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { and, eq, desc, sql } from "drizzle-orm";
import { db, offbCases, offbExchangePilots, offbExchanges, onbCases, organizationsTable, accessAgents, organizationMembershipsTable } from "@workspace/db";
import { resolveEffectiveAccessInTransaction } from "../access-governance";
import { hasHumanPermissions } from "../human-permissions";
import { registeredDemoProfile } from "../demo-principal";
import { explicitlyConfiguredAddressAllowed } from "../onboarding/channels";
import { withSensitiveLifecycleFence, evaluateCaseDerivedLifecycleGateInTransaction } from "../onboarding/sensitive-lifecycle";
import { acquireCaseDispatchMutationLock } from "../onboarding/dispatch-guard";
import { connectedIntakeMailbox } from "../hro-email-ingestion";
import { access, confidentialRead, currentReceipt, receipt, type Tx } from "./authority";
import { createFixedPilotSeparationInTransaction, audit, hash } from "./service";
import { initialPilotState, EnrollmentInput, contextualRequest, TASK_IDS, checksOf, communicationAllowed, type PilotState, type PilotTask, type Observation } from "./exchange-contract";
import { SeparationError, endOfLwd, object, text } from "./model";
import { offbPolicies } from "@workspace/db";
import { mockSourceStatus } from "./source-adapters";
import { externalProviderDispatchDenied } from "../onboarding/provider-policy";
import { exchangeTestIdentity } from "./exchange-test-boundary";
import { getUatCaseIsolation } from "../onboarding/uat-isolation";
import { sourceHandling, type SourceHandling } from "./source-handling";

export const PILOT_PROVENANCE = "offboarding-contextual/v1";
export type PilotRow = typeof offbExchangePilots.$inferSelect;
export type ExchangeRow = typeof offbExchanges.$inferSelect;
export const stateOf = (p: PilotRow): PilotState => structuredClone(p.state) as unknown as PilotState;
export async function verifyDemo(tx: Tx, org: string) {
  const [tenant] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, org)).for("share");
  if (org !== "demo" || tenant?.slug !== "demo" || tenant?.name !== "Demo Organization") throw new SeparationError("The verified Demo organization is required.", 403);
}
export async function namedOperator(tx: Tx, org: string, actor: string, caseId?: number) {
  if (await registeredDemoProfile(actor)) throw new SeparationError("Use your own named member account; shared Demo accounts cannot enable communication.", 403);
  await access(tx, org, actor, true, caseId);
  if (!await hasHumanPermissions(tx, { organizationId: org, actorUserId: actor, caseId, requiredKeys: ["tool.external.dispatch", "tool.notification.send", "tool.approval.decide"] })) {
    throw new SeparationError("Current channel dispatch and approval permissions are required.", 403);
  }
  if (caseId) await confidentialRead(tx, org, actor, "US", caseId);
}
export async function loadPilot(tx: Tx, org: string, id: number) {
  await verifyDemo(tx, org);
  const [pilot] = await tx.select().from(offbExchangePilots).where(and(eq(offbExchangePilots.organizationId, org), eq(offbExchangePilots.caseId, id))).for("update");
  const [row] = await tx.select().from(offbCases).where(and(eq(offbCases.organizationId, org), eq(offbCases.id, id))).for("update");
  const [envelope] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, org), eq(onbCases.id, id))).for("share");
  if (!pilot || !row || !envelope || pilot.provenance !== PILOT_PROVENANCE ||
      envelope.hireType !== "separation" || envelope.syntheticProvenance !== "demo-full-coverage" ||
      envelope.scenarioKey !== `OFFB-CONTEXTUAL:${pilot.scenario}` ||
      pilot.generation !== row.generation || envelope.workerEmail !== "" || envelope.operationalActivation ||
      (await getUatCaseIsolation(envelope, tx)).isolated) {
    throw new SeparationError("Exact current-generation offboarding communication provenance is required.");
  }
  return { pilot, row, envelope };
}
export async function persistState(tx: Tx, pilot: PilotRow, state: PilotState) {
  const [updated] = await tx.update(offbExchangePilots).set({ state: state as unknown as Record<string, unknown>, version: pilot.version + 1 })
    .where(and(eq(offbExchangePilots.organizationId, pilot.organizationId), eq(offbExchangePilots.caseId, pilot.caseId), eq(offbExchangePilots.version, pilot.version))).returning();
  if (!updated) throw new SeparationError("Conversation changed; reload before continuing.");
  return updated;
}
export async function policyGate(tx: Tx, row: typeof offbCases.$inferSelect) {
  const s = row.state;
  if (row.status !== "active" || s.gatewayA !== "clear" || s.conflict || s.pauseReason || s.holds.length ||
      s.urgency !== "Standard" || s.flags?.highRisk || s.flags?.privileged || s.sensitiveTriggers.length ||
      !/^(voluntary[- ]?)?resignation$/i.test(row.facts.exitType)) {
    throw new SeparationError("A current, unpaused standard voluntary-resignation plan is required.");
  }
  for (const r of [s.screening, s.classificationReceipt ?? null]) {
    if (!await currentReceipt(tx, row.organizationId, r, row.facts.country, row.id)) throw new SeparationError("Refresh screening and classification authority.");
  }
  if (!await currentReceipt(tx, row.organizationId, s.policyReceipt, row.facts.country, undefined, true)) throw new SeparationError("A current approved policy is required.");
  const [policy] = await tx.select().from(offbPolicies).where(and(eq(offbPolicies.organizationId, row.organizationId), eq(offbPolicies.id, s.policyId!), eq(offbPolicies.version, s.policyVersion!)));
  if (policy?.status !== "approved" || policy.approval?.authorityId !== s.policyReceipt?.authorityId) throw new SeparationError("Adopted policy approval was withdrawn or replaced.");
  const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: row.organizationId, jurisdiction: row.facts.country });
  if (!gate.allowed) throw new SeparationError(gate.reason);
  return endOfLwd(row.facts.lastWorkingDay, policy.policy.endOfLwd, policy.policy.timeZone);
}
export async function verifiedRecipient(tx: Tx, org: string, memberId: string, address: string, caseId: number, owner: boolean, requireTransportBinding = true) {
  if (!explicitlyConfiguredAddressAllowed(address) || /\.(?:invalid|test|example)$/i.test(address.split("@")[1])) throw new SeparationError("Recipient must be a deliverable address on the explicit configured allowlist.");
  if (await registeredDemoProfile(memberId)) throw new SeparationError("Shared Demo principals cannot be enrolled.", 403);
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, memberId))).for("share");
  if (!member || member.revokedAt) throw new SeparationError("Recipient needs a current named membership.", 403);
  let verified = false;
  if (requireTransportBinding) try {
    const fixture = exchangeTestIdentity();
    if (fixture) verified = fixture.members.get(address.toLowerCase()) === memberId;
    else if (!externalProviderDispatchDenied() && process.env.ONBOARDING_AUTOMATED_TEST !== "true") {
      const users = await clerkClient.users.getUserList({ emailAddress: [address.toLowerCase()], limit: 2 });
      const matches = users.data.filter(u => u.emailAddresses.some(e => e.emailAddress.toLowerCase() === address.toLowerCase() && e.verification?.status === "verified"));
      verified = matches.length === 1 && matches[0].id === memberId;
    }
  } catch { /* Fail closed; no directory ownership fallback. */ }
  if (requireTransportBinding && !verified) throw new SeparationError("The reply source must match the exact independently verified member email.");
  if (!await hasHumanPermissions(tx, { organizationId: org, actorUserId: memberId, caseId, requiredKeys: owner ?
    ["flow.case.read", "flow.case.edit", "data.case.profile.read", "data.case.profile.edit", "tool.approval.decide"] : ["flow.case.read", "data.case.profile.read"] })) {
    throw new SeparationError("Recipient's current scoped case permissions are insufficient.", 403);
  }
}
/** Recorded reassignment/KT owner labels are not recipient bindings or access
 * grants. Human source declarations must name an independently current member. */
export async function verifyHandlingOwner(tx: Tx, org: string, id: number, handling: SourceHandling) {
  const target = handling.sharedAccountOwner ?? (handling.ktRequired ? handling.ktOwner : undefined);
  if (!target) return;
  if (await registeredDemoProfile(target) || !await hasHumanPermissions(tx, { organizationId: org, actorUserId: target, caseId: id,
    requiredKeys: ["flow.case.read", "data.case.profile.read"] })) throw new SeparationError("The recorded account/KT owner needs a current named membership and scoped case-read access.");
}
export async function agentGate(tx: Tx, org: string, operator: string, agentId: string, caseId: number) {
  const [agent] = await tx.select().from(accessAgents).where(and(eq(accessAgents.organizationId, org), eq(accessAgents.id, agentId))).for("share");
  if (!agent || agent.status !== "active" || agent.revokedAt || agent.ownerUserId !== operator) throw new SeparationError("Select an active registered agent owned by the named initiating operator.", 403);
  const effective = await resolveEffectiveAccessInTransaction(tx, { organizationId: org, principalType: "agent", principalId: agentId, caseId, purpose: "offboarding-contextual-conversation", initiatorUserId: operator });
  if (!["tool.case.read", "flow.case.read", "data.case.profile.read", "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read", "tool.notification.send", "tool.external.dispatch"].every(k => effective.allows.includes(k))) throw new SeparationError("Agent requires delegated private case-read and conversation-dispatch capabilities intersected with its initiating operator; no decision authority is inferred.", 403);
}

/** Additive, retry-safe, sends nothing and grants no authority. */
export async function provisionExchangePilots(org: string, actor: string, input: unknown) {
  if (object(input).confirmAddThree !== true) throw new SeparationError("Explicitly confirm adding the three resignation cases.", 400);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await verifyDemo(tx, org); await namedOperator(tx, org, actor);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('offb-contextual-provision:v1', 0))`);
    const ids: number[] = [];
    const day = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    for (const scenario of ["success", "delayed", "exception"] as const) {
      const [existing] = await tx.select().from(offbExchangePilots).where(and(eq(offbExchangePilots.organizationId, org), eq(offbExchangePilots.scenario, scenario)));
      if (existing) { ids.push(existing.caseId); continue; }
      const employeeId = `FICTIONAL-OX-${scenario.toUpperCase()}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`separation:${org}:${employeeId}`}, 0))`);
      const collision = await tx.select({ id: offbCases.id }).from(offbCases).where(and(eq(offbCases.organizationId, org), eq(offbCases.employeeId, employeeId)));
      if (collision.length) throw new SeparationError("The reserved fictional identity already has a historical record; it cannot be promoted.");
      const result = await createFixedPilotSeparationInTransaction(tx, org, actor, scenario);
      // Newly-created exact envelope only. Existing employee/source collisions abort.
      const [envelope] = await tx.select().from(onbCases).where(eq(onbCases.id, result.caseId));
      if (!envelope || envelope.syntheticProvenance || result.status === "deduplicated") throw new SeparationError("Provisioning collision; historical rows cannot be promoted.");
      await tx.update(onbCases).set({ scenarioKey: `OFFB-CONTEXTUAL:${scenario}`, syntheticProvenance: "demo-full-coverage", notes: "[synthetic-offline-reset:v1]", updatedAt: new Date() }).where(eq(onbCases.id, result.caseId));
      const state = initialPilotState(`${day}T00:00:00.000Z`);
      state.clock = new Date().toISOString();
      state.tasks.forEach(t => { t.dueAt = ""; t.notBeforeAt = null; });
      await tx.insert(offbExchangePilots).values({ caseId: result.caseId, organizationId: org, provenance: PILOT_PROVENANCE, scenario, createdBy: actor,
        state: state as unknown as Record<string, unknown> });
      ids.push(result.caseId);
    }
    return { caseIds: ids, sent: 0 };
  }));
}

export async function enrollExchange(org: string, actor: string, id: number, raw: unknown) {
  const parsed = EnrollmentInput.safeParse(raw);
  if (!parsed.success) throw new SeparationError("Provide current Gmail settings and valid task-owner and escalation contacts.", 400);
  const b = parsed.data;
  // Health probe is read-only; never a provisioning or enrollment send.
  const mailbox = b.enabled ? exchangeTestIdentity()?.mailbox ??
    (externalProviderDispatchDenied() || process.env.ONBOARDING_AUTOMATED_TEST === "true" ? null : await connectedIntakeMailbox()) : null;
  if (b.enabled && !mailbox) throw new SeparationError("Connected Gmail mailbox is unavailable. Restore mailbox health before enabling communication.");
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await namedOperator(tx, org, actor, id); await acquireCaseDispatchMutationLock(tx, org, id);
    const { pilot, row } = await loadPilot(tx, org, id), state = stateOf(pilot);
    if (state.enrollment.revision !== b.expectedRevision) throw new SeparationError("Enrollment changed; reload before approving.");
    if (b.enabled) {
      const due = await policyGate(tx, row);
      if (!b.agentId || !b.recipients.length) throw new SeparationError("Enroll at least one task owner and an independent escalation contact, and choose a registered agent.");
      await agentGate(tx, org, actor, b.agentId, id);
      if (new Set(b.recipients.map(r => r.taskId)).size !== b.recipients.length) throw new SeparationError("Each task needs exactly one enrolled source owner.");
      for (const r of b.recipients) {
        if (r.memberId === r.escalationMemberId || r.address.toLowerCase() === r.escalationAddress.toLowerCase()) throw new SeparationError("Escalation requires a distinct accountable person and mailbox.");
        await verifiedRecipient(tx, org, r.memberId, r.address, id, true, false);
        await verifiedRecipient(tx, org, r.escalationMemberId, r.escalationAddress, id, false, false);
        const task = state.tasks.find(t => t.id === r.taskId)!;
        if (task.owner !== r.memberId) {
          task.revision++; task.owner = r.memberId; task.confirmed = []; task.outstanding = [...task.expected]; task.status = "pending"; task.evidence = []; task.exception = null;
          delete task.handling;
        }
        task.dueAt = due; task.notBeforeAt = task.id === "access-closure" ? due : null;
      }
      const stale = new Set(state.tasks.filter(t => t.evidence.length === 0).map(t => t.id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const task of state.tasks) if (!stale.has(task.id) && task.prerequisites.some(p => stale.has(p))) {
          stale.add(task.id); changed = true; task.revision++; task.status = "pending"; task.confirmed = [];
          task.outstanding = [...task.expected]; task.evidence = []; task.exception = null;
          delete task.handling;
        }
      }
    }
    state.enrollment = { enabled: b.enabled, revision: state.enrollment.revision + 1, generation: row.generation,
      operator: actor, agentId: b.agentId ?? state.enrollment.agentId, mailbox: mailbox ?? state.enrollment.mailbox,
      approvedAt: new Date().toISOString(), recipients: b.enabled ? b.recipients.map(({ consentReference: _legacyConsent, escalationConsentReference: _legacyEscalation, ...r }) => ({ ...r, address: r.address.toLowerCase(), escalationAddress: r.escalationAddress.toLowerCase() })) : state.enrollment.recipients };
    state.communicationChecks = { ...checksOf(state), changedBy: actor };
    const saved = await persistState(tx, pilot, state);
    await audit(tx, org, actor, b.enabled ? "gmail-enrolled" : "gmail-paused", id, saved.version);
    return exchangeView(tx, saved);
  }));
}

export async function exchangeView(tx: Tx, pilot: PilotRow) {
  const blockers: string[] = [];
  const [row] = await tx.select().from(offbCases).where(and(eq(offbCases.organizationId, pilot.organizationId), eq(offbCases.id, pilot.caseId)));
  try { if (!row) throw new SeparationError("Case missing."); await policyGate(tx, row); } catch (e) { blockers.push(e instanceof SeparationError ? e.message : "Current policy readiness could not be confirmed."); }
  if (!stateOf(pilot).enrollment.enabled) blockers.push("Gmail communication is not enabled. A named operator must approve the exact case and enrolled recipients.");
  const messages = await tx.select().from(offbExchanges).where(and(eq(offbExchanges.organizationId, pilot.organizationId), eq(offbExchanges.caseId, pilot.caseId))).orderBy(desc(offbExchanges.createdAt)).limit(200);
  if (messages.some(m => m.status === "ambiguous")) blockers.push("Gmail acceptance is unconfirmed. The connected mailbox is checked for the exact signed frozen request; no automatic resend is allowed. Investigate the provider record if reconciliation stays blocked.");
  if (!communicationAllowed(stateOf(pilot)) && stateOf(pilot).enrollment.enabled) blockers.push("Case email is paused pending manual consent or address review.");
  return { caseId: pilot.caseId, version: pilot.version, generation: pilot.generation, ...stateOf(pilot), communicationChecks: checksOf(stateOf(pilot)),
    exchanges: messages,
    closureAvailable: false, blockers };
}
export async function readExchange(org: string, actor: string, id: number) {
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, false, id); await confidentialRead(tx, org, actor, undefined, id);
    const [pilot] = await tx.select().from(offbExchangePilots).where(and(eq(offbExchangePilots.organizationId, org), eq(offbExchangePilots.caseId, id)));
    if (!pilot) return null;
    await verifyDemo(tx, org);
    return exchangeView(tx, pilot);
  }));
}

/** Client declarations are not transport evidence. Once flagged, ticking Yes
 * again cannot bypass the independent manual-review path. */
export async function updateCommunicationChecks(org: string, actor: string, id: number, raw: unknown, review = false) {
  const b = object(raw);
  if (!Number.isSafeInteger(b.expectedVersion) || (review ?
    !text(b.consentReference, "Consent review evidence") || !text(b.emailReference, "Email review evidence") :
    typeof b.emailConsent !== "boolean" || typeof b.emailVerified !== "boolean")) {
    throw new SeparationError("Provide the current version and email indicators or manual review evidence.", 400);
  }
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await namedOperator(tx, org, actor, id);
    await acquireCaseDispatchMutationLock(tx, org, id);
    const { pilot } = await loadPilot(tx, org, id);
    if (pilot.version !== b.expectedVersion) throw new SeparationError("Case email settings changed; reload before saving.");
    const state = stateOf(pilot), prior = checksOf(state);
    if (review) {
      if (!prior.reviewRequired) throw new SeparationError("No manual email review is pending.");
      if (!state.enrollment.recipients.length) throw new SeparationError("Configure the case contacts before reviewing their addresses.");
      for (const r of state.enrollment.recipients) {
        await verifiedRecipient(tx, org, r.memberId, r.address, id, true);
        await verifiedRecipient(tx, org, r.escalationMemberId, r.escalationAddress, id, false);
      }
      state.communicationChecks = { emailConsent: true, emailVerified: true, reviewRequired: false, basis: "client-declared",
        changedBy: actor, reviewedBy: actor, reviewReference: JSON.stringify({ consent: text(b.consentReference, "Consent review evidence"), email: text(b.emailReference, "Email review evidence"), version: pilot.version }) };
    } else {
      state.communicationChecks = { ...prior, emailConsent: b.emailConsent as boolean, emailVerified: b.emailVerified as boolean,
        reviewRequired: prior.reviewRequired || !b.emailConsent || !b.emailVerified, changedBy: actor };
    }
    // Fence already prepared mail and replies when the source declarations
    // change; neither re-ticking nor a later review revives those references.
    state.enrollment.revision++;
    const saved = await persistState(tx, pilot, state);
    await audit(tx, org, actor, review ? "email-manual-review" : "email-indicators-changed", id, saved.version);
    return exchangeView(tx, saved);
  }));
}

export async function queueExchangeInTransaction(tx: Tx, pilot: PilotRow, task: PilotTask, kind: string, previous?: Observation) {
  const state = stateOf(pilot), enrollment = state.enrollment;
  const binding = enrollment.recipients.find(r => r.taskId === task.id);
  if (!communicationAllowed(state) || !binding || !enrollment.operator || !enrollment.agentId || !enrollment.mailbox) throw new SeparationError("Configure case contacts and resolve any manual email review before sending.");
  if (task.status === "resolved" && kind !== "receipt") throw new SeparationError("This task has no outstanding portions.");
  const recent = await tx.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, pilot.caseId), eq(offbExchanges.direction, "outbound"))).orderBy(desc(offbExchanges.createdAt)).limit(100);
  // A possibly dispatched operation must be reconciled even after enrollment
  // changes. An unsent stale draft, however, has no effect to reconcile.
  for (const stale of recent.filter(m => m.status === "queued" && (m.generation !== pilot.generation || m.enrollmentRevision !== enrollment.revision || state.tasks.find(t => t.id === m.taskId)?.revision !== m.taskRevision))) {
    await tx.update(offbExchanges).set({ status: "cancelled" }).where(eq(offbExchanges.id, stale.id));
    stale.status = "cancelled";
  }
  const unresolved = recent.find(m => m.taskId === task.id && ["dispatching", "ambiguous"].includes(m.status) ||
    m.taskId === task.id && m.generation === pilot.generation && m.taskRevision === task.revision && m.enrollmentRevision === enrollment.revision && m.status === "queued");
  if (unresolved) return unresolved;
  if (recent.filter(m => Date.now() - m.createdAt.getTime() < 3600000).length >= 12 ||
      (kind === "request" && recent.some(m => m.taskId === task.id && Date.now() - m.createdAt.getTime() < 60000))) throw new SeparationError("Communication rate limit reached. Wait before requesting another message.");
  const reference = `OX-${randomBytes(24).toString("hex")}`, payload = contextualRequest({ reference, caseId: pilot.caseId, task, previous, escalation: kind === "escalation" });
  const [message] = await tx.insert(offbExchanges).values({
    id: randomUUID(), organizationId: pilot.organizationId, caseId: pilot.caseId, taskId: task.id,
    generation: pilot.generation, taskRevision: task.revision, enrollmentRevision: enrollment.revision,
    reference, direction: "outbound", kind, status: "queued",
    recipient: kind === "escalation" ? binding.escalationAddress : binding.address,
    memberId: kind === "escalation" ? binding.escalationMemberId : binding.memberId,
    operator: enrollment.operator, agentId: enrollment.agentId, persona: kind === "escalation" ? "Accountable escalation contact" : binding.persona,
    mailbox: enrollment.mailbox, ...payload,
  }).returning();
  return message;
}

/** Reconcile one already selected fictional operation; never calls a provider. */
async function inspectSource(tx: Tx, pilot: PilotRow, state: PilotState, task: PilotTask, actor: string) {
  if (task.status === "resolved" || task.exception?.disposition) return;
  const [previous] = await tx.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, pilot.caseId), eq(offbExchanges.generation, pilot.generation),
    eq(offbExchanges.taskId, task.id), eq(offbExchanges.taskRevision, task.revision), eq(offbExchanges.direction, "interface"))).orderBy(desc(offbExchanges.createdAt)).limit(1);
  if (previous && previous.status !== "pending") return;
  const reference = previous?.reference ?? `OX-${hash({ caseId: pilot.caseId, generation: pilot.generation, taskId: task.id, revision: task.revision }).slice(0, 48)}`;
  const operation = { "access-inventory": "read-access-inventory", "shared-accounts": "reassign-shared-account", "kt-access-exception": "confirm-kt-handling",
    "access-closure": "disable-access", "asset-inventory": "read-equipment-inventory", "asset-return": "confirm-return" }[task.id];
  const result = mockSourceStatus({ correlation: { caseId: pilot.caseId, generation: pilot.generation, taskId: task.id, taskRevision: task.revision, reference },
    provider: task.id.startsWith("asset-") ? "servicenow" : "entra", operation, sourceReferences: [], expected: task.expected, notBeforeAt: task.notBeforeAt },
    pilot.scenario as "success" | "delayed" | "exception", state.clock);
  if (previous && hash(previous.observation) === hash(result)) return;
  task.confirmed = [...new Set([...task.confirmed, ...result.confirmed])];
  if (result.handling) task.handling = result.handling;
  task.outstanding = task.expected.filter(v => !task.confirmed.includes(v));
  task.status = result.status === "exception" || task.exception && !task.exception.disposition ? "review" : task.outstanding.length ? task.confirmed.length ? "partial" : "pending" : "resolved";
  if (result.status !== "pending") task.evidence.push({ type: "simulated-api-response", sourceId: reference, actor, interpreter: null,
    generation: pilot.generation, revision: task.revision, recordedAt: new Date().toISOString() });
  if (result.status === "exception") task.exception = { revision: (task.exception?.revision ?? 0) + 1, sourceId: reference,
    explanation: `Unresolved portions: ${result.outstanding.join(", ")}`, disposition: null, reviewedBy: null };
  const body = JSON.stringify({ provider: result.provider, status: result.status, confirmed: result.confirmed, outstanding: result.outstanding, correlation: result.correlation });
  if (previous) await tx.update(offbExchanges).set({ status: result.status, body, observation: result }).where(eq(offbExchanges.id, previous.id));
  else await tx.insert(offbExchanges).values({ id: randomUUID(), organizationId: pilot.organizationId, caseId: pilot.caseId, taskId: task.id,
    generation: pilot.generation, taskRevision: task.revision, enrollmentRevision: state.enrollment.revision, reference, direction: "interface", kind: "status-response",
    status: result.status, recipient: "", memberId: actor, operator: actor, agentId: state.enrollment.agentId ?? "", persona: "Source interface", mailbox: "",
    subject: task.label, body, observation: result });
}

export async function exchangeAction(org: string, actor: string, id: number, raw: unknown) {
  const b = object(raw);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    if (b.action === "request") await namedOperator(tx, org, actor, id);
    else {
      if (await registeredDemoProfile(actor)) throw new SeparationError("Use a named accountable member account.", 403);
      await access(tx, org, actor, true, id);
    }
    await confidentialRead(tx, org, actor, undefined, id);
    await acquireCaseDispatchMutationLock(tx, org, id);
    const { pilot, row } = await loadPilot(tx, org, id), state = stateOf(pilot);
    if (b.expectedVersion !== pilot.version) throw new SeparationError("Conversation changed; reload before applying this action.");
    if (b.action === "advance-clock") {
      const clock = text(b.clock, "clock", 30), next = Date.parse(clock);
      if (!Number.isFinite(next) || next < Date.parse(state.clock) || next > Date.parse(state.clock) + 7 * 86400000) throw new SeparationError("Advance the operational clock by at most seven days; it never advances Gmail time.", 400);
      state.clock = new Date(next).toISOString();
      // Advancing this clock cannot advance mail deadlines or schedule sends.
      // It may reconcile only a previously requested access-cutoff operation.
      const [scheduled] = await tx.select().from(offbExchanges).where(and(eq(offbExchanges.caseId, id), eq(offbExchanges.generation, pilot.generation),
        eq(offbExchanges.direction, "interface"), eq(offbExchanges.taskId, "access-closure"), eq(offbExchanges.status, "pending"))).limit(1);
      const closure = state.tasks.find(t => t.id === "access-closure")!;
      if (scheduled && scheduled.taskRevision === closure.revision) {
        const due = await policyGate(tx, row);
        closure.dueAt = due; closure.notBeforeAt = due;
        if (closure.prerequisites.every(p => state.tasks.find(t => t.id === p)?.status === "resolved")) await inspectSource(tx, pilot, state, closure, actor);
      }
    } else {
      const task = state.tasks.find(t => t.id === b.taskId);
      if (!task) throw new SeparationError("Unknown access/equipment task.", 400);
      const due = await policyGate(tx, row);
      task.dueAt = due; task.notBeforeAt = task.id === "access-closure" ? due : null;
      if (b.action === "request") {
        if (task.prerequisites.some(p => state.tasks.find(t => t.id === p)?.status !== "resolved")) throw new SeparationError("Resolve upstream task prerequisites first.");
        await queueExchangeInTransaction(tx, pilot, task, "request");
      } else if (b.action === "source-confirm") {
        const binding = state.enrollment.recipients.find(r => r.taskId === task.id);
        if (!binding || binding.memberId !== actor || task.owner !== actor || state.enrollment.generation !== pilot.generation || b.taskRevision !== task.revision || b.confirmed !== true) throw new SeparationError("The currently enrolled source owner must explicitly confirm this exact task revision.", 403);
        await verifiedRecipient(tx, org, actor, binding.address, id, true);
        if (task.prerequisites.some(p => state.tasks.find(t => t.id === p)?.status !== "resolved") ||
            task.notBeforeAt && (Date.now() < Date.parse(task.notBeforeAt) || Date.parse(state.clock) < Date.parse(task.notBeforeAt))) throw new SeparationError("Current prerequisites and date cutoff must pass.");
        if (typeof b.sourceReference !== "string" || !b.sourceReference.trim() || b.sourceReference.length > 256 ||
            !Array.isArray(b.portions) || !b.portions.length || new Set(b.portions).size !== b.portions.length ||
            b.portions.some(p => typeof p !== "string" || !task.expected.includes(p))) throw new SeparationError("Provide a bounded source reference and exact checked portions.", 400);
        const handling = sourceHandling(task, typeof b.handlingStatement === "string" && b.handlingStatement.length <= 1000 ? b.handlingStatement : "", state.clock);
        if (handling.question) throw new SeparationError(handling.question, 400);
        if (handling.handling) {
          await verifyHandlingOwner(tx, org, id, handling.handling);
          task.handling = handling.handling;
        }
        await receipt(tx, { organizationId: org, actor, scope: "it-security-approve", country: row.facts.country, caseId: id, reference: b.sourceReference, generation: pilot.generation });
        task.confirmed = [...new Set([...task.confirmed, ...b.portions as string[]])]; task.outstanding = task.expected.filter(p => !task.confirmed.includes(p));
        if (task.status !== "review") task.status = task.outstanding.length ? "partial" : "resolved";
        task.evidence.push({ type: "authorized-human-attestation", sourceId: b.sourceReference, actor, interpreter: null,
          generation: pilot.generation, revision: task.revision, recordedAt: new Date().toISOString() });
        await tx.insert(offbExchanges).values({ id: randomUUID(), organizationId: org, caseId: id, taskId: task.id, generation: pilot.generation,
          taskRevision: task.revision, enrollmentRevision: state.enrollment.revision, reference: `OX-${randomBytes(24).toString("hex")}`,
          direction: "source", kind: "attestation", status: task.status, recipient: "", memberId: actor, operator: actor,
          agentId: "", persona: binding.persona, mailbox: "", subject: task.label, body: `Authenticated source confirmed ${b.portions.join(", ")}. Source: ${b.sourceReference}`, applied: 1 });
      } else if (b.action === "inspect-interface") {
        if (task.prerequisites.some(p => state.tasks.find(t => t.id === p)?.status !== "resolved")) throw new SeparationError("Resolve upstream task prerequisites first.");
        const before = hash(state);
        await inspectSource(tx, pilot, state, task, actor);
        if (before === hash(state)) return exchangeView(tx, pilot);
      } else if (b.action === "exception-review") {
        if (task.prerequisites.some(p => state.tasks.find(t => t.id === p)?.status !== "resolved") ||
            task.notBeforeAt && (Date.now() < Date.parse(task.notBeforeAt) || Date.parse(state.clock) < Date.parse(task.notBeforeAt))) throw new SeparationError("Current prerequisites and date cutoff must pass before exception disposition.");
        if (!task.exception || b.exceptionRevision !== task.exception.revision || b.evidenceReference !== task.exception.sourceId ||
            b.taskRevision !== task.revision || b.confirmed !== true) throw new SeparationError("Review the exact current exception revision and evidence.");
        const decision = await receipt(tx, { organizationId: org, actor, scope: "it-security-approve", country: row.facts.country, caseId: id,
          reference: text(b.disposition, "review disposition"), generation: pilot.generation });
        if (b.disposition !== "resolved-with-reviewed-exception") throw new SeparationError("Use the explicit resolved-with-reviewed-exception decision. Financial write-offs and deductions remain out of scope.");
        task.exception.disposition = b.disposition; task.exception.reviewedBy = actor;
        task.status = "resolved"; task.outstanding = [];
        task.evidence.push({ type: "authorized-human-attestation", sourceId: hash(decision), actor, interpreter: null, generation: pilot.generation, revision: task.revision, recordedAt: decision.recordedAt });
      } else throw new SeparationError("Unsupported conversation action.", 400);
    }
    const saved = await persistState(tx, pilot, state);
    await audit(tx, org, actor, `conversation-${String(b.action)}`, id, saved.version);
    return exchangeView(tx, saved);
  }));
}
