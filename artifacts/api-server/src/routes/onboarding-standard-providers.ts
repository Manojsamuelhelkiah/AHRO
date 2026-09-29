import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  onbCases,
  onbEvents,
  onbStandardProviderConfigs,
  onbStandardProviderDecisions,
  onbStandardProviderSourceRecords,
  onbReadinessSlaAttestations,
  onbReadinessSlaCaseState,
} from "@workspace/db/schema";
import { getOrganizationId } from "../lib/organization-scope";
import { isChecklistAdministrator } from "../lib/onboarding/checklist";
import {
  hasOpaqueNarrativeAccess,
  resolveSensitiveAccess,
  SensitiveAuthorityRequiredError,
  withSensitiveAuthorityFence,
} from "../lib/onboarding/sensitive-access";
import { withCaseDerivedLifecycleWrite, withSensitiveLifecycleFence } from "../lib/onboarding/sensitive-lifecycle";
import {
  STANDARD_PROVIDER_CONTRACTS,
  STANDARD_PROVIDER_KEYS,
  standardProviderLaunchBlockers,
  type StandardProviderConfigurationState,
  type StandardProviderKey,
} from "../lib/onboarding/standard-provider-contracts";
import {
  createServerBearerTransport,
  readConfirmedProviderSource,
  readSettingsFromEnvironment,
  StandardProviderSourceReadError,
} from "../lib/onboarding/standard-provider-source-read";
import { dispatchWithProviderGovernance } from "../lib/onboarding/governance-provider-boundary";

const router: IRouter = Router();

function requireProviderAdministrator(req: Request, res: Response): boolean {
  if (isChecklistAdministrator(req.organizationRole)) return true;
  res.status(403).json({
    message: "Organization owner or admin role required for standard provider configuration.",
  });
  return false;
}

function providerKey(value: unknown): StandardProviderKey | null {
  return typeof value === "string" &&
    (STANDARD_PROVIDER_KEYS as readonly string[]).includes(value)
    ? value as StandardProviderKey
    : null;
}

function text(value: unknown, max: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.trim().length <= max
    ? value.trim()
    : null;
}

function mapping(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 30) return null;
  const parsed: Record<string, string> = {};
  for (const [key, field] of entries) {
    const parsedKey = text(key, 120);
    const parsedField = text(field, 500);
    if (!parsedKey || !parsedField) return null;
    parsed[parsedKey] = parsedField;
  }
  return parsed;
}

