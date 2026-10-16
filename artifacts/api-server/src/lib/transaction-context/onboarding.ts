import { and, asc, eq, sql } from "drizzle-orm";
import {
  db, accessAgents, onbCases, onbApprovals, onbApprovalHistory, onbDocuments, onbPolicyEvidence,
  onbSystemChecks, onbEvents, onbSettings, onbCandidateUploads, onbCaseLogistics,
  transactionHandoffRevisions,
  onbReadinessSlaCaseState, onbReadinessSlaSnapshots, onbReadinessSlaLedger, onbReadinessSlaAttestations,
} from "@workspace/db";
import { resolveEffectiveAccessInTransaction } from "../access-governance";
import { isSharedDemoPrincipalInTransaction } from "../human-permissions";
import { resolveOriginalIntent } from "../onboarding/original-intent";
import { currentActionForCase } from "../onboarding/current-action";
import { currentActionAssignments } from "../onboarding/current-action-owner";
import { isFictionalOfflineExampleCase } from "../onboarding/offline-example-display";
import { isHistoricalTestRecord } from "../onboarding/historical-test-record";
import { evidenceBelongsToOperationalGeneration } from "../onboarding/operational-eligibility";
import { sensitiveClassForDocument, ALL_SENSITIVE_RECORD_CLASSES } from "../onboarding/sensitive-access";
import { evaluateCaseDerivedLifecycleGateInTransaction, jurisdictionForCaseDerivedEnvelope } from "../onboarding/sensitive-lifecycle";
import { contextDigest, contextLimitations, finishContext, type ContextSection, type TransactionContextSource, type TransactionWorkingContext } from "./projection";

export type ContextTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type ContextReader = {
  organizationId: string; caseId: number; userId: string;
  agentId?: string;
};
export class TransactionContextError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const LIMIT = 200;
const readKeys = ALL_SENSITIVE_RECORD_CLASSES.map(c => `data.${c}.read`);
const editKeys = ALL_SENSITIVE_RECORD_CLASSES.map(c => `data.${c}.edit`);

/** Every consumer supplies its own live principal; agent ownership is not delegation. */
export async function contextAccess(tx: ContextTx, input: ContextReader) {
  if (input.agentId) {
    const [agent] = await tx.select().from(accessAgents).where(and(
      eq(accessAgents.organizationId, input.organizationId), eq(accessAgents.id, input.agentId),
    ));
    if (!agent || agent.status !== "active" || agent.revokedAt || agent.ownerUserId !== input.userId)
      throw new TransactionContextError(403, "Current registered-agent ownership and explicit scope are required.");
  }
  const access = await resolveEffectiveAccessInTransaction(tx, {
    organizationId: input.organizationId, caseId: input.caseId,
    principalType: input.agentId ? "agent" : "human",
    principalId: input.agentId ?? input.userId,
    ...(input.agentId ? { initiatorUserId: input.userId } : {}),
    purpose: "transaction-working-context",
  });
  if (!access.allows.includes("flow.case.read")) throw new TransactionContextError(403, "Current case read access is required.");
  if (input.agentId && !access.allows.includes("tool.context.read"))
    throw new TransactionContextError(403, "The registered agent has no shared-context capability.");
  const demo = await isSharedDemoPrincipalInTransaction(tx, input.userId);
  const has = (key: string) => access.allows.includes(key);
  return {
    keys: [...access.allows].sort(), demo, has,
    opaque: !demo && has("data.case.profile.read") && has("data.case.notes.read") && readKeys.every(has),
    edit: !input.agentId && !demo && has("flow.case.edit") && has("data.case.notes.read") &&
      has("data.case.notes.edit") && has("data.case.profile.read") && readKeys.every(has) && editKeys.every(has),
  };
}

