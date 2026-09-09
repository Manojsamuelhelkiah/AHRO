import { Router, type IRouter } from "express";
import multer from "multer";
import { ExportScenarioWorkbookBody, ImportScenarioWorkbookResponse } from "@workspace/api-zod";
import { buildScenarioWorkbook, parseScenarioWorkbook } from "../lib/workbook";
import { validateScenarioInputs, InputValidationError } from "../lib/validate-inputs";
import { loadActiveCustomIntents } from "./custom-intents";
import type { ScenarioInputs } from "../lib/rollup";
import {
  ensureBaselineRateSet,
  loadAndValidateCurrentRateSet,
  type RateSetReference,
} from "../lib/pricing-rate-sets";
import {
  getOrganizationId,
} from "../lib/organization-scope";

const router: IRouter = Router();

// 10 MB is generous for a filled-in workbook.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function sendWorkbook(
  inputs: ScenarioInputs,
  organizationId: string,
  res: Parameters<Parameters<IRouter["post"]>[1]>[1],
) {
  await ensureBaselineRateSet(organizationId);
  const [customIntents, currentRateSet] = await Promise.all([
    loadActiveCustomIntents(organizationId),
    loadAndValidateCurrentRateSet(organizationId),
  ]);
  validateScenarioInputs(inputs, new Set(customIntents.map((i) => i.key)));
  const rateSetReference: RateSetReference = {
    rateSetId: currentRateSet.id,
    effectiveDate: currentRateSet.effectiveDate,
    rationale: currentRateSet.rationale,
    createdBy: currentRateSet.createdBy,
    createdAt: currentRateSet.createdAt.toISOString(),
  };
  const buffer = await buildScenarioWorkbook(
    inputs,
    customIntents,
    currentRateSet.rates,
    rateSetReference,
  );
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", 'attachment; filename="hro-cost-shadow.xlsx"');
  res.send(buffer);
}

// GET variant for direct-navigation downloads (mobile browsers block
// blob-based programmatic downloads, especially inside the preview iframe).
// `q` is base64url-encoded JSON: { inputs: ScenarioInputs }.
router.get("/workbook/export", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    if (!q) {
      // No payload → serve the default reference scenario. Keeps the share
      // link short and un-mangleable on mobile.
      await sendWorkbook(
        {
          numSystems: 5, annualTransactions: 50000, employees: 5000,
          sector: "technology", companyType: "multi-country", isolationTier: "siloed",
          hrHourlyCostUsd: 45, hitlHourlyCostUsd: 35, countries: 3,
        } as ScenarioInputs,
        getOrganizationId(req),
        res,
      );
      return;
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(Buffer.from(q, "base64url").toString("utf8"));
    } catch {
      throw new InputValidationError("q parameter is not valid base64url-encoded JSON");
    }
    const body = ExportScenarioWorkbookBody.parse(parsedBody);
    await sendWorkbook(body.inputs as ScenarioInputs, getOrganizationId(req), res);
  } catch (err) {
    next(err);
  }
});

router.post("/workbook/export", async (req, res, next) => {
  try {
    const body = ExportScenarioWorkbookBody.parse(req.body);
    await sendWorkbook(body.inputs as ScenarioInputs, getOrganizationId(req), res);
  } catch (err) {
    next(err);
  }
});

router.post("/workbook/import", upload.single("workbookFile"), async (req, res, next) => {
  try {
    if (!req.file) throw new InputValidationError("No workbook file uploaded (field name must be workbookFile)");
    const inputs = await parseScenarioWorkbook(req.file.buffer);
    const customIntents = await loadActiveCustomIntents(getOrganizationId(req));
    validateScenarioInputs(inputs, new Set(customIntents.map((i) => i.key)));
    res.json(ImportScenarioWorkbookResponse.parse({ inputs }));
  } catch (err) {
    next(err);
  }
});

export default router;
