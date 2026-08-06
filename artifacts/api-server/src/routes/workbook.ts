import { Router, type IRouter } from "express";
import multer from "multer";
import { ExportScenarioWorkbookBody, ImportScenarioWorkbookResponse } from "@workspace/api-zod";
import { buildScenarioWorkbook, parseScenarioWorkbook } from "../lib/workbook";
import { validateScenarioInputs, InputValidationError } from "../lib/validate-inputs";
import { loadActiveCustomIntents } from "./custom-intents";
import type { ScenarioInputs } from "../lib/rollup";

const router: IRouter = Router();

// 10 MB is generous for a filled-in workbook.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post("/workbook/export", async (req, res, next) => {
  try {
    const body = ExportScenarioWorkbookBody.parse(req.body);
    const inputs = body.inputs as ScenarioInputs;
    const customIntents = await loadActiveCustomIntents();
    validateScenarioInputs(inputs, new Set(customIntents.map((i) => i.key)));
    const buffer = await buildScenarioWorkbook(inputs, customIntents);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", 'attachment; filename="hro-cost-shadow.xlsx"');
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

router.post("/workbook/import", upload.single("workbookFile"), async (req, res, next) => {
  try {
    if (!req.file) throw new InputValidationError("No workbook file uploaded (field name must be workbookFile)");
    const inputs = await parseScenarioWorkbook(req.file.buffer);
    const customIntents = await loadActiveCustomIntents();
    validateScenarioInputs(inputs, new Set(customIntents.map((i) => i.key)));
    res.json(ImportScenarioWorkbookResponse.parse({ inputs }));
  } catch (err) {
    next(err);
  }
});

export default router;
