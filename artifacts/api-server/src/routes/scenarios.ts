import { Router, type IRouter } from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db, scenariosTable, scenarioFilesTable, actualsOverlaysTable, objectCleanupJobsTable, flowOverridesTable } from "@workspace/db";
import { onbConnectors, onbSystemChecks } from "@workspace/db/schema";
import {
  ListScenariosResponse,
  CreateScenarioBody,
  CreateScenarioResponse,
  GetScenarioResponse,
  UpdateScenarioBody,
  UpdateScenarioResponse,
  ComputeRollupBody,
  ComputeRollupResponse,
  ResolveScenarioFlowBasisBody,
} from "@workspace/api-zod";
import { computeRollup, computeVariance, type ScenarioInputs, type FlowOverrideValues } from "../lib/rollup";
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
import {
  canActivateSystemSetup,
  connectorUpdateForSetupSelection,
  selectedWatcherConfigurations,
  SYSTEM_SETUP_CAPABILITIES,
  validateSystemSetup,
} from "../lib/onboarding/system-setup-capabilities";
import { ensureConnectorsSeeded } from "../lib/onboarding/connectors";
import { systemDef } from "../lib/onboarding/external-systems";
import { resolveSetupFlowBasis, validateSetupFlowBasis } from "../lib/setup-flow-basis";

const router: IRouter = Router();

async function currentSetupSnapshot(organizationId: string, domains: string[]) {
  // Unlike the legacy rollup loader, failure here must not conceal existing overrides.
  const overrides = await db.select().from(flowOverridesTable).where(and(
    organizationWhere(flowOverridesTable, organizationId), eq(flowOverridesTable.status, "approved"),
  )).catch(() => { throw new InputValidationError("Approved flow definitions could not be read. Restore the definition store and retry; existing client overrides have not been replaced."); });
  const values: Record<string, FlowOverrideValues> = {};
  for (const row of [...overrides].sort((a, b) => a.version - b.version)) {
    values[row.intentKey] = {
      ...(row.flowClass !== null && { flowClass: row.flowClass }),
      ...(row.toBeHumanMin !== null && { toBeHumanMin: row.toBeHumanMin }),
      ...(row.actGetActions !== null && { actGetActions: row.actGetActions }),
      ...(row.actPutActions !== null && { actPutActions: row.actPutActions }),
    };
  }
  return { basis: resolveSetupFlowBasis(domains, overrides), values };
}

async function currentSetupBasis(organizationId: string, domains: string[]) {
  return (await currentSetupSnapshot(organizationId, domains)).basis;
}

router.post("/scenario-flow-basis", requireAuth, async (req, res, next) => {
  try {
    const body = ResolveScenarioFlowBasisBody.parse(req.body);
    res.json(await currentSetupBasis(getOrganizationId(req), body.selectedDomains));
  } catch (error) { next(error); }
});

router.get("/scenario-system-capabilities", requireAuth, (_req, res) => {
  res.json(SYSTEM_SETUP_CAPABILITIES);
});

async function applySetupWatcherModes(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  setupData: Parameters<typeof selectedWatcherConfigurations>[0],
): Promise<void> {
  for (const selection of selectedWatcherConfigurations(setupData)) {
    const def = systemDef(selection.system)!;
    const [current] = await tx.select({
      trackingMode: onbConnectors.trackingMode,
      configurationProvenance: onbConnectors.configurationProvenance,
    }).from(onbConnectors).where(and(
      eq(onbConnectors.organizationId, organizationId),
      eq(onbConnectors.key, selection.connectorKey),
    )).for("update");
    if (!current) {
      throw new InputValidationError(`Connector "${selection.connectorKey}" is unavailable`);
    }
    const update = connectorUpdateForSetupSelection(current, selection);
    await tx.update(onbConnectors)
      .set({
        ...update,
        lastSyncAt: new Date(),
      })
      .where(and(
        eq(onbConnectors.organizationId, organizationId),
        eq(onbConnectors.key, selection.connectorKey),
      ));
    await tx.update(onbSystemChecks)
      .set({ mode: selection.trackingMode === "email" ? "email" : def.mode })
      .where(and(
        eq(onbSystemChecks.organizationId, organizationId),
        eq(onbSystemChecks.system, selection.system),
        inArray(onbSystemChecks.status, ["pending", "overdue"]),
      ));
  }
}

