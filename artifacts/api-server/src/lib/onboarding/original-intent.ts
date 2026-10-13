import type { onbCases } from "@workspace/db/schema";
import { findHroTemplate, readHroBatchRequest } from "./hro-batch-templates";
import { preparationSource } from "./offline-preparation";
import { isFictionalOfflineExampleCase } from "./offline-example-display";
import { originalDemoFullCoverageScenarioKey } from "./demo-full-coverage";
import { getScenario } from "./scenarios";

type CaseRow = typeof onbCases.$inferSelect;
type Origin = NonNullable<CaseRow["originalIntent"]>;

/** Fixed taxonomy only: no submitted narrative, requester or authorization claim. */
export function templateOriginalIntent(templateId: string, source = "recorded-template-intake"): Origin | null {
  const template = findHroTemplate(templateId);
  if (!template) return null;
  return {
    label: template.family === "Onboarding" ? "Onboarding"
      : template.id === "it-access-request" ? "Application access request"
      : template.name,
    source, templateId,
  };
}

export function onboardingOriginalIntent(source: string): Origin {
  return { label: "Onboarding", source };
}

const SCENARIO_ORIGINS: Record<string, string> = {
  "standard-fte": "Onboarding", "contractor-client": "Onboarding", rehire: "Onboarding",
  "bgv-exception": "Onboarding", "critical-skill": "Onboarding",
  "internal-transfer": "Internal transfer request",
  "payroll-bank-change": "Bank-detail change request",
  "benefits-life-event": "Life-event enrolment request",
  "leave-parental": "Parental leave request",
  "compliance-work-authorization": "Work-authorization renewal request",
  "offboarding-voluntary": "Voluntary offboarding",
  "helpdesk-employment-letter": "Employment-letter request",
  "it-privileged-access": "Privileged application access request",
  "learning-mandatory-certification": "Certification assignment request",
  "mobility-country-transfer": "Cross-border transfer request",
  "documents-policy-acknowledgement": "Policy acknowledgement request",
};

export function scenarioOriginalIntent(key: string): Origin | null {
  return SCENARIO_ORIGINS[key] ? { label: SCENARIO_ORIGINS[key], source: "fixed-scenario-intake" } : null;
}

/** Legacy resolution is evidence-based, never a hire-type/title/workstream fallback. */
export function resolveOriginalIntent(row: CaseRow): Origin | null {
  if (row.originalIntent) return row.originalIntent;
  const source = preparationSource(row);
  if (source) return templateOriginalIntent(
    source.values.processPolicySnapshot.batchIntake.templateId, "curated-fictional-intake",
  );
  const legacyKey = originalDemoFullCoverageScenarioKey(row.scenarioKey);
  const scenario = legacyKey ? getScenario(legacyKey) : undefined;
  if (scenario && isFictionalOfflineExampleCase(row) &&
    row.workerName === `Demo sample — ${scenario.title}` &&
    row.workerEmail === `demo-${legacyKey}@hro.invalid`) return scenarioOriginalIntent(legacyKey!);
  // Activation replaces current intake. Without a retained source, it cannot
  // establish what the case originally requested.
  if (row.operationalActivation) return null;
  const intake = readHroBatchRequest(row.processPolicySnapshot);
  return intake ? templateOriginalIntent(intake.templateId) : null;
}

export function originalIntentLabel(row: CaseRow, canReadProfile: boolean): string | null {
  // Do not disclose provenance objects or any opaque source fields.
  return canReadProfile ? resolveOriginalIntent(row)?.label ?? "Not recorded" : null;
}
