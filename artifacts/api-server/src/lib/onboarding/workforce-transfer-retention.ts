import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import {
  db,
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
  onbTransferReconciliationRepairs,
  onbTransferWorkers,
} from "@workspace/db";
import { appendProtectedAuditInTransaction } from "./protected-audit";

/**
 * The transfer dataset is an opaque source record. These are all of its
 * durable representations; adding a table requires adding it to the newest
 * source watermark before lifecycle deletion can be considered supported.
 */
export const TRANSFER_RETENTION_TABLES = [
  "onb_transfer_programs",
  "onb_transfer_pathways",
  "onb_transfer_data_governance",
  "onb_transfer_populations",
  "onb_transfer_import_previews",
  "onb_transfer_imports",
  "onb_transfer_workers",
  "onb_transfer_consultation_milestones",
  "onb_transfer_objections",
  "onb_transfer_integration_actions",
  "onb_transfer_operational_supersessions",
  "onb_transfer_cutover_plans",
  "onb_transfer_cutover_reconciliations",
  "onb_transfer_cutover_signoffs",
  "onb_transfer_reconciliation_repairs",
  "onb_transfer_kpi_evidence",
  "onb_transfer_kpi_definitions",
] as const;

export const TRANSFER_RETENTION_RECORD_KIND = "transfer-program" as const;
const TRANSFER_CLASSES = [
  "candidate-document", "identity", "medical", "payroll", "bgv",
  "candidate-contact", "candidate-voice", "candidate-portal",
] as const;

type TransferClass = typeof TRANSFER_CLASSES[number];
type PolicyRevision = { id: number; revision: number; retentionDays: number };
type RetentionSnapshot = {
  sourceAt: string;
  jurisdictions: Array<{
    jurisdiction: string;
    retentionUntil: string;
    revision: number;
    policyRevisions: Record<TransferClass, Pick<PolicyRevision, "id" | "revision">>;
  }>;
};

async function latest(tx: any, table: any, timestamp: any, predicate: any): Promise<Date | null> {
  const [row] = await tx.select({ at: timestamp }).from(table).where(predicate).orderBy(desc(timestamp)).limit(1);
  return row?.at ?? null;
}

type TransferRetentionContext = {
  program: typeof onbTransferPrograms.$inferSelect;
  jurisdiction: string;
  governance: typeof onbTransferDataGovernance.$inferSelect;
  policies: Map<TransferClass, PolicyRevision>;
  workerIds: string[];
  milestoneIds: string[];
  plans: Array<{
    id: string;
    workerSnapshot: Array<{ workerId: string; populationId: string; stableSourceId: string; workerVersion: number }>;
    pathwaySnapshot: Array<{ jurisdiction: string }>;
  }>;
  kpiDefinitions: Array<typeof onbTransferKpiDefinitions.$inferSelect>;
  newestSourceAt: Date;
};

