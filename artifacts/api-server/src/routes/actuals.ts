import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, actualsOverlaysTable } from "@workspace/db";
import {
  ListActualsOverlaysResponse,
  CreateActualsOverlayBody,
  CreateActualsOverlayResponse,
  GetActualsOverlayResponse,
  ValidateActualsOverlayBody,
  ValidateActualsOverlayResponse,
} from "@workspace/api-zod";
import { validateActualsOverlay, validateActualsOverlayOrThrow, InputValidationError } from "../lib/validate-inputs";
import type { ActualsOverlay } from "../data/types";

const router: IRouter = Router();

function serialize(row: typeof actualsOverlaysTable.$inferSelect) {
  return {
    id: row.id,
    clientLabel: row.clientLabel ?? null,
    periodStart: row.periodStart ?? null,
    periodEnd: row.periodEnd ?? null,
    payload: row.payload as ActualsOverlay,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InputValidationError("id must be a positive integer");
  }
  return id;
}

router.get("/actuals", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(actualsOverlaysTable)
      .orderBy(actualsOverlaysTable.id);
    res.json(ListActualsOverlaysResponse.parse(rows.map(serialize)));
  } catch (err) {
    next(err);
  }
});

router.post("/actuals/validate", async (req, res, next) => {
  try {
    const body = ValidateActualsOverlayBody.parse(req.body);
    const overlay = body as ActualsOverlay;
    const result = validateActualsOverlay(overlay);
    res.json(ValidateActualsOverlayResponse.parse(result));
  } catch (err) {
    next(err);
  }
});

router.post("/actuals", async (req, res, next) => {
  try {
    const body = CreateActualsOverlayBody.parse(req.body);
    const overlay = body as ActualsOverlay;
    validateActualsOverlayOrThrow(overlay);

    const [row] = await db
      .insert(actualsOverlaysTable)
      .values({
        clientLabel: overlay.clientLabel ?? null,
        periodStart: overlay.periodStart ?? null,
        periodEnd: overlay.periodEnd ?? null,
        payload: overlay as Record<string, unknown>,
      })
      .returning();
    res.status(201).json(CreateActualsOverlayResponse.parse(serialize(row!)));
  } catch (err) {
    next(err);
  }
});

router.get("/actuals/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const [row] = await db
      .select()
      .from(actualsOverlaysTable)
      .where(eq(actualsOverlaysTable.id, id));
    if (!row) {
      res.status(404).json({ error: "Actuals overlay not found" });
      return;
    }
    res.json(GetActualsOverlayResponse.parse(serialize(row)));
  } catch (err) {
    next(err);
  }
});

router.delete("/actuals/:id", async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const [row] = await db
      .delete(actualsOverlaysTable)
      .where(eq(actualsOverlaysTable.id, id))
      .returning();
    if (!row) {
      res.status(404).json({ error: "Actuals overlay not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
