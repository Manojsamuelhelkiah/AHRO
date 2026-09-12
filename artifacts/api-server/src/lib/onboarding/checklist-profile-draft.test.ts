import test from "node:test";
import assert from "node:assert/strict";
import {
  applyChecklistOverrides,
  validateProfileInput,
} from "./checklist-profiles";
import type {
  OnbChecklistItemOverride,
  OnbChecklistProfileCriteria,
} from "@workspace/db/schema";
import { LEGACY_CHECKLIST } from "./settings";
import {
  assertDraftOverridesDoNotDisableEnabledBaseline,
  normalizeDraftOverridesForBaseline,
  validateChecklistProfileDraftAiOutput,
} from "./checklist-profile-draft";

const validAiOutput = (overrides: Record<string, unknown>[] = []) => ({
  name: "Remote finance cohort",
  criteria: { workEnvironment: "remote", role: "Finance Analyst" },
  overrides,
  priority: 10,
  processPolicy: { match: null },
  rationale: "Applies the existing remote-work controls to finance analysts.",
  warnings: [],
  unsupportedRequests: [],
});

test("strict draft parsing preserves explicit unsupported constraints", () => {
  const parsed = validateChecklistProfileDraftAiOutput({
    ...validAiOutput(),
    unsupportedRequests: ["Automatically send a provider email after approval."],
  });
  assert.deepEqual(parsed.unsupportedRequests, [
    "Automatically send a provider email after approval.",
  ]);
});

test("strict draft parsing rejects malicious extra override fields", () => {
  assert.throws(
    () => validateChecklistProfileDraftAiOutput({
      ...validAiOutput([{
        id: "identity-proof",
        enabled: true,
        malicious: "publish-now",
      }]),
    }),
    (error: unknown) => error instanceof Error &&
      error.name === "ChecklistProfileDraftFailure" &&
      error.message.includes("unknown field"),
  );
});

test("additive baseline validation cannot weaken a mandatory item", () => {
  const base = [{
    id: "identity-proof",
    label: "Identity proof",
    order: 0,
    enabled: true,
    mandatory: true,
    enforcementStage: "before-workstreams" as const,
  }];
  assert.throws(
    () => applyChecklistOverrides(base, [{
      id: "identity-proof",
      enabled: false,
      mandatory: false,
    }]),
    /cannot be disabled or weakened/,
  );
});

test("draft invariant rejects disabling an enabled optional baseline item", () => {
  assert.throws(
    () => assertDraftOverridesDoNotDisableEnabledBaseline(
      [{
        id: "optional-manager-welcome",
        label: "Manager welcome",
        order: 1,
        enabled: true,
        mandatory: false,
        enforcementStage: "before-day1-review",
      }],
      [{ id: "optional-manager-welcome", enabled: false }],
    ),
    (error: unknown) => error instanceof Error &&
      error.name === "ChecklistProfileDraftFailure" &&
      error.message.includes("cannot disable or remove"),
  );
});

test("real default checklist output preserves baseline order before additive validation", () => {
  const parsed = validateChecklistProfileDraftAiOutput({
    name: "Remote Canada Software Engineer Onboarding",
    criteria: {
      band: null,
      role: "Software Engineer",
      employmentType: "Full-time",
      location: "Canada (Remote)",
      roleFamily: "Engineering",
      department: "Engineering",
      legalEntity: null,
      businessUnit: null,
      industry: "Technology",
      workCountry: "Canada",
      workState: null,
      site: null,
      employmentArrangement: "Remote",
      workerCategory: null,
      payBasis: null,
      shiftPattern: null,
      workEnvironment: "Remote",
      hiringMode: "Direct Hire",
      safetyCritical: null,
    },
    overrides: [{
      id: "learning",
      label: "Mandatory learning requirement override",
      order: 1,
      enabled: true,
      mandatory: true,
      enforcementStage: "before-day1-review",
      evidenceRequired: false,
      executor: "existing-workflow",
      prerequisites: [],
    }],
    priority: 1,
    processPolicy: { match: null },
    rationale: "Preserves baseline controls for the requested workforce context.",
    warnings: [],
    unsupportedRequests: [],
  });
  const normalized = normalizeDraftOverridesForBaseline(LEGACY_CHECKLIST, parsed.overrides);
  const criteria = Object.fromEntries(
    Object.entries(parsed.criteria).filter(([, value]) => typeof value === "string"),
  ) as OnbChecklistProfileCriteria;
  const input = validateProfileInput({
    name: parsed.name,
    criteria,
    overrides: normalized.overrides as OnbChecklistItemOverride[],
    priority: parsed.priority,
    enabled: false,
    processPolicy: {},
  });
  const effective = applyChecklistOverrides(LEGACY_CHECKLIST, input.overrides);

  assert.equal(effective.find((item) => item.id === "learning")?.order, 5);
  assert.deepEqual(normalized.warnings, [
    'Preserved the organization baseline order for checklist item "learning".',
  ]);
});

test("profile input validation forces semantics v2 while draft remains disabled", () => {
  const normalized = validateProfileInput({
    name: "Remote cohort",
    criteria: { workEnvironment: "remote" },
    overrides: [],
    priority: 0,
    enabled: false,
    processPolicy: {},
  });
  assert.equal(normalized.enabled, false);
  assert.equal(normalized.processPolicy?.semanticsVersion, 2);
});