async function transferRetentionContextInTransaction(
  tx: any,
  organizationId: string,
  programId: string,
  jurisdiction: string,
): Promise<TransferRetentionContext | null> {
  const [program]: Array<typeof onbTransferPrograms.$inferSelect | undefined> = await tx.select().from(onbTransferPrograms).where(and(
    eq(onbTransferPrograms.organizationId, organizationId),
    eq(onbTransferPrograms.id, programId),
  )).for("update");
  if (!program) return null;
  if (!(program.countries as string[]).includes(jurisdiction)) return null;
  const [[governance], populations, plans, milestones]: [
    Array<typeof onbTransferDataGovernance.$inferSelect>,
    Array<{ id: string }>,
    Array<{ id: string; workerSnapshot: Array<{ workerId: string; populationId: string; stableSourceId: string; workerVersion: number }>; pathwaySnapshot: Array<{ jurisdiction: string }> }>,
    Array<{ id: number; createdAt: Date }>,
  ] = await Promise.all([
    tx.select().from(onbTransferDataGovernance).where(and(
      eq(onbTransferDataGovernance.organizationId, organizationId),
      eq(onbTransferDataGovernance.programId, programId),
      eq(onbTransferDataGovernance.jurisdiction, jurisdiction),
    )).for("update").limit(1),
    tx.select({ id: onbTransferPopulations.id }).from(onbTransferPopulations).where(and(
      eq(onbTransferPopulations.organizationId, organizationId),
      eq(onbTransferPopulations.programId, programId),
      eq(onbTransferPopulations.country, jurisdiction),
    )),
    tx.select({ id: onbTransferCutoverPlans.id, workerSnapshot: onbTransferCutoverPlans.workerSnapshot, pathwaySnapshot: onbTransferCutoverPlans.pathwaySnapshot }).from(onbTransferCutoverPlans).where(and(
      eq(onbTransferCutoverPlans.organizationId, organizationId),
      eq(onbTransferCutoverPlans.programId, programId),
    )),
    tx.select({ id: onbTransferConsultationMilestones.id, createdAt: onbTransferConsultationMilestones.createdAt }).from(onbTransferConsultationMilestones).where(and(
      eq(onbTransferConsultationMilestones.organizationId, organizationId),
      eq(onbTransferConsultationMilestones.programId, programId),
      eq(onbTransferConsultationMilestones.jurisdiction, jurisdiction),
    )),
  ]);
  const populationIds = populations.map((row: { id: string }) => row.id);
  const workers = populationIds.length
    ? await tx.select({ id: onbTransferWorkers.id }).from(onbTransferWorkers).where(and(
      eq(onbTransferWorkers.organizationId, organizationId),
      inArray(onbTransferWorkers.populationId, populationIds),
    ))
    : [];
  const workerIds = workers.map((row: { id: string }) => row.id);
  const milestoneIds = milestones.map((milestone) => String(milestone.id));
  const scopedSourceIds = [...workerIds, ...milestoneIds];
  const kpiDefinitions: Array<typeof onbTransferKpiDefinitions.$inferSelect> = scopedSourceIds.length
    ? await tx.select().from(onbTransferKpiDefinitions).where(and(
      eq(onbTransferKpiDefinitions.organizationId, organizationId),
      eq(onbTransferKpiDefinitions.programId, programId),
    ))
    : [];
  const scopedKpiDefinitions = kpiDefinitions.filter((definition) =>
    definition.cohortSnapshot.some((recordId) => scopedSourceIds.includes(recordId)));
  const policies: Array<typeof onbSensitiveLifecyclePolicies.$inferSelect> = await tx.select().from(onbSensitiveLifecyclePolicies).where(and(
    eq(onbSensitiveLifecyclePolicies.organizationId, organizationId),
    eq(onbSensitiveLifecyclePolicies.isCurrent, true),
    eq(onbSensitiveLifecyclePolicies.jurisdiction, jurisdiction),
    inArray(onbSensitiveLifecyclePolicies.dataClass, [...TRANSFER_CLASSES]),
  )).for("update");
  const policiesByClass = new Map<TransferClass, PolicyRevision>();
  for (const policy of policies) {
    policiesByClass.set(policy.dataClass as TransferClass, {
      id: policy.id, revision: policy.revision, retentionDays: policy.retentionDays,
    });
  }
  const planIds = plans
    .filter((plan) => plan.workerSnapshot.some((worker) => workerIds.includes(worker.workerId)))
    .map((plan) => plan.id);
  const timestamps = await Promise.all([
    Promise.resolve(program.updatedAt),
    latest(tx, onbTransferPathways, onbTransferPathways.decidedAt, and(eq(onbTransferPathways.organizationId, organizationId), eq(onbTransferPathways.programId, programId), eq(onbTransferPathways.jurisdiction, jurisdiction))),
    governance?.approvedAt ?? null,
    latest(tx, onbTransferPopulations, onbTransferPopulations.createdAt, and(eq(onbTransferPopulations.organizationId, organizationId), eq(onbTransferPopulations.programId, programId), eq(onbTransferPopulations.country, jurisdiction))),
    populationIds.length ? latest(tx, onbTransferImportPreviews, onbTransferImportPreviews.createdAt, and(eq(onbTransferImportPreviews.organizationId, organizationId), inArray(onbTransferImportPreviews.populationId, populationIds))) : null,
    populationIds.length ? latest(tx, onbTransferImports, onbTransferImports.createdAt, and(eq(onbTransferImports.organizationId, organizationId), inArray(onbTransferImports.populationId, populationIds))) : null,
    populationIds.length ? latest(tx, onbTransferWorkers, onbTransferWorkers.createdAt, and(eq(onbTransferWorkers.organizationId, organizationId), inArray(onbTransferWorkers.populationId, populationIds))) : null,
    ...milestones.map((milestone) => Promise.resolve(milestone.createdAt)),
    milestoneIds.length ? latest(tx, onbTransferOperationalSupersessions, onbTransferOperationalSupersessions.createdAt, and(
      eq(onbTransferOperationalSupersessions.organizationId, organizationId),
      eq(onbTransferOperationalSupersessions.programId, programId),
      eq(onbTransferOperationalSupersessions.recordKind, "consultation-milestone"),
      inArray(onbTransferOperationalSupersessions.recordId, milestoneIds),
    )) : null,
    workerIds.length ? latest(tx, onbTransferObjections, onbTransferObjections.createdAt, and(eq(onbTransferObjections.organizationId, organizationId), inArray(onbTransferObjections.workerId, workerIds))) : null,
    planIds.length ? latest(tx, onbTransferCutoverPlans, onbTransferCutoverPlans.createdAt, and(eq(onbTransferCutoverPlans.organizationId, organizationId), inArray(onbTransferCutoverPlans.id, planIds))) : null,
    workerIds.length ? latest(tx, onbTransferCutoverReconciliations, onbTransferCutoverReconciliations.createdAt, and(eq(onbTransferCutoverReconciliations.organizationId, organizationId), inArray(onbTransferCutoverReconciliations.workerId, workerIds))) : null,
    workerIds.length ? latest(tx, onbTransferReconciliationRepairs, onbTransferReconciliationRepairs.createdAt, and(eq(onbTransferReconciliationRepairs.organizationId, organizationId), inArray(onbTransferReconciliationRepairs.workerId, workerIds))) : null,
    scopedSourceIds.length ? latest(tx, onbTransferKpiEvidence, onbTransferKpiEvidence.createdAt, and(
      eq(onbTransferKpiEvidence.organizationId, organizationId),
      eq(onbTransferKpiEvidence.programId, programId),
      or(
        workerIds.length ? inArray(onbTransferKpiEvidence.workerId, workerIds) : undefined,
        inArray(onbTransferKpiEvidence.sourceRecordId, scopedSourceIds),
      ),
    )) : null,
    ...scopedKpiDefinitions.map((definition) => Promise.resolve(definition.approvedAt)),
    planIds.length ? latest(tx, onbTransferCutoverSignoffs, onbTransferCutoverSignoffs.createdAt, and(
      eq(onbTransferCutoverSignoffs.organizationId, organizationId),
      inArray(onbTransferCutoverSignoffs.planId, planIds),
    )) : null,
    // Integration actions and their supersession evidence are program-wide.
    // They remain until the final jurisdiction is purged, when the program
    // cascade removes them under the same reviewed lifecycle job.
    (program.countries as string[]).length === 1 ? latest(tx, onbTransferIntegrationActions, onbTransferIntegrationActions.createdAt, and(
      eq(onbTransferIntegrationActions.organizationId, organizationId),
      eq(onbTransferIntegrationActions.programId, programId),
    )) : null,
    (program.countries as string[]).length === 1 ? latest(tx, onbTransferOperationalSupersessions, onbTransferOperationalSupersessions.createdAt, and(
      eq(onbTransferOperationalSupersessions.organizationId, organizationId),
      eq(onbTransferOperationalSupersessions.programId, programId),
      eq(onbTransferOperationalSupersessions.recordKind, "integration-action"),
    )) : null,
  ]);
  const newestSourceAt = timestamps.reduce<Date>((newest, timestamp) =>
    timestamp && timestamp > newest ? timestamp : newest, program.updatedAt);
  if (!governance) return null;
  return { program, jurisdiction, governance, policies: policiesByClass, workerIds, milestoneIds, plans, kpiDefinitions: scopedKpiDefinitions, newestSourceAt };
}

