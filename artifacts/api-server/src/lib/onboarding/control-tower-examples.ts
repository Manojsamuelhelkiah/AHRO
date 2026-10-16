import { isDeepStrictEqual } from "node:util";
import { and, eq, inArray } from "drizzle-orm";
import { db, onbCases } from "@workspace/db";
import { GetControlTowerExamplesResponse } from "@workspace/api-zod";
import type { z } from "zod";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { syntheticJourneyEligibility } from "./synthetic-case-journey";
import { actualRunOwnedCaseIds } from "./offline-preparation";
import { authoritativelyUatRunOwnedCaseIds } from "./uat-isolation";
import { resolveEffectiveAccessForCases } from "../access-governance";
import { agentCatalogueIdentity } from "../agent-catalogue";

type Row = typeof onbCases.$inferSelect;
type ControlTowerExample = z.infer<typeof GetControlTowerExamplesResponse>["items"][number];
type Definition = Omit<ControlTowerExample, "caseId" | "reference" | "caseHref" | "owner"> & { slotKey: string };
const slot = (family: string, index: number) => {
  const item = CURATED_OFFLINE_EXAMPLES.filter(e => e.family === family)[index];
  if (!item) throw new Error("Control Tower example inventory definition is missing.");
  return item;
};
const limitations = "Fixed authored scenario, not a provider receipt, model evaluation, human review record or measured employee outcome. No execution or recovery is authorized.";
const definition = (family: string, index: number, agentKey: string,
  fields: Omit<Definition, "slotKey" | "family" | "agent" | "source" | "limitations">): Definition => ({
  slotKey: slot(family, index).key, family: family as ControlTowerExample["family"],
  agent: agentCatalogueIdentity(agentKey).name, source: "Server-authored case example",
  limitations, ...fields,
});

/** Fixed complementary observations. Never written to genuine telemetry tables. */
export const CONTROL_TOWER_EXAMPLE_DEFINITIONS: readonly Definition[] = [
  definition("Payroll", 5, "payroll", {
    id: "payroll-integration-failure", title: "Payroll lookup failed", category: "integration-failure",
    task: "Validate proposed payroll routing", status: "Failed task — review required",
    impact: "Routing validation cannot proceed; no bank change is confirmed.",
    nextStep: "Owner assignment and an independently verified provider check are required. Do not automatically retry.",
    expected: null, observed: null, corrected: null, matched: null,
  }),
  definition("IT Access", 6, "it-access", {
    id: "access-ambiguous-timeout", title: "Access lookup timed out", category: "ambiguous-timeout",
    task: "Read requested entitlement scope", status: "Ambiguous timeout — outcome unknown",
    impact: "No response was available in the authored scenario; neither success nor failure of a remote write may be inferred.",
    nextStep: "Inspect the provider record with an authorized operator before deciding whether any recovery is safe.",
    expected: null, observed: null, corrected: null, matched: null,
  }),
  definition("Benefits", 5, "benefits", {
    id: "benefits-stale-update", title: "Benefits provider update is stale", category: "stale-update",
    task: "Reconcile the proposed coverage update", status: "Stale synchronization — review required",
    impact: "The last authored response predates the requested change. Current coverage is unknown.",
    nextStep: "Request current source evidence and compare its effective date before reconciliation.",
    expected: null, observed: null, corrected: null, matched: null,
  }),
  definition("Learning", 7, "learning", {
    id: "learning-stuck-task", title: "Certification lookup has no callback", category: "stuck-task",
    task: "Check prerequisite equivalence", status: "Overdue callback — review required",
    impact: "The authored callback deadline passed without a response. This is not a policy hold or a human approval wait.",
    nextStep: "Assign an operator to confirm the source task status; no assignment or completion is established.",
    expected: null, observed: null, corrected: null, matched: null,
  }),
  definition("Documents", 8, "documents-records", {
    id: "documents-answer-match", title: "Acknowledgement answer matches expected response", category: "answer-match",
    task: "Answer whether an acknowledgement is established", status: "Authored expected-answer match",
    impact: "One initial answer matches the authored criterion; no policy acknowledgement is recorded.",
    nextStep: "Use source documents and current applicability review for any real decision.",
    expected: "Acknowledgement not established; review the prior request.",
    observed: "Acknowledgement not established; review the prior request.", corrected: null, matched: true,
  }),
  definition("Leave", 5, "leave", {
    id: "leave-human-correction", title: "Leave answer requires a human correction", category: "human-correction",
    task: "Answer a proposed leave-extension inquiry", status: "Authored correction — not a recorded human decision",
    impact: "The initial authored answer incorrectly asserts approval. A corrected answer withdraws that assertion.",
    nextStep: "A named reviewer must verify current entitlement and approval evidence before communicating an outcome.",
    expected: "Extension requires current entitlement and manager review.",
    observed: "The extension is approved.",
    corrected: "Extension requires current entitlement and manager review.", matched: false,
  }),
  definition("HR Helpdesk", 6, "hr-helpdesk", {
    id: "helpdesk-paired-fairness", title: "Paired letter responses differ without a supported reason", category: "fairness-review",
    task: "Compare two authored employment-letter inquiries", status: "Paired observation — fairness review required",
    impact: "Identical eligibility facts with a changed name produced different authored responses: A received a routine path; B an extra manager check.",
    nextStep: "Review why the extra requirement appeared and confirm policy grounding. Do not infer fairness across other cases or groups.",
    expected: "Both inquiries should receive the same evidence requirements when eligibility facts are equal.",
    observed: "A: routine signatory review. B: signatory review plus an unexplained manager check.",
    corrected: null, matched: null,
  }),
];

