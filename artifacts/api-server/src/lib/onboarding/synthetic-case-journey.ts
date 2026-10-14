import type { onbCases } from "@workspace/db";
import type { GetOnboardingCaseResponse } from "@workspace/api-zod";
import type { z } from "zod";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { originalDemoFullCoverageScenarioKey, DEMO_FULL_COVERAGE_SCENARIO_KEYS } from "./demo-full-coverage";
import { getScenario } from "./scenarios";
import { isFictionalOfflineExampleCase } from "./offline-example-display";
import { isRetiredControllerCase } from "./controller-retirement";
import { JOURNEY_FAMILIES, CANONICAL_JOURNEY_BRANCHES } from "./synthetic-journey-catalogue";
import { agentCatalogueIdentity } from "../agent-catalogue";

type CaseRow = typeof onbCases.$inferSelect;
type OnbSyntheticJourney = NonNullable<z.infer<typeof GetOnboardingCaseResponse>["syntheticJourney"]>;
type OnbSyntheticJourneyStage = OnbSyntheticJourney["stages"][number];
const LEGACY_FAMILIES = ["Onboarding", "Employee Changes", "Payroll", "Benefits", "Leave",
  "Compliance", "Offboarding", "HR Helpdesk", "IT Access", "Learning", "Mobility", "Documents"] as const;
const AGENT_KEY_BY_FAMILY: Record<string, string> = {
  Onboarding: "onboarding", "Employee Changes": "employee-changes", Payroll: "payroll",
  Benefits: "benefits", Leave: "leave", Compliance: "compliance", Offboarding: "offboarding",
  "HR Helpdesk": "hr-helpdesk", "IT Access": "it-access", Learning: "learning",
  Mobility: "mobility", Documents: "documents-records",
};
const COMPLETION_BY_FAMILY: Record<string, string> = {
  Onboarding: "Onboarding preparation completed after HR, documentation, access, equipment and induction reviews.",
  "Employee Changes": "Role amendment and dependent-team reconciliation completed after HR and manager review.",
  Payroll: "Payroll routing amendment reconciled after independent identity and dual-control reviews.",
  Benefits: "Coverage enrolment reconciled after event, plan eligibility and effective-date reviews.",
  Leave: "Leave and payroll calendars reconciled after entitlement, manager and capacity decisions.",
  Compliance: "Renewal review reconciled after source authentication and qualified jurisdiction review.",
  Offboarding: "Supported preparation completed. Final exit closure remains blocked pending approved section 4.6 requirements; no closed archive or alumni record.",
  "HR Helpdesk": "Letter preparation, signatory review and retained-document reconciliation completed.",
  "IT Access": "Entitlement scope and expiry reconciled after independent manager, application-owner and security reviews.",
  Learning: "Assignment and completion reconciled after prerequisite and curriculum-version reviews.",
  Mobility: "Transfer dependencies and cutover reconciled after specialist, source and destination entity reviews.",
  Documents: "Policy revision and acknowledgement reconciled after applicability review.",
};

/** Only fixed server-authored catalogue text enters here, never stored prose.
 * S-reference is the sole user-facing marker; internal provenance is retained. */
function fixedJourneyText(text: string): string {
  return text.replace(/\b(?:fictional|illustrative)\s+/gi, "")
    .replace(/\billustrated\b/gi, "recorded")
    .replace(/\billustrating\b/gi, "recording")
    .replace(/\billustrate\b/gi, "record")
    .replace(/\billustration\b/gi, "case")
    .replace(/\bsample worksheet\b/gi, "review worksheet")
    .replace(/\b(fictional|illustrative|synthetic)\b/gi, "")
    .replace(/\s{2,}/g, " ").trim();
}

/** No database writes, state transitions, provider calls or authority evaluation.
 * Callers must additionally exclude authoritative run-ledger ownership. */
