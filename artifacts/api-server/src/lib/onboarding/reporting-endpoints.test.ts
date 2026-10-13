import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { isRestrictedHistoricalCase, evidenceBelongsToOperationalGeneration } from "./operational-eligibility";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { isReportableFictionalOfflineExampleCase } from "./offline-example-display";
import { preparationSource } from "./offline-preparation";

// Execute the actual registered handlers with isolated read-only repositories.
// No app server, shared fixtures, provider, policy writes or credentials involved.
const source = readFileSync("src/routes/onboarding.ts", "utf8");
const { transformSync } = createRequire(import.meta.url)("esbuild") as typeof import("esbuild");
function handler(path: string, cases: any[], approvals: any[]) {
  const prefix = `router.get("${path}", `;
  const start = source.indexOf(prefix);
  assert.ok(start >= 0);
  const end = source.indexOf("\n});", start);
  assert.ok(end > start);
  const code = transformSync(`module.exports = ${source.slice(start + prefix.length, end + 2)}`, {
    loader: "ts", format: "cjs",
  }).code;
  const module = { exports: undefined as any };
  const tableCases = {};
  const tableApprovals = {};
  const tableEvents = {};
  const context = {
    module,
    db: {
      select: () => {
        let rows: any[] = [];
        const query: any = {
          from: (table: unknown) => {
            rows = table === tableCases ? cases : table === tableApprovals
              ? approvals.map(approval => ({ approval })) : [];
            return query;
          },
          where: () => query, innerJoin: () => query, orderBy: () => query, limit: () => query,
          then: (resolve: (rows: any[]) => unknown) => Promise.resolve(rows).then(resolve),
        };
        return query;
      },
    },
    onbCases: tableCases, onbApprovals: tableApprovals, onbEvents: tableEvents,
    getOrganizationId: () => "reporting-fixture",
    organizationWhere: () => true, eq: () => true, desc: () => true,
    demoPrincipalVisibleCases: async (_req: unknown, rows: any[]) => rows,
    excludeUatAggregateCases: async (rows: any[]) => rows,
    caseGovernanceAccessForRequest: async () => ({ flowRead: true, readinessRead: true }),
    isHistoricalTestRecord: isRestrictedHistoricalCase,
    evidenceBelongsToOperationalGeneration,
    isDay1ReadinessApproval: () => false,
    serializeEventForRequest: async (_req: unknown, event: unknown) => event,
    SUPPRESSION_THRESHOLD: 3,
  };
  runInNewContext(code, context);
  return module.exports;
}

for (const endpoint of ["/onboarding/dashboard", "/onboarding/analytics"]) {
  test(`${endpoint} counts offline cases but excludes their retained pending approvals`, async () => {
    const fixture = {
      id: 1, organizationId: "reporting-fixture", scenarioKey: "fictional-example",
      syntheticProvenance: "onboarding-demo-fictional", lifecycleStage: "service-intake",
      orchestrationStatus: "blocked", joiningDate: "2030-01-01", readiness: [],
      workstreams: [], primarySkill: null,
    };
    const live = { ...fixture, id: 2, scenarioKey: null, syntheticProvenance: null };
    const approvals = [
      { id: 11, caseId: 1, status: "pending", hitlPattern: "hard-block", agent: "documentation", createdAt: new Date() },
      { id: 12, caseId: 2, status: "pending", hitlPattern: "soft-gate", agent: "access", createdAt: new Date() },
    ];
    let result: any;
    await handler(endpoint, [fixture, live], approvals)({}, { json: (body: any) => { result = body; } },
      (error: unknown) => { throw error; });
    if (endpoint.endsWith("dashboard")) {
      assert.equal(result.totalCases, 2);
      assert.equal(result.byStage.reduce((sum: number, stage: any) => sum + stage.count, 0), 2);
      assert.equal(result.pendingApprovals, 1);
      assert.equal(result.hardBlocked, 0);
    } else {
      assert.equal(result.bottlenecks.length, 1);
      assert.equal(result.bottlenecks[0].theme, "access");
      assert.match(result.narrative, /2 onboarding cases/);
      assert.match(result.narrative, /1 human review is pending/);
    }
  });
}

test("actual reporting population and serialized eligibility independently exclude retained controller examples", async () => {
  const example = {
    ...CURATED_OFFLINE_EXAMPLES[0]!.values, organizationId: "demo", id: 1,
    workerPhone: null, candidateEmailAuthorizedAt: null, candidateEmailAuthorizedBy: null,
  };
  const controller = { ...example, id: 2, syntheticProvenance: "demo-controller-fictional" };
  const controllerState = { ...example, id: 3, checklistProfileId: "demo-controller" };
  const originals = [example, controller, controllerState];
  assert.ok(isReportableFictionalOfflineExampleCase(example),
    "owned example fixture must satisfy the real inventory classifier");
  const query: any = {
    from: () => query, where: () => query,
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(originals).then(resolve),
  };
  const context = {
    module: { exports: undefined as any },
    db: { select: () => query }, onbCases: {}, and: () => true, inArray: () => true,
    preparationSource, isReportableFictionalOfflineExampleCase,
    isHistoricalTestRecord: isRestrictedHistoricalCase,
    // No UAT ledger ownership: the controller fence must work independently.
    actualRunOwnsCase: async () => false,
    getUatCaseIsolation: async () => ({ isolated: false }),
    isAuthoritativelyUatRunOwnedCase: async () => false,
  };
  const filterStart = source.indexOf("async function excludeUatAggregateCases");
  const filterEnd = source.indexOf("async function loadOutcomeKpis", filterStart);
  const filterCode = transformSync(`${source.slice(filterStart, filterEnd)}\nmodule.exports=excludeUatAggregateCases;`,
    { loader: "ts", format: "cjs" }).code;
  runInNewContext(filterCode, context);
  const filtered = await context.module.exports(originals);
  assert.deepEqual(filtered.map((row: any) => row.id), [1]);

  // Use the real serialization expression, not a duplicated test predicate.
  const expressionStart = source.indexOf("    reportingCaseEligible:");
  const expressionEnd = source.indexOf("    caseFamily:", expressionStart);
  const serializerCode = transformSync(`module.exports=async(row,presentation)=>({
    ${source.slice(expressionStart, expressionEnd)}
  });`, { loader: "ts", format: "cjs" }).code;
  runInNewContext(serializerCode, context);
  assert.equal((await context.module.exports(example)).reportingCaseEligible, true);
  assert.equal((await context.module.exports(controller)).reportingCaseEligible, false);
  assert.equal((await context.module.exports(controllerState)).reportingCaseEligible, false);
});
