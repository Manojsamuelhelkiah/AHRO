import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  onbAuthorityAssignments,
  onbAuthorityGovernance,
  onbSettings,
  onbSensitiveLifecycleDeletionJobs,
  onbSensitiveLifecycleHolds,
  onbSensitiveLifecyclePolicies,
  onbTransferConsultationMilestones,
  onbTransferCutoverPlans,
  onbTransferCutoverReconciliations,
  onbTransferCutoverSignoffs,
  onbTransferDataGovernance,
  onbTransferImportPreviews,
  onbTransferImports,
  onbTransferIntegrationActions,
  onbTransferKpiEvidence,
  onbTransferKpiDefinitions,
  onbTransferObjections,
  onbTransferOperationalSupersessions,
  onbTransferPathways,
  onbTransferPopulations,
  onbTransferPrograms,
  onbTransferWorkers,
  organizationMembershipsTable,
  organizationsTable,
} from "@workspace/db";
import { after, before, test } from "node:test";
import workforceTransfersRouter from "./onboarding-workforce-transfers";
import {
  processTransferRetentionDeletionJob,
  purgeExpiredTransferRetention,
} from "../lib/onboarding/workforce-transfer-retention";

const suffix = `${process.pid}-${randomUUID()}`;
const orgA = `transfer-a-${suffix}`;
const orgB = `transfer-b-${suffix}`;
const hrUser = `transfer-hr-${suffix}`;
const legalUser = `transfer-legal-${suffix}`;
const scopedLegalUser = `transfer-scoped-legal-${suffix}`;
const revokableLegalUser = `transfer-revokable-legal-${suffix}`;
const payrollUser = `transfer-payroll-${suffix}`;
const itUser = `transfer-it-${suffix}`;
const otherTenantUser = `transfer-other-tenant-${suffix}`;
let server: Server;
let baseUrl: string;

const sourceLegalEntity = "Source Ltd";
const destinationLegalEntity = "Destination Ltd";
const futureDay = "2031-01-01T00:00:00.000Z";
const historicalDate = "2020-01-02T00:00:00.000Z";
const historicalServiceDate = "2020-01-03T00:00:00.000Z";
const transferRetentionClasses = [
  "candidate-document", "identity", "medical", "payroll", "bgv",
  "candidate-contact", "candidate-voice", "candidate-portal",
] as const;

type Json = Record<string, unknown>;

const mapping = {
  sourceWorkerId: "source_id",
  workerName: "name",
  workEmail: "email",
  originalHireDate: "hire",
  continuousServiceDate: "service",
  termsReference: "terms",
  compensationReference: "compensation",
  benefitsReference: "benefits",
};

function row(sourceId: string, name = "Transfer Worker") {
  return {
    source_id: sourceId,
    name,
    email: `${sourceId}@example.test`,
    hire: historicalDate,
    service: historicalServiceDate,
    terms: `terms-${sourceId}`,
    compensation: `compensation-${sourceId}`,
    benefits: `benefits-${sourceId}`,
  };
}

async function call(
  path: string,
  actor: string,
  body?: Json,
  options: { organizationId?: string; method?: string } = {},
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers: {
      "content-type": "application/json",
      "x-organization-id": options.organizationId ?? orgA,
      "x-test-user": actor,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response;
}

async function json(response: Response): Promise<Json> {
  return response.clone().json() as Promise<Json>;
}

async function expectStatus(response: Response, expected: number) {
  if (response.status !== expected) {
    assert.equal(response.status, expected, await response.text());
  }
}

async function createProgram(
  actor = hrUser,
  proposedBasis: "automatic-transfer" | "share-purchase" | "asset-purchase" | "cross-border" = "automatic-transfer",
  countries = ["US"],
) {
  const response = await call("/onboarding/workforce-transfers/programs", actor, {
    name: `${proposedBasis} ${randomUUID()}`,
    sourceLegalEntity,
    destinationLegalEntity,
    countries,
    proposedBasis,
    legalDay1: futureDay,
    owners: {
      hrIntegration: hrUser,
      legal: legalUser,
      payroll: payrollUser,
      it: itUser,
    },
  });
  await expectStatus(response, 201);
  return json(response);
}

async function approvePathway(
  programId: string,
  actor: string,
  expectedVersion: number,
  jurisdiction: string,
  decision: "approved" | "rejected" = "approved",
) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/pathways`,
    actor,
    {
      expectedVersion,
      jurisdiction,
      reviewReference: `legal-review-${jurisdiction}-${randomUUID()}`,
      decision,
      offerRequirement: "not-required",
      bgvApplicability: "not-required",
    },
  );
  return { response, payload: await json(response) };
}

async function approveGovernance(
  programId: string,
  expectedVersion: number,
  jurisdiction = "US",
  retentionUntil = "2035-01-01T00:00:00.000Z",
) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/data-governance`,
    legalUser,
    {
      expectedVersion,
      jurisdiction,
      lawfulBasisReference: "lawful-basis:transfer-administration:v1",
      retentionReference: "retention-schedule:transfer:v1",
      retentionUntil,
    },
  );
  await expectStatus(response, 200);
  return json(response);
}

async function seedExpiredTransferRetentionPolicies(jurisdictions: string[]) {
  await db.insert(onbSensitiveLifecyclePolicies).values(
    jurisdictions.flatMap((jurisdiction) => transferRetentionClasses.map((dataClass) => ({
      organizationId: orgA,
      dataClass,
      jurisdiction,
      revision: 1,
      purpose: "transfer retention integration test",
      lawfulBasis: "approved test basis",
      retentionDays: 30,
      providerSharingApproved: false,
      permittedProviders: [],
      policyReference: `transfer-retention:${jurisdiction}:${dataClass}`,
      approvalReference: `transfer-retention-approval:${jurisdiction}:${dataClass}`,
      approvedByUserId: legalUser,
      approvedAuthorityAssignmentId: 1,
      isCurrent: true,
    }))),
  );
}

async function createImportedPopulation(
  programId: string,
  expectedProgramVersion: number,
  sourceIds = ["source-1"],
  expectedHeadcount = sourceIds.length,
  country = "US",
) {
  const populationResponse = await call(
    `/onboarding/workforce-transfers/programs/${programId}/populations`,
    hrUser,
    { country, expectedHeadcount },
  );
  await expectStatus(populationResponse, 201);
  const population = await json(populationResponse);

  const previewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser,
    { mapping, rows: sourceIds.map((sourceId) => row(sourceId)) },
  );
  await expectStatus(previewResponse, 201);
  const preview = await json(previewResponse);
  const commitResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports`,
    hrUser,
    {
      previewId: preview.previewId,
      idempotencyKey: `import-${randomUUID()}`,
      expectedPopulationVersion: 1,
    },
  );
  await expectStatus(commitResponse, 201);
  const imported = await json(commitResponse);
  assert.equal(imported.importedCount, sourceIds.length);
  assert.equal(expectedProgramVersion > 0, true);
  return {
    populationId: String(population.id),
    workerIds: (imported.workers as Array<{ id: string }>).map((worker) => worker.id),
    programVersionAfterImport: expectedProgramVersion,
  };
}

async function createReadyPlan(
  programId: string,
  expectedProgramVersion: number,
  workerCount: number,
) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/cutover-plans`,
    hrUser,
    { expectedVersion: expectedProgramVersion, contingencyReference: "contingency:parallel-run:v1" },
  );
  await expectStatus(response, 201);
  const plan = await json(response);
  assert.equal(plan.workerCount, workerCount);
  return { planId: String(plan.planId), version: Number(plan.version) };
}

async function recordReconciliation(
  planId: string,
  planVersion: number,
  workerId: string,
  stream: "migration" | "payroll" | "benefits" | "access" | "first-pay",
  status: "pending" | "ready" | "complete" | "exception" | "unknown-effect-manual-repair",
  actor: string,
) {
  const [worker] = stream === "migration" && status === "complete"
    ? await db.select({ sourcePayload: onbTransferWorkers.sourcePayload }).from(onbTransferWorkers).where(and(eq(onbTransferWorkers.organizationId, orgA), eq(onbTransferWorkers.id, workerId)))
    : [];
  const response = await call(
    `/onboarding/workforce-transfers/cutover-plans/${planId}/workers/${workerId}/reconciliation`,
    actor,
    {
      expectedPlanVersion: planVersion,
      stream,
      status,
      evidenceReference: `evidence:${stream}:${status}:${randomUUID()}`,
      ...(stream === "migration" && status === "complete" ? {
        sourceAttestationReference: `source-attestation:${workerId}`,
        destinationAttestationReference: `destination-attestation:${workerId}`,
        destinationOriginalHireDate: historicalDate,
        destinationContinuousServiceDate: historicalServiceDate,
        destinationTermsReference: worker!.sourcePayload.termsReference,
        destinationBenefitsReference: worker!.sourcePayload.benefitsReference,
      } : {}),
    },
  );
  await expectStatus(response, 200);
  return json(response);
}

