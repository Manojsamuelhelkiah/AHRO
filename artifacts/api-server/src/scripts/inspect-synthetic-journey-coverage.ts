/** Read-only development inventory report. Does not create or update cases. */
import { db, pool, onbCases } from "@workspace/db";
import { actualRunOwnedCaseIds } from "../lib/onboarding/offline-preparation";
import { authoritativelyUatRunOwnedCaseIds } from "../lib/onboarding/uat-isolation";
import { fixedSyntheticJourney, syntheticJourneyEligibility } from "../lib/onboarding/synthetic-case-journey";
import { CURATED_OFFLINE_EXAMPLES } from "../lib/onboarding/offline-example-extension";
import { DEMO_FULL_COVERAGE_SCENARIO_KEYS } from "../lib/onboarding/demo-full-coverage";
import { logger } from "../lib/logger";

try {
  const rows = await db.select().from(onbCases);
  const matrix: Record<string, Record<string, number>> = {};
  const skipped: Record<string, number> = {};
  const seen = new Set<string>();
  for (const organizationId of new Set(rows.map(row => row.organizationId))) {
    const scoped = rows.filter(row => row.organizationId === organizationId);
    const ids = scoped.map(row => row.id);
    const [actual, uat] = await Promise.all([
      actualRunOwnedCaseIds(db, organizationId, ids), authoritativelyUatRunOwnedCaseIds(organizationId, scoped),
    ]);
    for (const row of scoped) {
      const reason = actual.has(row.id) || uat.has(row.id) ? "authoritative-run-owned"
        : syntheticJourneyEligibility(row);
      if (reason) { skipped[reason] = (skipped[reason] ?? 0) + 1; continue; }
      const journey = fixedSyntheticJourney(row)!;
      seen.add(row.scenarioKey!);
      const counts = matrix[journey.family] ??= { completed: 0, rejected: 0, blocked: 0 };
      counts[journey.outcome]!++;
    }
  }
  const expectedKeys = [...CURATED_OFFLINE_EXAMPLES.map(item => item.key),
    ...DEMO_FULL_COVERAGE_SCENARIO_KEYS.map(key => `UAT-DEMO-COVERAGE:${key}`)];
  logger.info({ environment: process.env.NODE_ENV, inspected: rows.length, matrix, skipped,
    eligible: Object.values(matrix).reduce((sum, counts) => sum + Object.values(counts).reduce((a, b) => a + b, 0), 0),
    missingFixedKeys: expectedKeys.filter(key => !seen.has(key)),
  }, "Read-only synthetic journey inventory");
} finally { await pool.end(); }
