import { Router, type IRouter } from "express";
import { db, customIntentsTable } from "@workspace/db";
import {
  buildIntentRegistry,
  IntentResolutionError,
  INTENT_REGISTRY_VERSION,
} from "../lib/intent-registry";
import {
  getOrganizationId,
  organizationWhere,
} from "../lib/organization-scope";

const router: IRouter = Router();

router.get("/intent-registry", async (req, res, next) => {
  try {
    const customRows = await db
      .select()
      .from(customIntentsTable)
      .where(organizationWhere(customIntentsTable, getOrganizationId(req)));
    const registry = buildIntentRegistry(customRows);
    res.json({
      version: registry.version,
      counts: registry.counts,
      executors: registry.executors,
      reference: registry.reference,
      custom: registry.custom,
      groupingParents: registry.parents,
      candidateGaps: registry.candidates,
    });
  } catch (error) {
    next(error);
  }
});

router.post("/intent-registry/resolve", async (req, res, next) => {
  try {
    const suppliedKey = typeof req.body?.key === "string" ? req.body.key.trim() : "";
    const version = typeof req.body?.registryVersion === "string"
      ? req.body.registryVersion
      : INTENT_REGISTRY_VERSION;
    if (!suppliedKey) {
      res.status(400).json({ error: "key is required" });
      return;
    }
    const customRows = await db
      .select()
      .from(customIntentsTable)
      .where(organizationWhere(customIntentsTable, getOrganizationId(req)));
    const route = buildIntentRegistry(customRows).resolve(suppliedKey, version);
    res.json({ version: INTENT_REGISTRY_VERSION, route });
  } catch (error) {
    if (error instanceof IntentResolutionError) {
      const status = error.code === "UNKNOWN_OUTCOME" ? 404
        : error.code === "UNSUPPORTED_OUTCOME" ? 422
        : 409;
      res.status(status).json({ error: error.message, code: error.code, repair: error.repair });
      return;
    }
    next(error);
  }
});

export default router;