async function recordSignoff(
  planId: string,
  planVersion: number,
  role: "hr-integration" | "payroll" | "it",
  actor: string,
  decision: "approved" | "blocked" = "approved",
) {
  const response = await call(
    `/onboarding/workforce-transfers/cutover-plans/${planId}/signoffs`,
    actor,
    {
      expectedPlanVersion: planVersion,
      role,
      decision,
      reasonReference: `signoff:${role}:${randomUUID()}`,
    },
  );
  await expectStatus(response, 200);
  return json(response);
}

async function programSummary(programId: string, actor = hrUser) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}`,
    actor,
  );
  await expectStatus(response, 200);
  return json(response);
}

type KpiMetric =
  | "service-date-accurate"
  | "consultation-timely"
  | "access-timely"
  | "first-pay-accurate"
  | "actual-attrition"
  | "harmonisation-complete";

async function recordKpiDefinition(programId: string, metric: KpiMetric, suffixText: string) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/kpi-definitions`,
    hrUser,
    {
      metric,
      definitionReference: `definition:${metric}:${suffixText}`,
      denominatorReference: `denominator:${metric}:${suffixText}`,
    },
  );
  await expectStatus(response, 201);
  return json(response);
}

async function recordContingencyAction(
  programId: string,
  expectedVersion: number,
  status: "planned" | "completed",
  actionId?: string,
) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/integration-actions`,
    hrUser,
    {
      expectedVersion,
      ...(actionId ? { actionId } : {}),
      kind: "contingency-parallel-run",
      ownerUserId: hrUser,
      dueAt: futureDay,
      status,
      ...(status === "completed" ? {
        completedAt: "2020-01-05T00:00:00.000Z",
        evidenceReference: `contingency:evidence:${randomUUID()}`,
      } : {}),
    },
  );
  await expectStatus(response, 201);
  return json(response);
}

async function recordKpiEvidence(
  programId: string,
  actor: string,
  body: Json,
) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/kpi-evidence`,
    actor,
    body,
  );
  return { response, payload: await json(response) };
}

async function readKpis(programId: string) {
  const response = await call(
    `/onboarding/workforce-transfers/programs/${programId}/kpis`,
    hrUser,
  );
  await expectStatus(response, 200);
  return json(response);
}

async function createCutoverFixture(
  basis: "automatic-transfer" | "share-purchase" | "asset-purchase" | "cross-border" = "automatic-transfer",
  retentionUntil = "2035-01-01T00:00:00.000Z",
) {
  const program = await createProgram(hrUser, basis, ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(
    String(program.id),
    Number(pathway.payload.version),
    "US",
    retentionUntil,
  );
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governance.version),
    [`cutover-${randomUUID()}`],
  );
  const consultationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(governance.version) + 1,
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      completedAt: "2020-01-04T00:00:00.000Z",
      status: "completed",
      evidenceReference: `consultation:completed:${randomUUID()}`,
    },
  );
  await expectStatus(consultationResponse, 201);
  const consultation = await json(consultationResponse);
  const action = await recordContingencyAction(
    String(program.id),
    Number(consultation.version),
    "completed",
  );
  const plan = await createReadyPlan(
    String(program.id),
    Number(action.version),
    imported.workerIds.length,
  );
  return { program, pathway, governance, imported, consultation, action, plan };
}

before(async () => {
  await db.insert(organizationsTable).values([
    {
      id: orgA,
      name: "Workforce Transfer Test A",
      slug: orgA,
      joinCodeHash: `hash-${orgA}`,
      createdByUserId: hrUser,
    },
    {
      id: orgB,
      name: "Workforce Transfer Test B",
      slug: orgB,
      joinCodeHash: `hash-${orgB}`,
      createdByUserId: otherTenantUser,
    },
  ]);
  await db.insert(organizationMembershipsTable).values(([
    hrUser,
    legalUser,
    scopedLegalUser,
    revokableLegalUser,
    payrollUser,
    itUser,
  ].map((clerkUserId) => ({
    organizationId: orgA,
    clerkUserId,
    role: "member" as const,
   })) as Array<{ organizationId: string; clerkUserId: string; role: "member" | "owner" }>).concat({
    organizationId: orgB,
    clerkUserId: otherTenantUser,
    role: "owner" as const,
  }));
  await db.insert(onbAuthorityGovernance).values([
    orgA,
    orgB,
  ].map((organizationId) => ({
    organizationId,
    status: "governance-approved" as const,
    approvedByUserId: "transfer-governance",
    approvedAt: new Date(),
    governanceSource: "isolated-workforce-transfer-test",
  })));
  const assignment = (
    id: string,
    personUserId: string,
    authorityRole: "hr-compliance" | "legal" | "payroll" | "it-security",
    scope: "hr-compliance-approve" | "legal-approve" | "payroll-approve" | "it-security-approve",
    extra: { jurisdictionScope?: string } = {},
  ) => ({
    id,
    organizationId: orgA,
    personUserId,
    authorityRole,
    scopes: [scope],
    validFrom: new Date(Date.now() - 60_000),
    grantorUserId: "transfer-governance",
    source: "isolated-workforce-transfer-test",
    governanceDecisionRef: "transfer-governance-approved",
    ...extra,
  });
  await db.insert(onbAuthorityAssignments).values([
    assignment(`transfer-hr-authority-${suffix}`, hrUser, "hr-compliance", "hr-compliance-approve"),
    assignment(`transfer-legal-authority-${suffix}`, legalUser, "legal", "legal-approve"),
    // This assignment is deliberately scoped to an entity rather than a
    // country. A DE pathway must not be accepted by it.
    assignment(`transfer-scoped-legal-authority-${suffix}`, scopedLegalUser, "legal", "legal-approve", {
      jurisdictionScope: sourceLegalEntity,
    }),
    assignment(`transfer-revokable-legal-authority-${suffix}`, revokableLegalUser, "legal", "legal-approve"),
    assignment(`transfer-payroll-authority-${suffix}`, payrollUser, "payroll", "payroll-approve"),
    assignment(`transfer-it-authority-${suffix}`, itUser, "it-security", "it-security-approve"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.organizationId = String(req.header("x-organization-id") ?? orgA);
    req.authUserId = String(req.header("x-test-user") ?? hrUser);
    next();
  });
  app.use(workforceTransfersRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  const organizations = [orgA, orgB];
  await db.delete(onbTransferKpiEvidence).where(inArray(onbTransferKpiEvidence.organizationId, organizations));
  await db.delete(onbTransferCutoverReconciliations).where(inArray(onbTransferCutoverReconciliations.organizationId, organizations));
  await db.delete(onbTransferCutoverSignoffs).where(inArray(onbTransferCutoverSignoffs.organizationId, organizations));
  await db.delete(onbTransferCutoverPlans).where(inArray(onbTransferCutoverPlans.organizationId, organizations));
  await db.delete(onbTransferObjections).where(inArray(onbTransferObjections.organizationId, organizations));
  await db.delete(onbTransferWorkers).where(inArray(onbTransferWorkers.organizationId, organizations));
  await db.delete(onbTransferImports).where(inArray(onbTransferImports.organizationId, organizations));
  await db.delete(onbTransferImportPreviews).where(inArray(onbTransferImportPreviews.organizationId, organizations));
  await db.delete(onbTransferIntegrationActions).where(inArray(onbTransferIntegrationActions.organizationId, organizations));
  await db.delete(onbTransferOperationalSupersessions).where(inArray(onbTransferOperationalSupersessions.organizationId, organizations));
  await db.delete(onbTransferConsultationMilestones).where(inArray(onbTransferConsultationMilestones.organizationId, organizations));
  await db.delete(onbTransferDataGovernance).where(inArray(onbTransferDataGovernance.organizationId, organizations));
  await db.delete(onbTransferPathways).where(inArray(onbTransferPathways.organizationId, organizations));
  await db.delete(onbTransferPopulations).where(inArray(onbTransferPopulations.organizationId, organizations));
  await db.delete(onbTransferPrograms).where(inArray(onbTransferPrograms.organizationId, organizations));
  await db.delete(onbSensitiveLifecycleDeletionJobs).where(inArray(onbSensitiveLifecycleDeletionJobs.organizationId, organizations));
  await db.delete(onbSensitiveLifecycleHolds).where(inArray(onbSensitiveLifecycleHolds.organizationId, organizations));
  await db.delete(onbSensitiveLifecyclePolicies).where(inArray(onbSensitiveLifecyclePolicies.organizationId, organizations));
  await db.delete(onbAuthorityAssignments).where(inArray(onbAuthorityAssignments.organizationId, organizations));
  await db.delete(onbAuthorityGovernance).where(inArray(onbAuthorityGovernance.organizationId, organizations));
  await db.delete(organizationMembershipsTable).where(inArray(organizationMembershipsTable.organizationId, organizations));
  // The running watcher can seed settings for these isolated test tenants.
  await db.delete(onbSettings).where(inArray(onbSettings.organizationId, organizations));
  await deleteTestOrganizations(inArray(organizationsTable.id, organizations));
});

test("database custody makes imported source facts immutable and binds reconciliation evidence", async () => {
  const program = await createProgram();
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governed = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governed.version),
    ["immutable-source-worker"],
  );
  const workerId = imported.workerIds[0]!;
  const [worker] = await db.select({
    sourcePayload: onbTransferWorkers.sourcePayload,
    sourceFingerprint: onbTransferWorkers.sourceFingerprint,
  }).from(onbTransferWorkers).where(and(
    eq(onbTransferWorkers.organizationId, orgA),
    eq(onbTransferWorkers.id, workerId),
  ));
  assert.match(worker!.sourceFingerprint, /^[a-f0-9]{64}$/);
  const isCustodyError = (error: unknown) => {
    if (!(error instanceof Error)) return false;
    const cause = (error as Error & { cause?: unknown }).cause;
    return /immutable custody evidence/i.test(error.message) ||
      (cause instanceof Error && /immutable custody evidence/i.test(cause.message));
  };
  await assert.rejects(
    db.update(onbTransferWorkers).set({ sourcePayload: { ...worker!.sourcePayload, workerName: "Mutated" } })
      .where(and(eq(onbTransferWorkers.organizationId, orgA), eq(onbTransferWorkers.id, workerId))),
    isCustodyError,
  );
  await assert.rejects(
    db.update(onbTransferWorkers).set({ originalHireDate: new Date("2021-01-02T00:00:00.000Z") })
      .where(and(eq(onbTransferWorkers.organizationId, orgA), eq(onbTransferWorkers.id, workerId))),
    isCustodyError,
  );
  const plan = await createReadyPlan(String(program.id), Number(governed.version) + 1, 1);
  await recordReconciliation(plan.planId, plan.version, workerId, "migration", "complete", hrUser);
  const [reconciliation] = await db.select({
    sourceFingerprint: onbTransferCutoverReconciliations.sourceFingerprint,
  }).from(onbTransferCutoverReconciliations).where(and(
    eq(onbTransferCutoverReconciliations.organizationId, orgA),
    eq(onbTransferCutoverReconciliations.planId, plan.planId),
    eq(onbTransferCutoverReconciliations.workerId, workerId),
  ));
  assert.equal(reconciliation!.sourceFingerprint, worker!.sourceFingerprint);
});