function contextIsDue(
  context: TransferRetentionContext,
  now: Date,
  override?: { jurisdiction: string; dataClass: TransferClass; retentionDays: number },
) {
  if (context.governance.retentionUntil > now) return false;
  for (const dataClass of TRANSFER_CLASSES) {
    const policy = context.policies.get(dataClass);
    const useOverride = override?.jurisdiction === context.jurisdiction && override?.dataClass === dataClass;
    const retentionDays = useOverride ? override!.retentionDays : policy?.retentionDays;
    if (retentionDays === undefined ||
        context.newestSourceAt > new Date(now.getTime() - retentionDays * 86_400_000)) return false;
  }
  return true;
}

function snapshotForContext(
  context: TransferRetentionContext,
): RetentionSnapshot | null {
  if (TRANSFER_CLASSES.some((dataClass) => !context.policies.has(dataClass))) return null;
  return {
    sourceAt: context.newestSourceAt.toISOString(),
    jurisdictions: [{
      jurisdiction: context.jurisdiction,
      retentionUntil: context.governance.retentionUntil.toISOString(),
      revision: context.governance.revision,
      policyRevisions: Object.fromEntries(TRANSFER_CLASSES.map((dataClass) => {
        const policy = context.policies.get(dataClass)!;
        return [dataClass, { id: policy.id, revision: policy.revision }];
      })) as Record<TransferClass, Pick<PolicyRevision, "id" | "revision">>,
    }],
  };
}

