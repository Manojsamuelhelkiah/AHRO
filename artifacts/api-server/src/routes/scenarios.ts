import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, scenariosTable, actualsOverlaysTable } from "@workspace/db";
import {
  ListScenariosResponse,
  CreateScenarioBody,
  CreateScenarioResponse,
  GetScenarioResponse,
  UpdateScenarioBody,
  UpdateScenarioResponse,
  ComputeRollupBody,
  ComputeRollupResponse,
} from "@workspace/api-zod";
import { computeRollup, computeVariance, type ScenarioInputs } from "../lib/rollup";
import { loadActiveFlowOverrides } from "./flow-overrides";
import { loadActiveCustomIntents } from "./custom-intents";
import { validateScenarioInputs, InputValidationError } from "../lib/validate-inputs";
import type { ActualsOverlay } from "../data/types";

const router: IRouter = Router();

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InputValidationError("id must be a positive integer");
  }
  return id;
}

function serialize(row: typeof scenariosTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    inputs: row.inputs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

router.get("/scenarios", async (_req, res, next) => {
  try {
    const rows = await db.select().from(scenariosTable).orderBy(scenariosTable.id);
    res.json(ListScenariosResponse.parse(rows.map(serialize)));
  } catch (err) {
    next(err);
  }
});

router.post("/scenarios", async (req, res, next) => {
  try {
    const body = CreateScenarioBody.parse(req.body);
    const [overrides, customIntents] = await Promise.all([
      loadActiveFlowOverrides(),
      loadActiveCustomIntents(),
    ]);
    const customKeys = new Set(customIntents.map((i) => i.key));
    validateScenarioInputs(body.inputs as ScenarioInputs, customKeys);
    const [row] = await db
      .insert(scenariosTable)
      .values({ name: body.name, inputs: body.inputs })
      .returning();
    res.status(201).json(CreateScenarioResponse.parse(serialize(row!)));
  } catch (err) {
    next(err);
  }
});

router.get("/scenarios/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const [row] = await db
      .select()
      .from(scenariosTable)
      .where(eq(scenariosTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    res.json(GetScenarioResponse.parse(serialize(row)));
  } catch (err) {
    next(err);
  }
});

router.patch("/scenarios/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const body = UpdateScenarioBody.parse(req.body);
    if (body.inputs !== undefined) {
      const customIntents = await loadActiveCustomIntents();
      const customKeys = new Set(customIntents.map((i) => i.key));
      validateScenarioInputs(body.inputs as ScenarioInputs, customKeys);
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates["name"] = body.name;
    if (body.inputs !== undefined) updates["inputs"] = body.inputs;
    const [row] = await db
      .update(scenariosTable)
      .set(updates)
      .where(eq(scenariosTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    res.json(UpdateScenarioResponse.parse(serialize(row)));
  } catch (err) {
    next(err);
  }
});

router.delete("/scenarios/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const [row] = await db
      .delete(scenariosTable)
      .where(eq(scenariosTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post("/rollup", async (req, res, next) => {
  try {
    const body = ComputeRollupBody.parse(req.body);
    const [overrides, customIntents] = await Promise.all([
      loadActiveFlowOverrides(),
      loadActiveCustomIntents(),
    ]);
    const inputs = body.inputs as ScenarioInputs;
    const customKeys = new Set(customIntents.map((i) => i.key));
    validateScenarioInputs(inputs, customKeys);

    // Load actuals overlay if requested.
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

    if (overlay) {
      // Two-pass: estimate without overlay, then compute with overlay, diff for variance.
      const estimated = computeRollup(inputs, overrides, undefined, customIntents);
      const actual = computeRollup(inputs, overrides, overlay, customIntents);
      const variance = computeVariance(estimated, actual);
      const response = {
        ...actual,
        calibrated: true,
        estimatedTotals: estimated.totals,
        variance,
      };
      res.json(ComputeRollupResponse.parse(response));
    } else {
      const rollup = computeRollup(inputs, overrides, undefined, customIntents);
      res.json(ComputeRollupResponse.parse(rollup));
    }
  } catch (err) {
    next(err);
  }
});

export default router;
