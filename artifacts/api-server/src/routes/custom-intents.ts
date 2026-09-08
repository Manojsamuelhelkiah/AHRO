import { Router, type IRouter } from "express";
import { eq, and, ne } from "drizzle-orm";
import {
  db,
  customIntentRoutingLabelsTable,
  customIntentsTable,
} from "@workspace/db";
import { flowClassMap } from "../data/flow-classes";
import { intentMap } from "../data/intents";
import { InputValidationError } from "../lib/validate-inputs";
import type { Intent } from "../data/types";
import {
  buildIntentRegistry,
  INTENT_REGISTRY_VERSION,
  validateCustomRoutingMetadata,
} from "../lib/intent-registry";

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
  if (body.exactAliases !== undefined) {
    if (!Array.isArray(body.exactAliases) || body.exactAliases.some((alias) => typeof alias !== "string" || !alias.trim())) {
      throw new InputValidationError("exactAliases must be an array of non-empty strings");
    }
  }
  if (body.accountableSpecialist !== undefined && (typeof body.accountableSpecialist !== "string" || !body.accountableSpecialist.trim())) {
    throw new InputValidationError("accountableSpecialist must be a non-empty string");
  }
  if (body.riskClass !== undefined && !["low", "medium", "high", "consequential"].includes(String(body.riskClass))) {
    throw new InputValidationError("riskClass must be one of: low, medium, high, consequential");
  }
  if (body.maturity !== undefined && !["catalogued", "simulated", "integrated", "verified", "unsupported"].includes(String(body.maturity))) {
    throw new InputValidationError("maturity must be one of: catalogued, simulated, integrated, verified, unsupported");
  }
  for (const field of ["actionSchema", "evidenceContract"] as const) {
    if (body[field] !== undefined && (typeof body[field] !== "object" || body[field] === null || Array.isArray(body[field]))) {
      throw new InputValidationError(`${field} must be an object`);
    }
  }
}

function defaultActionSchema() {
  return {
    actions: [{
      type: "intake",
      name: "capture-client-request",
      description: "Capture the approved client-specific request for specialist triage.",
      inputSchema: { type: "object", required: ["requestId", "subjectId"] },
      executorKey: null,
    }],
  };
}

function validateMergedRoutingFields(
  body: Record<string, unknown>,
  existing?: typeof customIntentsTable.$inferSelect,
) {
  try {
    validateCustomRoutingMetadata({
      accountableSpecialist: String(body.accountableSpecialist ?? existing?.accountableSpecialist ?? "HRO Service Owner"),
      riskClass: String(body.riskClass ?? existing?.riskClass ?? "medium"),
      maturity: String(body.maturity ?? existing?.maturity ?? "catalogued"),
      exactAliases: body.exactAliases ?? (existing ? JSON.parse(existing.exactAliases) : []),
      actionSchema: body.actionSchema ?? (existing ? JSON.parse(existing.actionSchema) : defaultActionSchema()),
      evidenceContract: body.evidenceContract ?? (existing ? JSON.parse(existing.evidenceContract) : { required: ["request", "actor", "recordedAt"] }),
    });
  } catch (error) {
    throw new InputValidationError(error instanceof Error ? error.message : "Invalid routing contract");
  }
}

