// Explicit additive development-only population. Never called by app startup.
import { and, eq, sql } from "drizzle-orm";
import { db, pool, onbCases, onbSettings, organizationsTable } from "@workspace/db";
import { emptyWorkforceState, WORKFORCE_INSIGHTS_KEY, type WorkforceState } from "../lib/workforce-insights";
import { buildRiskExamples, eligibleRiskExampleSource, RISK_EXAMPLE_SOURCES, riskExampleStore, WORKFORCE_EXAMPLES_KEY } from "../lib/workforce-risk-examples";
import { GetWorkforceInsightsResponse } from "@workspace/api-zod";

try {
  if (process.env.NODE_ENV !== "development") throw new Error("Talent at Risk examples may only be added to development Demo.");
  const report = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('demo'))`);
    const [tenant] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, "demo"));
    const optionalSetup = process.env.WORKFORCE_EXAMPLES_IF_READY === "true";
    if (tenant?.slug !== "demo" || tenant.name !== "Demo Organization") {
      if (optionalSetup) return { added: 0, examples: 0, status: "skipped-demo-unavailable" };
      throw new Error("Demo workspace identity could not be verified.");
    }
    const settings = await tx.select().from(onbSettings).where(and(
      eq(onbSettings.organizationId, "demo"), eq(onbSettings.key, WORKFORCE_INSIGHTS_KEY),
    ));
    const state: WorkforceState = settings[0] ? JSON.parse(settings[0].value) : emptyWorkforceState();
    if (!Number.isSafeInteger(state.version) || state.version < 0) throw new Error("Invalid review version.");
    state.reviews.forEach(row => GetWorkforceInsightsResponse.shape.reviews.element.parse(row));
    state.assessments.forEach(row => GetWorkforceInsightsResponse.shape.assessments.element.parse(row));
    const [existing] = await tx.select().from(onbSettings).where(and(
      eq(onbSettings.organizationId, "demo"), eq(onbSettings.key, WORKFORCE_EXAMPLES_KEY),
    ));
    if (existing) return { added: 0, examples: riskExampleStore.parse(JSON.parse(existing.value)).length };
    const sources = await tx.select().from(onbCases).where(eq(onbCases.organizationId, "demo")).for("share");
    if (optionalSetup && !RISK_EXAMPLE_SOURCES.every(definition =>
      sources.some(source => source.scenarioKey === definition.key && eligibleRiskExampleSource(source)))) {
      return { added: 0, examples: 0, status: "skipped-source-inventory-unavailable" };
    }
    const result = buildRiskExamples(state, sources);
    for (const [key, value] of [[WORKFORCE_INSIGHTS_KEY, result.state], [WORKFORCE_EXAMPLES_KEY, result.examples]] as const) {
      await tx.insert(onbSettings).values({ organizationId: "demo", key, value: JSON.stringify(value) })
        .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(value), updatedAt: new Date() } });
    }
    return { added: result.state.reviews.length - state.reviews.length, examples: result.examples.length };
  });
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Talent at Risk population failed.");
  process.exitCode = 1;
} finally { await pool.end(); }