function snapshotMatches(expected: RetentionSnapshot, actual: Partial<RetentionSnapshot>): boolean {
  if (expected.sourceAt !== actual.sourceAt || !Array.isArray(actual.jurisdictions) ||
      expected.jurisdictions.length !== actual.jurisdictions.length) return false;
  return expected.jurisdictions.every((expectedJurisdiction, index) => {
    const actualJurisdiction = actual.jurisdictions![index];
    if (!actualJurisdiction ||
        expectedJurisdiction.jurisdiction !== actualJurisdiction.jurisdiction ||
        expectedJurisdiction.retentionUntil !== actualJurisdiction.retentionUntil ||
        expectedJurisdiction.revision !== actualJurisdiction.revision) return false;
    return TRANSFER_CLASSES.every((dataClass) => {
      const expectedPolicy = expectedJurisdiction.policyRevisions[dataClass];
      const actualPolicy = actualJurisdiction.policyRevisions?.[dataClass];
      return expectedPolicy.id === actualPolicy?.id && expectedPolicy.revision === actualPolicy?.revision;
    });
  });
}

async function transferHoldApplies(tx: any, organizationId: string) {
  const [hold] = await tx.select({ id: onbSensitiveLifecycleHolds.id }).from(onbSensitiveLifecycleHolds).where(and(
    eq(onbSensitiveLifecycleHolds.organizationId, organizationId),
    eq(onbSensitiveLifecycleHolds.active, true),
    isNull(onbSensitiveLifecycleHolds.caseId),
    isNull(onbSensitiveLifecycleHolds.objectPath),
    or(isNull(onbSensitiveLifecycleHolds.dataClass), inArray(onbSensitiveLifecycleHolds.dataClass, [...TRANSFER_CLASSES])),
  )).limit(1);
  return Boolean(hold);
}