test("retention preserves another country while scrubbing due-country plans, cohorts, evidence, and holds", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US", "CA"]);
  const programId = String(program.id);
  const usPopulation = `retention-us-${randomUUID()}`;
  const caPopulation = `retention-ca-${randomUUID()}`;
  const usWorker = `retention-us-worker-${randomUUID()}`;
  const caWorker = `retention-ca-worker-${randomUUID()}`;
  const usMilestone = 800_000 + Math.floor(Math.random() * 10_000);
  const caMilestone = usMilestone + 1;
  const planId = `retention-plan-${randomUUID()}`;
  const old = new Date("2020-01-01T00:00:00.000Z");
  await seedExpiredTransferRetentionPolicies(["US", "CA"]);
  await db.insert(onbTransferDataGovernance).values(["US", "CA"].map((jurisdiction) => ({
    organizationId: orgA, programId, jurisdiction, lawfulBasisReference: "basis", retentionReference: "retention", retentionUntil: old,
    authorityAssignmentId: "authority", authorityAssignmentRevision: 1, approvedByUserId: legalUser, approvedAt: old,
  })));
  await db.insert(onbTransferPopulations).values([
    { id: usPopulation, organizationId: orgA, programId, country: "US", sourceLegalEntity, destinationLegalEntity, expectedHeadcount: 1 },
    { id: caPopulation, organizationId: orgA, programId, country: "CA", sourceLegalEntity, destinationLegalEntity, expectedHeadcount: 1 },
  ]);
  for (const [populationId, workerId] of [[usPopulation, usWorker], [caPopulation, caWorker]] as const) {
    const previewId = `retention-preview-${randomUUID()}`, importId = `retention-import-${randomUUID()}`;
    await db.insert(onbTransferImportPreviews).values({ id: previewId, organizationId: orgA, populationId, mapping, normalizedRows: [], fingerprint: previewId, validCount: 1, invalidCount: 0, createdByUserId: hrUser });
    await db.insert(onbTransferImports).values({ id: importId, organizationId: orgA, populationId, previewId, idempotencyKey: importId, fingerprint: importId, importedCount: 1, createdByUserId: hrUser });
    await db.insert(onbTransferWorkers).values({ id: workerId, organizationId: orgA, populationId, importId, stableSourceId: workerId, sourcePayload: { workerName: workerId }, originalHireDate: old, continuousServiceDate: old });
  }
  await db.insert(onbTransferConsultationMilestones).values([
    { id: usMilestone, organizationId: orgA, programId, jurisdiction: "US", kind: "notice", dueAt: old, status: "completed", privateEvidenceReference: "us", authorityAssignmentId: "authority", authorityAssignmentRevision: 1, recordedByUserId: legalUser },
    { id: caMilestone, organizationId: orgA, programId, jurisdiction: "CA", kind: "notice", dueAt: old, status: "completed", privateEvidenceReference: "ca", authorityAssignmentId: "authority", authorityAssignmentRevision: 1, recordedByUserId: legalUser },
  ]);
  await db.insert(onbTransferCutoverPlans).values({ id: planId, organizationId: orgA, programId, version: 1, readinessGeneration: 1, workerCount: 2, workerSnapshot: [{ workerId: usWorker, populationId: usPopulation, stableSourceId: usWorker, workerVersion: 1 }, { workerId: caWorker, populationId: caPopulation, stableSourceId: caWorker, workerVersion: 1 }], pathwaySnapshot: [{ jurisdiction: "US" }, { jurisdiction: "CA" }] as any, createdByUserId: hrUser });
  await db.insert(onbTransferCutoverSignoffs).values({ organizationId: orgA, planId, role: "hr-integration", decision: "approved", readinessGeneration: 1, reasonReference: "recent", authorityScope: "hr-compliance-approve", authorityAssignmentId: "authority", authorityAssignmentRevision: 1, signedByUserId: hrUser });
  await db.insert(onbTransferKpiDefinitions).values([
    { organizationId: orgA, programId, metric: "consultation-timely", revision: 1, definitionReference: "us", denominatorReference: "us", cohortSnapshot: [String(usMilestone)], authorityAssignmentId: "authority", authorityAssignmentRevision: 1, approvedByUserId: legalUser },
    { organizationId: orgA, programId, metric: "access-timely", revision: 1, definitionReference: "ca", denominatorReference: "ca", cohortSnapshot: [caWorker], authorityAssignmentId: "authority", authorityAssignmentRevision: 1, approvedByUserId: legalUser },
  ]);
  await db.insert(onbTransferKpiEvidence).values([
    { organizationId: orgA, programId, workerId: null, metric: "consultation-timely", definitionRevision: 1, sourceRecordId: String(usMilestone), value: true, occurredAt: new Date(), measurement: {}, sourceAttestationReference: "us", evidenceReference: "us", authorityAssignmentId: "authority", authorityAssignmentRevision: 1, recordedByUserId: legalUser },
    { organizationId: orgA, programId, workerId: caWorker, metric: "access-timely", definitionRevision: 1, sourceRecordId: caWorker, value: true, occurredAt: new Date(), measurement: {}, sourceAttestationReference: "ca", evidenceReference: "ca", authorityAssignmentId: "authority", authorityAssignmentRevision: 1, recordedByUserId: legalUser },
  ]);
  // Every other representation is historical. The only fresh custody facts
  // are the signoff and KPI definitions, proving both participate in the
  // retention watermark rather than merely sharing a convenient future date.
  await Promise.all([
    db.update(onbTransferPrograms).set({ updatedAt: old }).where(eq(onbTransferPrograms.id, programId)),
    db.update(onbTransferPopulations).set({ createdAt: old }).where(eq(onbTransferPopulations.programId, programId)),
    db.update(onbTransferImportPreviews).set({ createdAt: old }).where(eq(onbTransferImportPreviews.organizationId, orgA)),
    db.update(onbTransferImports).set({ createdAt: old }).where(eq(onbTransferImports.organizationId, orgA)),
    db.update(onbTransferWorkers).set({ createdAt: old }).where(inArray(onbTransferWorkers.id, [usWorker, caWorker])),
    db.update(onbTransferConsultationMilestones).set({ createdAt: old }).where(eq(onbTransferConsultationMilestones.programId, programId)),
    db.update(onbTransferCutoverPlans).set({ createdAt: old }).where(eq(onbTransferCutoverPlans.id, planId)),
    db.update(onbTransferKpiEvidence).set({ createdAt: old }).where(eq(onbTransferKpiEvidence.programId, programId)),
  ]);
  assert.equal((await purgeExpiredTransferRetention(orgA, new Date(Date.now() + 24 * 60 * 60_000))).scheduled, 0);
  const dueAt = new Date(Date.now() + 40 * 24 * 60 * 60_000);
  assert.equal((await purgeExpiredTransferRetention(orgA, dueAt)).scheduled, 2);
  const usRecordId = `transfer-jurisdiction:${encodeURIComponent(programId)}:US`;
  const [usJob] = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.recordId, usRecordId));
  assert.deepEqual(await processTransferRetentionDeletionJob(usJob!, dueAt), { state: "complete" });
  const [plan] = await db.select().from(onbTransferCutoverPlans).where(eq(onbTransferCutoverPlans.id, planId));
  assert.deepEqual(plan!.workerSnapshot.map((worker) => worker.workerId), [caWorker]);
  assert.deepEqual(plan!.pathwaySnapshot.map((pathway) => pathway.jurisdiction), ["CA"]);
  assert.equal((await db.select().from(onbTransferKpiEvidence).where(eq(onbTransferKpiEvidence.programId, programId))).length, 1);
  assert.equal((await db.select().from(onbTransferKpiDefinitions).where(eq(onbTransferKpiDefinitions.programId, programId))).length, 1);
  assert.equal((await db.select().from(onbTransferPopulations).where(eq(onbTransferPopulations.id, caPopulation))).length, 1);
  const caRecordId = `transfer-jurisdiction:${encodeURIComponent(programId)}:CA`;
  const [caJob] = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.recordId, caRecordId));
  assert.deepEqual(await processTransferRetentionDeletionJob(caJob!, dueAt), { state: "complete" }, "the sibling job remains valid without a time jump");
  assert.equal((await db.select().from(onbTransferPrograms).where(eq(onbTransferPrograms.id, programId))).length, 0);

  const heldProgram = await createProgram();
  const heldProgramId = String(heldProgram.id);
  await db.insert(onbTransferDataGovernance).values({
    organizationId: orgA, programId: heldProgramId, jurisdiction: "US", lawfulBasisReference: "basis", retentionReference: "retention", retentionUntil: old,
    authorityAssignmentId: "authority", authorityAssignmentRevision: 1, approvedByUserId: legalUser, approvedAt: old,
  });
  const heldAt = new Date(Date.now() + 80 * 24 * 60 * 60_000);
  assert.equal((await purgeExpiredTransferRetention(orgA, heldAt)).scheduled, 1);
  await db.insert(onbSensitiveLifecycleHolds).values({ organizationId: orgA, dataClass: "candidate-document", reason: "hold", reference: "hold", active: true, setByUserId: legalUser, setAuthorityAssignmentId: 1 });
  const heldRecordId = `transfer-jurisdiction:${encodeURIComponent(heldProgramId)}:US`;
  const [heldJob] = await db.select().from(onbSensitiveLifecycleDeletionJobs).where(eq(onbSensitiveLifecycleDeletionJobs.recordId, heldRecordId));
  assert.equal((await processTransferRetentionDeletionJob(heldJob!, heldAt)).state, "blocked");
  assert.equal((await db.select().from(onbTransferPrograms).where(eq(onbTransferPrograms.id, heldProgramId))).length, 1);
});