export function syntheticJourneyEligibility(row: CaseRow): string | null {
  if (row.operationalActivation || row.operationalPreparation) return "prepared-or-activated";
  // Inventory carries a generic retirement flag, not a controller association.
  if (isRetiredControllerCase({ ...row, controllerRetired: false })) return "controller-history";
  if (!isFictionalOfflineExampleCase(row)) return "not-verified-fictional-inventory";
  const curated = CURATED_OFFLINE_EXAMPLES.find(item => item.key === row.scenarioKey &&
    item.values.workerName === row.workerName && item.values.workerEmail === row.workerEmail);
  if (curated) return null;
  const key = originalDemoFullCoverageScenarioKey(row.scenarioKey);
  const scenario = key ? getScenario(key) : null;
  return scenario && row.workerName === `Demo sample — ${scenario.title}` &&
    row.workerEmail === `demo-${key}@hro.invalid` ? null : "unknown-or-modified-inventory-identity";
}

export function fixedSyntheticJourney(row: CaseRow, runOwned = false): OnbSyntheticJourney | null {
  if (runOwned || syntheticJourneyEligibility(row)) return null;
  const curated = CURATED_OFFLINE_EXAMPLES.find(item => item.key === row.scenarioKey);
  const legacyKey = originalDemoFullCoverageScenarioKey(row.scenarioKey);
  const family = curated?.family ?? LEGACY_FAMILIES[DEMO_FULL_COVERAGE_SCENARIO_KEYS.indexOf(
    legacyKey as typeof DEMO_FULL_COVERAGE_SCENARIO_KEYS[number])];
  if (!family) return null;
  const definition = JOURNEY_FAMILIES[family]!;
  const scenarioIndex = curated ? CURATED_OFFLINE_EXAMPLES.filter(item => item.family === family)
    .findIndex(item => item.key === curated.key) : 0;
  // Canonical examples use their own intentional branch, not a status hash.
  const legacyBranch = CANONICAL_JOURNEY_BRANCHES[legacyKey ?? ""]!;
  const [outcome, originalRationale] = curated ? definition.branches[scenarioIndex]! : legacyBranch;
  const rationale = fixedJourneyText(originalRationale);
  const coordinator = agentCatalogueIdentity(AGENT_KEY_BY_FAMILY[family]!);
  const title = curated?.title ?? getScenario(legacyKey!)!.title;
  const responsibleRole = outcome === "blocked"
    ? rationale.match(/^The (.+?) (?:must|has not)/)?.[1] ?? definition.reviewer : definition.reviewer;
  // Fixed illustrative dates, explicitly independent from stored case dates.
  const day = (offset: number) => new Date(Date.UTC(2030, 9, 1 + scenarioIndex * 2 + offset))
    .toISOString().slice(0, 10);
  const stage = (id: string, stageTitle: string, offset: number, status: OnbSyntheticJourneyStage["status"],
    dependencies: string[], evidence: string, decision: string, communication: string,
    role = definition.reviewer, agentKey = coordinator.key as string): OnbSyntheticJourneyStage => {
      const actor = agentCatalogueIdentity(agentKey);
      return {
        id, title: fixedJourneyText(stageTitle), date: day(offset), agent: actor.name,
        agentKey: actor.key, agentVersion: actor.version, role: fixedJourneyText(role),
        status, dependencies, evidence: fixedJourneyText(evidence),
        decision: fixedJourneyText(decision), communication: fixedJourneyText(communication),
      };
    };
  const verificationAgent = ["Onboarding", "Compliance", "Benefits", "Documents"].includes(family)
    ? agentCatalogueIdentity("document-verification") : coordinator;
  const stages = [
    stage("intake", `${family} request intake`, 0, "completed", [],
      `Request: ${title}. ${curated?.summary ?? getScenario(legacyKey!)!.description}`,
      `${coordinator.name} classified the request and separated reported claims from review evidence.`,
      `Requester → ${coordinator.name}: Please review “${title}”.`, "Service coordinator"),
    stage("scope", `${family} scope and dependency review`, 1, "completed", ["intake"],
      `Review checklist: ${definition.evidence}.`,
      `${coordinator.name} assembled the dependency checklist. ${definition.review}.`,
      `${coordinator.name} → ${definition.reviewer}: Review the proposal and its prerequisite checklist for “${title}”.`),
    stage("evidence", `${family} evidence assessment`, 2, outcome === "blocked" ? "blocked" : "completed", ["scope"],
      outcome === "blocked" ? `Unresolved requirement: ${rationale}`
        : `Evidence review for “${title}”: ${definition.evidence}.`,
      outcome === "blocked" ? `Review remains open. ${rationale}`
        : `${verificationAgent.name} compared the required evidence and routed its assessment for human review.`,
      outcome === "blocked" ? `${verificationAgent.name} → ${responsibleRole}: ${rationale}`
        : `${verificationAgent.name} → ${definition.reviewer}: Evidence assessment recorded for “${title}”; proceed to the human decision.`,
      responsibleRole, verificationAgent.key),
  ];
  if (outcome !== "blocked") {
    let decisionDependency = "evidence";
    if (outcome === "completed" && (family === "Onboarding" || family === "Offboarding" ||
      family === "Employee Changes" && /department move|internal transfer|internal-transfer/i.test(title))) {
      const assets = agentCatalogueIdentity("assets-workplace");
      stages.push(stage("workplace", "Equipment and workplace preparation", 3, "completed", ["evidence"],
        family === "Offboarding" ? "Asset-return responsibilities and workplace handover plan reviewed."
          : "Equipment allocation and workplace responsibilities reviewed against the agreed role and dates.",
        `${assets.name} reconciled equipment dependencies and coordinated the responsible teams before handoff.`,
        `${assets.name} → ${coordinator.name}: Equipment and workplace preparation reviewed.`,
        "IT / Facilities reviewer", assets.key));
      decisionDependency = "workplace";
    }
    stages.push(stage("decision", `${family} human ${outcome === "rejected" ? "rejection" : "review decision"}`, stages.length,
      outcome === "rejected" ? "rejected" : "completed", [decisionDependency],
      `Decision review for “${title}”.`,
      rationale, `${definition.reviewer} → requester: ${rationale}`));
    stages.push(stage("outcome", outcome === "rejected" ? "Downstream work cancelled"
      : family === "Offboarding" ? "Supported preparation completed — closure blocked" : `${family} outcome reconciliation`,
    stages.length, outcome === "rejected" ? "cancelled" : "completed", ["decision"],
    outcome === "rejected" ? "Cancellation recorded; no downstream release."
      : `Reconciliation summary: ${definition.evidence}.`,
    outcome === "rejected" ? `The rejected proposal has no pending downstream work. ${rationale}` : COMPLETION_BY_FAMILY[family]!,
    `${coordinator.name} → requester: ${outcome === "rejected" ? "Proposal rejected; downstream work cancelled."
      : COMPLETION_BY_FAMILY[family]}.`));
    if (outcome === "completed") {
      const watcher = agentCatalogueIdentity("systems-watcher");
      stages.push(stage("observation", "Dependency and outcome observation", stages.length, "completed", ["outcome"],
        "Reviewed outcome and remaining dependency status compared with the case plan.",
        `${watcher.name} checked the outcome record for unresolved dependencies.${family === "Offboarding"
          ? " The final closure hold remains visible; preparation completion does not release it." : " No further supported work remains."}`,
        `${watcher.name} → ${coordinator.name}: ${family === "Offboarding"
          ? "Preparation reconciled; final closure hold retained." : "Outcome reconciled; no outstanding supported dependency."}`,
        "Service operations reviewer", watcher.key));
    }
  }
  return {
    version: "synthetic-journey/v1", title, family, outcome, rationale,
    qualifier: family === "Offboarding" && outcome === "completed" ? "Preparation completed; final closure blocked"
      : `${outcome[0]!.toUpperCase()}${outcome.slice(1)}`,
    coordinatingAgent: coordinator.name, stages,
    nextActions: outcome === "blocked" ? [rationale] : [],
  };
}