/**
 * This is intentionally an inventory only: it never purges. The shared
 * retention-shortening confirmation uses it so a policy revision cannot hide
 * already-expired transfer representations from the reviewer.
 */
export async function transferRetentionInventoryInTransaction(tx: any, input: {
  organizationId: string; dataClass: TransferClass; jurisdiction: string; retentionDays: number; now: Date;
}) {
  const programs: Array<{ id: string }> = await tx.select({ id: onbTransferPrograms.id }).from(onbTransferPrograms)
    .where(eq(onbTransferPrograms.organizationId, input.organizationId));
  const held = await transferHoldApplies(tx, input.organizationId);
  const eligibleRecordKeys: string[] = [];
  let heldRecordCount = 0;
  for (const { id } of programs) {
    const context = await transferRetentionContextInTransaction(tx, input.organizationId, id, input.jurisdiction);
    if (!context || !contextIsDue(context, input.now, input)) continue;
    if (held) heldRecordCount += 1;
    else eligibleRecordKeys.push(`transfer-jurisdiction:${id}:${input.jurisdiction}`);
  }
  return { eligibleRecordKeys, heldRecordCount };
}

export function jurisdictionRecordId(programId: string, jurisdiction: string) {
  return `transfer-jurisdiction:${encodeURIComponent(programId)}:${encodeURIComponent(jurisdiction)}`;
}

function parseJurisdictionRecordId(recordId: string): { programId: string; jurisdiction: string } | null {
  const match = /^transfer-jurisdiction:([^:]+):([^:]+)$/.exec(recordId);
  if (!match) return null;
  try {
    return { programId: decodeURIComponent(match[1]!), jurisdiction: decodeURIComponent(match[2]!) };
  } catch {
    return null;
  }
}

export function transferRetentionJobAction(
  existing: Array<{ status: "queued" | "processing" | "completed" | "blocked" | "failed"; policyId: number; policyRevision: number }>,
  currentPolicy: Pick<PolicyRevision, "id" | "revision">,
): "create" | "refresh" | "skip" {
  const currentRevisionJob = existing.find((job) =>
    job.policyId === currentPolicy.id && job.policyRevision === currentPolicy.revision);
  if (!currentRevisionJob) return "create";
  return currentRevisionJob.status === "blocked" || currentRevisionJob.status === "failed" ? "refresh" : "skip";
}

type TransferProgramCursor = { id: string; createdAt: Date };

/**
 * Walk each bounded keyset page, rather than repeatedly reconsidering an
 * oldest fixed window. This guarantees an old non-eligible backlog cannot
 * starve a later due transfer program.
 */
export async function scanTransferProgramPages<T extends TransferProgramCursor>(
  pageSize: number,
  fetchPage: (cursor: TransferProgramCursor | null) => Promise<T[]>,
  visit: (program: T) => Promise<void>,
) {
  let cursor: TransferProgramCursor | null = null;
  for (;;) {
    const page = await fetchPage(cursor);
    for (const program of page) await visit(program);
    if (page.length < pageSize) return;
    const last = page.at(-1)!;
    cursor = { id: last.id, createdAt: last.createdAt };
  }
}

/**
 * The legacy transfer expiry hook now only creates durable lifecycle jobs.
 * No source row is deleted here: the worker repeats policy, custody watermark,
 * all-class hold, and legal-retention checks inside its fenced finalization.
 */