test("records all four transfer bases and rejects tenant and jurisdiction authority misuse", async () => {
  const bases = [
    "automatic-transfer",
    "share-purchase",
    "asset-purchase",
    "cross-border",
  ] as const;
  const programs = await Promise.all(bases.map((basis) =>
    createProgram(hrUser, basis, ["US", "DE"])));
  assert.deepEqual(programs.map((program) => program.proposedBasis), [...bases]);

  const mixed = programs[0]!;
  const tenantDenied = await call(
    `/onboarding/workforce-transfers/programs/${mixed.id}/populations`,
    otherTenantUser,
    { country: "US", expectedHeadcount: 1 },
    { organizationId: orgA },
  );
  assert.equal(tenantDenied.status, 403);
  assert.match((await json(tenantDenied)).message as string, /membership|authority/i);

  const jurisdictionDenied = await call(
    `/onboarding/workforce-transfers/programs/${mixed.id}/pathways`,
    scopedLegalUser,
    {
      expectedVersion: 1,
      jurisdiction: "DE",
      reviewReference: "scoped-entity-review",
      decision: "approved",
      offerRequirement: "not-required",
      bgvApplicability: "not-required",
    },
  );
  assert.equal(jurisdictionDenied.status, 403);

  const us = await approvePathway(String(mixed.id), legalUser, 1, "US");
  await expectStatus(us.response, 200);
  const de = await approvePathway(String(mixed.id), legalUser, Number(us.payload.version), "DE");
  await expectStatus(de.response, 200);
  const usGovernance = await approveGovernance(String(mixed.id), Number(de.payload.version), "US");
  const deGovernance = await approveGovernance(String(mixed.id), Number(usGovernance.version), "DE");
  assert.equal(deGovernance.version, Number(usGovernance.version) + 1);
  const summary = await programSummary(String(mixed.id));
  assert.deepEqual(summary.countries, ["US", "DE"]);
  assert.equal((summary.pathways as Array<Json>).length, 2);
  assert.equal(JSON.stringify(summary).includes("sourcePayload"), false);
});

