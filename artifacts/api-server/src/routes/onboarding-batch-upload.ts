import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db, onbCases, onbIntakeBatchPeople, onbIntakeBatches } from "@workspace/db";
import { assertBatchFamilyEnabled, ClientOperationsError } from "../lib/onboarding/client-operations-settings";
import { requireBatchAdministrator, createHeldBatch, type BatchPerson } from "./onboarding-batch-intake";
import { serializeCaseForRequest } from "./onboarding";
import { getOrganizationId } from "../lib/organization-scope";
import { resolveEffectiveAccessInTransaction } from "../lib/access-governance";
import { HRO_BATCH_TEMPLATES, findHroTemplate, validateHroRows, canonicalIntakeHash, hroRequestForRow, readHroBatchRequest, type IntakeTemplate, type HroIntakeRow } from "../lib/onboarding/hro-batch-templates";
import { parseHroSpreadsheet, hroUploadMultipart } from "../lib/onboarding/hro-batch-files";
import catalogRouter from "./onboarding-batch-catalog";
import { evaluateCaseDerivedLifecycleGateInTransaction, withSensitiveLifecycleFence } from "../lib/onboarding/sensitive-lifecycle";
import { createSeparations } from "../lib/offboarding/service";
import { SeparationError } from "../lib/offboarding/model";

