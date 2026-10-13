import { Router, type IRouter } from "express";
import { db, customIntentsTable, type CustomIntentRow } from "@workspace/db";
import { buildIntentCatalog, catalogDefinition } from "../lib/intent-catalog";
import { getOrganizationId, organizationWhere } from "../lib/organization-scope";

export function createIntentCatalogRouter(loadRows: (organizationId: string) => Promise<CustomIntentRow[]> = async organizationId =>
  db.select().from(customIntentsTable).where(organizationWhere(customIntentsTable, organizationId))): IRouter {
  const router: IRouter = Router();
  router.get(["/intent-catalog", "/intent-catalog/export", "/intent-catalog/definitions/:key"], async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const customRows = await loadRows(organizationId);
    const catalog = buildIntentCatalog(customRows, organizationId);
    res.setHeader("Cache-Control", "private, no-store");
    if (typeof req.params["key"] === "string") {
      const definition = catalogDefinition(catalog, req.params["key"]);
      if (!definition) { res.status(404).json({ error: "Unknown or inaccessible catalog outcome" }); return; }
      res.json(definition);
      return;
    }
    if (req.path.endsWith("/export")) {
      res.setHeader("Content-Disposition", `attachment; filename="${catalog.version}.json"`);
    }
    res.json(catalog);
  } catch (error) { next(error); }
  });
  return router;
}
export default createIntentCatalogRouter();
