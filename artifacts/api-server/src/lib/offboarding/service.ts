import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, offbCases, offbSources, offbPolicies, offbCheckpoints, onbCases, type SeparationCase, type SeparationPolicy, type SeparationState } from "@workspace/db";
import { withSensitiveLifecycleFence, evaluateCaseDerivedLifecycleGateInTransaction } from "../onboarding/sensitive-lifecycle";
import { acquireCaseDispatchMutationLock } from "../onboarding/dispatch-guard";
import { appendProtectedAuditInTransaction } from "../onboarding/protected-audit";
import { access, lockTenant, authority, confidentialRead, payrollRead, receipt, currentReceipt, type Tx } from "./authority";
import { CLOSURE_BLOCKED, SENSITIVE_TRIGGERS, compilePlan, facts, initialState, object, text, SeparationError } from "./model";
export const hash = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function checkpoint(tx: Tx, row: SeparationCase, actor: string, action: string) {
  await tx.insert(offbCheckpoints).values({ organizationId: row.organizationId, caseId: row.id, version: row.version, generation: row.generation, status: row.status, facts: row.facts, state: row.state, actor, action }).onConflictDoNothing();
}
export async function audit(tx: Tx, org: string, actor: string, action: string, id: number | string, version: number) {
  await appendProtectedAuditInTransaction(tx, { organizationId: org, actorId: actor, actorKind: "authenticated", actorAuthority: "verified-offboarding-authority", action: `offboarding.${action}`, outcome: "success", objectType: "separation", objectId: String(id), reviewedRevision: version, correlationId: String(id), source: "offboarding", payload: { safeStatus: "recorded", closureAvailable: false } });
}
export async function createSeparationInTransaction(tx: Tx, org: string, actor: string, raw: unknown, channel: string, sourceReference: string) {
  const f = facts(raw);
  await access(tx, org, actor, true);
  const scope = channel === "security-request" ? "it-security-approve" : channel === "manager-request" ? "manager-approve" : "hr-compliance-approve";
  await authority(tx, org, actor, scope, f.country);
  const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: f.country });
  if (!lifecycle.allowed) throw new SeparationError(lifecycle.reason);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`separation:${org}:${f.employeeId}`}, 0))`);
  const fingerprint = hash(f);
  const [previous] = await tx.select().from(offbSources).where(and(eq(offbSources.organizationId, org), eq(offbSources.channel, channel), eq(offbSources.sourceReference, sourceReference)));
  if (previous) {
    await access(tx, org, actor, false, previous.caseId);
    if (previous.fingerprint !== fingerprint) throw new SeparationError("Source reference was already used with different values. Record a new attributable event; do not overwrite history.");
    const [existing] = await tx.select().from(offbCases).where(and(eq(offbCases.organizationId, org), eq(offbCases.id, previous.caseId)));
    return { caseId: previous.caseId, status: "deduplicated", conflict: existing?.state.conflict === true };
  }
  let [row] = await tx.select().from(offbCases).where(and(eq(offbCases.organizationId, org), eq(offbCases.activeKey, f.employeeId))).for("update");
  let conflict = false;
  if (row) {
    await access(tx, org, actor, true, row.id);
    await authority(tx, org, actor, scope, row.facts.country, row.id);
    conflict = hash(row.facts) !== fingerprint;
    if (conflict) {
      await acquireCaseDispatchMutationLock(tx, org, row.id);
      const state = { ...row.state, conflict: true, gatewayA: "restricted" as const, screening: null, hrBpDisposition: null, sensitiveTriggers: [...new Set([...row.state.sensitiveTriggers, "conflicting"])], tasks: row.state.tasks.map(t => ({ ...t, status: "blocked" as const })) };
      [row] = await tx.update(offbCases).set({ state, status: "restricted", version: row.version + 1, generation: row.generation + 1, updatedAt: new Date() }).where(eq(offbCases.id, row.id)).returning();
    }
  } else {
    // Empty email, no onboarding defaults, no candidate contact or derived release readiness.
    const [envelope] = await tx.insert(onbCases).values({ originalIntent: { label: "Controlled separation request", source: "separation-intake" }, organizationId: org, hireType: "separation", workerName: f.workerName, workerEmail: "", workerCategory: f.workerCategory, role: f.role, department: f.department, geography: f.country, legalEntity: f.legalEntity, managerName: f.manager, recruiterName: "", joiningDate: f.lastWorkingDay, lifecycleStage: "separation-held", orchestrationStatus: "separation-only", workforceContext: { workCountry: f.country }, readiness: [], workstreams: [], checklistSnapshot: [], processPolicySnapshot: { lifecycle: "separation", closureSpecification: "pending" }, createdByUserId: actor }).returning();
    [row] = await tx.insert(offbCases).values({ id: envelope.id, organizationId: org, employeeId: f.employeeId, activeKey: f.employeeId, facts: f, state: initialState() }).returning();
    await access(tx, org, actor, true, envelope.id);
  }
  if ((channel === "security-request" || channel === "compliance-request") && !row.state.sensitiveTriggers.includes("unknown")) {
    const state = { ...row.state, gatewayA: "restricted" as const, screening: null, sensitiveTriggers: [...new Set([...row.state.sensitiveTriggers, "unknown"])] };
    [row] = await tx.update(offbCases).set({ state, status: "restricted", version: row.version + 1, generation: row.generation + 1, updatedAt: new Date() }).where(eq(offbCases.id, row.id)).returning();
  }
  await tx.insert(offbSources).values({ id: randomUUID(), organizationId: org, caseId: row.id, channel, sourceReference, fingerprint, facts: f, actor, provenance: channel === "mailbox" ? "mailbox-unverified-hris" : "authenticated-human-not-hris-feed" });
  await audit(tx, org, actor, conflict ? "source-conflict" : "intake", row.id, row.version);
  await checkpoint(tx, row, actor, "intake");
  return { caseId: row.id, status: conflict ? "conflict-held" : "created-or-linked", conflict };
}
export async function createSeparations(org: string, actor: string, input: unknown, channel = "manual") {
  const b = object(input), entries = Array.isArray(b.entries) ? b.entries : [b];
  if (!entries.length || entries.length > 500) throw new SeparationError("Provide 1–500 requests.", 400);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    const results = [];
    for (const raw of entries) { const e = object(raw); results.push(await createSeparationInTransaction(tx, org, actor, e.facts, channel, text(e.sourceReference, "sourceReference", 160))); }
    return results;
  })).catch(error => {
    if (error instanceof SeparationError) throw error;
    // This entry point is also used by generic batch intake. Do not let a
    // driver exception containing confidential SQL parameters escape there.
    throw new SeparationError("The separation request was not applied. Reload and retry with the same source reference.", 503);
  });
}
export async function load(tx: Tx, org: string, actor: string, id: number, write = false) {
  await lockTenant(tx, org);
  const [row] = await tx.select().from(offbCases).where(and(eq(offbCases.organizationId, org), eq(offbCases.id, id))).for("update");
  if (!row) throw new SeparationError("Separation case not found.", 404);
  await access(tx, org, actor, write, id);
  return row;
}
export function summary(row: SeparationCase, originalIntent?: string | null) {
  const { exitReason: _reason, exitType: _type, ...f } = row.facts;
  return { id: row.id, originalIntent: originalIntent ?? "Not recorded", version: row.version, generation: row.generation, status: row.status, facts: f, closureBlocker: CLOSURE_BLOCKED, lifecycle: "separation" as const };
}
async function privateRead(tx: Tx, org: string, actor: string, row: SeparationCase) {
  await confidentialRead(tx, org, actor, row.facts.country, row.id);
}
export async function listSeparations(org: string, actor: string) {
  return db.transaction(async tx => {
    await lockTenant(tx, org);
    const rows = await tx.select().from(offbCases).where(eq(offbCases.organizationId, org)).orderBy(desc(offbCases.createdAt)).limit(200);
    const origins = rows.length ? await tx.select({ id: onbCases.id, origin: onbCases.originalIntent }).from(onbCases)
      .where(and(eq(onbCases.organizationId, org), inArray(onbCases.id, rows.map(r => r.id)))) : [];
    const labels = new Map(origins.map(r => [r.id, r.origin?.label]));
    const visible = [];
    for (const r of rows) { try { await access(tx, org, actor, false, r.id); visible.push(summary(r, labels.get(r.id))); } catch (e) { if (!(e instanceof SeparationError) || e.status !== 403) throw e; } }
    return visible;
  });
}
export async function separationDetail(org: string, actor: string, id: number) {
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    const row = await load(tx, org, actor, id);
    const [origin] = await tx.select({ intent: onbCases.originalIntent }).from(onbCases)
      .where(and(eq(onbCases.organizationId, org), eq(onbCases.id, id)));
    let privateVisible = false;
    try { await privateRead(tx, org, actor, row); privateVisible = true; } catch (e) { if (!(e instanceof SeparationError)) throw e; }
    let settlementVisible = false;
    try { await payrollRead(tx, org, actor, row.facts.country, id); settlementVisible = true; } catch (e) { if (!(e instanceof SeparationError)) throw e; }
    const sources = privateVisible ? await tx.select().from(offbSources).where(and(eq(offbSources.organizationId, org), eq(offbSources.caseId, id))) : [];
    let standardCurrent = true;
    try { await planCurrent(tx, row); } catch (e) { if (!(e instanceof SeparationError)) throw e; standardCurrent = false; }
    const tasks = [];
    for (const t of row.state.tasks) {
      const special = row.status === "restricted" && (t.activity === "02" || t.id.startsWith("emergency-"));
      const fresh = (standardCurrent || special) && Boolean(await freshTask(tx, row, t.id));
      const specialistVisible = privateVisible;
      tasks.push({ ...t, status: t.status === "verified" && !fresh ? "blocked" : t.status, evidence: specialistVisible ? t.evidence : null, details: specialistVisible ? t.details : {}, executionMode: "manual-source-evidence", blockers: [
        ...(!t.owner ? ["Verified accountable owner required"] : []),
        ...t.prerequisites.filter(p => row.state.tasks.find(x => x.id === p)?.status !== "verified").map(p => `Prerequisite: ${p}`),
        ...(t.status === "verified" && !fresh ? ["Evidence or authority is stale"] : []),
        ...(!standardCurrent && !special ? ["Current approved policy, classification and unpaused Separation Screening required"] : []),
      ] });
    }
    const [adopted] = row.state.policyId ? await tx.select().from(offbPolicies).where(and(eq(offbPolicies.organizationId, org), eq(offbPolicies.id, row.state.policyId), eq(offbPolicies.version, row.state.policyVersion!))) : [];
    const policyCurrent = adopted?.status === "approved" && await currentReceipt(tx, org, row.state.policyReceipt, row.facts.country, undefined, true);
    await access(tx, org, actor, false, id);
    const settlementReview = [];
    if (settlementVisible) for (const v of row.state.settlementVersions) settlementReview.push({ revision: v.revision, currency: v.currency, items: v.items, recordedAt: v.receipt.recordedAt, authorityCurrent: await currentReceipt(tx, org, v.receipt, row.facts.country, id) });
    return { ...summary(row, origin?.intent?.label), privateVisible, privateFacts: privateVisible ? row.facts : null, sources, settlementReview, state: {
      gatewayA: row.state.gatewayA, classification: privateVisible ? row.state.classification : null,
      urgency: row.state.urgency, flags: row.state.flags, sensitiveTriggers: privateVisible ? row.state.sensitiveTriggers : [],
      conflict: row.state.conflict, holds: privateVisible ? row.state.holds : row.state.holds.length ? ["Restricted hold"] : [],
      policyId: row.state.policyId, policyVersion: row.state.policyVersion, policyCurrent, restrictedManual: row.state.restrictedManual === true, tasks,
      decisions: privateVisible ? row.state.decisions : [],
      settlementVersions: privateVisible ? row.state.settlementVersions : [],
      pauseReason: privateVisible ? row.state.pauseReason : row.status === "paused" ? "HRBP review pending" : null,
    }, history: privateVisible ? await tx.select().from(offbCheckpoints).where(and(eq(offbCheckpoints.organizationId, org), eq(offbCheckpoints.caseId, id))).orderBy(desc(offbCheckpoints.version)) : [], finalizationAvailable: false, gatewayC: "unavailable", activity12: "unavailable" };
  }));
}
async function planCurrent(tx: Tx, row: SeparationCase) {
  const s = row.state;
  const restrictedManual = s.gatewayA === "restricted" && s.restrictedManual === true;
  if (!["active", "restricted", "closure-preparation"].includes(row.status) || (s.gatewayA !== "clear" && !restrictedManual) || s.conflict || s.pauseReason) throw new SeparationError("Work is held, sensitive without a reviewed human-led plan, paused, cancelled or obsolete.");
  if (restrictedManual && (!await currentReceipt(tx, row.organizationId, s.hrBpDisposition, row.facts.country, row.id) || !await freshTask(tx, row, "ethics-review") || !await freshTask(tx, row, "legal-review"))) throw new SeparationError("Restricted human-led work requires current HRBP, Ethics and Legal review; standard automation remains prohibited.");
  if (!await currentReceipt(tx, row.organizationId, s.screening, row.facts.country, row.id) || !await currentReceipt(tx, row.organizationId, s.policyReceipt, row.facts.country, undefined, true)) throw new SeparationError("Separation Screening or approved policy permissions are no longer current.");
  if (!await currentReceipt(tx, row.organizationId, s.classificationReceipt ?? null, row.facts.country, row.id)) throw new SeparationError("Classification authority is missing or revoked.");
  const [policy] = await tx.select().from(offbPolicies).where(and(eq(offbPolicies.organizationId, row.organizationId), eq(offbPolicies.id, s.policyId!), eq(offbPolicies.version, s.policyVersion!)));
  if (policy?.status !== "approved" || policy.approval?.authorityId !== s.policyReceipt?.authorityId) throw new SeparationError("Adopted policy approval was withdrawn.");
}
async function freshTask(tx: Tx, row: SeparationCase, id: string, seen = new Set<string>()): Promise<typeof row.state.tasks[number] | undefined> {
  if (seen.has(id)) return undefined;
  const t = row.state.tasks.find(t => t.id === id && t.status === "verified" && t.owner === t.evidence?.actor && t.evidence?.generation === row.generation);
  if (!t || !await currentReceipt(tx, row.organizationId, t.evidence, row.facts.country, row.id)) return undefined;
  const next = new Set(seen).add(id);
  for (const p of t.prerequisites) if (!await freshTask(tx, row, p, next)) return undefined;
  return t;
}
export async function actionSeparation(org: string, actor: string, id: number, input: unknown) {
  const b = object(input), action = text(b.action, "action", 80), reference = text(b.reference, "source-backed reference", 512);
  if (["finalize", "close", "archive", "alumni", "rehire-eligibility", "publish-insight"].includes(action)) throw new SeparationError(CLOSURE_BLOCKED);
  if (!Number.isSafeInteger(b.expectedVersion) || Number(b.expectedVersion) < 1) throw new SeparationError("expectedVersion must be a positive integer.", 400);
  return withSensitiveLifecycleFence(org, () => db.transaction(async tx => {
    await access(tx, org, actor, true, id);
    await acquireCaseDispatchMutationLock(tx, org, id);
    const row = await load(tx, org, actor, id, true);
    if (row.version !== b.expectedVersion) throw new SeparationError("Case changed; reload before deciding.");
    const lifecycle = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: row.facts.country });
    if (!lifecycle.allowed) throw new SeparationError(lifecycle.reason);
    const s: SeparationState = structuredClone(row.state);
    let status = row.status, generation = row.generation, f = row.facts, activeKey = row.activeKey;
    const r = (scope: string) => receipt(tx, { organizationId: org, actor, scope, country: row.facts.country, caseId: id, reference, generation });
    if (["cancelled", "transfer-review"].includes(status)) throw new SeparationError("This separation is no longer active. Completed effects cannot be reversed here.");
    if (action === "screen") {
      if (!Array.isArray(b.sensitiveTriggers) || b.sensitiveTriggers.some(v => !SENSITIVE_TRIGGERS.includes(v as typeof SENSITIVE_TRIGGERS[number]))) throw new SeparationError("Confirm every sensitive-trigger selection; unknown requires HRBP review.", 400);
      // Re-screening cannot silently release prior findings or legal holds.
      s.sensitiveTriggers = [...new Set([...s.sensitiveTriggers, ...(b.sensitiveTriggers as string[])])];
      const normalizedExit = f.exitType.toLowerCase().replace(/[\s_]+/g, "-");
      if (SENSITIVE_TRIGGERS.includes(normalizedExit as typeof SENSITIVE_TRIGGERS[number])) s.sensitiveTriggers.push(normalizedExit);
      if (s.holds.length && !s.sensitiveTriggers.includes("litigation-hold")) s.sensitiveTriggers.push("litigation-hold");
      if (s.conflict && !s.hrBpDisposition) s.sensitiveTriggers.push("conflicting");
      s.gatewayA = s.sensitiveTriggers.length ? "restricted" : "clear";
      status = s.gatewayA === "restricted" ? "restricted" : "held";
      generation++;
      // Bind the explicit decision to the newly adopted evidence generation.
      // Never rewrite only the outer receipt while leaving its authorization stale.
      s.screening = await r("hr-compliance-approve");
      s.restrictedManual = false;
      s.classification = null; s.urgency = null; s.flags = null; s.classificationReceipt = null;
      s.tasks = []; s.policyId = null; s.policyVersion = null; s.policyReceipt = null;
      if (s.gatewayA === "restricted") s.tasks = [
        { id: "ethics-review", activity: "02", label: "HR Ethics anti-retaliation / no-surprise review", stream: "restricted", scope: "hr-ethics-approve", owner: null, prerequisites: [], dueAt: null, notBeforeAt: null, status: "pending", evidence: null, details: {} },
        { id: "legal-review", activity: "02", label: "Legal human-led disposition; death: nominee benefits, no exit interview; abscondment: notice and F&F hold", stream: "restricted", scope: "legal-approve", owner: null, prerequisites: [], dueAt: null, notBeforeAt: null, status: "pending", evidence: null, details: {} },
      ];
      if (s.sensitiveTriggers.includes("litigation-hold")) s.holds = [...new Set([...s.holds, "legal-hold"])];
    } else if (action === "hrbp-reconcile") {
      const decision = await r("hrbp-approve");
      if (!s.conflict && !s.sensitiveTriggers.includes("unknown") && s.gatewayA !== "restricted") throw new SeparationError("No ambiguity or restricted human-led disposition is pending.");
      f = facts(b.facts);
      if (f.employeeId !== row.employeeId) throw new SeparationError("Employee identity cannot be changed.");
      await authority(tx, org, actor, "hrbp-approve", f.country, id);
      const collection = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: f.country });
      if (!collection.allowed) throw new SeparationError(collection.reason);
      s.hrBpDisposition = decision; s.conflict = false; s.sensitiveTriggers = s.sensitiveTriggers.filter(t => !["conflicting", "unknown"].includes(t)); s.screening = null; s.gatewayA = "pending"; status = "held";
      generation++; s.tasks = []; s.policyReceipt = null; s.policyId = null; s.policyVersion = null; s.restrictedManual = false;
      // Both submitted sources remain immutable; the HRBP reference attests comparison to the system of record.
    } else if (action === "classify") {
      if (!["clear", "restricted"].includes(s.gatewayA) || s.conflict || s.sensitiveTriggers.includes("unknown") || !await currentReceipt(tx, org, s.screening, f.country, id)) throw new SeparationError("Fresh Separation Screening and resolved ambiguity are required.");
      if (s.gatewayA === "restricted" && !await currentReceipt(tx, org, s.hrBpDisposition, f.country, id)) throw new SeparationError("Restricted classification requires a current HRBP human-led disposition.");
      if (b.confirmed !== true) throw new SeparationError("Uncertain classification needs HRBP disposition.");
      s.classification = text(b.classification, "human-confirmed classification", 160);
      if (/^(unknown|uncertain|unclassified|pending)$/i.test(s.classification)) throw new SeparationError("Unknown classification cannot activate a plan. Record an unknown sensitive flag and obtain HRBP disposition.");
      if (!["Standard", "Elevated", "High"].includes(String(b.urgency))) throw new SeparationError("Confirm Standard / Elevated / High urgency.", 400);
      s.urgency = b.urgency as SeparationState["urgency"];
      const flags = object(b.flags);
      for (const key of ["privileged", "highRisk", "clientFacing", "peopleManager", "statutory"]) if (typeof flags[key] !== "boolean") throw new SeparationError(`Explicit ${key} confirmation is required.`, 400);
      s.flags = Object.fromEntries(["privileged", "highRisk", "clientFacing", "peopleManager", "statutory"].map(k => [k, flags[k]])) as SeparationState["flags"];
      generation++;
      const decision = await r("hr-compliance-approve");
      s.decisions.push(decision);
      s.classificationReceipt = decision;
      if (s.flags!.statutory) { s.gatewayA = "restricted"; s.sensitiveTriggers.push("statutory-position"); status = "restricted"; }
      s.tasks = s.gatewayA === "restricted" ? [
        { id: "ethics-review", activity: "02", label: "HR Ethics anti-retaliation / no-surprise human-led review", stream: "restricted", scope: "hr-ethics-approve", owner: null, prerequisites: [], dueAt: null, notBeforeAt: null, status: "pending", evidence: null, details: {} },
        { id: "legal-review", activity: "02", label: "Legal restricted pathway, dignified nominee-benefit / abscondment settlement disposition; no death-in-service exit interview", stream: "restricted", scope: "legal-approve", owner: null, prerequisites: [], dueAt: null, notBeforeAt: null, status: "pending", evidence: null, details: {} },
      ] : []; s.policyReceipt = null; s.policyId = null; s.policyVersion = null; s.restrictedManual = false;
    } else if (action === "adopt-policy") {
      await r("hr-compliance-approve");
      const restricted = s.gatewayA === "restricted";
      if (s.tasks.some(t => t.evidence && t.activity !== "02")) throw new SeparationError("Rebase requires a reviewed context correction; executed evidence cannot be silently carried over.");
      if (restricted && (b.confirmed !== true || s.sensitiveTriggers.includes("unknown") || s.conflict || !await currentReceipt(tx, org, s.hrBpDisposition, f.country, id) || !await freshTask(tx, row, "ethics-review") || !await freshTask(tx, row, "legal-review"))) throw new SeparationError("Explicit human-led adoption and current HRBP, Ethics and Legal reviews are required; standard automation stays blocked.");
      const policyId = text(b.policyId, "policyId", 160);
      const [policy] = await tx.select().from(offbPolicies).where(and(eq(offbPolicies.organizationId, org), eq(offbPolicies.id, policyId), eq(offbPolicies.version, Number(b.policyVersion))));
      if (!policy || policy.status !== "approved" || !await currentReceipt(tx, org, policy.approval, f.country, undefined, true)) throw new SeparationError("A current approved versioned offboarding policy is required.");
      if (!await currentReceipt(tx, org, s.screening, f.country, id)) throw new SeparationError("Fresh Separation Screening review is required.");
      if (!await currentReceipt(tx, org, s.classificationReceipt ?? null, f.country, id)) throw new SeparationError("Fresh confirmed classification is required.");
      s.policyId = policyId; s.policyVersion = policy.version; s.policyReceipt = policy.approval;
      const reviews = restricted ? s.tasks.filter(t => t.activity === "02") : [];
      const plan = compilePlan(f, restricted ? { ...s, gatewayA: "clear" } : s, policy.policy);
      if (restricted) for (const task of plan) task.prerequisites = [...new Set([...task.prerequisites, "ethics-review", "legal-review"])];
      s.tasks = [...reviews, ...plan]; s.restrictedManual = restricted; status = restricted ? "restricted" : "active";
    } else if (action === "emergency-security-plan") {
      if (status !== "restricted" || s.gatewayA !== "restricted") throw new SeparationError("This path is only for independently authorized urgent security handling of a restricted case.");
      await r("it-security-approve");
      const emergencyBasis = object(b.details);
      text(emergencyBasis.policyReference, "approved Security operation / break-glass policy reference");
      text(emergencyBasis.breakGlassReference, "independent human emergency authorization reference");
      if (b.confirmed !== true) throw new SeparationError("Independent human authorization must explicitly confirm immediate execution.");
      s.tasks = [...s.tasks.filter(t => !t.id.startsWith("emergency-")), ...[
        { id: "emergency-closure", activity: "07", label: "Restricted urgent IT Security closure — human-led only", stream: "restricted-security", scope: "it-security-approve", owner: null, prerequisites: [], dueAt: new Date().toISOString(), notBeforeAt: null, status: "pending" as const, evidence: null, details: {} },
        { id: "emergency-review", activity: "07", label: "Subsequent independent Legal / break-glass reconciliation", stream: "restricted-security", scope: "legal-approve", owner: null, prerequisites: ["emergency-closure"], dueAt: null, notBeforeAt: null, status: "pending" as const, evidence: null, details: {} },
      ]];
    } else if (action === "pause" || action === "sensitive-flag" || action === "context-change" || action === "legal-hold") {
      await r(action === "legal-hold" ? "legal-approve" : "hr-compliance-approve");
      generation++; s.tasks.forEach(t => { t.status = "blocked"; });
      if (action === "pause") { s.pauseReason = reference; status = "paused"; }
      if (action === "sensitive-flag") {
        if (!Array.isArray(b.sensitiveTriggers) || !b.sensitiveTriggers.length || b.sensitiveTriggers.some(v => !SENSITIVE_TRIGGERS.includes(v as typeof SENSITIVE_TRIGGERS[number]))) throw new SeparationError("Select a known sensitive trigger or unknown.", 400);
        s.sensitiveTriggers = [...new Set([...s.sensitiveTriggers, ...(b.sensitiveTriggers as string[])])]; s.gatewayA = "restricted"; s.screening = null; status = "restricted";
      }
      if (action === "context-change") {
        f = facts(b.facts); if (f.employeeId !== row.employeeId) throw new SeparationError("Employee identity cannot be changed.");
        await authority(tx, org, actor, "hr-compliance-approve", f.country, id);
        const collection = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId: org, jurisdiction: f.country });
        if (!collection.allowed) throw new SeparationError(collection.reason);
        s.gatewayA = "pending"; s.screening = null; s.policyReceipt = null; status = "held";
      }
      if (action === "legal-hold") { s.holds = [...new Set([...s.holds, reference])]; s.gatewayA = "restricted"; status = "restricted"; }
    } else if (action === "hrbp-disposition") {
      s.hrBpDisposition = await r("hrbp-approve");
      if (status !== "paused") throw new SeparationError("A rehire/retraction pause is required.");
      if (!["cancel", "convert-to-transfer", "resume"].includes(String(b.disposition))) throw new SeparationError("Choose cancel, convert-to-transfer or resume.", 400);
      generation++; s.pauseReason = null;
      status = b.disposition === "cancel" ? "cancelled" : b.disposition === "convert-to-transfer" ? "transfer-review" : "held";
      if (status !== "held") activeKey = null;
      s.tasks.forEach(t => { t.status = "blocked"; });
      s.gatewayA = "pending"; s.screening = null; s.policyReceipt = null;
      // Resume restarts review, not provider actions. No automatic access restoration.
    } else if (action === "settlement-version") {
      await planCurrent(tx, row);
      const rr = await r("finance-approve"), items = object(b.items);
      const allowed = ["basePay", "assetRecovery", "relocationRecovery", "noticeAdjustment", "statutory", "equity", "other"];
      if (!Object.keys(items).length || Object.keys(items).some(k => !allowed.includes(k)) || Object.values(items).some(v => typeof v !== "number" || !Number.isFinite(v))) throw new SeparationError("Supply finite source-attested settlement line values, not an invented statutory formula.", 400);
      const currency = text(b.currency, "currency", 3);
      if (!/^[A-Z]{3}$/.test(currency)) throw new SeparationError("Use an ISO currency code.", 400);
      s.settlementVersions.push({ revision: s.settlementVersions.length + 1, currency, items: items as Record<string, number>, calculationReference: reference, rulesReference: text(b.rulesReference, "approved rules or source-attested calculation basis"), receipt: rr });
      for (const t of s.tasks.filter(t => t.stream === "settlement" || t.id === "closure-preparation")) { t.status = "pending"; t.evidence = null; }
    } else if (["assign", "task-evidence", "task-blocked"].includes(action)) {
      const t = s.tasks.find(t => t.id === b.taskId);
      if (!t) throw new SeparationError("Generate the approved checklist first, or use the restricted human-led tasks.", 404);
      const emergency = t.id.startsWith("emergency-") && s.gatewayA === "restricted" && status === "restricted";
      const restricted = s.gatewayA === "restricted" && t.activity === "02" && status === "restricted";
      if (!restricted && !emergency) await planCurrent(tx, row);
      const rr = await r(t.scope);
      if (action === "assign") {
        const owner = text(b.owner, "verified owner", 160);
        await authority(tx, org, owner, t.scope, f.country, id); t.owner = owner;
      } else if (action === "task-blocked") { t.status = b.uncertain === true ? "uncertain" : "blocked"; t.evidence = null; }
      else {
        if (b.provenance !== "human-source-attested" || b.simulated === true) throw new SeparationError("Simulated, UAT, mailbox or unverified provider results cannot establish real execution.");
        if (t.owner !== actor) throw new SeparationError("The current verified accountable owner must record execution.", 403);
        for (const p of t.prerequisites) {
          const prior = await freshTask(tx, row, p);
          if (!prior || !await currentReceipt(tx, org, prior.evidence, f.country, id)) throw new SeparationError(`Fresh prerequisite evidence required: ${p}.`);
        }
        if (t.notBeforeAt && Date.parse(t.notBeforeAt) > Date.now()) throw new SeparationError("Standard access closure is not due until the approved end of LWD.");
        const d = object(b.details ?? {});
        if (Object.keys(d).length > 30 || Object.keys(d).some(k => k.length > 80) || Object.values(d).some(v => !["boolean", "number", "string"].includes(typeof v) || (typeof v === "number" && !Number.isFinite(v)) || (typeof v === "string" && v.length > 512))) throw new SeparationError("Task details must be bounded scalar fields.", 400);
        if (t.id === "ethics-review" && (d.antiRetaliationReviewed !== true || d.noSurpriseReviewed !== true)) throw new SeparationError("Record both anti-retaliation and no-surprise review.");
        if (t.id === "legal-review") {
          if (d.humanLedDispositionReviewed !== true) throw new SeparationError("A recorded restricted human-led Legal disposition is required.");
          if (s.sensitiveTriggers.includes("death-in-service") && (d.nomineeBenefitsReviewed !== true || d.exitInterviewExcluded !== true)) throw new SeparationError("Death-in-service requires dignified nominee-benefit review and no exit interview; no entitlement is inferred.");
          if (s.sensitiveTriggers.includes("abscondment") && (!d.noticeReviewReference || !d.settlementHoldDispositionReference)) throw new SeparationError("Abscondment requires Legal notice and F&F hold disposition references.");
        }
        if (t.id === "asset-inventory" && d.confirmed !== true) throw new SeparationError("Default asset expectations must be explicitly confirmed.");
        if (t.id === "knowledge-risk" && d.riskPresent !== false && !(d.mitigationApproved === true && typeof d.mitigationReference === "string" && d.mitigationReference.trim())) throw new SeparationError("Single-point-of-knowledge risk requires an approved mitigation plan.");
        if (t.id === "kt-signoff") text(d.receivingManagerOrSuccessor, "receiving manager/successor sign-off");
        if (t.id === "kt-access-exception" && d.exceptionRequired !== false) {
          text(d.approvedScope, "approved temporary access scope");
          const expiry = Date.parse(text(d.expiresAt, "temporary access expiry"));
          if (!Number.isFinite(expiry) || expiry <= Date.now() || d.approved !== true) throw new SeparationError("KT access must have an approved, future time-limited expiry.");
        }
        if (t.id === "asset-recovery" && !["recovery-approved", "write-off-approved", "no-recovery-source-attested"].includes(String(d.disposition))) throw new SeparationError("Finance must approve recovery, deduction or write-off, or attest no recovery.");
        if (t.id === "payroll-reconciliation" && (d.hrisMatchesPayroll !== true || !d.hrisReference || !d.payrollReference)) throw new SeparationError("HRIS–Payroll reconciliation must be source-backed; inconsistent data stays held.");
        if (t.id === "payroll-ready" && d.ready !== true) throw new SeparationError("Payroll readiness must be explicitly confirmed.");
        if (t.id === "settlement-calculation" && (!s.settlementVersions.length || !await currentReceipt(tx, org, s.settlementVersions.at(-1)!.receipt, f.country, id))) throw new SeparationError("A fresh versioned final-settlement calculation is required.");
        if (t.id === "client-communication") { if (d.humanAuthored !== true || d.approved !== true) throw new SeparationError("Client communication requires human-authored content and Delivery Head approval."); text(d.contentReference, "approved client communication reference"); }
        if (t.id === "privacy-retention" && s.holds.length && d.action !== "preserve-under-hold") throw new SeparationError("Legal holds prohibit deletion or archival; record preservation evidence.");
        if (t.id === "access-closure" || t.id === "client-access") if (d.sourceConfirmedClosed !== true || d.dependenciesResolved !== true) throw new SeparationError("Access remains open/blocked/uncertain until source-backed closure and dependencies are confirmed.");
        if (t.id === "access-closure" && s.tasks.some(other => other.id === "kt-access-exception" && other.details.exceptionRequired === true) && !d.exceptionClosedReference) throw new SeparationError("A temporary KT exception is not access closure. Record source-backed exception closure.");
        if (t.id === "emergency-closure" && (d.sourceConfirmedClosed !== true || d.dependenciesResolved !== true || !d.accessInventoryReference)) throw new SeparationError("Restricted urgent closure needs an attested access inventory, closure and dependency evidence.");
        if (t.id === "emergency-review" && (d.reviewCompleted !== true || !d.breakGlassReference)) throw new SeparationError("Record subsequent review and break-glass disposition; unknown effects stay unresolved.");
        if (t.id === "emergency-review" && s.tasks.find(other => other.id === "emergency-closure")?.owner === actor) throw new SeparationError("Emergency review requires an independent verified reviewer.");
        if (t.id === "closure-preparation") status = "closure-preparation";
        t.details = d as typeof t.details; t.evidence = rr; t.status = "verified";
      }
      const affected = new Set([t.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const dependent of s.tasks) if (!affected.has(dependent.id) && dependent.prerequisites.some(p => affected.has(p))) {
          affected.add(dependent.id); dependent.status = "blocked"; dependent.evidence = null; changed = true;
        }
      }
      if (status === "closure-preparation" && t.id !== "closure-preparation") status = "active";
    } else throw new SeparationError("Unsupported separation action.", 400);
    s.decisions.push(await r(action === "hrbp-disposition" || action === "hrbp-reconcile" ? "hrbp-approve" : action === "legal-hold" ? "legal-approve" : action === "emergency-security-plan" ? "it-security-approve" : action === "settlement-version" ? "finance-approve" : ["assign", "task-evidence", "task-blocked"].includes(action) ? s.tasks.find(t => t.id === b.taskId)!.scope : "hr-compliance-approve"));
    if (f !== row.facts) {
      await tx.update(onbCases).set({ workerName: f.workerName, workerCategory: f.workerCategory, role: f.role, department: f.department, geography: f.country, legalEntity: f.legalEntity, managerName: f.manager, joiningDate: f.lastWorkingDay, workforceContext: { workCountry: f.country }, updatedAt: new Date() }).where(and(eq(onbCases.organizationId, org), eq(onbCases.id, id)));
      await access(tx, org, actor, true, id);
    }
    const [updated] = await tx.update(offbCases).set({ facts: f, state: s, status, activeKey, generation, version: row.version + 1, updatedAt: new Date() }).where(and(eq(offbCases.organizationId, org), eq(offbCases.id, id))).returning();
    await checkpoint(tx, updated, actor, action);
    await audit(tx, org, actor, action, id, row.version + 1);
    return { caseId: id, version: row.version + 1, status, closureBlocker: CLOSURE_BLOCKED };
  }));
}