export async function purgeExpiredTransferRetention(organizationId: string, now = new Date()) {
  let scheduled = 0;
  const pageSize = 100;
  await scanTransferProgramPages(
    pageSize,
    async (cursor) => {
      const afterCursor = cursor ? or(
        gt(onbTransferPrograms.createdAt, cursor.createdAt),
        and(eq(onbTransferPrograms.createdAt, cursor.createdAt), gt(onbTransferPrograms.id, cursor.id)),
      ) : undefined;
      return db.select({
        id: onbTransferPrograms.id,
        countries: onbTransferPrograms.countries,
        createdAt: onbTransferPrograms.createdAt,
      }).from(onbTransferPrograms).where(and(
        eq(onbTransferPrograms.organizationId, organizationId),
        afterCursor,
      )).orderBy(asc(onbTransferPrograms.createdAt), asc(onbTransferPrograms.id)).limit(pageSize);
    },
    async ({ id, countries }) => db.transaction(async (tx) => {
      for (const jurisdiction of countries as string[]) {
          const context = await transferRetentionContextInTransaction(tx, organizationId, id, jurisdiction);
          if (!context || !contextIsDue(context, now)) continue;
          const snapshot = snapshotForContext(context);
          const anchor = context.policies.get("candidate-document");
          if (!snapshot || !anchor) continue;
          const recordId = jurisdictionRecordId(id, jurisdiction);
          const existing: Array<{ id: number; status: "queued" | "processing" | "completed" | "blocked" | "failed"; policyId: number; policyRevision: number }> = await tx.select({
            id: onbSensitiveLifecycleDeletionJobs.id,
            status: onbSensitiveLifecycleDeletionJobs.status,
            policyId: onbSensitiveLifecycleDeletionJobs.policyId,
            policyRevision: onbSensitiveLifecycleDeletionJobs.policyRevision,
          }).from(onbSensitiveLifecycleDeletionJobs).where(and(
            eq(onbSensitiveLifecycleDeletionJobs.organizationId, organizationId),
            eq(onbSensitiveLifecycleDeletionJobs.recordKind, TRANSFER_RETENTION_RECORD_KIND),
            eq(onbSensitiveLifecycleDeletionJobs.recordId, recordId),
          )).for("update");
          const values = {
            dataClass: "candidate-document" as const,
            policyId: anchor.id,
            policyRevision: anchor.revision,
            policyRevisions: Object.fromEntries(TRANSFER_CLASSES.map((dataClass) => {
              const policy = context.policies.get(dataClass)!;
              return [dataClass, { id: policy.id, revision: policy.revision }];
            })),
            transferRetentionSnapshot: snapshot,
            status: "queued" as const,
            claimOwner: null,
            claimUntil: null,
            completedAt: null,
            lastError: null,
            updatedAt: now,
          };
          // The durable-job uniqueness is policy-revision scoped. A blocked
          // record can therefore be refreshed in place when the same reviewed
          // revision remains current, while a changed policy receives its own
          // superseding job without overwriting the older custody evidence.
          const action = transferRetentionJobAction(existing, anchor);
          const currentRevisionJob = existing.find((job) =>
            job.policyId === anchor.id && job.policyRevision === anchor.revision);
          if (action === "refresh") {
            const refreshed = await tx.update(onbSensitiveLifecycleDeletionJobs).set(values)
              .where(eq(onbSensitiveLifecycleDeletionJobs.id, currentRevisionJob!.id))
              .returning({ id: onbSensitiveLifecycleDeletionJobs.id });
            scheduled += refreshed.length;
            continue;
          }
          if (action === "skip") continue;
          const created = await tx.insert(onbSensitiveLifecycleDeletionJobs).values({
            organizationId,
            recordKind: TRANSFER_RETENTION_RECORD_KIND,
            recordId,
            ...values,
          }).onConflictDoNothing().returning({ id: onbSensitiveLifecycleDeletionJobs.id });
          scheduled += created.length;
        }
      }),
  );
  return { scheduled };
}

