import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import multer from "multer";
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
import { loadActiveCustomIntents } from "./custom-intents";
import { aggregateCallLog } from "../lib/aggregate-log";
import type { ActualsOverlay } from "../data/types";
import { intentMap } from "../data/intents";
import { CustomIntentStorageUnavailableError } from "../middlewares/error-handler";

const router: IRouter = Router();

export function overlayRequiresCustomIntentLookup(overlay: ActualsOverlay): boolean {
  return overlay.intents?.some(({ intentKey }) => !intentMap[intentKey]) ?? false;
}

export async function loadCustomIntentsWhenRequired(
  requiresLookup: boolean,
  load: typeof loadActiveCustomIntents = loadActiveCustomIntents,
) {
  if (!requiresLookup) return [];
  try {
    return await load();
  } catch (error) {
    throw new CustomIntentStorageUnavailableError({ cause: error });
  }
}

async function customIntentKeysForOverlay(overlay: ActualsOverlay): Promise<Set<string>> {
  const customIntents = await loadCustomIntentsWhenRequired(
    overlayRequiresCustomIntentLookup(overlay),
  );
  return new Set(customIntents.map((intent) => intent.key));
}

// 20 MB limit for raw call-log uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

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
    const customKeys = await customIntentKeysForOverlay(overlay);
    const result = validateActualsOverlay(overlay, customKeys);
    res.json(ValidateActualsOverlayResponse.parse(result));
  } catch (err) {
    next(err);
  }
});

router.post(
  "/actuals/parse-log",
  upload.single("logFile"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new InputValidationError("logFile field is required");
      }
      const csvText = req.file.buffer.toString("utf-8");
      const referenceResult = aggregateCallLog(csvText);
      const result = referenceResult.unknownIntents.length === 0
        ? referenceResult
        : aggregateCallLog(
          csvText,
          await loadCustomIntentsWhenRequired(true),
        );
      res.json(result);
    } catch (err) {
      next(err);
    }
  },
);

router.post("/actuals", async (req, res, next) => {
  try {
    const body = CreateActualsOverlayBody.parse(req.body);
    const overlay = body as ActualsOverlay;
    const customKeys = await customIntentKeysForOverlay(overlay);
    validateActualsOverlayOrThrow(overlay, customKeys);

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
