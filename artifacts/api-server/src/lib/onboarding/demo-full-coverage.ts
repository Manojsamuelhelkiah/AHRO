import { and, eq, sql } from "drizzle-orm";
import {
  db,
  onbCaseLogistics,
  onbCases,
} from "@workspace/db";
import { getDay1LogisticsDefault, readinessFromChecklist } from "./settings";
import { logisticsForCase } from "./logistics-defaults";
import {
  checklistProfileMatchingAttributes,
  resolveChecklistProfileInTransaction,
} from "./checklist-profiles";
import { getScenario } from "./scenarios";
import { SYNTHETIC_OFFLINE_MARKER, SYNTHETIC_OFFLINE_WARNING } from "./synthetic-offline";
import { withSensitiveLifecycleFence } from "./sensitive-lifecycle";

/**
 * This intentionally begins with the existing UAT-reserved prefix. Every
 * ordinary worker, provider boundary, mutation route and privacy/reporting
 * filter already treats that prefix as fail-closed, while these samples never
 * receive the UAT run-ledger link required for its narrow local exceptions.
 */
export const DEMO_FULL_COVERAGE_SCENARIO_PREFIX = "UAT-DEMO-COVERAGE:";

export function demoFullCoverageScenarioKey(originalKey: string): string {
  return `${DEMO_FULL_COVERAGE_SCENARIO_PREFIX}${originalKey}`;
}

export function originalDemoFullCoverageScenarioKey(
  scenarioKey: string | null | undefined,
): string | null {
  if (!scenarioKey?.startsWith(DEMO_FULL_COVERAGE_SCENARIO_PREFIX)) return null;
  const originalKey = scenarioKey.slice(DEMO_FULL_COVERAGE_SCENARIO_PREFIX.length);
  return DEMO_FULL_COVERAGE_SCENARIO_KEYS.includes(
    originalKey as typeof DEMO_FULL_COVERAGE_SCENARIO_KEYS[number],
  ) ? originalKey : null;
}

export function isDemoFullCoverageScenarioKey(
  scenarioKey: string | null | undefined,
): boolean {
  return originalDemoFullCoverageScenarioKey(scenarioKey) !== null;
}

/**
 * One demonstrative case for every case-family filter. These are existing
 * scenario definitions, rather than a second sample-data model.
 */
export const DEMO_FULL_COVERAGE_SCENARIO_KEYS = [
  "standard-fte",
  "internal-transfer",
  "payroll-bank-change",
  "benefits-life-event",
  "leave-parental",
  "compliance-work-authorization",
  "offboarding-voluntary",
  "helpdesk-employment-letter",
  "it-privileged-access",
  "learning-mandatory-certification",
  "mobility-country-transfer",
  "documents-policy-acknowledgement",
] as const;

export type DemoFullCoverageResult = {
  scenarioKeys: readonly string[];
  createdCaseIds: number[];
  existingCaseIds: number[];
};

function offlineWorkstreams() {
  return [
    { key: "documentation", label: "Documentation & Compliance", agent: "documentation", status: "pending", owner: "HR Ops", blockers: ["Offline demo sample"] },
    { key: "access", label: "Access & System Readiness", agent: "access", status: "pending", owner: "IT / Security", blockers: ["Offline demo sample"] },
    { key: "assets", label: "Asset & Workplace Readiness", agent: "assets", status: "pending", owner: "IT / Facilities", blockers: ["Offline demo sample"] },
    { key: "learning", label: "Learning, Engagement & Readiness", agent: "learning", status: "pending", owner: "L&D / Manager", blockers: ["Offline demo sample"] },
    { key: "analytics", label: "Data & Analytics", agent: "analytics", status: "pending", owner: "People Analytics", blockers: ["Offline demo sample"] },
  ];
}

function syntheticName(title: string) {
  return `Demo sample — ${title}`;
}

function syntheticEmail(key: string) {
  return `demo-${key}@hro.invalid`;
}

/**
 * Adds only missing samples. A tenant advisory transaction lock makes
 * concurrent button clicks and command retries converge on the same twelve
 * rows. It intentionally never starts orchestration or provider dispatch.
 *
 * The HTTP route is the policy boundary that restricts this helper to the
 * development Demo organization; accepting an organization argument keeps the
 * DB behavior directly testable without ever creating customer data.
 */
