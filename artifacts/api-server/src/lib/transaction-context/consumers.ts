import { onbCases } from "@workspace/db";
import { logger } from "../logger";
import { readOnboardingContext, type ContextReader } from "./onboarding";
import { contextDigest, type TransactionWorkingContext } from "./projection";
import {
  explainabilityIdentifiers, redactExplainabilityText,
  type CaseExplainabilityEvidence, type ExplainabilitySource,
} from "../onboarding/case-explainability-evidence";

/** External models receive only typed operational projections of common
 * sources. Opaque annotations, rationale, labels, messages and file data are
 * never inserted into a prompt, even for an all-class human reader. */
export function modelEvidenceFromContext(
  context: TransactionWorkingContext, row: typeof onbCases.$inferSelect,
): CaseExplainabilityEvidence {
  const identifiers = explainabilityIdentifiers(row);
  const safe: ExplainabilitySource[] = [];
  for (const s of context.sources) {
    let text: string | null = null;
    let title = "Recorded operational source";
    let kind = "context-source";
    if (s.id === `case:${row.id}:state`) {
      const match = /^Lifecycle: ([a-z0-9:-]{1,60})\. Work status: ([a-z0-9:-]{1,60})\./.exec(s.text);
      text = match ? `Lifecycle: ${match[1]}. Work status: ${match[2]}.` : null;
      title = "Current case state";
    } else if (s.id === `case:${row.id}:joining`) {
      text = /^\d{4}-\d{2}-\d{2}$/.test(s.text) ? `Recorded joining date: ${s.text}.` : "Joining date unavailable.";
    } else if (s.id === `case:${row.id}:acceptance`) text = s.text;
    else if (new RegExp(`^case:${row.id}:(readiness|workstream):\\d+$`).test(s.id)) {
      const match = /^Recorded status: ([a-z0-9_-]{1,60})\./i.exec(s.text);
      text = match ? `Recorded requirement/workstream status: ${match[1]}. Owner details and labels are excluded.` : null;
      title = "Recorded onboarding requirement";
      kind = "readiness-stream";
    } else if (new RegExp(`^case:${row.id}:blocker:\\d+:\\d+$`).test(s.id)) {
      text = "An outstanding workstream blocker is recorded. Its free-text explanation is restricted; no cause is inferred.";
      title = "Recorded blocker";
      kind = "recorded-blocker";
    } else if (/^document:\d+$/.test(s.id)) {
      const match = /^Recorded document status: ([a-z0-9_-]{1,60})\. Required: (yes|no)\./i.exec(s.text);
      text = match ? `Status: ${match[1]}. Required: ${match[2]}. Document detail: restricted.` : null;
      title = "Restricted document status";
      kind = "document-status";
    } else if (/^upload:\d+$/.test(s.id)) {
      const match = /^Validation: ([a-z0-9_-]{1,60})\. Malware gate: ([a-z0-9_-]{1,60})\./i.exec(s.text);
      text = match ? `Validation: ${match[1]}. Malware scan: ${match[2]}. File contents and object paths are excluded.` : null;
      title = "Document validation status";
      kind = "document-validation-status";
    } else if (/^check:\d+$/.test(s.id)) {
      const match = /^Recorded status: ([a-z0-9_-]{1,60}); mode: ([a-z0-9_-]{1,60})\. Requested at: ([\dTZ:.-]+)\. Completed at: ([\dTZ:.-]+|not recorded)\./i.exec(s.text);
      text = match ? `Status: ${match[1]}. Mode: ${match[2]}. Requested at: ${match[3]}. Completed at: ${match[4]}. System-check detail: restricted.` : null;
      title = s.label === "bgv" ? "Background-verification clearance status" : "Restricted system-check status";
      kind = "system-check-status";
    } else if (/^event:\d+$/.test(s.id)) {
      text = "An operational onboarding activity was recorded. The occurrence timestamp is recorded; the event narrative is restricted.";
      title = "Recorded onboarding activity";
      kind = "event";
    } else if (/^approval-history:\d+$/.test(s.id)) {
      const match = /^Recorded status: ([a-z0-9_-]{1,60})\. Event: (decision|reopened)\. Decision actor: (recorded|not recorded)\. Decision time: ([\dTZ:.-]+|not recorded)\./i.exec(s.text);
      text = match ? `Decision history event: ${match[2]}. Status: ${match[1]}. Human decision actor: ${match[3]}. Decision time: ${match[4]}. Historical rationale remains restricted; current policy does not establish it.` : null;
      title = "Recorded human approval history";
      kind = "human-approval-history";
    } else if (s.id.startsWith("task:")) {
      const match = /^Status: ([a-z0-9_-]{1,60})\./i.exec(s.text);
      text = match ? `Recorded task status: ${match[1]}. Assignment details and free-text failure reasons are restricted.` : null;
      title = "Recorded pending/completed work";
      kind = "operational-task";
    }
    else if (s.id.startsWith("approval:")) {
      // Only the fixed status portion of the source title, not its narrative.
      const match = /^Approval v(\d+): (pending|approved|rejected|withdrawn|superseded)$/.exec(s.label);
      text = match ? `Human approval version ${match[1]}; recorded status: ${match[2]}. Decision occurrence timestamp is recorded separately. Historical rationale and reviewer comments remain restricted.` : null;
      title = "Recorded human approval";
      kind = "human-approval";
    } else if (s.provenance === "human-annotation") {
      text = "A human handoff annotation is recorded. Its untrusted contents are excluded from external-model disclosure and do not authorize work.";
      title = "Human handoff reference";
      kind = "handoff-reference";
    }
    if (!text) continue;
    const historical = s.provenance === "scenario-managed";
    safe.push({
      id: s.id, kind,
      title, excerpt: redactExplainabilityText(`${historical ? "Historical example only, not current operational evidence. " : ""}${text}`, identifiers),
      occurredAt: s.occurredAt, tab: s.tab === "context" ? "overview" : s.tab,
    });
  }
  return {
    caseId: context.caseId, asOf: context.asOf, sources: safe.slice(0, 100), truncated: safe.length > 100 || context.limitations.some(l => l.includes("bounded context limit")),
    limitations: [...context.limitations, "External analysis excludes confidential source narratives and handoff bodies.",
      ...(safe.length > 100 ? ["External analysis is limited to 100 authorized source references."] : [])],
    redactionIdentifiers: identifiers, contextRevision: context.sourceRevision,
  };
}