export const controlTowerInventorySlots = () => CONTROL_TOWER_EXAMPLE_DEFINITIONS.map(d =>
  CURATED_OFFLINE_EXAMPLES.find(e => e.key === d.slotKey)!);

/** Exact authored slot, immutable intake, no preparation/activation or run ownership. */
export function eligibleControlTowerExample(row: Row, runOwned = false): boolean {
  const source = controlTowerInventorySlots().find(e => e.key === row.scenarioKey);
  return Boolean(source && !runOwned && !syntheticJourneyEligibility(row) &&
    Object.entries(source.values).every(([key, value]) => isDeepStrictEqual(row[key as keyof Row], value)));
}

export function projectControlTowerExamples(rows: readonly Row[], excluded = new Set<number>()) {
  const items: ControlTowerExample[] = [];
  for (const d of CONTROL_TOWER_EXAMPLE_DEFINITIONS) {
    const matches = rows.filter(r => r.scenarioKey === d.slotKey);
    if (matches.length !== 1) continue; // duplicate identity is not a valid example
    const row = matches[0];
    if (!eligibleControlTowerExample(row, excluded.has(row.id))) continue;
    const { slotKey: _, ...fields } = d;
    items.push({ ...fields, caseId: row.id, reference: `S${row.id}`,
      caseHref: `/cases/${row.id}#operational-reliability`, owner: null,
      limitations: d.category === "fairness-review"
        ? `${limitations} One authored pair, no protected-characteristic analysis, no population denominator and no bias-free certification.`
        : limitations });
  }
  return items;
}

export async function loadControlTowerExamples(organizationId: string, actorUserId: string) {
  // Non-Demo clients never receive synthetic findings, even for a colliding key.
  const rows = organizationId === "demo" ? await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId), inArray(onbCases.scenarioKey, controlTowerInventorySlots().map(e => e.key)),
  )) : [];
  const ids = rows.map(r => r.id);
  const [uat, actualRuns, access] = await Promise.all([
    authoritativelyUatRunOwnedCaseIds(organizationId, rows),
    actualRunOwnedCaseIds(db, organizationId, ids),
    resolveEffectiveAccessForCases({ organizationId, principalType: "human", principalId: actorUserId,
      purpose: "control-tower-examples" }, ids),
  ]);
  const visible = rows.filter(r => {
    const keys = access.get(r.id)?.allows ?? [];
    return ["flow.case.read", "data.case.profile.read", "data.case.notes.read"].every(k => keys.includes(k));
  });
  const items = projectControlTowerExamples(visible, new Set([...uat, ...actualRuns]));
  const answers = items.filter(i => i.matched !== null);
  return { organizationId, generatedAt: new Date().toISOString(), source: "authored-examples" as const,
    inventorySize: CONTROL_TOWER_EXAMPLE_DEFINITIONS.length, available: items.length,
    answerSamples: answers.length, answerMatches: answers.filter(i => i.matched).length, items };
}
