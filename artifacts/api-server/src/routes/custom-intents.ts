import { Router, type IRouter } from "express";
import { eq, and, ne } from "drizzle-orm";
import { db, customIntentsTable } from "@workspace/db";
import { flowClassMap } from "../data/flow-classes";
import { intentMap } from "../data/intents";
import { InputValidationError } from "../lib/validate-inputs";
import type { Intent } from "../data/types";

const router: IRouter = Router();

/** Slug-ify a name and append a suffix if there is a collision. */
async function generateKey(name: string, excludeId?: number): Promise<string> {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70);
  const candidates = [base, ...Array.from({ length: 9 }, (_, i) => `${base}-${i + 2}`)];
  for (const k of candidates) {
    if (intentMap[k]) continue; // collides with reference corpus
    const existing = await db
      .select({ id: customIntentsTable.id })
      .from(customIntentsTable)
      .where(
        excludeId !== undefined
          ? and(eq(customIntentsTable.key, k), ne(customIntentsTable.id, excludeId))
          : eq(customIntentsTable.key, k),
      )
      .limit(1);
    if (existing.length === 0) return k;
  }
  // Fallback: append timestamp
  return `${base}-${Date.now()}`;
}

function validateFields(body: Record<string, unknown>, partial = false) {
  const req = (field: string) => !partial || body[field] !== undefined;

  if (req("name")) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      throw new InputValidationError("name is required and must be a non-empty string");
    }
  }
  if (req("domain")) {
    if (typeof body.domain !== "string" || !body.domain.trim() || body.domain.trim().length > 60) {
      throw new InputValidationError("domain must be a non-empty string (max 60 chars)");
    }
  }
  if (req("flowClass")) {
    if (!body.flowClass || !flowClassMap[body.flowClass as string]) {
      throw new InputValidationError(
        `flowClass must be one of: ${Object.keys(flowClassMap).join(", ")}`,
      );
    }
  }
  if (req("description")) {
    if (typeof body.description !== "string" || !body.description.trim()) {
      throw new InputValidationError("description is required");
    }
  }
  if (req("source")) {
    if (typeof body.source !== "string" || !body.source.trim()) {
      throw new InputValidationError("source (rationale/provenance) is required");
    }
  }
  if (req("author")) {
    if (typeof body.author !== "string" || !body.author.trim()) {
      throw new InputValidationError("author is required");
    }
  }
  if (req("asIsHandlingMin")) {
    const v = Number(body.asIsHandlingMin);
    if (!Number.isFinite(v) || v < 0 || v > 600) {
      throw new InputValidationError("asIsHandlingMin must be between 0 and 600");
    }
  }
  if (req("toBeHumanMin")) {
    const v = Number(body.toBeHumanMin);
    if (!Number.isFinite(v) || v < 0 || v > 600) {
      throw new InputValidationError("toBeHumanMin must be between 0 and 600");
    }
  }
  // Cross-field: toBeHumanMin must not exceed asIsHandlingMin
  const asIs = body.asIsHandlingMin !== undefined ? Number(body.asIsHandlingMin) : undefined;
  const toBe = body.toBeHumanMin !== undefined ? Number(body.toBeHumanMin) : undefined;
  if (asIs !== undefined && toBe !== undefined && toBe > asIs) {
    throw new InputValidationError("toBeHumanMin must not exceed asIsHandlingMin");
  }
  if (req("baseWeight")) {
    const v = Number(body.baseWeight);
    if (!Number.isFinite(v) || v < 0.1 || v > 20) {
      throw new InputValidationError("baseWeight must be between 0.1 and 20");
    }
  }
  for (const field of ["actGetActions", "actPutActions"] as const) {
    if (req(field)) {
      const v = Number(body[field]);
      if (!Number.isInteger(v) || v < 0 || v > 50) {
        throw new InputValidationError(`${field} must be a whole number between 0 and 50`);
      }
    }
  }
  if (req("systemsTouchedBase")) {
    const v = Number(body.systemsTouchedBase);
    if (!Number.isInteger(v) || v < 1 || v > 10) {
      throw new InputValidationError("systemsTouchedBase must be a whole number between 1 and 10");
    }
  }
}

