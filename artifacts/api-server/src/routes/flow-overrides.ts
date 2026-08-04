import { Router, type IRouter } from "express";
import { desc, eq, and, max } from "drizzle-orm";
import { db, flowOverridesTable } from "@workspace/db";
import {
  ListFlowOverridesResponse,
  CreateFlowOverrideBody,
  CreateFlowOverrideResponse,
  ApproveFlowOverrideResponse,
  RevokeFlowOverrideResponse,
} from "@workspace/api-zod";
import { intentMap } from "../data/intents";
import { flowClassMap } from "../data/flow-classes";
import { InputValidationError } from "../lib/validate-inputs";
import type { FlowOverrideValues } from "../lib/rollup";

const router: IRouter = Router();

function serialize(row: typeof flowOverridesTable.$inferSelect) {
  return {
    id: row.id,
    intentKey: row.intentKey,
    version: row.version,
    status: row.status,
    author: row.author,
    rationale: row.rationale,
    flowClass: row.flowClass,
    toBeHumanMin: row.toBeHumanMin,
    actGetActions: row.actGetActions,
    actPutActions: row.actPutActions,
    createdAt: row.createdAt.toISOString(),
  };
}

router.get("/flow-overrides", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(flowOverridesTable)
      .orderBy(desc(flowOverridesTable.createdAt));
    res.json(ListFlowOverridesResponse.parse(rows.map(serialize)));
  } catch (e) {
    next(e);
  }
});

router.post("/flow-overrides", async (req, res, next) => {
  try {
    const body = CreateFlowOverrideBody.parse(req.body);
    const intent = intentMap[body.intentKey];
    if (!intent) {
      throw new InputValidationError(`Unknown intent key "${body.intentKey}"`);
    }
    if (!body.author.trim() || !body.rationale.trim()) {
      throw new InputValidationError("author and rationale are required");
    }
    if (body.flowClass !== undefined && !flowClassMap[body.flowClass]) {
      throw new InputValidationError(
        `Unknown flow class "${body.flowClass}". Valid: ${Object.keys(flowClassMap).join(", ")}`,
      );
    }
    if (body.toBeHumanMin !== undefined) {
      if (!Number.isFinite(body.toBeHumanMin) || body.toBeHumanMin < 0 || body.toBeHumanMin > 600) {
        throw new InputValidationError("toBeHumanMin must be between 0 and 600 minutes");
      }
    }
    for (const field of ["actGetActions", "actPutActions"] as const) {
      const v = body[field];
      if (v !== undefined && (!Number.isInteger(v) || v < 0 || v > 50)) {
        throw new InputValidationError(`${field} must be a whole number between 0 and 50`);
      }
    }
    if (
      body.flowClass === undefined &&
      body.toBeHumanMin === undefined &&
      body.actGetActions === undefined &&
      body.actPutActions === undefined
    ) {
      throw new InputValidationError("Override must change at least one flow property");
    }

    const [latest] = await db
      .select({ v: max(flowOverridesTable.version) })
      .from(flowOverridesTable)
      .where(eq(flowOverridesTable.intentKey, body.intentKey));
    const version = (latest?.v ?? 0) + 1;

    const [row] = await db
      .insert(flowOverridesTable)
      .values({
        intentKey: body.intentKey,
        version,
        status: "draft",
        author: body.author.trim(),
        rationale: body.rationale.trim(),
        flowClass: body.flowClass ?? null,
        toBeHumanMin: body.toBeHumanMin ?? null,
        actGetActions: body.actGetActions ?? null,
        actPutActions: body.actPutActions ?? null,
      })
      .returning();
    res.status(201).json(CreateFlowOverrideResponse.parse(serialize(row!)));
  } catch (e) {
    next(e);
  }
});

router.post("/flow-overrides/:id/approve", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new InputValidationError("id must be a positive integer");
    }
    // Transactional: only drafts can be approved, and approval supersedes any
    // prior approved version so exactly one override is active per intent.
    const approved = await db.transaction(async (tx) => {
      const [target] = await tx
        .select()
        .from(flowOverridesTable)
        .where(eq(flowOverridesTable.id, id))
        .for("update");
      if (!target) return { notFound: true as const };
      if (target.status !== "draft") {
        return { badState: target.status };
      }
      await tx
        .update(flowOverridesTable)
        .set({ status: "superseded" })
        .where(
          and(
            eq(flowOverridesTable.intentKey, target.intentKey),
            eq(flowOverridesTable.status, "approved"),
          ),
        );
      const [row] = await tx
        .update(flowOverridesTable)
        .set({ status: "approved" })
        .where(eq(flowOverridesTable.id, id))
        .returning();
      return { row: row! };
    });
    if ("notFound" in approved) {
      res.status(404).json({ error: "Flow override not found" });
      return;
    }
    if ("badState" in approved) {
      res.status(400).json({
        error: `Only drafts can be approved (this version is ${approved.badState}). Propose a new version instead.`,
      });
      return;
    }
    res.json(ApproveFlowOverrideResponse.parse(serialize(approved.row)));
  } catch (e) {
    next(e);
  }
});

router.post("/flow-overrides/:id/revoke", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new InputValidationError("id must be a positive integer");
    }
    const [target] = await db
      .select()
      .from(flowOverridesTable)
      .where(eq(flowOverridesTable.id, id));
    if (!target) {
      res.status(404).json({ error: "Flow override not found" });
      return;
    }
    if (target.status !== "approved") {
      res.status(400).json({ error: "Only the active approved version can be revoked" });
      return;
    }
    const [row] = await db
      .update(flowOverridesTable)
      .set({ status: "superseded" })
      .where(eq(flowOverridesTable.id, id))
      .returning();
    res.json(RevokeFlowOverrideResponse.parse(serialize(row!)));
  } catch (e) {
    next(e);
  }
});

router.delete("/flow-overrides/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new InputValidationError("id must be a positive integer");
    }
    const [target] = await db
      .select()
      .from(flowOverridesTable)
      .where(eq(flowOverridesTable.id, id));
    if (!target) {
      res.status(404).json({ error: "Flow override not found" });
      return;
    }
    // Approved/superseded versions are audit history; only drafts can be deleted.
    if (target.status !== "draft") {
      res.status(400).json({
        error: "Only drafts can be deleted. Revoke the active version to revert to the reference flow.",
      });
      return;
    }
    await db.delete(flowOverridesTable).where(eq(flowOverridesTable.id, id));
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

/**
 * Latest approved override per intent, in the shape the roll-up engine
 * consumes. Later approvals supersede earlier ones (by version).
 */
export async function loadActiveFlowOverrides(): Promise<Record<string, FlowOverrideValues>> {
  const rows = await db
    .select()
    .from(flowOverridesTable)
    .where(eq(flowOverridesTable.status, "approved"))
    .orderBy(flowOverridesTable.intentKey, flowOverridesTable.version);
  const active: Record<string, FlowOverrideValues> = {};
  for (const row of rows) {
    // ascending version order: later rows overwrite earlier ones
    active[row.intentKey] = {
      ...(row.flowClass !== null && { flowClass: row.flowClass }),
      ...(row.toBeHumanMin !== null && { toBeHumanMin: row.toBeHumanMin }),
      ...(row.actGetActions !== null && { actGetActions: row.actGetActions }),
      ...(row.actPutActions !== null && { actPutActions: row.actPutActions }),
    };
  }
  return active;
}

export default router;
