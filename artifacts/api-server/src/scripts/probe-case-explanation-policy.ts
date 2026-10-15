import { and, eq } from "drizzle-orm";
import { db, pool, onbCases } from "@workspace/db";
import { evaluateProviderGovernanceGate, PROVIDER_GOVERNANCE_WORKFLOW } from "../lib/onboarding/governance-provider-boundary";
import { evaluateSensitiveLifecycleGate, jurisdictionForWorkforceContext, SENSITIVE_DATA_CLASSES } from "../lib/onboarding/sensitive-lifecycle";

async function probe() {
  if (process.env.NODE_ENV !== "development") throw new Error("Development-only policy probe");
  const id = Number(process.argv[2]);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Provide a positive case ID");
  const [row] = await db.select().from(onbCases).where(and(
    eq(onbCases.organizationId, "demo"), eq(onbCases.id, id),
  ));
  if (!row) throw new Error("Case not found in Demo Organization");
  const gate = await evaluateProviderGovernanceGate(row, PROVIDER_GOVERNANCE_WORKFLOW.communication, {
    readOnlyCaseAnalysis: true,
  });
  const disclosure = [];
  for (const dataClass of SENSITIVE_DATA_CLASSES) {
    const result = await evaluateSensitiveLifecycleGate({
      organizationId: row.organizationId, jurisdiction: jurisdictionForWorkforceContext(row.workforceContext),
      dataClass, disclosure: true, providerId: "openai",
    });
    disclosure.push({ dataClass, allowed: result.allowed });
  }
  console.log(JSON.stringify({
    caseId: id, readOnlyAnalysisAllowed: gate.allowed, reason: gate.reason,
    disclosure, modelRequestsMade: 0,
  }));
}
probe().catch(() => { console.error("Policy probe failed; no model request was made."); process.exitCode = 1; })
  .finally(() => pool.end());
