import { Router, type IRouter } from "express";
import { and, eq, isNull, sql, desc } from "drizzle-orm";
import { db, onbCases, onbSettings, organizationMembershipsTable, DEMO_ORGANIZATION_ID } from "@workspace/db";
import {
  CreateWorkforceReviewCaseBody, UpdateWorkforceReviewCaseBody, GetWorkforceInsightsResponse, GetWorkforceInsightsQueryParams,
} from "@workspace/api-zod";
import { getOrganizationId } from "../lib/organization-scope";
import { isPlatformSuperAdmin } from "../lib/private-platform-admin";
import { isInternalAccount } from "../lib/member-identities";
import { demoPrincipalSettingKey, parseRegisteredDemoProfile } from "../lib/demo-principal";
import { resolveEffectiveAccessInTransaction } from "../lib/access-governance";
import {
  WORKFORCE_INSIGHTS_KEY, WorkforceInsightsError, emptyWorkforceState, fail,
  createHumanWorkforceReview, updateWorkforceReview, type WorkforceState,
} from "../lib/workforce-insights";
import { eligibleRiskExampleSource, riskExampleStore, visibleRiskExamples, WORKFORCE_EXAMPLES_KEY } from "../lib/workforce-risk-examples";
import { isFictionalOfflineExampleCase } from "../lib/onboarding/offline-example-display";
import { actionCenterFamily, matchesActionCenterContext } from "../lib/onboarding/action-center-family";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function administrator(tx: Tx, organizationId: string, userId: string): Promise<boolean> {
  if (isPlatformSuperAdmin(userId, organizationId)) return true;
  if (isInternalAccount(userId)) return false;
  const [demo] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID), eq(onbSettings.key, demoPrincipalSettingKey(userId)),
  ));
  if (parseRegisteredDemoProfile(demo?.value)) return false;
  const [member] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    eq(organizationMembershipsTable.clerkUserId, userId), isNull(organizationMembershipsTable.revokedAt),
  ));
  return member?.role === "admin" || member?.role === "owner";
}
async function loadState(tx: Tx, organizationId: string): Promise<WorkforceState> {
  const [row] = await tx.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, WORKFORCE_INSIGHTS_KEY),
  ));
  if (!row) return emptyWorkforceState();
  // Corrupt or incompatible persisted data must fail explicitly, not disappear.
  const value = JSON.parse(row.value) as WorkforceState;
  if (!Number.isSafeInteger(value.version) || value.version < 0 || !Array.isArray(value.assessments) || !Array.isArray(value.reviews)) {
    fail(409, "Early-warning records require administrative repair.");
  }
  return {
    version: value.version,
    assessments: value.assessments.map(row => GetWorkforceInsightsResponse.shape.assessments.element.parse(row)),
    reviews: value.reviews.map(row => GetWorkforceInsightsResponse.shape.reviews.element.parse(row)),
  };
}
async function casePermission(tx: Tx, organizationId: string, userId: string, caseId: number, edit: boolean) {
  const access = await resolveEffectiveAccessInTransaction(tx, {
    organizationId, principalType: "human", principalId: userId, caseId, purpose: "workforce-early-warning",
  });
  return ["flow.case.read", "data.case.profile.read", "data.case.notes.read",
    ...(edit ? ["flow.case.edit", "data.case.notes.edit"] : [])].every(key => access.allows.includes(key as never));
}
async function owners(tx: Tx, organizationId: string, actor: string) {
  const members = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId), isNull(organizationMembershipsTable.revokedAt),
  ));
  const result: { userId: string; label: string }[] = [];
  for (const member of members) {
    if (await administrator(tx, organizationId, member.clerkUserId)) {
      result.push({ userId: member.clerkUserId, label: member.clerkUserId === actor ? "Me — current administrator" : member.clerkUserId });
    }
  }
  if (!result.some(row => row.userId === actor)) result.push({ userId: actor, label: "Me — current administrator" });
  return result.sort((left, right) => Number(right.userId === actor) - Number(left.userId === actor));
}
async function snapshot(tx: Tx, organizationId: string, actor: string, state: WorkforceState, filters: typeof GetWorkforceInsightsQueryParams._type = {}) {
  const rows = await tx.select().from(onbCases)
    .where(eq(onbCases.organizationId, organizationId)).orderBy(desc(onbCases.id));
  const subjects = [];
  for (const row of rows) {
    if (filters.caseType && actionCenterFamily(row) !== filters.caseType) continue;
    if (!matchesActionCenterContext(row, filters)) continue;
    if (!await casePermission(tx, organizationId, actor, row.id, false)) continue;
    subjects.push({ caseId: row.id, reference: `${row.syntheticProvenance ? "S" : "HRO"}${row.id}`,
      displayName: isFictionalOfflineExampleCase(row) ? row.workerName.replace(/^(?:Example|Demo sample)\s*—\s*/, "") : row.workerName,
      sourceRevision: row.updatedAt.toISOString() });
  }
  const allowed = new Set(subjects.map(row => row.caseId));
  const [exampleRow] = organizationId === "demo" ? await tx.select().from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, WORKFORCE_EXAMPLES_KEY),
  )) : [];
  const riskExamples = visibleRiskExamples(organizationId,
    exampleRow ? riskExampleStore.parse(JSON.parse(exampleRow.value)) : [],
    rows.filter(row => allowed.has(row.id)));
  // Indicator freshness is not a retention policy for a review's work/history.
  const eligibleExampleCases = new Set(rows.filter(eligibleRiskExampleSource).map(row => row.id));
  return GetWorkforceInsightsResponse.parse({
    organizationId, version: state.version, modelStatus: "not-connected", canManage: true,
    subjects,
    // No approved model is connected. Historical/future payloads never imply live predictions.
    assessments: [],
    riskExamples,
    reviews: state.reviews.filter(row => allowed.has(row.caseId) &&
      (row.origin !== "catalogue" || eligibleExampleCases.has(row.caseId))),
    owners: await owners(tx, organizationId, actor),
    coverageNote: "Showing permitted source cases for this client.",
  });
}