const router: IRouter = Router();
const upload = hroUploadMultipart;
async function authorizeIntake(req: Request, res: Response, write = true): Promise<boolean> {
  if (!requireBatchAdministrator(req, res)) return false;
  const access = await db.transaction(tx => resolveEffectiveAccessInTransaction(tx, {
    organizationId: getOrganizationId(req), principalType: "human", principalId: req.authUserId!, purpose: write ? "hro-template-intake" : "hro-template-history",
  }));
  const required = write ? ["flow.case.edit", "data.case.profile.edit", "data.case.notes.edit"] : ["flow.case.read", "data.case.profile.read"];
  if (required.some(key => !access.allows.includes(key))) {
    res.status(403).json({ message: write ? "Explicit case-flow, profile and notes edit grants are required for template intake." : "Current case-flow and profile read access is required for batch history." });
    return false;
  }
  return true;
}
function personForRequest(definition: IntakeTemplate, row: HroIntakeRow): BatchPerson {
  const bool = (value: string) => value === "yes" ? true : value === "no" ? false : undefined;
  return {
    personKey: row.request_id, workerName: row.worker_name, workerEmail: row.worker_email,
    channelPreference: "email", hireType: definition.hireType ?? "service-request",
    workerCategory: row.worker_category || "unspecified", role: row.role || "",
    department: row.department, geography: row.work_country, legalEntity: row.legal_entity,
    managerName: row.manager_name || "", recruiterName: row.recruiter_name || "",
    joiningDate: row.joining_date || row.effective_date,
    ...(row.job_profile_id ? { jobProfileId: row.job_profile_id } : {}),
    workforceContext: {
      workCountry: row.work_country, department: row.department, legalEntity: row.legal_entity,
      hiringMode: "batch",
      ...(row.work_environment ? { workEnvironment: row.work_environment as "office" | "remote" | "site" | "field" | "mixed" } : {}),
      ...(row.site ? { site: row.site } : {}),
      ...Object.fromEntries(["site_exposure", "safety_critical", "assisted_intake"].map((key, index) => [["siteExposure", "safetyCritical", "assistedIntake"][index], bool(row[key])])),
    },
    batchRequest: hroRequestForRow(definition, row),
  };
}
async function checkPreviewCollection(req: Request, rows: HroIntakeRow[]): Promise<void> {
  const organizationId = getOrganizationId(req);
  const countries = [...new Set(rows.map(row => row.work_country))];
  await withSensitiveLifecycleFence(organizationId, () => db.transaction(async tx => {
    for (const jurisdiction of countries) {
      const gate = await evaluateCaseDerivedLifecycleGateInTransaction(tx, { organizationId, jurisdiction });
      if (!gate.allowed) throw Object.assign(new Error(gate.reason), { statusCode: 409 });
    }
  }));
}
router.use(catalogRouter);
router.post("/onboarding/batch-upload/validate", async (req, res, next) => {
  if (!(await authorizeIntake(req, res))) return;
  upload(req, res, error => {
    void (async () => {
      if (error) { res.status(400).json({ message: "Upload one CSV/XLSX file up to 2 MB with the selected template ID and version." }); return; }
      if (!req.file) { res.status(400).json({ message: "Select a CSV or XLSX file." }); return; }
      const version = Number(req.body.templateVersion);
      const definition = findHroTemplate(req.body.templateId);
      if (!definition || !Number.isInteger(version) || definition.version !== version) { res.status(400).json({ message: "Download a current template first." }); return; }
      let rows: HroIntakeRow[];
      try { rows = await parseHroSpreadsheet(req.file.buffer, req.file.originalname); }
      catch (error) {
        res.status(400).json({ message: (error as { statusCode?: number }).statusCode === 400 ? (error as Error).message : "The file could not be parsed. Use a fresh Excel/CSV template." }); return;
      } finally { req.file.buffer.fill(0); delete req.file; }
      try { await assertBatchFamilyEnabled(getOrganizationId(req), definition.id); }
      catch (error) {
        if (error instanceof ClientOperationsError) { res.status(error.status).json({ message: error.message }); return; }
        throw error;
      }
      const result = validateHroRows(definition.id, version, rows);
      if (result.valid) await checkPreviewCollection(req, result.rows);
      res.setHeader("Cache-Control", "no-store");
      res.json(result);
    })().catch(next);
  });
});
router.post("/onboarding/batch-upload", async (req, res, next) => {
  if (!(await authorizeIntake(req, res))) return;
  const { templateId, templateVersion, name, rows } = req.body ?? {};
  const validated = validateHroRows(templateId, templateVersion, rows);
  if (!validated.valid) { res.status(400).json({ message: "Fix the template validation errors before creating any cases.", issues: validated.issues }); return; }
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120 || /[\u0000-\u001f]/.test(name)) { res.status(400).json({ message: "Enter a batch name of 1–120 plain-text characters." }); return; }
  const definition = findHroTemplate(templateId)!;
  try { await assertBatchFamilyEnabled(getOrganizationId(req), definition.id); }
  catch (error) {
    if (error instanceof ClientOperationsError) res.status(error.status).json({ message: error.message });
    else next(error);
    return;
  }
  if (definition.id === "offboarding-separation") {
    try {
      const results = await createSeparations(getOrganizationId(req), req.authUserId!, {
        entries: validated.rows.map(row => ({ sourceReference: row.request_id, facts: {
          employeeId: row.employee_id, workerName: row.worker_name, exitType: row.separation_type, exitReason: row.exit_reason,
          lastWorkingDay: row.last_working_date, terminationDate: row.termination_date, timeZone: row.time_zone,
          role: row.role, department: row.department, country: row.work_country, legalEntity: row.legal_entity, workerCategory: row.worker_category, manager: row.manager_name,
        } })),
      }, "batch");
      // Existing uploader consumes this envelope; no onboarding batch-release record is created.
      res.status(201).json({ batchId: `separation:${canonicalIntakeHash(validated.rows)}`, name: name.trim(), retry: results.every(r => r.status === "deduplicated"), results: results.map((r, i) => ({ personKey: validated.rows[i].request_id, caseId: r.caseId, status: r.status === "deduplicated" ? "reconciled" : "created", profileId: "offboarding-review-pending", profileVersion: 0 })), lifecycle: "separation" });
    } catch (error) { if (error instanceof SeparationError) res.status(error.status).json({ message: error.message }); else next(error); }
    return;
  }
  const people = validated.rows.map(row => personForRequest(definition, row)).sort((a, b) => a.personKey.localeCompare(b.personKey));
  res.locals.hroBatchPeople = people;
  req.body = { name: name.trim(), idempotencyKey: `hro:${canonicalIntakeHash({ name: name.trim(), people })}`, people };
  res.setHeader("Cache-Control", "no-store");
  await createHeldBatch(req, res, next);
});
router.get("/onboarding/batch-upload/history", async (req, res) => {
  if (!(await authorizeIntake(req, res, false))) return;
  const organizationId = getOrganizationId(req);
  const batches = await db.select().from(onbIntakeBatches).where(and(eq(onbIntakeBatches.organizationId, organizationId), eq(onbIntakeBatches.createdBy, req.authUserId!))).orderBy(desc(onbIntakeBatches.createdAt)).limit(10);
  const history = [];
  for (const batch of batches) {
    const linked = await db.select({ case: onbCases }).from(onbIntakeBatchPeople)
      .innerJoin(onbCases, and(eq(onbCases.organizationId, onbIntakeBatchPeople.organizationId), eq(onbCases.id, onbIntakeBatchPeople.caseId)))
      .where(and(eq(onbIntakeBatchPeople.organizationId, organizationId), eq(onbIntakeBatchPeople.batchId, batch.batchId)));
    const visible = [];
    for (const { case: record } of linked) {
      if (!readHroBatchRequest(record.processPolicySnapshot)) continue;
      const serialized = await serializeCaseForRequest(req, record);
      if (serialized.batchIntake) visible.push(serialized);
    }
    if (!visible.length) continue;
    const request = visible[0].batchIntake!;
    history.push({ batchId: batch.batchId, name: visible.length === linked.length ? batch.name : "Partially accessible batch", createdAt: batch.createdAt.toISOString(), family: request.family, templateId: request.templateId, caseIds: visible.map(row => row.id), count: visible.length });
  }
  // Re-evaluate current membership/grants after asynchronous case projection;
  // never let a long history query survive loss of its admission authority.
  if (!(await authorizeIntake(req, res, false))) return;
  res.setHeader("Cache-Control", "no-store");
  res.json(history);
});
export default router;
