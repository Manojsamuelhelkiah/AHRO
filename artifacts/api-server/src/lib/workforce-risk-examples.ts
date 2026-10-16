import { z } from "zod";
import { GetWorkforceInsightsResponse } from "@workspace/api-zod";
import { OFFLINE_CASE_EXAMPLES } from "./onboarding/offline-example-inventory";
import { isFictionalOfflineExampleCase } from "./onboarding/offline-example-display";
import { createHumanWorkforceReview, type WorkforceState, type WorkforceAssessment } from "./workforce-insights";

export const WORKFORCE_EXAMPLES_KEY = "workforce.early-warning.examples.v1";
export const riskExampleStore = z.array(GetWorkforceInsightsResponse.shape.assessments.element);
export const RISK_EXAMPLE_SOURCES = OFFLINE_CASE_EXAMPLES.filter(row => row.family === "Employee Changes").slice(0, 3);
type Source = Parameters<typeof isFictionalOfflineExampleCase>[0] & { id: number; updatedAt: Date };
const scenarios = [
  { band: "red", probability: 0.78, reason: "Career progression has stalled while a promotion review remains unresolved.",
    action: "Arrange a confidential career conversation and agree a dated progression plan.", priority: "critical" },
  { band: "amber", probability: 0.46, reason: "A department move is pending and the employee needs clarity on responsibilities and workload.",
    action: "Confirm the proposed move timeline and discuss workload support with the employee.", priority: "standard" },
  { band: "green", probability: 0.12, reason: "Role expectations are aligned; a role-title correction needs routine follow-through.",
    action: "Confirm the title correction and retain the regular manager check-in.", priority: "standard" },
] as const;

export function eligibleRiskExampleSource(source: Source): boolean {
  const expected = RISK_EXAMPLE_SOURCES.find(row => row.key === source.scenarioKey);
  return Boolean(expected && source.workerName === expected.values.workerName &&
    source.workerEmail === expected.values.workerEmail && isFictionalOfflineExampleCase(source));
}

/** Separate from the live model adapter. No invocation, authority or provider effect. */
export function buildRiskExamples(state: WorkforceState, sources: Source[], now = new Date()) {
  let next = state;
  const examples: WorkforceAssessment[] = [];
  for (const [index, definition] of RISK_EXAMPLE_SOURCES.entries()) {
    const source = sources.find(row => row.scenarioKey === definition.key);
    if (!source || !eligibleRiskExampleSource(source)) throw new Error("The three approved Demo source cases must be available before adding Talent at Risk examples.");
    const scenario = scenarios[index]!;
    const id = `workforce-example:${source.id}`;
    examples.push({
      id, caseId: source.id, kind: "talent-risk", band: scenario.band,
      modelId: "workforce-example-catalogue", modelVersion: "1",
      assessedAt: now.toISOString(), validUntil: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
      sourceRevision: source.updatedAt.toISOString(), probability: scenario.probability, horizonDays: 90,
      factors: [scenario.reason], recommendedActions: [scenario.action],
    });
    // A closed example stays closed. Reruns do not restore or duplicate work.
    if (next.reviews.some(row => row.id === id || (row.caseId === source.id && row.kind === "talent-risk"))) continue;
    next = createHumanWorkforceReview(next, {
      version: next.version, caseId: source.id, kind: "talent-risk", priority: scenario.priority,
      reason: scenario.reason, recommendedAction: scenario.action, ownerUserId: "HR team",
      dueDate: new Date(now.getTime() + (index + 1) * 86_400_000).toISOString().slice(0, 10),
    }, "Talent at Risk", now);
    const createdId = next.reviews.at(-1)!.id;
    next = { ...next, reviews: next.reviews.map(row => row.id === createdId ? {
      ...row, id, reference: `S${source.id}`, origin: "catalogue" as const,
      history: row.history.map(event => ({ ...event, action: "review-created" })),
    } : row) };
  }
  return { state: next, examples };
}

export function visibleRiskExamples(organizationId: string, examples: WorkforceAssessment[], sources: Source[], now = new Date()) {
  if (organizationId !== "demo") return [];
  return examples.filter(example => {
    const source = sources.find(row => row.id === example.caseId);
    return source && eligibleRiskExampleSource(source) &&
      example.sourceRevision === source.updatedAt.toISOString() &&
      example.kind === "talent-risk" && example.modelId === "workforce-example-catalogue" &&
      example.modelVersion === "1" && Date.parse(example.assessedAt) <= now.getTime() &&
      Date.parse(example.validUntil) > now.getTime();
  });
}
