import { createHash } from "node:crypto";
import { defineFlow, type Action, type Condition, type Definition, type FlowFamily, type Handler, type Stage } from "./contract";

const stage = (id: string, label: string, role: string, completed: Condition,
  prerequisites: string[] = [], applies: Condition = "always"): Stage =>
  ({ id, label, role, completed, prerequisites, applies });
const action = (id: string, stage: string, handler: Handler, requires: Condition[],
  authority: string[], evidence: string[], reworkTo?: string): Action =>
  ({ id, stage, handler, requires, authority, evidence, ...(reworkTo ? { reworkTo } : {}) });

export const ONBOARDING_V1 = defineFlow({
  id: "onboarding.base", version: 1, family: "onboarding",
  continuations: {
    plan: ["plan", "workstreams", "communications", "review"],
    initial: ["plan", "workstreams", "communications", "review"],
    "intake-approved": ["plan", "workstreams", "communications", "review"],
    "plan-approved": ["plan", "workstreams", "communications", "review"],
    "blocked:before-workstreams": ["workstreams", "communications", "review"],
    "waiting:standard-operations-release": ["connector", "communications", "review"],
    "blocked:before-employee-communications": ["communications", "review"],
    "workstreams-complete": ["communications", "review"],
    "blocked:before-day1-review": ["review"],
    "communications-complete": ["review"],
    "blocked:re-review": ["review"],
  },
  stages: [
    stage("acceptance", "Offer acceptance", "HR reviewer", "offer-released", [], "offer-required"),
    stage("intake", "Intake and profile review", "HR Operations", "intake-released", ["acceptance"]),
    stage("plan", "Deterministic plan and conditional approvals", "HR reviewer", "plan-released", ["intake"]),
    // Entering the workstream phase is intentionally distinct from completing
    // its parallel tasks. Dynamic tasks remain visible from domain records.
    stage("workstreams", "Parallel workstream initiation and evidence", "Domain owners", "workstreams-entered", ["plan"]),
    stage("communications", "Employee communications", "HR Operations", "communications-recorded", ["workstreams"]),
    stage("readiness", "Live readiness and human confirmation", "HR reviewer", "readiness-review", ["communications"]),
  ],
  actions: [
    action("start", "intake", "onboarding.reconcile", ["admission-pending"],
      ["existing-intake-authority"], ["new-domain-admission"], "intake"),
    action("offer", "acceptance", "onboarding.offer", [], ["flow.case.edit"], ["offer-package"]),
    action("intake", "intake", "onboarding.intake", ["offer-released"], ["existing-intake-authority"], ["profile"]),
    action("plan", "plan", "onboarding.plan", ["offer-released"], ["current-intake-decisions"], ["intake"]),
    action("workstreams", "workstreams", "onboarding.workstreams", ["offer-released", "plan-released"],
      ["current-execution-decisions"], ["before-workstreams-checklist"]),
    action("communications", "communications", "onboarding.communications", ["offer-released", "plan-released"],
      ["current-recipient-and-delivery-authority"], ["before-employee-communications-checklist"]),
    action("review", "readiness", "onboarding.review", ["offer-released", "plan-released"],
      ["existing-review-authority"], ["live-checklist-and-malware"]),
    action("readiness", "readiness", "onboarding.readiness", ["offer-released", "plan-released"],
      ["current-gate-c-human-decision"], ["bgv", "weighted-readiness", "frontline-release", "latest-malware"]),
    action("reconcile", "intake", "onboarding.reconcile", [],
      ["current-continuation-decisions"], ["durable-checkpoint"], "intake"),
    action("connector", "workstreams", "onboarding.connector", ["offer-released", "plan-released"],
      ["current-connector-decision"], ["source-and-provider-policy"]),
    action("workforce", "workstreams", "onboarding.workforce", ["offer-released", "plan-released"],
      ["current-task-permissions"], ["task-prerequisites"]),
    action("notification", "intake", "onboarding.notification", ["offer-released"],
      ["current-channel-and-recipient-permissions"], ["stable-message-payload"], "intake"),
    action("administrative", "intake", "onboarding.notification", [],
      ["current-administrative-recipient-permissions"], ["stable-message-payload"], "intake"),
  ],
});

export const SEPARATION_V1 = defineFlow({
  id: "separation.base", version: 1, family: "separation",
  stages: [
    stage("screening", "Separation Screening", "HR / HRBP", "screened"),
    stage("classification", "Human-confirmed classification", "HR / HRBP", "classified", ["screening"]),
    stage("plan", "Approved-policy plan", "HR / policy owner", "policy-planned", ["classification"]),
    stage("restricted", "Restricted human-led review", "HRBP / Ethics / Legal", "policy-planned", [], "restricted"),
    stage("workstreams", "Dependent workstreams", "Task owners", "closure-unavailable", ["plan"]),
    stage("closure", "Final closure unavailable — section 4.6 pending", "HR / policy owner", "closure-unavailable", ["workstreams"]),
  ],
  actions: [
    action("screen", "screening", "separation.screen", [], ["current-screening-permissions"], ["source-reference"], "screening"),
    action("classify", "classification", "separation.classify", ["screened"],
      ["current-classification-permissions"], ["screening-receipt"]),
    action("plan", "plan", "separation.plan", ["screened", "classified"],
      ["current-policy-approval"], ["country-role-category-zone-policy"]),
    action("task", "workstreams", "separation.task", ["policy-planned"],
      ["current-task-owner-permissions"], ["task-generation", "prerequisites", "source-attestation"]),
    action("restricted-task", "restricted", "separation.task", ["restricted"],
      ["current-human-led-review-permissions"], ["restricted-source-reference"], "restricted"),
    action("exchange", "workstreams", "separation.exchange", ["policy-planned"],
      ["current-pilot-recipient-and-channel-permissions"], ["exact-pilot-provenance", "stable-effect-key"]),
    action("reconcile", "screening", "separation.reconcile", [],
      ["current-domain-permissions"], ["recorded-source-and-generation"], "screening"),
  ],
});

export const DEFINITIONS: readonly Definition[] = Object.freeze([ONBOARDING_V1, SEPARATION_V1]);
// Explicit release choice for new admissions. Retain all prior definitions in
// DEFINITIONS; compatibility mapping always uses the captured baseline, never
// an automatically selected newest version.
export function admissionDefinition(family: FlowFamily): Definition {
  return family === "onboarding" ? ONBOARDING_V1 : SEPARATION_V1;
}
export function legacyBaselineDefinition(family: FlowFamily): Definition {
  return family === "onboarding" ? ONBOARDING_V1 : SEPARATION_V1;
}
export function definitionDigest(definition: Definition): string {
  // PostgreSQL jsonb does not preserve object key order.
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => [key, canonical(v)]))
      : value;
  return createHash("sha256").update(JSON.stringify(canonical(definition))).digest("hex");
}
export function registeredDefinition(id: string, version: number): Definition | undefined {
  return DEFINITIONS.find(definition => definition.id === id && definition.version === version);
}