export function createWorkforceInsightsRouter(): IRouter {
  const router: IRouter = Router();
  router.use("/workforce-insights", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });
  router.get("/workforce-insights", async (req, res, next): Promise<void> => {
    try {
      const organizationId = getOrganizationId(req), actor = req.authUserId!;
      // Generated boolean coercion treats the string "false" as true.
      const raw: Record<string, unknown> = { ...req.query };
      for (const key of ["safetyCritical", "siteExposure"]) {
        if (raw[key] === "true") raw[key] = true;
        else if (raw[key] === "false") raw[key] = false;
        else if (raw[key] !== undefined) { res.status(400).json({ message: "Invalid job-context filter." }); return; }
      }
      const filters = GetWorkforceInsightsQueryParams.safeParse(raw);
      if (!filters.success) { res.status(400).json({ message: "Invalid early-warning discovery filters." }); return; }
      const result = await db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
        if (!await administrator(tx, organizationId, actor)) fail(403, "Current client administrator access is required for workforce insights.");
        return snapshot(tx, organizationId, actor, await loadState(tx, organizationId), filters.data);
      });
      res.json(result);
    } catch (error) {
      if (error instanceof WorkforceInsightsError) { res.status(error.status).json({ message: error.message }); return; }
      next(error);
    }
  });
  for (const method of ["post", "patch"] as const) {
    const path = method === "post" ? "/workforce-insights/reviews" : "/workforce-insights/reviews/:reviewId";
    router[method](path, async (req, res, next): Promise<void> => {
      try {
        const organizationId = getOrganizationId(req), actor = req.authUserId!;
        const body = method === "post" ? CreateWorkforceReviewCaseBody.parse(req.body) : UpdateWorkforceReviewCaseBody.parse(req.body);
        if (method === "post" && (!Number.isSafeInteger((body as typeof CreateWorkforceReviewCaseBody._type).caseId) ||
          (body as typeof CreateWorkforceReviewCaseBody._type).caseId <= 0)) fail(400, "Choose a valid source case.");
        const result = await db.transaction(async tx => {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
          if (!await administrator(tx, organizationId, actor)) fail(403, "Current client administrator access is required.");
          const current = await loadState(tx, organizationId);
          const reviewId = "reviewId" in req.params ? String(req.params.reviewId) : "";
          const review = method === "patch" ? current.reviews.find(row => row.id === reviewId) : null;
          if (method === "patch" && !review) fail(404, "Review case not found.");
          const caseId = method === "post" ? (body as typeof CreateWorkforceReviewCaseBody._type).caseId : review!.caseId;
          const [source] = await tx.select({ id: onbCases.id }).from(onbCases).where(and(
            eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
          ));
          if (!source) fail(404, "Source case unavailable in this client.");
          if (!await casePermission(tx, organizationId, actor, caseId, true)) fail(403, "Current source-case read, edit and notes permissions are required.");
          if (!await administrator(tx, organizationId, body.ownerUserId)) fail(404, "Choose a current administrator of this client as the human review owner.");
          const updated = method === "post"
            ? createHumanWorkforceReview(current, body as typeof CreateWorkforceReviewCaseBody._type, actor)
            : updateWorkforceReview(current, reviewId, body as typeof UpdateWorkforceReviewCaseBody._type, actor);
          if (updated !== current) {
            await tx.insert(onbSettings).values({ organizationId, key: WORKFORCE_INSIGHTS_KEY, value: JSON.stringify(updated) })
              .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key],
                set: { value: JSON.stringify(updated), updatedAt: new Date() } });
          }
          return snapshot(tx, organizationId, actor, updated);
        });
        res.json(result);
      } catch (error) {
        if (error instanceof WorkforceInsightsError) { res.status(error.status).json({ message: error.message }); return; }
        if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
          res.status(400).json({ message: "Invalid early-warning review fields. Check the case, dates and required text." }); return;
        }
        next(error);
      }
    });
  }
  return router;
}
export default createWorkforceInsightsRouter();