test("a mixed-country cutover is blocked when DE consultation is missing", async () => {
  const program = await createProgram(hrUser, "cross-border", ["US", "DE"]);
  const usPathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const dePathway = await approvePathway(String(program.id), legalUser, Number(usPathway.payload.version), "DE");
  const usGovernance = await approveGovernance(String(program.id), Number(dePathway.payload.version), "US");
  const deGovernance = await approveGovernance(String(program.id), Number(usGovernance.version), "DE");

  const consultationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(deGovernance.version),
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      completedAt: "2030-01-03T00:00:00.000Z",
      status: "completed",
      evidenceReference: "consultation:US-only",
    },
  );
  await expectStatus(consultationResponse, 201);
  const consultation = await json(consultationResponse);
  const action = await recordContingencyAction(
    String(program.id),
    Number(consultation.version),
    "completed",
  );
  const plan = await createReadyPlan(String(program.id), Number(action.version), 0);

  let planVersion = plan.version;
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "hr-integration", hrUser)).version);
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "payroll", payrollUser)).version);
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "it", itUser)).version);

  const blockedGo = await call(
    `/onboarding/workforce-transfers/cutover-plans/${plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: planVersion, decision: "go" },
  );
  assert.equal(blockedGo.status, 409);
  const message = (await json(blockedGo)).message as string;
  assert.match(message, /consultation/i);
  assert.match(message, /DE|country|jurisdiction/i);
});

test("consultation milestones and contingency actions supersede planned records by stable id", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const plannedMilestoneResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(governance.version),
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      status: "planned",
      evidenceReference: "consultation:planned",
    },
  );
  await expectStatus(plannedMilestoneResponse, 201);
  const plannedMilestone = await json(plannedMilestoneResponse);
  const completedMilestoneResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(plannedMilestone.version),
      milestoneId: plannedMilestone.milestoneId,
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      completedAt: "2030-01-03T00:00:00.000Z",
      status: "completed",
      evidenceReference: "consultation:completed",
    },
  );
  await expectStatus(completedMilestoneResponse, 201);
  const completedMilestone = await json(completedMilestoneResponse);
  assert.equal(completedMilestone.milestoneId, plannedMilestone.milestoneId);

  const plannedAction = await recordContingencyAction(
    String(program.id),
    Number(completedMilestone.version),
    "planned",
  );
  const completedAction = await recordContingencyAction(
    String(program.id),
    Number(plannedAction.version),
    "completed",
    String(plannedAction.actionId),
  );
  assert.equal(completedAction.actionId, plannedAction.actionId);

  const summary = await programSummary(String(program.id));
  const summaryJson = JSON.stringify(summary);
  assert.equal(summaryJson.includes("consultation:planned"), false);
  assert.equal(summaryJson.includes("contingency:evidence"), false);
  const summaryMilestones = summary.consultation as Array<Json>;
  assert.equal(summaryMilestones.find((item) => item.id === plannedMilestone.milestoneId)?.status, "completed");
  const summaryActions = summary.integrationActions as Array<Json>;
  assert.equal(summaryActions.find((item) => item.id === plannedAction.actionId)?.status, "completed");
  assert.equal(summaryActions.find((item) => item.id === plannedAction.actionId)?.evidenceRecorded, true);

  const supersessions = await db.select({
    recordKind: onbTransferOperationalSupersessions.recordKind,
    recordId: onbTransferOperationalSupersessions.recordId,
    priorStatus: onbTransferOperationalSupersessions.priorStatus,
  }).from(onbTransferOperationalSupersessions).where(and(
    eq(onbTransferOperationalSupersessions.organizationId, orgA),
    eq(onbTransferOperationalSupersessions.programId, String(program.id)),
  ));
  assert.deepEqual(
    supersessions.map((item) => [item.recordKind, item.recordId, item.priorStatus]),
    [
      ["consultation-milestone", String(plannedMilestone.milestoneId), "planned"],
      ["integration-action", String(plannedAction.actionId), "planned"],
    ],
  );
});

test("pre-approval payload cannot be previewed or retained, then lawful retention permits import", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const populationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/populations`,
    hrUser,
    { country: "US", expectedHeadcount: 1 },
  );
  await expectStatus(populationResponse, 201);
  const population = await json(populationResponse);
  const previewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser,
    { mapping, rows: [row("preapproval-worker")] },
  );
  assert.equal(previewResponse.status, 409);
  assert.match((await json(previewResponse)).message as string, /approved.*pathway|lawful basis/i);
  assert.equal(
    (await db.select({ count: onbTransferWorkers.id }).from(onbTransferWorkers)
       .where(and(eq(onbTransferWorkers.organizationId, orgA), eq(onbTransferWorkers.populationId, String(population.id))))).length,
    0,
  );

  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version) + 1, "US");
  await expectStatus(pathway.response, 200);
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const approvedPreviewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser,
    { mapping, rows: [row("preapproval-worker")] },
  );
  await expectStatus(approvedPreviewResponse, 201);
  const preview = await json(approvedPreviewResponse);
  const committed = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports`,
    hrUser,
    {
      previewId: preview.previewId,
      idempotencyKey: `approved-${randomUUID()}`,
      expectedPopulationVersion: 1,
    },
  );
  await expectStatus(committed, 201);
  const committedPayload = await json(committed);
  assert.equal(committedPayload.importedCount, 1);
  assert.equal(governance.version, Number(pathway.payload.version) + 1);

  const [retention] = await db.select({
    lawfulBasisReference: onbTransferDataGovernance.lawfulBasisReference,
    retentionUntil: onbTransferDataGovernance.retentionUntil,
  }).from(onbTransferDataGovernance).where(and(
    eq(onbTransferDataGovernance.organizationId, orgA),
    eq(onbTransferDataGovernance.programId, program.id as string),
  ));
  assert.equal(retention?.lawfulBasisReference, "lawful-basis:transfer-administration:v1");
  assert.equal(retention?.retentionUntil.toISOString(), "2035-01-01T00:00:00.000Z");
});

test("KPI evidence derives false for unequal first pay and late access, and revisions invalidate old evidence", async () => {
  const program = await createProgram(hrUser, "cross-border", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governance.version),
    ["kpi-worker"],
  );
  const workerId = imported.workerIds[0]!;

  await recordKpiDefinition(String(program.id), "first-pay-accurate", "v1");
  const firstPay = await recordKpiEvidence(String(program.id), payrollUser, {
    metric: "first-pay-accurate",
    workerId,
    sourceRecordId: workerId,
    value: true,
    occurredAt: "2020-01-05T00:00:00.000Z",
    sourceAttestationReference: "payroll-source:kpi-worker:v1",
    evidenceReference: "payroll-evidence:kpi-worker:v1",
    measurement: {
      expectedAmount: 100,
      actualAmount: 90,
       expectedCurrency: "USD",
       actualCurrency: "USD",
      paidAt: "2020-01-05T00:00:00.000Z",
    },
  });
   await expectStatus(firstPay.response, 201);
   const firstPayPayload = firstPay.payload;
   const [storedFirstPay] = await db.select({ value: onbTransferKpiEvidence.value })
     .from(onbTransferKpiEvidence)
     .where(and(
       eq(onbTransferKpiEvidence.organizationId, orgA),
       eq(onbTransferKpiEvidence.id, Number(firstPayPayload.evidenceId)),
     ));
   assert.equal(storedFirstPay?.value, false, "unequal first-pay amounts cannot produce true evidence");

  await recordKpiDefinition(String(program.id), "access-timely", "v1");
  const lateAccess = await recordKpiEvidence(String(program.id), itUser, {
    metric: "access-timely",
    workerId,
    sourceRecordId: workerId,
    value: true,
    occurredAt: "2020-01-06T00:00:00.000Z",
    sourceAttestationReference: "access-source:kpi-worker:v1",
    evidenceReference: "access-evidence:kpi-worker:v1",
    measurement: {
      requiredBy: "2020-01-05T00:00:00.000Z",
      accessGrantedAt: "2020-01-06T00:00:00.000Z",
    },
  });
   await expectStatus(lateAccess.response, 201);
   const lateAccessPayload = lateAccess.payload;
   const [storedLateAccess] = await db.select({ value: onbTransferKpiEvidence.value })
     .from(onbTransferKpiEvidence)
     .where(and(
       eq(onbTransferKpiEvidence.organizationId, orgA),
       eq(onbTransferKpiEvidence.id, Number(lateAccessPayload.evidenceId)),
     ));
   assert.equal(storedLateAccess?.value, false, "late access cannot produce true evidence");

  const consultationMilestone = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    { expectedVersion: Number(governance.version) + 1, jurisdiction: "US", kind: "kpi-consultation", dueAt: "2020-01-08T00:00:00.000Z", completedAt: "2020-01-07T00:00:00.000Z", status: "completed", evidenceReference: "consultation:kpi-worker:v1" },
  );
  await expectStatus(consultationMilestone, 201);
  const consultationMilestonePayload = await json(consultationMilestone);
  await recordKpiDefinition(String(program.id), "consultation-timely", "v1");
  const consultationEvidence = await recordKpiEvidence(String(program.id), legalUser, {
    metric: "consultation-timely",
    sourceRecordId: String(consultationMilestonePayload.milestoneId),
    value: true,
    occurredAt: "2020-01-07T00:00:00.000Z",
    sourceAttestationReference: "consultation-source:kpi-worker:v1",
    evidenceReference: "consultation-evidence:kpi-worker:v1",
    measurement: {
      dueAt: "2020-01-08T00:00:00.000Z",
      completedAt: "2020-01-07T00:00:00.000Z",
    },
  });
  await expectStatus(consultationEvidence.response, 201);
  const beforeRevision = await readKpis(String(program.id));
  const consultationBefore = (beforeRevision.metrics as Array<Json>)
    .find((metric) => metric.id === "consultation-timely");
  assert.equal(consultationBefore?.status, "measured");
  assert.equal(consultationBefore?.value, 100);

  await recordKpiDefinition(String(program.id), "consultation-timely", "v2");
  const afterRevision = await readKpis(String(program.id));
  const consultationAfter = (afterRevision.metrics as Array<Json>)
    .find((metric) => metric.id === "consultation-timely");
  assert.equal(consultationAfter?.status, "not-collected");
  assert.equal(consultationAfter?.value, null);
});

test("consultation KPI binds persisted dates so a late milestone cannot fabricate a timely result", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const milestoneResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(governance.version),
      jurisdiction: "US",
      kind: "late-consultation",
      dueAt: "2020-01-08T00:00:00.000Z",
      completedAt: "2020-01-09T00:00:00.000Z",
      status: "completed",
      evidenceReference: `consultation:late:${randomUUID()}`,
    },
  );
  await expectStatus(milestoneResponse, 201);
  const milestone = await json(milestoneResponse);
  await recordKpiDefinition(String(program.id), "consultation-timely", "persisted-facts");

  const fabricated = await recordKpiEvidence(String(program.id), legalUser, {
    metric: "consultation-timely",
    sourceRecordId: String(milestone.milestoneId),
    occurredAt: "2020-01-09T00:00:00.000Z",
    sourceAttestationReference: "consultation-source:late",
    evidenceReference: "consultation-evidence:late",
    measurement: {
      completedAt: "2020-01-07T00:00:00.000Z",
      dueAt: "2020-01-08T00:00:00.000Z",
    },
  });
  assert.equal(fabricated.response.status, 409);
  assert.match(fabricated.payload.message as string, /persisted|milestone|date/i);

  const bound = await recordKpiEvidence(String(program.id), legalUser, {
    metric: "consultation-timely",
    sourceRecordId: String(milestone.milestoneId),
    occurredAt: "2020-01-09T00:00:00.000Z",
    sourceAttestationReference: "consultation-source:late-bound",
    evidenceReference: "consultation-evidence:late-bound",
    measurement: {},
  });
  await expectStatus(bound.response, 201);
  const [stored] = await db.select({
    value: onbTransferKpiEvidence.value,
    measurement: onbTransferKpiEvidence.measurement,
  }).from(onbTransferKpiEvidence).where(and(
    eq(onbTransferKpiEvidence.organizationId, orgA),
    eq(onbTransferKpiEvidence.id, Number(bound.payload.evidenceId)),
  ));
  assert.equal(stored!.value, false);
  assert.deepEqual(stored!.measurement, {
    completedAt: "2020-01-09T00:00:00.000Z",
    dueAt: "2020-01-08T00:00:00.000Z",
  });
});

test("harmonisation completion uses actual action and current Legal approval receipts", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const policyReference = `legal-policy:${randomUUID()}`;
  const pathwayResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/pathways`,
    legalUser,
    {
      expectedVersion: Number(program.version),
      jurisdiction: "US",
      reviewReference: policyReference,
      decision: "approved",
      offerRequirement: "not-required",
      bgvApplicability: "not-required",
    },
  );
  await expectStatus(pathwayResponse, 200);
  const pathway = await json(pathwayResponse);

  const futureCompletion = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/integration-actions`,
    hrUser,
    {
      expectedVersion: Number(pathway.version),
      kind: "harmonisation",
      ownerUserId: hrUser,
      dueAt: futureDay,
      completedAt: "2031-01-02T00:00:00.000Z",
      status: "completed",
      evidenceReference: "harmonisation:future",
      legalApprovalReference: policyReference,
    },
  );
  assert.equal(futureCompletion.status, 400);
  assert.match((await json(futureCompletion)).message as string, /completedAt.*future/i);

  const missingApproval = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/integration-actions`,
    hrUser,
    {
      expectedVersion: Number(pathway.version),
      kind: "harmonisation",
      ownerUserId: hrUser,
      dueAt: futureDay,
      completedAt: new Date().toISOString(),
      status: "completed",
      evidenceReference: "harmonisation:unapproved",
      legalApprovalReference: "not-a-current-legal-receipt",
    },
  );
  assert.equal(missingApproval.status, 409);
  assert.match((await json(missingApproval)).message as string, /current.*Legal.*receipt/i);

  const completedAt = new Date().toISOString();
  const actionResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/integration-actions`,
    hrUser,
    {
      expectedVersion: Number(pathway.version),
      kind: "harmonisation",
      ownerUserId: hrUser,
      dueAt: futureDay,
      completedAt,
      status: "completed",
      evidenceReference: "harmonisation:completed",
      legalApprovalReference: policyReference,
    },
  );
  await expectStatus(actionResponse, 201);
  const action = await json(actionResponse);
  const summary = await programSummary(String(program.id));
  const safeAction = (summary.integrationActions as Array<Json>).find((item) => item.id === action.actionId)!;
  assert.equal(safeAction.completedAt, completedAt);
  assert.equal(typeof safeAction.policyApprovedAt, "string");

  await recordKpiDefinition(String(program.id), "harmonisation-complete", "receipt-bound");
  const fabricated = await recordKpiEvidence(String(program.id), legalUser, {
    metric: "harmonisation-complete",
    sourceRecordId: String(action.actionId),
    occurredAt: completedAt,
    sourceAttestationReference: "harmonisation-source:forged",
    evidenceReference: "harmonisation-evidence:forged",
    measurement: {
      actionCompletedAt: "2020-01-01T00:00:00.000Z",
      policyApprovedAt: "2020-01-01T00:00:00.000Z",
    },
  });
  assert.equal(fabricated.response.status, 409);
  assert.match(fabricated.payload.message as string, /persisted|action|Legal.*approval/i);

  const bound = await recordKpiEvidence(String(program.id), legalUser, {
    metric: "harmonisation-complete",
    sourceRecordId: String(action.actionId),
    occurredAt: completedAt,
    sourceAttestationReference: "harmonisation-source:bound",
    evidenceReference: "harmonisation-evidence:bound",
    measurement: {},
  });
  await expectStatus(bound.response, 201);
  const [stored] = await db.select({
    measurement: onbTransferKpiEvidence.measurement,
  }).from(onbTransferKpiEvidence).where(and(
    eq(onbTransferKpiEvidence.organizationId, orgA),
    eq(onbTransferKpiEvidence.id, Number(bound.payload.evidenceId)),
  ));
  assert.deepEqual(stored!.measurement, {
    actionCompletedAt: safeAction.completedAt,
    policyApprovedAt: safeAction.policyApprovedAt,
  });
});

test("rejects fabricated service KPI dates even when the dates appear to match", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governance.version),
    ["fabricated-service-worker"],
  );
  const workerId = imported.workerIds[0]!;

  await recordKpiDefinition(String(program.id), "service-date-accurate", "v1");
  const fabricated = await recordKpiEvidence(String(program.id), hrUser, {
    metric: "service-date-accurate",
    workerId,
    sourceRecordId: workerId,
    value: true,
    occurredAt: "2020-01-05T00:00:00.000Z",
    sourceAttestationReference: "fabricated-service-source:v1",
    evidenceReference: "fabricated-service-evidence:v1",
    measurement: {
      sourceFingerprint: "fabricated-source-fingerprint",
      sourceOriginalHireDate: historicalDate,
      destinationOriginalHireDate: historicalDate,
      sourceContinuousServiceDate: historicalServiceDate,
      destinationContinuousServiceDate: historicalServiceDate,
    },
  });
  assert.ok([400, 409].includes(fabricated.response.status));
  assert.match((fabricated.payload.message as string) ?? "", /service|reconciliation|attestation|evidence/i);
});

test("preserves continuous service and makes stable-ID retries idempotent", async () => {
  const program = await createProgram(hrUser, "cross-border", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const populationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/populations`,
    hrUser,
    { country: "US", expectedHeadcount: 2 },
  );
  await expectStatus(populationResponse, 201);
  const population = await json(populationResponse);
  const rows = [row("stable-1", "First Worker"), row("stable-2", "Second Worker")];
  const previewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser,
    { mapping, rows },
  );
  await expectStatus(previewResponse, 201);
  const preview = await json(previewResponse);
  const firstCommit = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports`,
    hrUser,
    {
      previewId: preview.previewId,
      idempotencyKey: `stable-retry-${suffix}`,
      expectedPopulationVersion: 1,
    },
  );
  await expectStatus(firstCommit, 201);
  const first = await json(firstCommit);
  assert.equal(first.importedCount, 2);
  const firstWorkerIds = (first.workers as Array<{ id: string }>).map((worker) => worker.id);

  const stored = await db.select({
    id: onbTransferWorkers.id,
    stableSourceId: onbTransferWorkers.stableSourceId,
    originalHireDate: onbTransferWorkers.originalHireDate,
    continuousServiceDate: onbTransferWorkers.continuousServiceDate,
  }).from(onbTransferWorkers).where(and(
    eq(onbTransferWorkers.organizationId, orgA),
    eq(onbTransferWorkers.populationId, population.id as string),
  ));
  assert.equal(stored.length, 2);
   assert.ok(stored.every((worker) =>
     worker.originalHireDate.toISOString() === historicalDate &&
     worker.continuousServiceDate.toISOString() === historicalServiceDate,
   ));
  assert.equal(governance.version, Number(pathway.payload.version) + 1);

  const retry = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports`,
    hrUser,
    {
      previewId: preview.previewId,
      idempotencyKey: `stable-retry-${suffix}`,
      expectedPopulationVersion: 1,
    },
  );
  await expectStatus(retry, 201);
  const retryPayload = await json(retry);
  assert.equal(retryPayload.retry, true);
  assert.equal(retryPayload.importedCount, first.importedCount);
  assert.deepEqual(
    (retryPayload.workers as Array<{ id: string }>).map((worker) => worker.id).sort(),
    [...firstWorkerIds].sort(),
  );

  const conflictingPreviewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser,
    { mapping, rows: [row("stable-1", "Changed Worker"), row("stable-2", "Second Worker")] },
  );
  await expectStatus(conflictingPreviewResponse, 201);
  const conflictingPreview = await json(conflictingPreviewResponse);
  const conflictingRetry = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports`,
    hrUser,
    {
      previewId: conflictingPreview.previewId,
      idempotencyKey: `stable-retry-${suffix}`,
      expectedPopulationVersion: 1,
    },
  );
  assert.equal(conflictingRetry.status, 409);
  assert.match((await json(conflictingRetry)).message as string, /idempotency|different.*preview/i);
  const identicalPreviewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser, { mapping, rows },
  );
  await expectStatus(identicalPreviewResponse, 201);
  const identicalPreview = await json(identicalPreviewResponse);
  const reimportBody = {
    previewId: identicalPreview.previewId,
    idempotencyKey: `identical-reimport-${suffix}`,
    expectedPopulationVersion: 2,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await call(
      `/onboarding/workforce-transfers/populations/${population.id}/imports`,
      hrUser, reimportBody,
    );
    await expectStatus(response, 201);
    const result = await json(response);
    assert.equal(result.importedCount, 2);
    assert.equal(result.retry, attempt === 1);
    assert.deepEqual(
      (result.workers as Array<{ id: string }>).map((worker) => worker.id).sort(),
      [...firstWorkerIds].sort(),
    );
  }
  const unchangedWorkers = await db.select({ id: onbTransferWorkers.id })
    .from(onbTransferWorkers).where(and(
      eq(onbTransferWorkers.organizationId, orgA),
      eq(onbTransferWorkers.populationId, String(population.id)),
    ));
  assert.equal(unchangedWorkers.length, 2);
});

test("unapproved consultation and an objected worker block go decisions", async () => {
  const program = await createProgram(hrUser, "asset-purchase", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governance.version),
    ["consultation-worker"],
  );
  const consultationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(governance.version) + 1,
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      status: "planned",
      evidenceReference: "consultation-plan:unapproved",
    },
  );
  await expectStatus(consultationResponse, 201);
  const consultation = await json(consultationResponse);
  const objectionResponse = await call(
    `/onboarding/workforce-transfers/workers/${imported.workerIds[0]}/objections`,
    hrUser,
    {
      expectedWorkerVersion: 1,
      outcome: "objected",
      receivedAt: "2020-01-04T00:00:00.000Z",
      evidenceReference: "worker-objection:private-record",
    },
  );
  await expectStatus(objectionResponse, 201);
  const plan = await createReadyPlan(
    String(program.id),
    Number(consultation.version),
    1,
  );
  const go = await call(
    `/onboarding/workforce-transfers/cutover-plans/${plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: plan.version, decision: "go" },
  );
  assert.equal(go.status, 409);
  const message = (await json(go)).message as string;
  assert.match(message, /consultation/i);
  assert.match(message, /objection|opt-out/i);
});

