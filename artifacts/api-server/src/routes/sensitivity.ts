import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, actualsOverlaysTable } from "@workspace/db";
import { ComputeSensitivityBody, ComputeSensitivityResponse } from "@workspace/api-zod";
import type { ActualsOverlay } from "../data/types";
import { computeSensitivity } from "../lib/sensitivity";
import { validateScenarioInputs } from "../lib/validate-inputs";
import { loadActiveFlowOverrides } from "./flow-overrides";
import { loadActiveCustomIntents } from "./custom-intents";
import type { ScenarioInputs } from "../lib/rollup";
import {
  ensureBaselineRateSet,
  loadAndValidateCurrentRateSet,
} from "../lib/pricing-rate-sets";
import {
  getOrganizationId,
  organizationWhere,
} from "../lib/organization-scope";

const router: IRouter = Router();

router.post("/sensitivity", async (req, res, next) => {
  try {
    const body = ComputeSensitivityBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    await ensureBaselineRateSet(organizationId);
    const [overrides, customIntents, currentRateSet] = await Promise.all([
      loadActiveFlowOverrides(organizationId),
      loadActiveCustomIntents(organizationId),
      loadAndValidateCurrentRateSet(organizationId),
    ]);
    const inputs = body.inputs as ScenarioInputs;
    validateScenarioInputs(inputs, new Set(customIntents.map((i) => i.key)));

    // Same overlay semantics as /rollup so the tornado matches the on-screen rollup.
    let overlay: ActualsOverlay | undefined;
    if (body.actualsOverlayId !== undefined) {
      const [overlayRow] = await db
        .select()
        .from(actualsOverlaysTable)
        .where(and(
          eq(actualsOverlaysTable.id, body.actualsOverlayId),
          organizationWhere(actualsOverlaysTable, organizationId),
        ));
      if (!overlayRow) {
        res.status(400).json({ error: `Actuals overlay ${body.actualsOverlayId} not found` });
        return;
      }
      overlay = overlayRow.payload as ActualsOverlay;
    }

    const result = computeSensitivity(
      inputs,
      overrides,
      customIntents,
      overlay,
      currentRateSet.rates,
    );
    res.json(ComputeSensitivityResponse.parse(result));
  } catch (err) {
    next(err);
  }
});

export default router;