function scenarioAccessWhere(organizationId: string, ownerUserId: string) {
  return and(
    organizationWhere(scenariosTable, organizationId),
    or(
      eq(scenariosTable.ownerUserId, ownerUserId),
      isNull(scenariosTable.ownerUserId),
    ),
  );
}

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
  const setup = row.setupData as Record<string, unknown> | null;
  const basis = setup?.flowBasis as { overrideRefs?: unknown[] } | undefined;
  return {
    id: row.id,
    name: row.name,
    inputs: row.inputs,
    setupData: setup && basis ? { ...setup,
      customizationStatus: setup.processMode !== "recommended" || fileIds.length ? "pending-review"
        : basis.overrideRefs?.length ? "reviewed-overrides" : "none" } : row.setupData,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    fileIds,
  };
}

router.get("/scenarios", requireAuth, async (req, res, next) => {
  try {
    const organizationId = getOrganizationId(req);
    const rows = await db.select().from(scenariosTable)
      .where(scenarioAccessWhere(organizationId, req.authUserId!))
      .orderBy(scenariosTable.id);
    const fileRows = rows.length
      ? await db.select({ id: scenarioFilesTable.id, scenarioId: scenarioFilesTable.scenarioId })
          .from(scenarioFilesTable)
          .where(and(
            organizationWhere(scenarioFilesTable, organizationId),
            eq(scenarioFilesTable.ownerUserId, req.authUserId!),
            inArray(scenarioFilesTable.scenarioId, rows.map((row) => row.id)),
          ))
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
    validateSystemSetup(body.setupData);
    if (body.setupData && !body.setupData.flowBasis) {
      throw new InputValidationError("Resolve and review the current flow basis before saving a new client setup. Existing saved configurations remain intact.");
    }
    if (body.setupData?.flowBasis) {
      const basis = await currentSetupBasis(organizationId, body.setupData.selectedDomains);
      validateSetupFlowBasis(body.setupData.flowBasis, basis, body.inputs);
      const expectedStatus = body.setupData.processMode !== "recommended" || body.fileIds?.length ? "pending-review"
        : basis.overrideRefs.length ? "reviewed-overrides" : "none";
      if (body.setupData.customizationStatus !== expectedStatus) {
        throw new InputValidationError("Customization status must reflect the reviewed planning basis, not uploaded files.");
      }
    }
    const [overrides, customIntents] = await Promise.all([
      loadActiveFlowOverrides(organizationId),
      body.setupData?.flowBasis ? Promise.resolve([]) : loadRequiredCustomIntents(organizationId),
    ]);
    const customKeys = new Set(customIntents.map((i) => i.key));
    validateScenarioInputs(body.inputs as ScenarioInputs, customKeys);
    const fileIds = body.fileIds ?? [];
    const row = await db.transaction(async (tx) => {
      if (fileIds.length) {
        const files = await tx.select({ id: scenarioFilesTable.id, scenarioId: scenarioFilesTable.scenarioId }).from(scenarioFilesTable)
          .where(and(
            organizationWhere(scenarioFilesTable, organizationId),
            eq(scenarioFilesTable.ownerUserId, req.authUserId!),
            inArray(scenarioFilesTable.id, fileIds),
          ))
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
          .where(and(
            organizationWhere(scenarioFilesTable, organizationId),
            eq(scenarioFilesTable.ownerUserId, req.authUserId!),
            inArray(scenarioFilesTable.id, fileIds),
          ));
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
        scenarioAccessWhere(organizationId, req.authUserId!),
      ));
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    const files = await db.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
      .where(and(
        organizationWhere(scenarioFilesTable, organizationId),
        eq(scenarioFilesTable.scenarioId, id),
        eq(scenarioFilesTable.ownerUserId, req.authUserId!),
      ));
    res.json(GetScenarioResponse.parse(serialize(row, files.map((file) => file.id))));
  } catch (err) {
    next(err);
  }
});

router.post("/scenarios/:id/activate-system-setup", requireAuth, async (req, res, next) => {
  try {
    if (!canActivateSystemSetup(req.organizationRole)) {
      res.status(403).json({ message: "Organization owner or admin role required to activate system setup." });
      return;
    }
    const id = parseId(req.params["id"]);
    const organizationId = getOrganizationId(req);
    await ensureConnectorsSeeded(organizationId);
    const row = await db.transaction(async (tx) => {
      const [lockedScenario] = await tx.select().from(scenariosTable).where(and(
        eq(scenariosTable.id, id),
        scenarioAccessWhere(organizationId, req.authUserId!),
      )).for("update");
      if (!lockedScenario) return undefined;
      const setupData = lockedScenario.setupData as Parameters<typeof validateSystemSetup>[0];
      validateSystemSetup(setupData);
      await applySetupWatcherModes(tx, organizationId, setupData);
      return lockedScenario;
    });
    if (!row) {
      res.status(404).json({ message: "Scenario not found" });
      return;
    }
    const files = await db.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
      .where(and(
        organizationWhere(scenarioFilesTable, organizationId),
        eq(scenarioFilesTable.scenarioId, id),
        eq(scenarioFilesTable.ownerUserId, req.authUserId!),
      ));
    res.json(CreateScenarioResponse.parse(serialize(row, files.map((file) => file.id))));
  } catch (err) {
    next(err);
  }
});

router.patch("/scenarios/:id", requireAuth, async (req, res, next) => {
  try {
    const id = parseId(req.params["id"]);
    const organizationId = getOrganizationId(req);
    const body = UpdateScenarioBody.parse(req.body);
    validateSystemSetup(body.setupData);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (body.name !== undefined) updates["name"] = body.name;
    if (body.inputs !== undefined) updates["inputs"] = body.inputs;
    if (body.setupData !== undefined) updates["setupData"] = body.setupData;
    const row = await db.transaction(async (tx) => {
      const [accessibleScenario] = await tx.select()
        .from(scenariosTable)
        .where(and(
          eq(scenariosTable.id, id),
          scenarioAccessWhere(organizationId, req.authUserId!),
        ))
        .for("update");
      if (!accessibleScenario) return undefined;
      const previous = accessibleScenario.setupData as { flowBasis?: Parameters<typeof validateSetupFlowBasis>[0] } | null;
      if (previous?.flowBasis && body.setupData !== undefined && !body.setupData?.flowBasis) {
        throw new InputValidationError("Existing flow provenance cannot be silently removed from a saved setup.");
      }
      if (body.inputs !== undefined) {
        const reviewedBasis = body.setupData?.flowBasis ?? previous?.flowBasis;
        // Ordinary Cost Explorer saves send only inputs. Preserve historical
        // planning provenance unless a new basis is explicitly reviewed;
        // never retain its label alongside a different intent distribution.
        if (reviewedBasis) validateSetupFlowBasis(reviewedBasis, reviewedBasis, body.inputs);
        const customIntents = reviewedBasis ? [] : await loadRequiredCustomIntents(organizationId);
        validateScenarioInputs(body.inputs as ScenarioInputs, new Set(customIntents.map((intent) => intent.key)));
      }
      if (body.setupData !== undefined && body.setupData !== null) {
        if (body.setupData.flowBasis) {
          validateSetupFlowBasis(body.setupData.flowBasis,
            await currentSetupBasis(organizationId, body.setupData.selectedDomains),
            (body.inputs ?? accessibleScenario.inputs) as ScenarioInputs);
          const retainedFiles = body.fileIds === undefined
            ? await tx.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable).where(and(
              organizationWhere(scenarioFilesTable, organizationId),
              eq(scenarioFilesTable.ownerUserId, req.authUserId!),
              eq(scenarioFilesTable.scenarioId, id),
            )) : body.fileIds;
          const expected = body.setupData.processMode !== "recommended" || retainedFiles.length ? "pending-review"
            : body.setupData.flowBasis.overrideRefs.length ? "reviewed-overrides" : "none";
          if (body.setupData.customizationStatus !== expected) throw new InputValidationError("Invalid customization status.");
        }
      }
      if (body.fileIds !== undefined) {
        if (accessibleScenario.ownerUserId === null && body.fileIds.length > 0) {
          throw new InputValidationError("Private files cannot be attached to a legacy scenario");
        }
        const files = body.fileIds.length
          ? await tx.select({ id: scenarioFilesTable.id, scenarioId: scenarioFilesTable.scenarioId }).from(scenarioFilesTable)
              .where(and(
                organizationWhere(scenarioFilesTable, organizationId),
                eq(scenarioFilesTable.ownerUserId, req.authUserId!),
                inArray(scenarioFilesTable.id, body.fileIds),
              ))
              .for("update")
          : [];
        if (files.length !== body.fileIds.length) throw new InputValidationError("One or more file IDs are unavailable");
        if (files.some((file) => file.scenarioId !== null && file.scenarioId !== id)) {
          throw new InputValidationError("A file already belongs to another scenario");
        }
        await tx.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
          .where(and(
            organizationWhere(scenarioFilesTable, organizationId),
            eq(scenarioFilesTable.ownerUserId, req.authUserId!),
            eq(scenarioFilesTable.scenarioId, id),
          ))
          .for("update");
        await tx.update(scenarioFilesTable).set({ scenarioId: null, updatedAt: new Date() })
          .where(and(
            organizationWhere(scenarioFilesTable, organizationId),
            eq(scenarioFilesTable.ownerUserId, req.authUserId!),
            eq(scenarioFilesTable.scenarioId, id),
          ));
        if (body.fileIds.length) await tx.update(scenarioFilesTable).set({ scenarioId: id, updatedAt: new Date() })
          .where(and(
            organizationWhere(scenarioFilesTable, organizationId),
            eq(scenarioFilesTable.ownerUserId, req.authUserId!),
            inArray(scenarioFilesTable.id, body.fileIds),
          ));
      }
      const [updated] = await tx.update(scenariosTable).set(updates)
        .where(and(
          eq(scenariosTable.id, id),
          scenarioAccessWhere(organizationId, req.authUserId!),
        ))
        .returning();
      return updated;
    });
    if (!row) {
      res.status(404).json({ error: "Scenario not found" });
      return;
    }
    const files = await db.select({ id: scenarioFilesTable.id }).from(scenarioFilesTable)
      .where(and(
        organizationWhere(scenarioFilesTable, organizationId),
        eq(scenarioFilesTable.scenarioId, id),
        eq(scenarioFilesTable.ownerUserId, req.authUserId!),
      ));
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
        scenarioAccessWhere(organizationId, req.authUserId!),
      )).for("update");
      if (!accessible) return undefined;
      const files = await tx.select().from(scenarioFilesTable).where(and(
        organizationWhere(scenarioFilesTable, organizationId),
        eq(scenarioFilesTable.scenarioId, id),
      )).for("update");
      for (const file of files) {
        await tx.insert(objectCleanupJobsTable).values({ objectPath: file.objectPath }).onConflictDoNothing();
      }
      const [deleted] = await tx.delete(scenariosTable).where(and(
        eq(scenariosTable.id, id),
        scenarioAccessWhere(organizationId, req.authUserId!),
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
    const setupSnapshot = body.flowBasis ? await currentSetupSnapshot(organizationId, body.flowBasis.selectedDomains) : undefined;
    if (body.flowBasis) {
      if (body.actualsOverlayId !== undefined) throw new InputValidationError("Setup basis estimates cannot apply an unreviewed actuals overlay.");
      validateSetupFlowBasis(body.flowBasis, setupSnapshot!.basis, body.inputs);
    }

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
      setupSnapshot ? Promise.resolve(setupSnapshot.values) : loadActiveFlowOverrides(organizationId),
      body.flowBasis ? Promise.resolve([]) : loadRequiredCustomIntents(organizationId),
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