test("a population headcount shortfall blocks cutover go", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governance.version),
    ["headcount-worker"],
    100,
  );
  const consultationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(governance.version) + 1,
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      completedAt: "2030-01-03T00:00:00.000Z",
      status: "completed",
      evidenceReference: "consultation:headcount-shortfall",
    },
  );
  await expectStatus(consultationResponse, 201);
  const consultation = await json(consultationResponse);
  const action = await recordContingencyAction(
    String(program.id),
    Number(consultation.version),
    "completed",
  );
  const plan = await createReadyPlan(
    String(program.id),
    Number(action.version),
    1,
  );
  const summary = await programSummary(String(program.id));
  const populationSummary = (summary.populations as Array<Json>)
    .find((population) => population.expectedHeadcount === 100);
  assert.equal(populationSummary?.importedHeadcount, 1);
  assert.equal(JSON.stringify(summary).includes("sourcePayload"), false);
  assert.equal((summary.cutoverPlans as Array<Json>)
    .find((candidate) => candidate.id === plan.planId)?.workerCount, 1);

  let planVersion = plan.version;
  for (const [stream, actor] of [
    ["migration", hrUser],
    ["payroll", payrollUser],
    ["benefits", payrollUser],
    ["access", itUser],
  ] as const) {
    planVersion = Number((await recordReconciliation(
      plan.planId,
      planVersion,
      imported.workerIds[0]!,
      stream,
      "complete",
      actor,
    )).version);
  }
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "hr-integration", hrUser)).version);
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "payroll", payrollUser)).version);
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "it", itUser)).version);

  const blockedGo = await call(
    `/onboarding/workforce-transfers/cutover-plans/${plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: planVersion, decision: "go" },
  );
  assert.equal(blockedGo.status, 409);
  assert.match((await json(blockedGo)).message as string, /headcount|population|imported/i);
});

test("persists partial pay/access and unknown-effect repair outcomes without claiming continuity", async () => {
  const program = await createProgram(hrUser, "share-purchase", ["US"]);
  const pathway = await approvePathway(String(program.id), legalUser, Number(program.version), "US");
  const governance = await approveGovernance(String(program.id), Number(pathway.payload.version));
  const imported = await createImportedPopulation(
    String(program.id),
    Number(governance.version),
    ["partial-worker"],
  );
  const consultationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/consultation-milestones`,
    legalUser,
    {
      expectedVersion: Number(governance.version) + 1,
      jurisdiction: "US",
      kind: "worker-consultation",
      dueAt: futureDay,
      completedAt: "2030-01-03T00:00:00.000Z",
      status: "completed",
      evidenceReference: "consultation:completed",
    },
  );
  await expectStatus(consultationResponse, 201);
  const consultation = await json(consultationResponse);
  const action = await recordContingencyAction(
    String(program.id),
    Number(consultation.version),
    "completed",
  );
  const plan = await createReadyPlan(
    String(program.id),
    Number(action.version),
    1,
  );

  let planVersion = plan.version;
  planVersion = Number((await recordReconciliation(plan.planId, planVersion, imported.workerIds[0]!, "migration", "complete", hrUser)).version);
  planVersion = Number((await recordReconciliation(plan.planId, planVersion, imported.workerIds[0]!, "payroll", "exception", payrollUser)).version);
  planVersion = Number((await recordReconciliation(plan.planId, planVersion, imported.workerIds[0]!, "benefits", "complete", payrollUser)).version);
  planVersion = Number((await recordReconciliation(plan.planId, planVersion, imported.workerIds[0]!, "access", "unknown-effect-manual-repair", itUser)).version);
  planVersion = Number((await recordReconciliation(plan.planId, planVersion, imported.workerIds[0]!, "first-pay", "pending", payrollUser)).version);

  const reconciliationResponse = await call(
    `/onboarding/workforce-transfers/populations/${imported.populationId}/reconciliation`,
    hrUser,
  );
  await expectStatus(reconciliationResponse, 200);
  const reconciliation = await json(reconciliationResponse);
   assert.equal((reconciliation.migrationCounts as Json).reconciled, 1);
  const evidence = await db.select({
    stream: onbTransferCutoverReconciliations.stream,
    status: onbTransferCutoverReconciliations.status,
  }).from(onbTransferCutoverReconciliations).where(and(
    eq(onbTransferCutoverReconciliations.organizationId, orgA),
    eq(onbTransferCutoverReconciliations.planId, plan.planId),
  ));
  assert.equal(evidence.find((item) => item.stream === "payroll")?.status, "exception");
  assert.equal(evidence.find((item) => item.stream === "access")?.status, "unknown-effect-manual-repair");

  planVersion = Number((await recordSignoff(plan.planId, planVersion, "hr-integration", hrUser)).version);
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "payroll", payrollUser)).version);
  planVersion = Number((await recordSignoff(plan.planId, planVersion, "it", itUser)).version);
  const blockedGo = await call(
    `/onboarding/workforce-transfers/cutover-plans/${plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: planVersion, decision: "go" },
  );
  assert.equal(blockedGo.status, 409);
  assert.match((await json(blockedGo)).message as string, /payroll|access|incomplete/i);
  assert.equal(
    (await db.select({ count: onbTransferCutoverPlans.id }).from(onbTransferCutoverPlans)
      .where(and(eq(onbTransferCutoverPlans.organizationId, orgA), eq(onbTransferCutoverPlans.id, plan.planId)))).length,
    1,
    "the safe-repair evidence path must not dispatch or delete a cutover plan",
  );
});

test("evidence recorded after signoff invalidates the cutover go decision", async () => {
  const fixture = await createCutoverFixture("automatic-transfer");
  let planVersion = fixture.plan.version;
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "migration",
    "complete",
    hrUser,
  )).version);
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "payroll",
    "complete",
    payrollUser,
  )).version);
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "benefits",
    "complete",
    payrollUser,
  )).version);
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "access",
    "complete",
    itUser,
  )).version);

  planVersion = Number((await recordSignoff(
    fixture.plan.planId,
    planVersion,
    "hr-integration",
    hrUser,
  )).version);
  planVersion = Number((await recordSignoff(
    fixture.plan.planId,
    planVersion,
    "payroll",
    payrollUser,
  )).version);
  planVersion = Number((await recordSignoff(
    fixture.plan.planId,
    planVersion,
    "it",
    itUser,
  )).version);

  // A new evidence revision after signoff must make those signoffs stale,
  // rather than allowing a go decision against an unreviewed outcome.
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "access",
    "complete",
    itUser,
  )).version);
  const go = await call(
    `/onboarding/workforce-transfers/cutover-plans/${fixture.plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: planVersion, decision: "go" },
  );
  assert.equal(go.status, 409);
  assert.match((await json(go)).message as string, /sign.?off|evidence|fresh|review/i);
});