/** Optional narrative preparation is not an orchestration prerequisite.
 * Fields are selected only when the shared projection permits the profile.
 * The caller must still use its existing exact-payload provider/budget gates. */
export async function prepareOnboardingPlanEvidence(
  input: ContextReader, row: typeof onbCases.$inferSelect,
  adjustments: readonly { rule: string; text: string; hitl: string }[],
  read: typeof readOnboardingContext = readOnboardingContext,
): Promise<string | null> {
  try {
    const context = await read(input);
    const profile = context.sources.find(s => s.id === `case:${row.id}:profile`);
    // Checklist rules were calculated from this case row. A concurrently
    // changed profile must not be labelled with the newer shared revision.
    if (!profile || profile.revision !== contextDigest([
      row.role, row.department, row.geography, row.workerCategory, row.hireType, row.primarySkill, row.skillCriticality,
    ])) return null;
    const identifiers = explainabilityIdentifiers(row);
    const field = (value: string | null) => redactExplainabilityText((value ?? "not recorded").slice(0, 200), identifiers);
    return JSON.stringify({
      sourceRevision: context.sourceRevision, profileSourceId: `case:${row.id}:profile`,
      profile: {
        role: field(row.role), department: field(row.department), geography: field(row.geography),
        workerCategory: field(row.workerCategory), hireType: field(row.hireType),
        primarySkill: field(row.primarySkill), skillCriticality: field(row.skillCriticality),
      },
      // These are the engine's rule-derived adjustments after its existing
      // approve-before-act checkpoint, never handoff instructions.
      checklistAdjustments: adjustments.map(a => ({ rule: a.rule, text: field(a.text), hitl: a.hitl })),
      operationalSources: modelEvidenceFromContext(context, row).sources,
    });
  } catch {
    // No raw ORM exception: it can include confidential bound parameters.
    logger.warn({ caseId: input.caseId }, "Optional onboarding plan narrative skipped: shared context unavailable; rule-based checklist remains in force");
    return null;
  }
}

export async function prepareOnboardingAgentContext(input: ContextReader) {
  // Same live authorization and source revisions as the human view. No
  // ordinary execution-metadata permission is accepted here.
  return readOnboardingContext(input);
}

export async function collectSharedExplanationEvidence(input: ContextReader, row: typeof onbCases.$inferSelect) {
  return modelEvidenceFromContext(await readOnboardingContext(input), row);
}
