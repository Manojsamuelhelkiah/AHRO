import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { HRO_BATCH_TEMPLATES, findHroTemplate } from "../lib/onboarding/hro-batch-templates";
import { buildHroTemplate } from "../lib/onboarding/hro-batch-files";

// The parent API middleware verifies authentication and active tenant
// membership. Catalog definitions contain no client or employee records;
// submitting personal data remains guarded by the separate intake router.
function requireCatalogContext(req: Request, res: Response, next: NextFunction) {
  if (!req.authUserId) {
    res.status(401).json({ message: "Sign in to browse batch templates." });
    return;
  }
  if (!req.organizationId) {
    res.status(403).json({ message: "Active organization membership is required to browse batch templates." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
  next();
}

const router: IRouter = Router();
router.get("/onboarding/batch-upload/templates", requireCatalogContext, (_req, res) => {
  res.json(HRO_BATCH_TEMPLATES);
});
router.get("/onboarding/batch-upload/templates/:templateId/download", requireCatalogContext, async (req, res) => {
  const definition = findHroTemplate(req.params.templateId);
  const format = req.query.format;
  if (!definition || (format !== "csv" && format !== "xlsx")) {
    res.status(400).json({ message: "Choose a supported template and CSV or XLSX format." });
    return;
  }
  const bytes = await buildHroTemplate(definition, format);
  res.setHeader("Content-Type", format === "csv" ? "text/csv; charset=utf-8" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${definition.id}-v${definition.version}.${format}"`);
  res.send(bytes);
});

export default router;