function serialize(row: typeof customIntentsTable.$inferSelect) {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    domain: row.domain,
    flowClass: row.flowClass,
    description: row.description,
    asIsHandlingMin: row.asIsHandlingMin,
    toBeHumanMin: row.toBeHumanMin,
    baseWeight: row.baseWeight,
    actGetActions: row.actGetActions,
    actPutActions: row.actPutActions,
    systemsTouchedBase: row.systemsTouchedBase,
    tags: JSON.parse(row.tags) as string[],
    source: row.source,
    author: row.author,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Convert a DB row to the Intent shape used by rollup. */
export function rowToIntent(row: typeof customIntentsTable.$inferSelect): Intent {
  return {
    id: -row.id, // negative to avoid clashing with reference corpus numeric ids
    key: row.key,
    name: row.name,
    domain: row.domain,
    flowClass: row.flowClass,
    description: row.description,
    source: { name: row.source, confidence: "medium" },
    asIsHandlingMin: row.asIsHandlingMin,
    toBeHumanMin: row.toBeHumanMin,
    baseWeight: row.baseWeight,
    actGetActions: row.actGetActions,
    actPutActions: row.actPutActions,
    systemsTouchedBase: row.systemsTouchedBase,
    tags: JSON.parse(row.tags) as string[],
  };
}

/** Load all active custom intents as Intent objects for rollup injection. */
export async function loadActiveCustomIntents(): Promise<Intent[]> {
  const rows = await db
    .select()
    .from(customIntentsTable)
    .where(eq(customIntentsTable.status, "active"));
  return rows.map(rowToIntent);
}

// ── Routes ─────────────────────────────────────────────────────────────────

router.get("/custom-intents", async (req, res, next) => {
  try {
    const statusFilter = req.query["status"] === "all" ? undefined : "active";
    const rows = statusFilter
      ? await db
          .select()
          .from(customIntentsTable)
          .where(eq(customIntentsTable.status, statusFilter))
      : await db.select().from(customIntentsTable);
    res.json(rows.map(serialize));
  } catch (e) {
    next(e);
  }
});

router.post("/custom-intents", async (req, res, next) => {
  try {
    const body = req.body as Record<string, unknown>;
    validateFields(body);
    const key = await generateKey(String(body.name));
    const [row] = await db
      .insert(customIntentsTable)
      .values({
        key,
        name: String(body.name).trim(),
        domain: String(body.domain).trim(),
        flowClass: String(body.flowClass),
        description: String(body.description).trim(),
        asIsHandlingMin: Number(body.asIsHandlingMin),
        toBeHumanMin: Number(body.toBeHumanMin),
        baseWeight: Number(body.baseWeight),
        actGetActions: Number(body.actGetActions),
        actPutActions: Number(body.actPutActions),
        systemsTouchedBase: body.systemsTouchedBase !== undefined ? Number(body.systemsTouchedBase) : 2,
        tags: '["custom"]',
        source: String(body.source).trim(),
        author: String(body.author).trim(),
        status: "active",
      })
      .returning();
    res.status(201).json(serialize(row!));
  } catch (e) {
    next(e);
  }
});

router.get("/custom-intents/:key", async (req, res, next) => {
  try {
    const [row] = await db
      .select()
      .from(customIntentsTable)
      .where(eq(customIntentsTable.key, req.params["key"]!));
    if (!row) {
      res.status(404).json({ error: "Custom intent not found" });
      return;
    }
    res.json(serialize(row));
  } catch (e) {
    next(e);
  }
});

router.patch("/custom-intents/:key", async (req, res, next) => {
  try {
    const key = req.params["key"]!;
    const [existing] = await db
      .select()
      .from(customIntentsTable)
      .where(eq(customIntentsTable.key, key));
    if (!existing) {
      res.status(404).json({ error: "Custom intent not found" });
      return;
    }
    const body = req.body as Record<string, unknown>;
    validateFields(body, true);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) update.name = String(body.name).trim();
    if (body.domain !== undefined) update.domain = String(body.domain).trim();
    if (body.flowClass !== undefined) update.flowClass = String(body.flowClass);
    if (body.description !== undefined) update.description = String(body.description).trim();
    if (body.source !== undefined) update.source = String(body.source).trim();
    if (body.author !== undefined) update.author = String(body.author).trim();
    if (body.asIsHandlingMin !== undefined) update.asIsHandlingMin = Number(body.asIsHandlingMin);
    if (body.toBeHumanMin !== undefined) update.toBeHumanMin = Number(body.toBeHumanMin);
    if (body.baseWeight !== undefined) update.baseWeight = Number(body.baseWeight);
    if (body.actGetActions !== undefined) update.actGetActions = Number(body.actGetActions);
    if (body.actPutActions !== undefined) update.actPutActions = Number(body.actPutActions);
    if (body.systemsTouchedBase !== undefined) update.systemsTouchedBase = Number(body.systemsTouchedBase);

    // Re-validate the cross-field constraint against the merged state
    const asIs = update.asIsHandlingMin !== undefined
      ? Number(update.asIsHandlingMin)
      : existing.asIsHandlingMin;
    const toBe = update.toBeHumanMin !== undefined
      ? Number(update.toBeHumanMin)
      : existing.toBeHumanMin;
    if (toBe > asIs) {
      throw new InputValidationError("toBeHumanMin must not exceed asIsHandlingMin");
    }

    const [row] = await db
      .update(customIntentsTable)
      .set(update)
      .where(eq(customIntentsTable.key, key))
      .returning();
    res.json(serialize(row!));
  } catch (e) {
    next(e);
  }
});

router.post("/custom-intents/:key/retire", async (req, res, next) => {
  try {
    const key = req.params["key"]!;
    const [existing] = await db
      .select()
      .from(customIntentsTable)
      .where(eq(customIntentsTable.key, key));
    if (!existing) {
      res.status(404).json({ error: "Custom intent not found" });
      return;
    }
    if (existing.status === "retired") {
      res.status(400).json({ error: "Intent is already retired" });
      return;
    }
    const [row] = await db
      .update(customIntentsTable)
      .set({ status: "retired", updatedAt: new Date() })
      .where(eq(customIntentsTable.key, key))
      .returning();
    res.json(serialize(row!));
  } catch (e) {
    next(e);
  }
});

router.delete("/custom-intents/:key", async (req, res, next) => {
  try {
    const key = req.params["key"]!;
    const [existing] = await db
      .select()
      .from(customIntentsTable)
      .where(eq(customIntentsTable.key, key));
    if (!existing) {
      res.status(404).json({ error: "Custom intent not found" });
      return;
    }
    // Hard-delete is blocked when flow-override history exists for this key.
    // Import flowOverridesTable inline to avoid circular deps.
    const { flowOverridesTable } = await import("@workspace/db");
    const history = await db
      .select({ id: flowOverridesTable.id })
      .from(flowOverridesTable)
      .where(eq(flowOverridesTable.intentKey, key))
      .limit(1);
    if (history.length > 0) {
      res.status(409).json({
        error:
          "Cannot delete: this intent has SME flow-override history. Use /retire instead to remove it from roll-ups while preserving history.",
      });
      return;
    }
    await db.delete(customIntentsTable).where(eq(customIntentsTable.key, key));
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;
