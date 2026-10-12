import { sql } from "drizzle-orm";
import { onbCases } from "@workspace/db/schema";
/**
 * Explicit new lifecycle plus conservative historical intake quarantine.
 * A label is never permission to promote retained history into a separation.
 */
export function isSeparationOrLegacyExit(c: { hireType: string; processPolicySnapshot?: Record<string, unknown> | null }): boolean {
  const snapshot = c.processPolicySnapshot;
  const intake = snapshot?.batchIntake as { templateId?: string; family?: string } | undefined;
  return ["separation", "offboarding"].includes(c.hireType.trim().toLowerCase()) ||
    ["separation", "offboarding"].includes(String(snapshot?.lifecycle ?? "").toLowerCase()) ||
    intake?.templateId === "offboarding-separation" || String(intake?.family ?? "").toLowerCase() === "offboarding";
}

/** Worker selection fence; generic read-only case inventories stay intact. */
export function onboardingCaseCandidateSql() {
  return sql`lower(trim(${onbCases.hireType})) not in ('separation', 'offboarding')
    and lower(coalesce(${onbCases.processPolicySnapshot}->>'lifecycle', '')) not in ('separation', 'offboarding')
    and coalesce(${onbCases.processPolicySnapshot}->'batchIntake'->>'templateId', '') <> 'offboarding-separation'
    and lower(coalesce(${onbCases.processPolicySnapshot}->'batchIntake'->>'family', '')) <> 'offboarding'`;
}
