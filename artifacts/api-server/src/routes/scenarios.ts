import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, scenariosTable, scenarioFilesTable, actualsOverlaysTable, objectCleanupJobsTable } from "@workspace/db";
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
import {
  loadAndValidateCurrentRateSet,
  ensureBaselineRateSet,
  type RateSetReference,
} from "../lib/pricing-rate-sets";
import { CustomIntentStorageUnavailableError } from "../middlewares/error-handler";
import { requireAuth } from "../middlewares/require-auth";
import { processObjectCleanupJobs } from "../lib/scenario-file-lifecycle";
import {
  getOrganizationId,
  organizationValues,
  organizationWhere,
} from "../lib/organization-scope";

const router: IRouter = Router();

async function loadRequiredCustomIntents(organizationId: string) {
  try {
    return await loadActiveCustomIntents(organizationId);
  } catch (error) {
    throw new CustomIntentStorageUnavailableError({ cause: error });
  }
}

function parseId(raw: string | string[] | undefined): number {
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new InputValidationError("id must be a positive integer");
  }
  return id;
}

function serialize(row: typeof scenariosTable.$inferSelect, fileIds: number[] = []) {
  return {
    id: row.id,
    name: row.name,
    inputs: row.inputs,
    setupData: row.setupData,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    fileIds,
  };
}

router.get("/scenarios", requireAuth, async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const rows = await db.select().from(scenariosTable)
      .where(organizationWhere(scenariosTable, organizationId))
      .orderBy(scenariosTable.id);
    const fileRows = rows.length
      ? await db.select({ id: scenarioFilesTable.id, scenarioId: scenarioFilesTable.scenarioId })
          .from(scenarioFilesTable)
          .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), inArray(scenarioFilesTable.scenarioId, rows.map((row) => row.id))))
      : [];
    res.json(ListScenariosResponse.parse(rows.map((row) =>
      serialize(row, fileRows.filter((file) => file.scenarioId === row.id).map((file) => file.id)))));
  } catch (err) {
    next(err);
  }
});

router.post("/scenarios", requireAuth, async (req, res, next) => {
  try {
    const body = CreateScenarioBody.parse(req.body);
    const organizationId = getOrganizationId(req);
    const [overrides, customIntents] = await Promise.all([
      loadActiveFlowOverrides(organizationId),
      loadRequiredCustomIntents(organizationId),
    ]);
    const customKeys = new Set(customIntents.map((i) => i.key));
    validateScenarioInputs(body.inputs as ScenarioInputs, customKeys);
    const fileIds = body.fileIds ?? [];
    const row = await db.transaction(async (tx) => {
      if (fileIds.length) {
        const files = await tx.select({ id: scenarioFilesTable.id, scenarioId: scenarioFilesTable.scenarioId }).from(scenarioFilesTable)
          .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), inArray(scenarioFilesTable.id, fileIds)))
          .for("update");
        if (files.length !== fileIds.length) throw new InputValidationError("One or more file IDs are unavailable");
        if (files.some((file) => file.scenarioId !== null)) {
          throw new InputValidationError("A file is already linked to another scenario");
        }
      }
      const [created] = await tx.insert(scenariosTable)
        .values({
          ownerUserId: req.authUserId!,
          name: body.name,
          inputs: body.inputs,
          setupData: body.setupData ?? null,
          ...organizationValues(organizationId),
        }).returning();
      if (fileIds.length) {
        await tx.update(scenarioFilesTable).set({ scenarioId: created!.id, updatedAt: new Date() })
          .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), inArray(scenarioFilesTable.id, fileIds)));
      }
      return created!;
    });
    res.status(201).json(CreateScenarioResponse.parse(serialize(row, fileIds)));
  } catch (err) {
    next(err);
  }
});

router.get("/scenarios/:id", requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const organizationId = getOrganizationId(req);
    const [row] = await db
      .select()
      .from(scenariosTable)
      .where(and(
        eq(scenariosTable.id, id),
        organizationWhere(scenariosTable, organizationId),
      ));
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    const files = await db.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
      .where(and(eq(scenarioFilesTable.scenarioId, id), eq(scenarioFilesTable.ownerUserId, req.authUserId!)));
    res.json(GetScenarioResponse.parse(serialize(row, files.map((file) => file.id))));
  } catch (err) {
    next(err);
  }
});