async function assertNoRoutingLabelCollision(
  key: string,
  aliases: string[],
  excludeId?: number,
) {
  const rows = await db.select().from(customIntentsTable);
  const otherRows = excludeId === undefined ? rows : rows.filter((row) => row.id !== excludeId);
  const occupied = new Set(
    buildIntentRegistry(otherRows).reference.flatMap((route) => [route.key, ...route.exactAliases]),
  );
  for (const row of otherRows) {
    occupied.add(row.key);
    for (const alias of JSON.parse(row.exactAliases) as string[]) occupied.add(alias);
  }
  for (const label of [key, ...aliases]) {
    if (occupied.has(label)) throw new InputValidationError(`Routing label already belongs to another outcome: ${label}`);
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
    registryVersion: row.registryVersion,
    parentIntentKey: row.parentIntentKey,
    exactAliases: JSON.parse(row.exactAliases) as string[],
    accountableSpecialist: row.accountableSpecialist,
    riskClass: row.riskClass,
    actionSchema: JSON.parse(row.actionSchema) as Record<string, unknown>,
    evidenceContract: JSON.parse(row.evidenceContract) as Record<string, unknown>,
    maturity: row.maturity,
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
    .where(and(
      eq(customIntentsTable.status, "active"),
      eq(customIntentsTable.registryVersion, INTENT_REGISTRY_VERSION),
    ));
  return rows.map(rowToIntent);
}

function routingLabels(key: string, aliases: string[]) {
  return [key, ...aliases].map((label) => ({
    label,
    registryVersion: INTENT_REGISTRY_VERSION,
  }));
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && (current as { code?: unknown }).code === "23505") return true;
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

let createAfterPreflightHookForTests: (() => Promise<void>) | undefined;

export function setCustomIntentCreateAfterPreflightHookForTests(
  hook: (() => Promise<void>) | undefined,
) {
  createAfterPreflightHookForTests = hook;
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
    validateMergedRoutingFields(body);
    const key = await generateKey(String(body.name));
    await assertNoRoutingLabelCollision(key, body.exactAliases as string[] | undefined ?? []);
    await createAfterPreflightHookForTests?.();
    const aliases = body.exactAliases as string[] | undefined ?? [];
    let row: typeof customIntentsTable.$inferSelect;
    try {
      row = await db.transaction(async (tx) => {
        const [inserted] = await tx
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
            registryVersion: INTENT_REGISTRY_VERSION,
            parentIntentKey: body.parentIntentKey ? String(body.parentIntentKey) : null,
            exactAliases: JSON.stringify(aliases),
            accountableSpecialist: body.accountableSpecialist
              ? String(body.accountableSpecialist).trim()
              : "HRO Service Owner",
            riskClass: body.riskClass ? String(body.riskClass) : "medium",
            actionSchema: JSON.stringify(body.actionSchema ?? defaultActionSchema()),
            evidenceContract: JSON.stringify(body.evidenceContract ?? { required: ["request", "actor", "recordedAt"] }),
            maturity: body.maturity ? String(body.maturity) : "catalogued",
          })
          .returning();
        await tx.insert(customIntentRoutingLabelsTable).values(
          routingLabels(key, aliases).map((label) => ({ ...label, customIntentId: inserted!.id })),
        );
        return inserted!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InputValidationError("A canonical key or exact alias already belongs to another outcome");
      }
      throw error;
    }
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
    if (body.parentIntentKey !== undefined) update.parentIntentKey = body.parentIntentKey ? String(body.parentIntentKey) : null;
    if (body.exactAliases !== undefined) update.exactAliases = JSON.stringify(body.exactAliases);
    if (body.accountableSpecialist !== undefined) update.accountableSpecialist = String(body.accountableSpecialist).trim();
    if (body.riskClass !== undefined) update.riskClass = String(body.riskClass);
    if (body.actionSchema !== undefined) update.actionSchema = JSON.stringify(body.actionSchema);
    if (body.evidenceContract !== undefined) update.evidenceContract = JSON.stringify(body.evidenceContract);
    if (body.maturity !== undefined) update.maturity = String(body.maturity);

    let row: typeof customIntentsTable.$inferSelect | null;
    try {
      row = await db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(customIntentsTable)
          .where(eq(customIntentsTable.key, key))
          .for("update");
        if (!existing) return null;

        validateMergedRoutingFields(body, existing);
        const aliases = body.exactAliases as string[] | undefined
          ?? JSON.parse(existing.exactAliases) as string[];
        const referenceLabels = new Set(
          buildIntentRegistry().reference.flatMap((route) => [route.key, ...route.exactAliases]),
        );
        for (const label of [key, ...aliases]) {
          if (referenceLabels.has(label)) {
            throw new InputValidationError(`Routing label already belongs to another outcome: ${label}`);
          }
        }

        // Validate the numeric relationship against the same locked state that
        // this transaction updates.
        const asIs = update.asIsHandlingMin !== undefined
          ? Number(update.asIsHandlingMin)
          : existing.asIsHandlingMin;
        const toBe = update.toBeHumanMin !== undefined
          ? Number(update.toBeHumanMin)
          : existing.toBeHumanMin;
        if (toBe > asIs) {
          throw new InputValidationError("toBeHumanMin must not exceed asIsHandlingMin");
        }

        const [updated] = await tx
          .update(customIntentsTable)
          .set(update)
          .where(eq(customIntentsTable.key, key))
          .returning();
        await tx
          .delete(customIntentRoutingLabelsTable)
          .where(eq(customIntentRoutingLabelsTable.customIntentId, existing.id));
        await tx.insert(customIntentRoutingLabelsTable).values(
          routingLabels(key, aliases).map((label) => ({ ...label, customIntentId: existing.id })),
        );
        return updated!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new InputValidationError("A canonical key or exact alias already belongs to another outcome");
      }
      throw error;
    }
    if (!row) {
      res.status(404).json({ error: "Custom intent not found" });
      return;
    }
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