/** Bounded global scheduler used by the established lifecycle worker. */
export async function scheduleExpiredTransferRetention(input: {
  now: Date; limit: number; organizationId?: string;
}) {
  const organizations: Array<{ organizationId: string }> = input.organizationId
    ? [{ organizationId: input.organizationId }]
    : await db.selectDistinct({ organizationId: onbTransferPrograms.organizationId })
      .from(onbTransferPrograms).orderBy(asc(onbTransferPrograms.organizationId)).limit(input.limit);
  let scheduled = 0;
  for (const { organizationId } of organizations) {
    scheduled += (await purgeExpiredTransferRetention(organizationId, input.now)).scheduled;
  }
  return scheduled;
}

export async function processTransferRetentionDeletionJob(
  job: typeof onbSensitiveLifecycleDeletionJobs.$inferSelect,
  now: Date,
): Promise<{ state: "complete" } | { state: "blocked"; message: string }> {
  return db.transaction(async (tx) => {
    const scope = parseJurisdictionRecordId(job.recordId);
    if (!scope) return { state: "blocked", message: "Transfer lifecycle job lacks a stable jurisdiction identity." };
    const context = await transferRetentionContextInTransaction(tx, job.organizationId, scope.programId, scope.jurisdiction);
    if (!context) {
      await tx.update(onbSensitiveLifecycleDeletionJobs).set({
        status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
      }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
      return { state: "complete" };
    }
    const snapshot = job.transferRetentionSnapshot as Partial<RetentionSnapshot>;
    const expected = snapshotForContext(context);
    const anchor = expected?.jurisdictions[0]?.policyRevisions["candidate-document"];
    if (!expected || !snapshotMatches(expected, snapshot) ||
        !anchor || anchor.id !== job.policyId || anchor.revision !== job.policyRevision) {
      return { state: "blocked", message: "Transfer retention policy, source custody watermark, or jurisdiction inventory changed; a fresh lifecycle evaluation is required." };
    }
    if (!contextIsDue(context, now)) {
      return { state: "blocked", message: "Transfer program is no longer eligible under its current approved retention policies." };
    }
    if (await transferHoldApplies(tx, job.organizationId)) {
      return { state: "blocked", message: "An active legal/privacy hold blocks opaque workforce-transfer deletion." };
    }
    for (const plan of context.plans) {
      const workerSnapshot = plan.workerSnapshot.filter((worker) => !context.workerIds.includes(worker.workerId));
      const pathwaySnapshot = plan.pathwaySnapshot.filter((pathway) => pathway.jurisdiction !== scope.jurisdiction);
      if (workerSnapshot.length !== plan.workerSnapshot.length ||
          pathwaySnapshot.length !== plan.pathwaySnapshot.length) {
        await tx.update(onbTransferCutoverPlans).set({
          workerSnapshot,
          workerCount: workerSnapshot.length,
          pathwaySnapshot: pathwaySnapshot as typeof onbTransferCutoverPlans.$inferInsert["pathwaySnapshot"],
        }).where(and(
          eq(onbTransferCutoverPlans.organizationId, job.organizationId),
          eq(onbTransferCutoverPlans.id, plan.id),
        ));
      }
    }
    const scopedSourceIds = [...context.workerIds, ...context.milestoneIds];
    if (scopedSourceIds.length) {
      await tx.delete(onbTransferKpiEvidence).where(and(
        eq(onbTransferKpiEvidence.organizationId, job.organizationId),
        eq(onbTransferKpiEvidence.programId, context.program.id),
        or(
          context.workerIds.length ? inArray(onbTransferKpiEvidence.workerId, context.workerIds) : undefined,
          inArray(onbTransferKpiEvidence.sourceRecordId, scopedSourceIds),
        ),
      ));
    }
    // Approved cohorts are immutable evidence. Never rewrite one to omit a
    // purged source ID: discard the affected definition and its observations
    // atomically, rather than retaining an obsolete restricted cohort.
    for (const definition of context.kpiDefinitions) {
      await tx.delete(onbTransferKpiEvidence).where(and(
        eq(onbTransferKpiEvidence.organizationId, job.organizationId),
        eq(onbTransferKpiEvidence.programId, context.program.id),
        eq(onbTransferKpiEvidence.metric, definition.metric as any),
        eq(onbTransferKpiEvidence.definitionRevision, definition.revision),
      ));
      await tx.delete(onbTransferKpiDefinitions).where(and(
        eq(onbTransferKpiDefinitions.organizationId, job.organizationId),
        eq(onbTransferKpiDefinitions.programId, context.program.id),
        eq(onbTransferKpiDefinitions.metric, definition.metric),
        eq(onbTransferKpiDefinitions.revision, definition.revision),
      ));
    }
    await tx.delete(onbTransferPopulations).where(and(
      eq(onbTransferPopulations.organizationId, job.organizationId),
      eq(onbTransferPopulations.programId, context.program.id),
      eq(onbTransferPopulations.country, scope.jurisdiction),
    ));
    if (context.milestoneIds.length) {
      await tx.delete(onbTransferOperationalSupersessions).where(and(
        eq(onbTransferOperationalSupersessions.organizationId, job.organizationId),
        eq(onbTransferOperationalSupersessions.programId, context.program.id),
        eq(onbTransferOperationalSupersessions.recordKind, "consultation-milestone"),
        inArray(onbTransferOperationalSupersessions.recordId, context.milestoneIds),
      ));
    }
    await Promise.all([
      tx.delete(onbTransferPathways).where(and(eq(onbTransferPathways.organizationId, job.organizationId), eq(onbTransferPathways.programId, context.program.id), eq(onbTransferPathways.jurisdiction, scope.jurisdiction))),
      tx.delete(onbTransferDataGovernance).where(and(eq(onbTransferDataGovernance.organizationId, job.organizationId), eq(onbTransferDataGovernance.programId, context.program.id), eq(onbTransferDataGovernance.jurisdiction, scope.jurisdiction))),
      tx.delete(onbTransferConsultationMilestones).where(and(eq(onbTransferConsultationMilestones.organizationId, job.organizationId), eq(onbTransferConsultationMilestones.programId, context.program.id), eq(onbTransferConsultationMilestones.jurisdiction, scope.jurisdiction))),
    ]);
    const remainingCountries = (context.program.countries as string[]).filter((country) => country !== scope.jurisdiction);
    if (remainingCountries.length) {
      // `updatedAt` is part of the source watermark. This is a lifecycle
      // administrative change, not new source custody, so do not advance it:
      // sibling jurisdictions that were already due must remain processable
      // from their same-time snapshots.
      await tx.update(onbTransferPrograms).set({ countries: remainingCountries }).where(and(
        eq(onbTransferPrograms.organizationId, job.organizationId),
        eq(onbTransferPrograms.id, context.program.id),
      ));
    } else {
      await tx.delete(onbTransferPrograms).where(and(
        eq(onbTransferPrograms.organizationId, job.organizationId),
        eq(onbTransferPrograms.id, context.program.id),
      ));
    }
    await tx.update(onbSensitiveLifecycleDeletionJobs).set({
      status: "completed", completedAt: now, claimOwner: null, claimUntil: null, updatedAt: now,
    }).where(eq(onbSensitiveLifecycleDeletionJobs.id, job.id));
    await appendProtectedAuditInTransaction(tx, {
      organizationId: job.organizationId, actorKind: "system", actorAuthority: "sensitive-lifecycle-worker",
      action: "privacy.sensitive-lifecycle.workforce-transfer-jurisdiction-deleted", outcome: "success",
      objectType: "workforce-transfer-jurisdiction", objectId: `${context.program.id}:${scope.jurisdiction}`,
      reviewedRevision: job.policyRevision, source: "sensitive-lifecycle-worker",
      payload: { jurisdiction: scope.jurisdiction, representations: TRANSFER_RETENTION_TABLES.length, programDeleted: !remainingCountries.length },
    });
    return { state: "complete" };
  });
}