function listMapping(values: Record<string, string>, key: string): string[] {
  return (values[key] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

const BASELINE_DECISIONS = {
  "oracle-hcm": {
    accountableRole: "HRIS owner",
    requirement: "Confirm Oracle tenant REST resource version, mappings, integration role, and authenticated sandbox receipt.",
  },
  servicenow: {
    accountableRole: "ITSM service owner",
    requirement: "Confirm catalog item/request-state mappings, ServiceNow release, least-privilege role, and authenticated sandbox receipt.",
  },
  bgv: {
    accountableRole: "HR compliance / BGV owner",
    requirement: "No BGV vendor is selected. Approve vendor, consent, evidence, clearance, no-response, adverse, retention, and escalation requirements.",
  },
  payroll: {
    accountableRole: "Payroll owner",
    requirement: "No payroll vendor is selected. Approve provider, eligibility, cutoff, reconciliation, failure recovery, authority, and privacy requirements.",
  },
  benefits: {
    accountableRole: "Benefits owner",
    requirement: "No benefits vendor is selected. Approve administrator, eligibility, consent, cutoff, carrier reconciliation, and failure recovery requirements.",
  },
} satisfies Record<StandardProviderKey, { accountableRole: string; requirement: string }>;

async function ensureStandardProviderDecisionRegister(organizationId: string) {
  await db.insert(onbStandardProviderDecisions).values(
    STANDARD_PROVIDER_KEYS.map((key) => ({
      organizationId,
      providerKey: key,
      decisionKey: "provider-contract-and-activation",
      status: "open" as const,
      accountableRole: BASELINE_DECISIONS[key].accountableRole,
      requirement: BASELINE_DECISIONS[key].requirement,
      detail: STANDARD_PROVIDER_CONTRACTS[key].decisionRequirements.join(" "),
      documentationUrls: STANDARD_PROVIDER_CONTRACTS[key].documentationUrl
        ? [STANDARD_PROVIDER_CONTRACTS[key].documentationUrl!]
        : [],
    })),
  ).onConflictDoNothing();
}

function configurationResponse(input: {
  key: StandardProviderKey;
  config?: typeof onbStandardProviderConfigs.$inferSelect;
  observations: Array<typeof onbStandardProviderSourceRecords.$inferSelect>;
  canReadSourceObservation: (observation: typeof onbStandardProviderSourceRecords.$inferSelect) => boolean;
}) {
  const contract = STANDARD_PROVIDER_CONTRACTS[input.key];
  const configurationState = (input.config?.configurationState ??
    "not-configured") as StandardProviderConfigurationState;
  const blockers = standardProviderLaunchBlockers({
    contract,
    configurationState,
    sandboxEvidenceReference: input.config?.sandboxEvidenceReference ?? null,
    operatorApprovalReference: input.config?.operatorApprovalReference ?? null,
  });
  const sourceConfirmed = input.observations.length > 0;
  const serverConfirmed = input.observations.some((row) =>
    row.evidenceClass === "server-adapter-source-read");
  const sourceObservationState = serverConfirmed
    ? "source-read-confirmed-not-live-evidence"
    : sourceConfirmed
      ? "legacy-operator-observation-unverified"
      : "awaiting-source-confirmation";
  return {
    key: input.key,
    label: contract.label,
    sourceOfTruth: contract.sourceOfTruth,
    documentedApi: contract.documentedApi,
    documentationUrl: contract.documentationUrl,
    defaultMappings: contract.defaultMappings,
    fieldMappings: input.config?.fieldMappings ?? {},
    configurationState,
    sourceObservationState,
    fulfillmentState: ["bgv", "payroll", "benefits"].includes(input.key)
      ? "not-configured-manual-work-required"
      : serverConfirmed ? "source-read-confirmed-not-live-evidence"
        : sourceConfirmed ? "legacy-operator-observation-unverified" : "not-submitted",
    manualOwner: contract.manualOwner,
    sourceRecords: input.observations.map((row) => ({
      // An evidence reference and source identifier are opaque confidential
      // envelopes. Organization administration alone cannot reveal them.
      caseId: input.canReadSourceObservation(row) ? row.caseId : null,
      recordType: row.sourceRecordType,
      sourceRecordId: input.canReadSourceObservation(row)
        ? row.sourceRecordId
        : "Restricted confidential source observation.",
      normalizedState: input.canReadSourceObservation(row)
        ? row.normalizedState
        : "restricted",
      sourceObservedAt: input.canReadSourceObservation(row)
        ? row.sourceObservedAt.toISOString()
        : null,
      evidenceReference: input.canReadSourceObservation(row)
        ? row.evidenceReference
        : null,
      evidenceClass: input.canReadSourceObservation(row)
        ? row.evidenceClass
        : "restricted-confidential-source-observation",
    })),
     // Transport adapters are server-only and a browser cannot turn a
     // configuration or an observation into production dispatch.
    remoteDispatchEnabled: false,
    liveReadinessEligible: false,
    launchBlockers: blockers,
    setupBlockers: contract.decisionRequirements,
    manualFulfillment: contract.manualFulfillment,
    version: input.config?.version ?? 0,
    updatedAt: input.config?.updatedAt?.toISOString() ?? null,
  };
}

/**
 * UI contract:
 * GET /onboarding/standard-providers/status
 * returns `{ providers: StandardProviderStatus[], decisions: Decision[] }`.
 * `operator-observation-recorded-unverified` and `liveReadinessEligible: false`
 * must be rendered distinctly from a live provider confirmation.
 */
router.get("/onboarding/standard-providers/status", async (req, res, next) => {
  try {
    if (!requireProviderAdministrator(req, res)) return;
    const organizationId = getOrganizationId(req);
    await ensureStandardProviderDecisionRegister(organizationId);
    const [configs, observations, decisions] = await Promise.all([
      db.select().from(onbStandardProviderConfigs)
        .where(eq(onbStandardProviderConfigs.organizationId, organizationId)),
      db.select().from(onbStandardProviderSourceRecords)
        .where(eq(onbStandardProviderSourceRecords.organizationId, organizationId))
        .orderBy(desc(onbStandardProviderSourceRecords.recordedAt)),
      db.select().from(onbStandardProviderDecisions)
        .where(eq(onbStandardProviderDecisions.organizationId, organizationId))
        .orderBy(onbStandardProviderDecisions.providerKey, onbStandardProviderDecisions.decisionKey),
    ]);
    const accessByCase = new Map<number, boolean>();
    const observedCaseIds = [...new Set(observations
      .map((observation) => observation.caseId)
      .filter((caseId): caseId is number => caseId !== null))];
    await Promise.all(observedCaseIds.map(async (caseId) => {
      accessByCase.set(caseId, hasOpaqueNarrativeAccess(await resolveSensitiveAccess({
        organizationId,
        caseId,
        actorUserId: req.authUserId,
      })));
    }));
    const canReadSourceObservation = (observation: typeof onbStandardProviderSourceRecords.$inferSelect) =>
      observation.caseId !== null && accessByCase.get(observation.caseId) === true;
    res.json({
      providers: STANDARD_PROVIDER_KEYS.map((key) => configurationResponse({
        key,
        config: configs.find((config) => config.providerKey === key),
        observations: observations.filter((observation) => observation.providerKey === key),
        canReadSourceObservation,
      })),
      decisions: decisions.map((decision) => ({
        providerKey: decision.providerKey,
        decisionKey: decision.decisionKey,
        status: decision.status,
        accountableRole: decision.accountableRole,
        requirement: decision.requirement,
        detail: decision.detail,
        documentationUrls: decision.documentationUrls,
        createdAt: decision.createdAt.toISOString(),
        resolvedAt: decision.resolvedAt?.toISOString() ?? null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

/**
 * Stores mappings only; credentials belong in Replit Secrets and this route
 * cannot enable a real provider write. BGV, payroll, and benefits remain
 * intentionally unconfigurable until an approved vendor-specific contract is
 * added to the decision register.
 */
router.put("/onboarding/standard-providers/:providerKey/configuration", async (req, res, next) => {
  try {
    if (!requireProviderAdministrator(req, res)) return;
    const key = providerKey(req.params.providerKey);
    if (!key) return void res.status(404).json({ message: "Unknown standard provider." });
    if (!["oracle-hcm", "servicenow"].includes(key)) {
      return void res.status(409).json({
        message: `${STANDARD_PROVIDER_CONTRACTS[key].label} is Not configured: an approved vendor-specific contract is required before mappings can be saved.`,
      });
    }
    const body = req.body as Record<string, unknown>;
    const state = body.configurationState;
    const fieldMappings = mapping(body.fieldMappings);
    const expectedVersion = body.expectedVersion;
    const sandboxEvidenceReference = text(body.sandboxEvidenceReference, 500);
    const operatorApprovalReference = text(body.operatorApprovalReference, 500);
    if (
      (state !== "mapping-configured" && state !== "sandbox-validated" && state !== "operator-approved") ||
      !fieldMappings ||
      !Number.isInteger(expectedVersion) || Number(expectedVersion) < 0
    ) {
      return void res.status(400).json({
        message: "configurationState, expectedVersion, and a bounded string-to-string fieldMappings object are required.",
      });
    }
    if ((state === "sandbox-validated" || state === "operator-approved") && !sandboxEvidenceReference) {
      return void res.status(400).json({ message: "sandboxEvidenceReference is required after mapping configuration." });
    }
    if (state === "operator-approved" && !operatorApprovalReference) {
      return void res.status(400).json({ message: "operatorApprovalReference is required for operator-approved configuration." });
    }
    const organizationId = getOrganizationId(req);
    await ensureStandardProviderDecisionRegister(organizationId);
    const result = await db.transaction(async (tx) => {
      const [current] = await tx.select().from(onbStandardProviderConfigs).where(and(
        eq(onbStandardProviderConfigs.organizationId, organizationId),
        eq(onbStandardProviderConfigs.providerKey, key),
      )).for("update");
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== expectedVersion) return { conflict: true as const, currentVersion };
      if (
        state === "sandbox-validated" &&
        current?.configurationState !== "mapping-configured"
      ) {
        return {
          conflict: true as const,
          currentVersion,
          message: "Save the mapping-configured version before recording sandbox validation.",
        };
      }
      if (
        state === "operator-approved" &&
        current?.configurationState !== "sandbox-validated"
      ) {
        return {
          conflict: true as const,
          currentVersion,
          message: "An independently recorded sandbox-validated version is required before operator approval.",
        };
      }
      const now = new Date();
      const values = {
        organizationId,
        providerKey: key,
        sourceOfTruth: STANDARD_PROVIDER_CONTRACTS[key].sourceOfTruth,
        configurationState: state,
        fieldMappings,
        sandboxEvidenceReference,
        sandboxValidatedAt: state === "mapping-configured" ? null : now,
        operatorApprovalReference,
        operatorApprovedAt: state === "operator-approved" ? now : null,
        version: currentVersion + 1,
        updatedBy: req.authUserId!,
        updatedAt: now,
      };
      if (current) {
        await tx.update(onbStandardProviderConfigs).set(values).where(and(
          eq(onbStandardProviderConfigs.organizationId, organizationId),
          eq(onbStandardProviderConfigs.providerKey, key),
          eq(onbStandardProviderConfigs.version, currentVersion),
        ));
      } else {
        await tx.insert(onbStandardProviderConfigs).values(values);
      }
      await tx.insert(onbEvents).values({
        organizationId,
        caseId: null,
        agent: "standard-provider-contract",
        engine: "human",
        hitlPattern: "approve-before-act",
        ruleRef: "Standard provider configuration contract",
        title: `${STANDARD_PROVIDER_CONTRACTS[key].label} mapping updated`,
        detail: `Configuration is ${state}. Remote dispatch remains disabled until a separately reviewed dispatcher exists.`,
        idempotencyKey: `standard-provider-config:${key}:v${currentVersion + 1}`,
      }).onConflictDoNothing();
      return { conflict: false as const, version: currentVersion + 1 };
    });
    if (result.conflict) return void res.status(409).json({
      message: ("message" in result ? result.message : undefined) ??
        `Configuration changed by another reviewer (current version ${result.currentVersion}).`,
      currentVersion: result.currentVersion,
    });
    res.json({ providerKey: key, version: result.version, remoteDispatchEnabled: false });
  } catch (error) {
    next(error);
  }
});

/** Authenticated server read; no browser-supplied state, narrative, or snapshot. */
router.post("/onboarding/standard-providers/:providerKey/source-confirmations/refresh", async (req, res, next) => {
  try {
    if (!requireProviderAdministrator(req, res)) return;
    const key = providerKey(req.params.providerKey);
    if (key !== "oracle-hcm" && key !== "servicenow") {
      return void res.status(409).json({ message: "Only documented Oracle HCM and ServiceNow contracts accept source observations." });
    }
    const body = req.body as Record<string, unknown>;
    const caseId = body.caseId === undefined ? null : Number(body.caseId);
    if (caseId === null || !Number.isInteger(caseId) || caseId < 1) {
      return void res.status(400).json({ message: "caseId is required and must be a positive integer for a sensitive source observation." });
    }
    const organizationId = getOrganizationId(req);
    const [config] = await db.select().from(onbStandardProviderConfigs).where(and(
      eq(onbStandardProviderConfigs.organizationId, organizationId),
      eq(onbStandardProviderConfigs.providerKey, key),
    )).limit(1);
    if (!config || config.configurationState === "not-configured") {
      return void res.status(409).json({ message: "Configure and review mappings before recording a source observation." });
    }
    const [caseRow] = await db.select().from(onbCases).where(and(
      eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId),
    )).limit(1);
    if (!caseRow) return void res.status(404).json({ message: "Case not found in this organization." });
    if (!["sandbox-validated", "operator-approved"].includes(config.configurationState)) {
      return void res.status(409).json({
        message: "Authenticated source reads require sandbox-validated or operator-approved mappings.",
      });
    }
    const persistence = await withSensitiveLifecycleFence(organizationId, () => withSensitiveAuthorityFence({
      organizationId,
      caseId,
      actorUserId: req.authUserId!,
      // Provider evidence and field snapshots are unclassified opaque
      // envelopes. Require all scopes rather than guessing from a label.
      classification: "identity",
      additionalClassifications: ["medical", "payroll", "bgv"],
      additionalAccessKeys: ["tool.external.dispatch"],
      mutate: async () => {
      const settings = readSettingsFromEnvironment(key, organizationId);
      const confirmedRead = await dispatchWithProviderGovernance({
        caseRow,
        workflow: "worker-record-documents",
        operation: `standard-provider-source-read:${key}:case:${caseId}`,
        providerId: key,
        dispatch: () => key === "oracle-hcm"
          ? readConfirmedProviderSource({
            providerKey: key,
            source: {
              workersUniqId: text(body.workersUniqId, 255) ?? "",
              periodOfServiceId: text(body.periodOfServiceId, 255) ?? "",
            },
            settings: settings as Extract<typeof settings, { providerKey: "oracle-hcm" }>,
            fieldMappings: config.fieldMappings,
            transport: createServerBearerTransport(settings.bearerToken),
            organizationId,
            caseId,
            expectedCaseIdentity: caseRow.workerEmail,
            expectedCaseStartDate: caseRow.joiningDate,
          })
        : readConfirmedProviderSource({
            providerKey: key,
            source: { requestSysId: text(body.requestSysId, 255) ?? "" },
            settings: settings as Extract<typeof settings, { providerKey: "servicenow" }>,
            fieldMappings: config.fieldMappings,
            transport: createServerBearerTransport(settings.bearerToken),
            organizationId,
            caseId,
            expectedCaseIdentity: caseRow.workerEmail,
            expectedCaseStartDate: caseRow.joiningDate,
          }),
        disposition: () => "sent",
      });
      if (!confirmedRead.dispatched) {
        throw new StandardProviderSourceReadError(confirmedRead.reason);
      }
      const observation = confirmedRead.value;
      return withCaseDerivedLifecycleWrite({ organizationId, caseId }, async (tx, currentCase) => {
      const [existing] = await tx.select().from(onbStandardProviderSourceRecords).where(and(
        eq(onbStandardProviderSourceRecords.organizationId, organizationId),
        eq(onbStandardProviderSourceRecords.providerKey, observation.providerKey),
        eq(onbStandardProviderSourceRecords.sourceRecordType, observation.sourceRecordType),
        eq(onbStandardProviderSourceRecords.sourceRecordId, observation.sourceRecordId),
      )).for("update");
      if (existing && existing.sourceObservedAt > observation.sourceObservedAt) {
        return { stale: true as const };
      }
      await tx.insert(onbStandardProviderSourceRecords).values({
      organizationId,
      caseId,
      providerKey: observation.providerKey,
      sourceRecordType: observation.sourceRecordType,
      sourceRecordId: observation.sourceRecordId,
      normalizedState: observation.normalizedState,
      sourceObservedAt: observation.sourceObservedAt,
      evidenceReference: observation.evidenceReference,
      evidenceClass: "server-adapter-source-read",
      fieldSnapshot: {},
      recordedBy: req.authUserId!,
      }).onConflictDoUpdate({
      target: [
        onbStandardProviderSourceRecords.organizationId,
        onbStandardProviderSourceRecords.providerKey,
        onbStandardProviderSourceRecords.sourceRecordType,
        onbStandardProviderSourceRecords.sourceRecordId,
      ],
      set: {
        caseId,
        normalizedState: observation.normalizedState,
        sourceObservedAt: observation.sourceObservedAt,
        evidenceReference: observation.evidenceReference,
        fieldSnapshot: {},
        recordedBy: req.authUserId!,
        recordedAt: new Date(),
      },
    });
      // Only this server-side Oracle response classifier can emit trusted HRIS
      // activation evidence. Configuration labels and manual approvals are
      // deliberately not inputs. Bind both returned case identity and the
      // returned effective date to the currently locked case before writing.
      const currentStartDate = /^\d{4}-\d{2}-\d{2}/.exec(currentCase.joiningDate)?.[0] ?? null;
      const identityMatches = observation.verifiedCaseIdentity?.trim().toLowerCase()
        === currentCase.workerEmail.trim().toLowerCase();
      if (observation.providerKey === "oracle-hcm" &&
          observation.normalizedState === "work-relationship-active" &&
          identityMatches &&
          currentStartDate !== null &&
           observation.employmentStartDate === currentStartDate &&
           observation.sourceEvidenceRevision !== undefined) {
        const [slaState] = await tx.select({ snapshotVersion: onbReadinessSlaCaseState.snapshotVersion })
          .from(onbReadinessSlaCaseState).where(and(
            eq(onbReadinessSlaCaseState.organizationId, organizationId),
            eq(onbReadinessSlaCaseState.caseId, caseId),
          )).for("update");
        if (slaState) {
          await tx.insert(onbReadinessSlaAttestations).values({
            organizationId,
            caseId,
            snapshotVersion: slaState.snapshotVersion,
            streamKey: "hris",
            complete: true,
            evidenceProvenance: "trusted-provider",
            sourceStartDate: currentStartDate,
            sourceEvidenceRevision: observation.sourceEvidenceRevision,
            reason: "Server-classified Oracle HCM active work relationship matched the locked case identity, joining date, and immutable Oracle source revision.",
            attestedBy: "server-oracle-hcm-classifier",
            attestedRole: "system",
          });
        }
      }
      return { stale: false as const, observation };
      });
      },
    }));
    if (persistence.stale) {
      return void res.status(409).json({
        message: "A newer observation is already recorded for this source record; the stale observation was not applied.",
      });
    }
    res.status(201).json({
      providerKey: key,
      normalizedState: persistence.observation.normalizedState,
      sourceRecordId: persistence.observation.sourceRecordId,
      evidenceClass: "server-adapter-source-read",
      liveReadinessEligible: false,
      remoteDispatchEnabled: false,
    });
  } catch (error) {
    if (error instanceof SensitiveAuthorityRequiredError) {
      return void res.status(403).json({
        message: "Current sensitive-record authority is required to record a source observation.",
      });
    }
    if (error instanceof StandardProviderSourceReadError) {
      return void res.status(409).json({ message: error.message });
    }
    next(error);
  }
});

export default router;