test("expired per-country data governance blocks go even after evidence and signoffs", async () => {
  const fixture = await createCutoverFixture("share-purchase");
  let planVersion = fixture.plan.version;
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "migration",
    "complete",
    hrUser,
  )).version);
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "payroll",
    "complete",
    payrollUser,
  )).version);
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "benefits",
    "complete",
    payrollUser,
  )).version);
  planVersion = Number((await recordReconciliation(
    fixture.plan.planId,
    planVersion,
    fixture.imported.workerIds[0]!,
    "access",
    "complete",
    itUser,
  )).version);
  planVersion = Number((await recordSignoff(
    fixture.plan.planId,
    planVersion,
    "hr-integration",
    hrUser,
  )).version);
  planVersion = Number((await recordSignoff(
    fixture.plan.planId,
    planVersion,
    "payroll",
    payrollUser,
  )).version);
  planVersion = Number((await recordSignoff(
    fixture.plan.planId,
    planVersion,
    "it",
    itUser,
  )).version);

  await db.update(onbTransferDataGovernance).set({
    retentionUntil: new Date(Date.now() - 60_000),
  }).where(and(
    eq(onbTransferDataGovernance.organizationId, orgA),
    eq(onbTransferDataGovernance.programId, String(fixture.program.id)),
    eq(onbTransferDataGovernance.jurisdiction, "US"),
  ));
  const go = await call(
    `/onboarding/workforce-transfers/cutover-plans/${fixture.plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: planVersion, decision: "go" },
  );
  assert.equal(go.status, 409);
  assert.match((await json(go)).message as string, /retention|governance|lawful|expired/i);
});

test("revoked Legal authority invalidates recorded approvals and stale cutover evidence cannot authorize go", async () => {
  const program = await createProgram(hrUser, "automatic-transfer", ["US"]);
  const pathwayResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/pathways`,
    revokableLegalUser,
    {
      expectedVersion: Number(program.version),
      jurisdiction: "US",
      reviewReference: "revokable-legal-review",
      decision: "approved",
      offerRequirement: "not-required",
      bgvApplicability: "not-required",
    },
  );
  await expectStatus(pathwayResponse, 200);
  const pathway = await json(pathwayResponse);
  const governance = await approveGovernance(String(program.id), Number(pathway.version));
  const populationResponse = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/populations`,
    hrUser,
    { country: "US", expectedHeadcount: 1 },
  );
  await expectStatus(populationResponse, 201);
  const population = await json(populationResponse);
  const previewResponse = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports/preview`,
    hrUser,
    { mapping, rows: [row("revoked-before-import")] },
  );
  await expectStatus(previewResponse, 201);
  const preview = await json(previewResponse);

  await db.update(onbAuthorityAssignments).set({
    status: "revoked",
    revokedAt: new Date(),
    revokedByUserId: "transfer-governance",
    revokeReason: "isolated revocation test",
    revision: 2,
  }).where(and(
    eq(onbAuthorityAssignments.organizationId, orgA),
    eq(onbAuthorityAssignments.personUserId, revokableLegalUser),
  ));
  const revokedCommit = await call(
    `/onboarding/workforce-transfers/populations/${population.id}/imports`,
    hrUser,
    {
      previewId: preview.previewId,
      idempotencyKey: `revoked-${randomUUID()}`,
      expectedPopulationVersion: 1,
    },
  );
  assert.equal(revokedCommit.status, 409);
  assert.match((await json(revokedCommit)).message as string, /current.*Legal|authority/i);
  assert.equal(governance.version, Number(pathway.version) + 1);
});