/** A single repeatable snapshot; never read cached grant or execution-history data. */
export async function projectOnboardingContext(tx: ContextTx, input: ContextReader): Promise<TransactionWorkingContext> {
  const access = await contextAccess(tx, input);
  const [row] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
  ));
  if (!row) throw new TransactionContextError(404, "Case unavailable.");
  if (row.hireType === "separation" || row.lifecycleStage.startsWith("separation-"))
    throw new TransactionContextError(409, "This workflow does not yet have a working-context adapter.");
  const sources: TransactionContextSource[] = [];
  const limitations = contextLimitations();
  const scenario = isHistoricalTestRecord(row);
  const provenance = (at?: Date, id?: number, kind?: string): TransactionContextSource["provenance"] =>
    scenario && !(at && id && kind && evidenceBelongsToOperationalGeneration(row, at, id, kind))
      ? "scenario-managed" : "operational-record";
  const add = (id: string, section: ContextSection, label: string, text: string, record: unknown,
    tab: TransactionContextSource["tab"] = "overview", at?: Date | null,
    p: TransactionContextSource["provenance"] = provenance()) => {
    sources.push({ id, section, label, text, revision: contextDigest(record), provenance: p, tab, occurredAt: at?.toISOString() ?? null });
  };
  add(`case:${row.id}:state`, "facts", "Current state",
    `Lifecycle: ${row.lifecycleStage}. Work status: ${row.orchestrationStatus}. Last checkpoint: ${row.orchestrationCheckpoint ?? "not recorded"}.`,
    [row.lifecycleStage, row.orchestrationStatus, row.orchestrationCheckpoint], "overview", row.updatedAt);
  if (access.has("data.case.profile.read")) {
    add(`case:${row.id}:profile`, "facts", "Recorded job profile",
      `Role: ${row.role}. Department: ${row.department}. Geography: ${row.geography}. Worker category: ${row.workerCategory}. Hire type: ${row.hireType}. Primary skill: ${row.primarySkill ?? "not recorded"}. Skill criticality: ${row.skillCriticality ?? "not recorded"}.`,
      [row.role, row.department, row.geography, row.workerCategory, row.hireType, row.primarySkill, row.skillCriticality]);
    const origin = resolveOriginalIntent(row);
    add(`case:${row.id}:request`, "original-request", "Original request", origin?.label ?? "Not recorded",
      origin, "overview", row.createdAt);
    add(`case:${row.id}:joining`, "facts", "Recorded joining date", row.joiningDate, row.joiningDate);
  } else limitations.push("Profile facts and original request are unavailable under current field permissions.");
  if (access.has("data.case.readiness.read")) {
    for (const [i, item] of (access.opaque ? row.readiness : []).entries()) {
      add(`case:${row.id}:readiness:${i}`, item.status === "complete" || item.status === "completed" ? "completed" : "pending",
        access.opaque ? item.label : "Onboarding requirement", `Recorded status: ${item.status}.${access.opaque && item.responsibleRole ? ` Accountable role: ${item.responsibleRole}.` : " Accountable owner: not recorded in this item."}`,
        item);
    }
    for (const [i, stream] of (access.opaque ? row.workstreams : []).entries()) {
      add(`case:${row.id}:workstream:${i}`, stream.status === "complete" || stream.status === "completed" ? "completed" : "pending",
        access.opaque ? stream.label : "Workstream", `Recorded status: ${stream.status}. ${access.opaque && stream.owner ? `Accountable owner/queue: ${stream.owner}` : "Owner detail unavailable."}`,
        stream);
      if (access.opaque) for (const [j, blocker] of stream.blockers.entries())
        add(`case:${row.id}:blocker:${i}:${j}`, "blockers", stream.label, blocker, stream);
    }
    add(`case:${row.id}:acceptance`, row.offerAcceptanceComplete ? "completed" : "pending", "Offer acceptance",
      row.offerAcceptanceComplete ? "Recorded complete; current domain gates still apply." : "Package completion not recorded.",
      [row.offerAcceptanceComplete, row.offerAcceptanceCompletedAt], "overview", row.offerAcceptanceCompletedAt);
  }
  const revisions: unknown[] = [row, access.keys, access.demo];
  if (access.opaque && access.has("data.case.readiness.read") && !scenario && !isFictionalOfflineExampleCase(row)) {
    // Read on the same transaction/tenant snapshot as the rest of the context.
    const assignments = (await currentActionAssignments(input.organizationId, [row.id], tx)).get(row.id) ?? [];
    const action = currentActionForCase(row, assignments);
    revisions.push(action);
    add(`case:${row.id}:current-action`, "facts", "Current action",
      action
        ? `${action.label}. Recorded status: ${action.status}. Source: ${action.source}. Other open items in this source: ${action.additionalCount}. This is recorded workload, not proof of execution.`
        : "No current action recorded.",
      action);
  }
  if (access.opaque && row.planSummary)
    add(`case:${row.id}:plan`, "pending", "Recorded plan narrative (unverified)", row.planSummary, row.planSummary);
  if (access.opaque && row.notes)
    add(`case:${row.id}:notes`, "facts", "Recorded case note (unverified)", row.notes, row.notes);
  // Do not query restricted collections just to disclose their size or presence.
  async function collect<T>(table: any, predicate: any, order: any): Promise<T[]> {
    const records = await tx.select().from(table).where(predicate).orderBy(asc(order)).limit(LIMIT + 1);
    revisions.push(records);
    if (records.length > LIMIT) {
      // Fingerprint the entire authorized collection, not just the displayed
      // window: edits outside it must still invalidate a stale handoff.
      const fingerprint = await tx.execute(sql`select md5(coalesce(string_agg(md5(to_jsonb(${table})::text), '' order by ${order}), '')) as revision from ${table} where ${predicate}`);
      revisions.push(fingerprint.rows);
      limitations.push("An authorized source collection exceeds the bounded context limit; review its domain view. Handoff editing is unavailable until the source set is bounded.");
    }
    return records.slice(0, LIMIT) as T[];
  }
  const predicate = (table: any) => and(eq(table.organizationId, input.organizationId), eq(table.caseId, input.caseId));
  if (access.opaque) {
    const approvals = await collect<typeof onbApprovals.$inferSelect>(onbApprovals, predicate(onbApprovals), onbApprovals.id);
    for (const a of approvals) add(`approval:${a.id}`, a.status === "pending" ? "pending" : "decisions",
      `Approval v${a.version}: ${a.status}`,
      `${a.recommendation} Recorded rationale: ${a.rationale || "not recorded"}. Decision actor: ${a.decidedBy ?? "not recorded"}. Decision time: ${a.decidedAt?.toISOString() ?? "not recorded"}. ${a.comment ? `Recorded comment: ${a.comment}` : ""}`,
      a, "approvals", a.decidedAt ?? a.createdAt, provenance(a.createdAt, a.id, "approvals"));
    const history = await collect<typeof onbApprovalHistory.$inferSelect>(onbApprovalHistory, predicate(onbApprovalHistory), onbApprovalHistory.id);
    for (const a of history) add(`approval-history:${a.id}`, "decisions", `Approval history v${a.version}`,
      `Recorded status: ${a.status}. Event: ${a.eventType}. Decision actor: ${a.decidedBy ? "recorded" : "not recorded"}. Decision time: ${a.decidedAt?.toISOString() ?? "not recorded"}. Historical rationale is available only in the authorized approval record, not inferred from current policy.`,
      a, "approvals", a.decidedAt ?? a.createdAt, scenario ? "scenario-managed" : "operational-record");
    const events = await collect<typeof onbEvents.$inferSelect>(onbEvents, predicate(onbEvents), onbEvents.id);
    for (const event of events) add(`event:${event.id}`, "facts", event.title, event.detail, event, "activity",
      event.createdAt, provenance(event.createdAt, event.id, "events"));
    const evidence = await collect<typeof onbPolicyEvidence.$inferSelect>(onbPolicyEvidence, predicate(onbPolicyEvidence), onbPolicyEvidence.id);
    for (const e of evidence) add(`policy-evidence:${e.id}`, "decisions", "Recorded policy evidence",
      `${e.itemId}: ${e.decision}. Recorded reviewer: ${e.verifiedBy}. Reason: ${e.reason || "not recorded"}.`,
      e, "overview", e.createdAt, scenario ? "scenario-managed" : "operational-record");
    const readinessState = await collect<typeof onbReadinessSlaCaseState.$inferSelect>(onbReadinessSlaCaseState, predicate(onbReadinessSlaCaseState), onbReadinessSlaCaseState.caseId);
    const snapshots = await collect<typeof onbReadinessSlaSnapshots.$inferSelect>(onbReadinessSlaSnapshots, predicate(onbReadinessSlaSnapshots), onbReadinessSlaSnapshots.snapshotVersion);
    const attestations = await collect<typeof onbReadinessSlaAttestations.$inferSelect>(onbReadinessSlaAttestations, predicate(onbReadinessSlaAttestations), onbReadinessSlaAttestations.id);
    const ledger = await collect<typeof onbReadinessSlaLedger.$inferSelect>(onbReadinessSlaLedger, predicate(onbReadinessSlaLedger), onbReadinessSlaLedger.id);
    if (!scenario && readinessState.length) {
      add(`readiness:${row.id}`, "facts", "Readiness policy snapshot",
        `Recorded snapshot version: ${readinessState[0].snapshotVersion}. A score or snapshot is not final human approval.`,
        [readinessState, snapshots, attestations, ledger]);
    } else limitations.push("Current readiness-policy evidence is unavailable or historical; no readiness result is inferred.");
    const checks = await collect<typeof onbSystemChecks.$inferSelect>(onbSystemChecks, predicate(onbSystemChecks), onbSystemChecks.id);
    for (const c of checks) add(`check:${c.id}`, c.status === "complete" || c.status === "completed" ? "completed" : "pending",
      c.system, `Recorded status: ${c.status}; mode: ${c.mode}. Requested at: ${c.requestedAt.toISOString()}. Completed at: ${c.completedAt?.toISOString() ?? "not recorded"}. ${c.note ?? "Rationale not recorded."}`,
      c, "activity", c.lastCheckedAt ?? c.requestedAt, provenance(c.requestedAt, c.id, "systemChecks"));
    const logistics = await collect<typeof onbCaseLogistics.$inferSelect>(onbCaseLogistics, predicate(onbCaseLogistics), onbCaseLogistics.caseId);
    // Only reference the source revision here; the existing overview owns its private contact fields.
    if (logistics.length) add(`logistics:${row.id}`, "facts", "Day-1 logistics", "Case-specific logistics recorded; review the case overview.", logistics, "overview", logistics[0].updatedAt);
    const settings = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, input.organizationId),
      eq(onbSettings.key, `operational_requests:${input.caseId}`)));
    revisions.push(settings);
    if (settings.length) {
      try {
        const state = JSON.parse(settings[0].value) as { requests?: Array<{
          id: string; label: string; status: string; assignedTo?: string | null; responsibleRole?: string; owner?: string;
          failureReason?: string | null; simulated?: boolean;
        }> };
        if (!Array.isArray(state.requests)) throw new Error("invalid");
        for (const task of state.requests.slice(0, LIMIT)) {
          if (typeof task.id !== "string" || typeof task.label !== "string" || typeof task.status !== "string") continue;
          add(`task:${task.id}`, task.status === "completed" ? "completed" : task.status === "blocked" || task.status === "failed" ? "blockers" : "pending",
            task.label, `Status: ${task.status}. Accountable owner: ${task.assignedTo || task.owner || "not recorded"}.${task.responsibleRole ? ` Recorded responsible role (not an assignment): ${task.responsibleRole}.` : ""}${task.failureReason ? ` Recorded blocker: ${task.failureReason}` : ""}`,
            task, "overview", null, task.simulated ? "scenario-managed" : provenance());
        }
        if (state.requests.length > LIMIT) limitations.push("Operational tasks exceed the bounded context limit.");
      } catch { limitations.push("Operational task sources are unavailable: their stored format could not be validated."); }
    }
  } else limitations.push("Confidential narratives, approvals, evidence and handoff history are unavailable under current permissions.");
  const documents = access.opaque
    ? await collect<typeof onbDocuments.$inferSelect>(onbDocuments, predicate(onbDocuments), onbDocuments.id) : [];
  for (const doc of documents) {
    if (access.demo || !sensitiveClassForDocument(doc).every(c => access.has(`data.${c}.read`))) continue;
    add(`document:${doc.id}`, doc.status === "complete" || doc.status === "verified" ? "completed" : "pending",
      doc.label, `Recorded document status: ${doc.status}. Required: ${doc.required ? "yes" : "no"}. File contents are not projected.`,
      doc, "documents", doc.updatedAt, provenance(doc.createdAt, doc.id, "documents"));
  }
  if (access.opaque) {
    // Include live validation revisions; do not publish paths, files or filenames.
    const uploads = await collect<typeof onbCandidateUploads.$inferSelect>(onbCandidateUploads, predicate(onbCandidateUploads), onbCandidateUploads.id);
    for (const u of uploads) add(`upload:${u.id}`, "facts", "Document validation",
      `Validation: ${u.validationState}. Malware gate: ${u.malwareScanState}. This is not proof of authenticity.`,
      u, "documents", u.validatedAt ?? u.createdAt, provenance(u.createdAt, u.id, "candidateUploads"));
  }
  let notes = access.opaque
    ? await collect<typeof transactionHandoffRevisions.$inferSelect>(transactionHandoffRevisions, predicate(transactionHandoffRevisions), transactionHandoffRevisions.id)
    : [];
  const bounded = !limitations.some(l => l.includes("bounded context limit"));
  if (!bounded) notes = []; // Never label a truncated historical version as the current handoff.
  const latest = new Map<string, typeof notes[number]>();
  for (const note of notes) latest.set(note.kind, note);
  for (const note of latest.values()) if (note.body) add(`handoff:${note.kind}:${note.revision}`,
    note.kind === "question" ? "questions" : "handoff", `Handoff ${note.kind}`, note.body, note, "context", note.createdAt, "human-annotation");
  if (scenario) limitations.push("Scenario-managed source records are historical examples and cannot satisfy operational evidence, readiness or approval requirements.");
  limitations.push("Communication bodies, private files and provider payloads are intentionally not copied into working context.");
  const lifecycle = access.edit && !scenario && !row.controllerRetired
    ? await evaluateCaseDerivedLifecycleGateInTransaction(tx, {
      organizationId: input.organizationId, jurisdiction: jurisdictionForCaseDerivedEnvelope(row),
    }) : { allowed: false };
  revisions.push(lifecycle);
  if (access.edit && !lifecycle.allowed)
    limitations.push("Handoff collection is unavailable until applicable confidential-record lifecycle policies permit storage.");
  return finishContext({
    workflow: "onboarding", transactionId: `onboarding:case:${row.id}`, caseId: row.id,
    sourceRevision: contextDigest(revisions), sources, limitations,
    canAnnotate: access.edit && lifecycle.allowed && bounded && !scenario && !row.controllerRetired && row.workerName !== "[minimized]",
    annotations: notes.map(n => ({ kind: n.kind, body: n.body, revision: n.revision,
      author: n.authorUserId, createdAt: n.createdAt.toISOString(), sourceRevision: n.sourceRevision })),
  });
}

export async function readOnboardingContext(input: ContextReader) {
  const snapshot = await db.transaction(async tx => ({
    context: await projectOnboardingContext(tx, input), access: await contextAccess(tx, input),
  }), { isolationLevel: "repeatable read", accessMode: "read only" });
  // A permission downgrade that committed during source collection must not
  // disclose the old repeatable-read snapshot.
  const current = await db.transaction(tx => contextAccess(tx, input));
  if (contextDigest([snapshot.access.keys, snapshot.access.demo]) !== contextDigest([current.keys, current.demo]))
    throw new TransactionContextError(403, "Case permissions changed. Reopen with current access.");
  return snapshot.context;
}
