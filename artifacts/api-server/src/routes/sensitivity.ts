import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, actualsOverlaysTable } from "@workspace/db";
import { ComputeSensitivityBody, ComputeSensitivityResponse } from "@workspace/api-zod";
import type { ActualsOverlay } from "../data/types";
import { computeSensitivity } from "../lib/sensitivity";
import { validateScenarioInputs } from "../lib/validate-inputs";
import { loadActiveFlowOverrides } from "./flow-overrides";
import { loadActiveCustomIntents } from "./custom-intents";
import type { ScenarioInputs } from "../lib/rollup";

const router: IRouter = Router();

router.post("/sensitivity", async (req, res, next) => {
  try {
    const body = ComputeSensitivityBody.parse(req.body);
    const [overrides, customIntents] = await Promise.all([
      loadActiveFlowOverrides(),
      loadActiveCustomIntents(),
    ]);
    const inputs = body.inputs as ScenarioInputs;
    validateScenarioInputs(inputs, new Set(customIntents.map((i) => i.key)));

    // Same overlay semantics as /rollup so the tornado matches the on-screen rollup.
    let overlay: ActualsOverlay | undefined;
    if (body.actualsOverlayId !== undefined) {
      const [overlayRow] = await db
        .select()
        .from(actualsOverlaysTable)
        .where(eq(actualsOverlaysTable.id, body.actualsOverlayId));
      if (!overlayRow) {
        res.status(400).json({ error: `Actuals overlay ${body.actualsOverlayId} not found` });
        return;
      }
      overlay = overlayRow.payload as ActualsOverlay;
    }

    const result = computeSensitivity(inputs, overrides, customIntents, overlay);
    res.json(ComputeSensitivityResponse.parse(result));
  } catch (err) {
    next(err);
  }
});

export default router;