test("specialist reads are scope-limited, omit restricted references, and require live authority", async () => {
  const program = await createProgram();
  const legalRead = await call(`/onboarding/workforce-transfers/programs/${program.id}`, legalUser, undefined, { method: "GET" });
  await expectStatus(legalRead, 200);
  const summary = await json(legalRead);
  assert.deepEqual(summary.readCapabilities, ["legal"]);
  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes("sourcePayload"));
  assert.ok(!serialized.includes("evidenceReference"));
  assert.ok(!serialized.includes("reviewReference"));

  const legalPathway = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/pathways`,
    legalUser,
    { expectedVersion: 1, jurisdiction: "US", decision: "approved", offerRequirement: "not-required", bgvApplicability: "not-required", reviewReference: "legal-specialist-only" },
  );
  await expectStatus(legalPathway, 200);

  const legalHrMutation = await call(
    `/onboarding/workforce-transfers/programs/${program.id}/populations`,
    legalUser,
    { country: "US", expectedHeadcount: 1 },
  );
  assert.equal(legalHrMutation.status, 403);

  await db.update(onbAuthorityAssignments).set({
    status: "active",
    revokedAt: null,
    revokedByUserId: null,
    revokeReason: null,
    revision: 3,
  }).where(and(
    eq(onbAuthorityAssignments.organizationId, orgA),
    eq(onbAuthorityAssignments.personUserId, revokableLegalUser),
  ));
  const specialistRead = await call(`/onboarding/workforce-transfers/programs/${program.id}`, revokableLegalUser, undefined, { method: "GET" });
  await expectStatus(specialistRead, 200);
  await db.update(onbAuthorityAssignments).set({
    status: "revoked",
    revokedAt: new Date(),
    revokedByUserId: "transfer-governance",
    revokeReason: "specialist read revocation test",
    revision: 4,
  }).where(and(
    eq(onbAuthorityAssignments.organizationId, orgA),
    eq(onbAuthorityAssignments.personUserId, revokableLegalUser),
  ));
  const revokedRead = await call(`/onboarding/workforce-transfers/programs/${program.id}`, revokableLegalUser, undefined, { method: "GET" });
  assert.equal(revokedRead.status, 403);
});

test("material Legal pathway requirements and review references fence existing cutover plans", async () => {
  const fixture = await createCutoverFixture();
  let planVersion = fixture.plan.version;
  planVersion = Number((await recordSignoff(fixture.plan.planId, planVersion, "hr-integration", hrUser)).version);
  planVersion = Number((await recordSignoff(fixture.plan.planId, planVersion, "payroll", payrollUser)).version);
  planVersion = Number((await recordSignoff(fixture.plan.planId, planVersion, "it", itUser)).version);

  const beforeRequirementChange = await programSummary(String(fixture.program.id));
  const requirementChange = await call(
    `/onboarding/workforce-transfers/programs/${fixture.program.id}/pathways`,
    legalUser,
    {
      expectedVersion: Number(beforeRequirementChange.version), jurisdiction: "US", decision: "approved",
      offerRequirement: "required", bgvApplicability: "not-required", reviewReference: "legal-review:requirement-changed",
    },
  );
  await expectStatus(requirementChange, 200);
  const staleRequirementGo = await call(
    `/onboarding/workforce-transfers/cutover-plans/${fixture.plan.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: planVersion, decision: "go" },
  );
  assert.equal(staleRequirementGo.status, 409);
  assert.match((await json(staleRequirementGo)).message as string, /pathway.*requirements.*new cutover plan/i);

  const requirementVersion = Number((await json(requirementChange)).version);
  const replacement = await createReadyPlan(String(fixture.program.id), requirementVersion, 1);
  let replacementVersion = replacement.version;
  replacementVersion = Number((await recordSignoff(replacement.planId, replacementVersion, "hr-integration", hrUser)).version);
  replacementVersion = Number((await recordSignoff(replacement.planId, replacementVersion, "payroll", payrollUser)).version);
  replacementVersion = Number((await recordSignoff(replacement.planId, replacementVersion, "it", itUser)).version);
  const beforeReferenceChange = await programSummary(String(fixture.program.id));
  const referenceChange = await call(
    `/onboarding/workforce-transfers/programs/${fixture.program.id}/pathways`,
    legalUser,
    {
      expectedVersion: Number(beforeReferenceChange.version), jurisdiction: "US", decision: "approved",
      offerRequirement: "required", bgvApplicability: "not-required", reviewReference: "legal-review:reference-changed",
    },
  );
  await expectStatus(referenceChange, 200);
  const staleReferenceGo = await call(
    `/onboarding/workforce-transfers/cutover-plans/${replacement.planId}/go-no-go`,
    hrUser,
    { expectedPlanVersion: replacementVersion, decision: "go" },
  );
  assert.equal(staleReferenceGo.status, 409);
  assert.match((await json(staleReferenceGo)).message as string, /pathway.*requirements.*new cutover plan/i);
});