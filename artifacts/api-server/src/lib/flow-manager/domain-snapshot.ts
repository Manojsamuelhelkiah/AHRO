import { and, eq } from "drizzle-orm";
import { onbApprovals, onbCases, offbCases } from "@workspace/db";
import type { OnboardingDbTransaction } from "../onboarding/settings";
import { LEGACY_CHECKLIST } from "../onboarding/settings";
import { latestRequiredUploadMalwareBlockers } from "../onboarding/document-readiness-guard";
import { CONDITIONS, type Facts, type FlowFamily } from "./contract";
import { isSeparationOrLegacyExit } from "../onboarding/separation-isolation";

export type DomainSnapshot = {
  organizationId: string;
  caseId: number;
  family: FlowFamily | "review-only";
  version: number;
  generation: number;
  facts: Facts;
  checkpoint: string | null;
  legacyContinuationSupported?: boolean;
  tasks: Array<{
    id: string; label: string; role: string; status: string;
    prerequisites: string[]; blockers: string[];
  }>;
};
export type FlowReadClient = Pick<OnboardingDbTransaction, "select">;
const falseFacts = () => ({
  ...Object.fromEntries(CONDITIONS.map(condition => [condition, false])),
  always: true,
}) as Record<keyof Facts, boolean>;

/** Read-only adapter. Never invokes a domain reconciler, model or provider. */
export async function loadDomainSnapshot(tx: FlowReadClient, organizationId: string, caseId: number): Promise<DomainSnapshot | null> {
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
  ));
  if (!c) return null;
  const facts = falseFacts();
  const base = {
    organizationId, caseId, version: c.orchestrationClaimToken,
    generation: c.workforceContextVersion, facts, checkpoint: c.orchestrationCheckpoint,
  };
  if (c.hireType === "separation") {
    const [s] = await tx.select().from(offbCases).where(and(
      eq(offbCases.organizationId, organizationId), eq(offbCases.id, caseId),
    ));
    if (!s) return { ...base, family: "review-only", tasks: [] };
    facts.screened = s.state.gatewayA !== "pending" && Boolean(s.state.screening) && !s.state.conflict;
    facts.classified = facts.screened && Boolean(s.state.classification && s.state.classificationReceipt);
    facts["policy-planned"] = facts.classified && Boolean(s.state.policyId && s.state.policyReceipt) &&
      ["active", "restricted", "closure-preparation"].includes(s.status) && !s.state.pauseReason;
    facts.restricted = s.state.gatewayA === "restricted";
    return {
      ...base, family: "separation", version: s.version, generation: s.generation,
      checkpoint: s.status,
      tasks: s.state.tasks.map(t => ({
        id: t.id, label: t.label, role: t.owner ? "Assigned task owner" : t.scope,
        status: t.status, prerequisites: t.prerequisites,
        blockers: [
          ...(!t.owner ? ["Accountable owner required"] : []),
          ...t.prerequisites.filter(id => s.state.tasks.find(task => task.id === id)?.status !== "verified")
            .map(id => `Prerequisite: ${id}`),
          ...(t.status === "uncertain" ? ["Source outcome needs reconciliation; do not replay"] : []),
        ],
      })),
    };
  }
  const onboardingTypes = new Set(["external-fte", "contractor", "rehire", "internal-transfer",
    "campus-cohort", "expedited", "new-hire", "external", "internal", "transfer", "vendor"]);
  if (!onboardingTypes.has(c.hireType) || c.hireType === "service-request" || c.hireType === "exit" || c.processPolicySnapshot?.specialistReviewOnly === true ||
    isSeparationOrLegacyExit(c) || c.lifecycleStage.startsWith("separation")) return { ...base, family: "review-only", tasks: [] };
  facts["offer-required"] = ["external-fte", "contractor", "rehire"].includes(c.hireType);
  facts["admission-pending"] = c.lifecycleStage === "trigger-received" && c.orchestrationStatus === "idle" &&
    c.orchestrationCheckpoint === null;
  facts["offer-released"] = !facts["offer-required"] || c.offerAcceptanceComplete;
  const cp = c.orchestrationCheckpoint;
  const approvals = await tx.select({
    action: onbApprovals.resumeAction, status: onbApprovals.status,
  }).from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, organizationId), eq(onbApprovals.caseId, caseId),
  ));
  const intakeOpen = approvals.filter(a => a.action === "continue-after-intake").every(a => a.status === "approved");
  const planOpen = approvals.filter(a => a.action === "continue-after-plan").every(a => a.status === "approved");
  const pipelineApprovals = approvals.filter(a => ["continue-after-intake", "continue-after-plan"].includes(a.action ?? ""));
  const legacyContinuationSupported = c.orchestrationStatus === "waiting-approval" && c.orchestrationCheckpoint === null &&
    pipelineApprovals.length > 0 && !approvals.some(a => a.status === "pending" &&
      !["continue-after-intake", "continue-after-plan"].includes(a.action ?? ""));
  const profile = c.readiness.find(item => item.key === "profile");
  facts["intake-released"] = intakeOpen && (profile ? profile.status === "ready" : (
    ["plan", "intake-approved", "waiting:plan", "plan-approved"].includes(cp ?? "") ||
    ["profile-validated", "plan-generated", "preboarding", "day1-review", "complete"].includes(c.lifecycleStage)
  ));
  facts["plan-released"] = facts["intake-released"] && planOpen && (
    ["plan-generated", "preboarding", "day1-review", "complete"].includes(c.lifecycleStage) ||
    ["plan-approved", "blocked:before-workstreams", "waiting:standard-operations-release",
      "blocked:before-employee-communications", "workstreams-complete", "communications-complete",
      "blocked:before-day1-review", "blocked:re-review", "waiting:day1-readiness", "review-complete"].includes(cp ?? "")
  );
  facts["workstreams-entered"] = ["preboarding", "day1-review", "complete"].includes(c.lifecycleStage) ||
    ["workstreams-complete", "blocked:before-employee-communications", "communications-complete",
      "blocked:before-day1-review", "blocked:re-review", "waiting:day1-readiness", "review-complete"].includes(cp ?? "");
  facts["communications-recorded"] = [
    "communications-complete", "blocked:before-day1-review", "blocked:re-review",
    "waiting:day1-readiness", "review-complete",
  ].includes(cp ?? "");
  facts["readiness-review"] = c.lifecycleStage === "complete";
  const { readOperationalFlowTasks } = await import("../onboarding/operational-requests");
  const runtimeTasks = await readOperationalFlowTasks(tx, organizationId, caseId, c.workforceContextVersion);
  const checklist = c.checklistSnapshot?.length ? c.checklistSnapshot : LEGACY_CHECKLIST;
  const documentSafetyHeld = checklist.some(item => item.id === "documentation" && item.enabled && item.mandatory) &&
    (await latestRequiredUploadMalwareBlockers(tx, organizationId, caseId)).length > 0;
  const safetyTasks = documentSafetyHeld ? [{
    id: "current-upload-safety", label: "Current required document safety checks", role: "HR reviewer",
    status: "blocked", prerequisites: [],
    blockers: ["Latest required-upload safety evidence is unresolved. Review the authorized document details."],
  }] : [];
  const checklistTasks = (c.checklistSnapshot ?? []).filter(item => item.enabled).map(item => {
    const evidence = c.readiness.find(r => r.key === item.id);
    return {
      id: `checklist:${item.id}`, label: item.label, role: item.responsibleRole ?? "Case HR owner",
      status: evidence?.status ?? "pending", prerequisites: (item.prerequisites ?? []).map(id => `checklist:${id}`),
      blockers: [
        ...(item.migrationReviewHold ? ["Historical checklist classification requires explicit review"] : []),
        ...(item.mandatory && evidence?.status !== "ready" ? [`Mandatory ${item.enforcementStage ?? "before-day1-review"} evidence is outstanding`] : []),
      ],
    };
  });
  return {
    ...base, family: "onboarding", legacyContinuationSupported,
    tasks: [...c.workstreams.map(t => ({
      id: t.key, label: t.label, role: t.owner, status: t.status, prerequisites: [],
      blockers: (t.blockers ?? []).map(() => "Domain workstream blocker; review the authorized workstream details"),
    })), ...checklistTasks, ...runtimeTasks, ...safetyTasks],
  };
}
