import type { onbCases } from "@workspace/db";
import { isFictionalOfflineExampleCase } from "./offline-example-display";
import { originalDemoFullCoverageScenarioKey } from "./demo-full-coverage";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { getScenario } from "./scenarios";
import { LEGACY_CHECKLIST } from "./settings";
import { redactOperationalItems, hasOpaqueNarrativeAccess, type SensitiveAccess } from "./sensitive-access";

type CaseRow = typeof onbCases.$inferSelect;

/** Display only. Never used by an authority, evidence or execution evaluator. */
export function fixedFictionalPresentation(row: CaseRow) {
  if (row.operationalActivation || row.operationalPreparation ||
    !isFictionalOfflineExampleCase(row)) return null;
  const curated = CURATED_OFFLINE_EXAMPLES.find(example =>
    example.key === row.scenarioKey && row.workerName === example.values.workerName &&
    row.workerEmail === example.values.workerEmail);
  if (curated) return {
    summary: curated.values.planSummary,
    review: curated.values.checklistMatchExplanation,
    batchIntake: curated.values.processPolicySnapshot.batchIntake,
    readiness: curated.values.readiness,
    workstreams: curated.values.workstreams,
    checklist: [],
  };
  const key = originalDemoFullCoverageScenarioKey(row.scenarioKey);
  const scenario = key ? getScenario(key) : null;
  if (!scenario || row.workerName !== `Demo sample — ${scenario.title}` ||
    row.workerEmail !== `demo-${key}@hro.invalid`) return null;
  return {
    summary: `${scenario.description} Evidence and human decisions remain pending.${
      key === "offboarding-voluntary" ? " Final closure requires the missing approved closure requirements." : ""
    }`,
    review: "Review the applicable policy, source evidence and current human decisions before any operational release.",
    batchIntake: null,
    readiness: LEGACY_CHECKLIST.map(item => ({ ...item, key: item.id })),
    checklist: LEGACY_CHECKLIST,
    workstreams: [
      { key: "documentation", label: "Documentation & Compliance", agent: "documentation", owner: "HR Ops" },
      { key: "access", label: "Access & System Readiness", agent: "access", owner: "IT / Security" },
      { key: "assets", label: "Asset & Workplace Readiness", agent: "assets", owner: "IT / Facilities" },
      { key: "learning", label: "Learning, Engagement & Readiness", agent: "learning", owner: "L&D / Manager" },
      { key: "analytics", label: "Data & Analytics", agent: "analytics", owner: "People Analytics" },
    ],
  };
}

/** Match exact fixed key AND label; copy only fixed metadata, never stored prose.
 * Keep each current typed state, not catalogue defaults or simulated outcomes. */
export function readableFictionalItems<T extends readonly Record<string, unknown>[]>(
  items: T, access: SensitiveAccess,
  definitions?: readonly { key?: string; id?: string; label: string; owner?: string; agent?: string }[],
): T {
  const restricted = redactOperationalItems(items, access);
  if (hasOpaqueNarrativeAccess(access)) return restricted;
  if (!definitions) return restricted;
  return items.map((item, index) => {
    const fixed = definitions.find(definition =>
      (definition.key ?? definition.id) === (item.key ?? item.id) && definition.label === item.label);
    if (!fixed) return restricted[index];
    const typed = redactOperationalItems([item], { identity: false, payroll: false, medical: false, bgv: false })[0];
    const { restricted: _restricted, ...state } = typed;
    return {
      ...state, key: fixed.key ?? fixed.id, id: fixed.id, label: fixed.label,
      ...(fixed.owner ? { owner: "Recorded ownership restricted by current field permissions" } : {}),
      ...(fixed.agent ? { agent: fixed.agent } : {}),
      ...(fixed.agent ? { blockers: ["Recorded blocker details restricted by current field permissions."] } : {}),
    };
  }) as unknown as T;
}