router.patch("/scenarios/:id", requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const organizationId = getOrganizationId(req);
    const body = UpdateScenarioBody.parse(req.body);
    if (body.inputs !== undefined) {
      const customIntents = await loadRequiredCustomIntents(organizationId);
      const customKeys = new Set(customIntents.map((i) => i.key));
      validateScenarioInputs(body.inputs as ScenarioInputs, customKeys);
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates["name"] = body.name;
    if (body.inputs !== undefined) updates["inputs"] = body.inputs;
    if (body.setupData !== undefined) updates["setupData"] = body.setupData;
    const row = await db.transaction(async (tx) => {
      const [accessibleScenario] = await tx.select({ id: scenariosTable.id, ownerUserId: scenariosTable.ownerUserId })
        .from(scenariosTable)
        .where(and(
          eq(scenariosTable.id, id),
          organizationWhere(scenariosTable, organizationId),
        ))
        .for("update");
      if (!accessibleScenario) return undefined;
      if (body.fileIds !== undefined) {
        if (accessibleScenario.ownerUserId === null && body.fileIds.length > 0) {
          throw new InputValidationError("Private files cannot be attached to a legacy scenario");
        }
        const files = body.fileIds.length
          ? await tx.select({ id: scenarioFilesTable.id, scenarioId: scenarioFilesTable.scenarioId }).from(scenarioFilesTable)
              .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), inArray(scenarioFilesTable.id, body.fileIds)))
              .for("update")
          : [];
        if (files.length !== body.fileIds.length) throw new InputValidationError("One or more file IDs are unavailable");
        if (files.some((file) => file.scenarioId !== null && file.scenarioId !== id)) {
          throw new InputValidationError("A file already belongs to another scenario");
        }
        await tx.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
          .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), eq(scenarioFilesTable.scenarioId, id)))
          .for("update");
        await tx.update(scenarioFilesTable).set({ scenarioId: null, updatedAt: new Date() })
          .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), eq(scenarioFilesTable.scenarioId, id)));
        if (body.fileIds.length) await tx.update(scenarioFilesTable).set({ scenarioId: id, updatedAt: new Date() })
          .where(and(eq(scenarioFilesTable.ownerUserId, req.authUserId!), inArray(scenarioFilesTable.id, body.fileIds)));
      }
      const [updated] = await tx.update(scenariosTable).set(updates)
        .where(and(
          eq(scenariosTable.id, id),
          organizationWhere(scenariosTable, organizationId),
        ))
        .returning();
      return updated;
    });
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    const files = await db.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
      .where(and(eq(scenarioFilesTable.scenarioId, id), eq(scenarioFilesTable.ownerUserId, req.authUserId!)));
    res.json(UpdateScenarioResponse.parse(serialize(row, files.map((file) => file.id))));
  } catch (err) {
    next(err);
  }
});

router.delete("/scenarios/:id", requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const organizationId = getOrganizationId(req);
    const row = await db.transaction(async (tx) => {
      const [accessible] = await tx.select().from(scenariosTable).where(and(
        eq(scenariosTable.id, id),
        organizationWhere(scenariosTable, organizationId),
      )).for("update");
      if (!accessible) return undefined;
      const files = await tx.select().from(scenarioFilesTable).where(eq(scenarioFilesTable.scenarioId, id)).for("update");
      for (const file of files) {
        await tx.insert(objectCleanupJobsTable).values({ objectPath: file.objectPath }).onConflictDoNothing();
      }
      const [deleted] = await tx.delete(scenariosTable).where(and(
        eq(scenariosTable.id, id),
        organizationWhere(scenariosTable, organizationId),
      )).returning();
      return deleted;
    });
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    await processObjectCleanupJobs();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post("/rollup", async (req, res, next) => {
  try {
    const body = ComputeRollupBody.parse(req.body);
    const organizationId = getOrganizationId(req);

    // Seed baseline if no rate sets exist, then load and validate the current snapshot.
    // This must happen before any compute so both passes use exactly the same snapshot.
    await ensureBaselineRateSet(organizationId);
    const currentRateSet = await loadAndValidateCurrentRateSet(organizationId);
    const rateSetRef: RateSetReference = {
      rateSetId: currentRateSet.id,
      effectiveDate: currentRateSet.effectiveDate,
      rationale: currentRateSet.rationale,
      createdBy: currentRateSet.createdBy,
      createdAt: currentRateSet.createdAt.toISOString(),
    };

    const [overrides, customIntents] = await Promise.all([
      loadActiveFlowOverrides(organizationId),
      loadRequiredCustomIntents(organizationId),
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

    if (overlay) {
      // Two-pass: estimate without overlay, then compute with overlay, diff for variance.
      // Both passes use the SAME rate snapshot loaded above.
      const estimated = computeRollup(inputs, overrides, undefined, customIntents, currentRateSet.rates, rateSetRef);
      const actual = computeRollup(inputs, overrides, overlay, customIntents, currentRateSet.rates, rateSetRef);
      const variance = computeVariance(estimated, actual);
      const response = {
        ...actual,
        calibrated: true,
        estimatedTotals: estimated.totals,
        variance,
      };
      res.json(ComputeRollupResponse.parse(response));
    } else {
      const rollup = computeRollup(inputs, overrides, undefined, customIntents, currentRateSet.rates, rateSetRef);
      res.json(ComputeRollupResponse.parse(rollup));
    }
  } catch (err) {
    next(err);
  }
});

export default router;