export async function seedDemoFullCoverage(
  organizationId: string,
  actorId: string | null,
): Promise<DemoFullCoverageResult> {
  return withSensitiveLifecycleFence(organizationId, async () => {
    const logisticsDefault = await getDay1LogisticsDefault(organizationId);
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`onboarding.demo-full-coverage:${organizationId}`}))`);
      const candidates = await tx
        .select({
          id: onbCases.id,
          workerName: onbCases.workerName,
          scenarioKey: onbCases.scenarioKey,
          notes: onbCases.notes,
          syntheticProvenance: onbCases.syntheticProvenance,
        })
        .from(onbCases)
        .where(eq(onbCases.organizationId, organizationId));
      const existingByKey = new Map<string, number>();
      for (const row of candidates) {
        const persistedKey = originalDemoFullCoverageScenarioKey(row.scenarioKey);
        if (persistedKey) {
          existingByKey.set(persistedKey, row.id);
          continue;
        }
        // Upgrade only our former marker-backed rows. This one-time bridge
        // applies only when the durable server-owned provenance also matches;
        // legacy marker-only rows are never promoted from mutable notes.
        if (
          row.syntheticProvenance === "demo-full-coverage" &&
          row.notes?.includes(SYNTHETIC_OFFLINE_MARKER) === true &&
          typeof row.scenarioKey === "string" &&
          DEMO_FULL_COVERAGE_SCENARIO_KEYS.includes(
            row.scenarioKey as typeof DEMO_FULL_COVERAGE_SCENARIO_KEYS[number],
          ) &&
          row.workerName === syntheticName(getScenario(row.scenarioKey)!.title)
        ) {
          await tx.update(onbCases)
            .set({ scenarioKey: demoFullCoverageScenarioKey(row.scenarioKey), updatedAt: new Date() })
            .where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, row.id)));
          existingByKey.set(row.scenarioKey, row.id);
        }
      }
      const createdCaseIds: number[] = [];
      const now = new Date();

      for (const key of DEMO_FULL_COVERAGE_SCENARIO_KEYS) {
        if (existingByKey.has(key)) continue;
        const scenario = getScenario(key);
        if (!scenario) throw new Error(`Demo full coverage references unknown scenario "${key}".`);
        const profile = await resolveChecklistProfileInTransaction(
          tx,
          organizationId,
          checklistProfileMatchingAttributes({}, {
            workerBand: null,
            role: scenario.intake.role,
            hireType: scenario.intake.hireType,
            workerCategory: scenario.intake.workerCategory,
            geography: scenario.intake.geography,
            department: scenario.intake.department,
            legalEntity: scenario.intake.legalEntity,
          }),
        );
        const joiningDate = new Date(
          now.getTime() + scenario.intake.joiningDateOffsetDays * 86_400_000,
        ).toISOString().slice(0, 10);
        const [created] = await tx.insert(onbCases).values({
          organizationId,
          workerName: syntheticName(scenario.title),
          workerEmail: syntheticEmail(key),
          workerPhone: null,
          channelPreference: "email",
          hireType: scenario.intake.hireType,
          workerCategory: scenario.intake.workerCategory,
          role: scenario.intake.role,
          department: scenario.intake.department,
          geography: scenario.intake.geography,
          legalEntity: scenario.intake.legalEntity,
          managerName: scenario.intake.managerName,
          recruiterName: scenario.intake.recruiterName,
          joiningDate,
          urgency: "standard",
          lifecycleStage: "service-intake",
          orchestrationStatus: "blocked",
          orchestrationCheckpoint: "synthetic-offline",
          orchestrationClaimOwner: null,
          orchestrationClaimUntil: null,
          readiness: readinessFromChecklist(profile.items),
          workstreams: offlineWorkstreams(),
          primarySkill: scenario.intake.primarySkill,
          skillCriticality: scenario.intake.skillCriticality,
          scenarioKey: demoFullCoverageScenarioKey(scenario.key),
          planSummary: `${scenario.description} ${scenario.expectedBehaviour}`,
          notes: `${SYNTHETIC_OFFLINE_MARKER} ${SYNTHETIC_OFFLINE_WARNING}`,
          syntheticProvenance: "demo-full-coverage",
          candidateEmailAuthorizedAt: null,
          candidateEmailAuthorizedBy: null,
          offerAcceptanceComplete: false,
          offerAcceptanceCompletedAt: null,
          offerAcceptanceCompletedBy: null,
          createdByUserId: actorId,
          checklistTemplateVersion: profile.templateVersion,
          checklistSnapshot: profile.items,
          checklistProfileId: profile.profileId,
          checklistProfileName: profile.profileName,
          checklistProfileVersion: profile.profileVersion,
          checklistMatchedCriteria: profile.matchedCriteria,
          checklistMatchExplanation: profile.explanation,
          updatedAt: now,
        }).returning({ id: onbCases.id });
        if (!created) throw new Error(`Demo sample "${key}" was not created.`);
        createdCaseIds.push(created.id);
        await tx.insert(onbCaseLogistics).values({
          organizationId,
          caseId: created.id,
          ...logisticsForCase(logisticsDefault, joiningDate),
        });
      }

      return {
        scenarioKeys: DEMO_FULL_COVERAGE_SCENARIO_KEYS,
        createdCaseIds,
        existingCaseIds: [...existingByKey.values()],
      };
    });
  });
}