import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, eaAssessmentsTable } from "@workspace/db";
import {
  ArchiveEaAssessmentResponse,
  ArchiveEaAssessmentParams,
  ArchiveEaAssessmentBody,
  CreateEaAssessmentBody,
  CreateEaAssessmentHandoffBody,
  CreateEaAssessmentHandoffParams,
  CreateEaAssessmentHandoffResponse,
  CreateEaAssessmentResponse,
  DeleteEaAssessmentBody,
  DeleteEaAssessmentParams,
  GetEaAssessmentParams,
  GetEaAssessmentResponse,
  GetEnterpriseArchitectureBaselineResponse,
  ListEaAssessmentsQueryParams,
  ListEaAssessmentsResponse,
  UpdateEaAssessmentBody,
  UpdateEaAssessmentParams,
  UpdateEaAssessmentResponse,
} from "@workspace/api-zod";
import { intents } from "../data/intents";
import { flowClasses } from "../data/flow-classes";
import { systems } from "../data/systems";
import { assumptions } from "../data/assumptions";
import { modelCatalog } from "../data/model-catalog";
import { logger } from "../lib/logger";
import { InputValidationError } from "../lib/validate-inputs";
import { requireAuth } from "../middlewares/require-auth";

const router: IRouter = Router();
const PHASES = [
  "preliminary",
  "architecture-vision",
  "business",
  "data",
  "application",
  "technology",
  "opportunities-solutions",
  "migration-planning",
  "implementation-governance",
  "architecture-change-management",
] as const;

function validatePhaseCoverage(content: {
  phaseProgress: Array<{ phase: string }>;
}): void {
  const phases = new Set(content.phaseProgress.map((item) => item.phase));
  if (PHASES.some((phase) => !phases.has(phase)) || phases.size !== PHASES.length) {
    throw new InputValidationError(
      "phaseProgress must contain each architecture phase exactly once",
    );
  }
}

export function requireInteger(
  value: number,
  label: string,
  minimum?: number,
  maximum?: number,
): void {
  if (
    !Number.isInteger(value) ||
    (minimum !== undefined && value < minimum) ||
    (maximum !== undefined && value > maximum)
  ) {
    const range =
      minimum !== undefined && maximum !== undefined
        ? ` between ${minimum} and ${maximum}`
        : minimum !== undefined
          ? ` greater than or equal to ${minimum}`
          : "";
    throw new InputValidationError(`${label} must be an integer${range}`);
  }
}

export function validateEaIntegers(content: Record<string, any>): void {
  for (const [domain, items] of Object.entries(content.currentState)) {
    for (const item of items as any[]) {
      requireInteger(item.maturity, `currentState.${domain}.maturity`, 0, 5);
    }
  }
  for (const item of content.roadmap.workPackages) {
    requireInteger(item.sequence, "roadmap.workPackages.sequence", 0);
  }
  for (const item of content.roadmap.waves) {
    requireInteger(item.sequence, "roadmap.waves.sequence", 0);
  }
  for (const item of content.risks) {
    requireInteger(item.likelihood, "risks.likelihood", 1, 5);
    requireInteger(item.impact, "risks.impact", 1, 5);
  }
  for (const item of content.costLinks) {
    requireInteger(item.linkedRecordId, "costLinks.linkedRecordId", 1);
  }
}

function nestedIds(content: Record<string, any>): Set<string> {
  const result = new Set<string>();
  const visit = (value: any): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (value && typeof value === "object") {
      if (typeof value.id === "string") result.add(value.id);
      Object.values(value).forEach(visit);
    }
  };
  visit(content);
  return result;
}

/** Removes references only to records that were present and have now been deleted. */
export function pruneRemovedEaReferences(
  previous: Record<string, any>,
  incoming: Record<string, any>,
): Record<string, any> {
  const clone = structuredClone(incoming);
  const removed = (oldItems: any[], newItems: any[]) => {
    const next = new Set(newItems.map((item) => item.id));
    return new Set<string>(oldItems.map((item) => item.id).filter((id) => !next.has(id)));
  };
  const removedRequirements = removed(previous.requirements, clone.requirements);
  const removedGaps = removed(previous.gaps, clone.gaps);
  const removedComponents = removed(
    previous.targetArchitecture.components,
    clone.targetArchitecture.components,
  );
  const removedWorkPackages = removed(
    previous.roadmap.workPackages,
    clone.roadmap.workPackages,
  );
  const removedTransitions = removed(
    previous.opportunities.transitionArchitectures,
    clone.opportunities.transitionArchitectures,
  );
  const previousGovernance = [
    ...previous.governance.contracts,
    ...previous.governance.reviews,
    ...previous.governance.deviations,
    ...previous.governance.waivers,
    ...previous.governance.remediation,
  ];
  const nextGovernance = [
    ...clone.governance.contracts,
    ...clone.governance.reviews,
    ...clone.governance.deviations,
    ...clone.governance.waivers,
    ...clone.governance.remediation,
  ];
  const removedGovernanceReviews = removed(
    previous.governance.reviews,
    clone.governance.reviews,
  );
  const removedDecisions = removed(previous.decisions, clone.decisions);
  const removedChanges = removed(
    previous.changeManagement.requests,
    clone.changeManagement.requests,
  );
  const filter = (values: string[], deleted: Set<string>) =>
    values.filter((id) => !deleted.has(id));
  const pruneTrace = (trace: any) => {
    trace.requirementIds = filter(trace.requirementIds, removedRequirements);
    trace.gapIds = filter(trace.gapIds, removedGaps);
    trace.targetComponentIds = filter(trace.targetComponentIds, removedComponents);
    trace.workPackageIds = filter(trace.workPackageIds, removedWorkPackages);
    trace.governanceReviewIds = filter(
      trace.governanceReviewIds,
      removedGovernanceReviews,
    );
  };

  clone.requirements.forEach((item: any) => pruneTrace(item.traceability));
  clone.gaps.forEach((item: any) => {
    if (removedComponents.has(item.targetBuildingBlockId)) item.targetBuildingBlockId = "";
    item.implementationDependencyIds = filter(
      item.implementationDependencyIds,
      removedWorkPackages,
    );
    pruneTrace(item.traceability);
  });
  clone.targetArchitecture.components.forEach((item: any) => {
    item.addressesGapIds = filter(item.addressesGapIds, removedGaps);
    item.deliveredByWorkPackageIds = filter(
      item.deliveredByWorkPackageIds,
      removedWorkPackages,
    );
  });
  clone.targetArchitecture.relationships = clone.targetArchitecture.relationships.filter(
    (item: any) =>
      !removedComponents.has(item.sourceComponentId) &&
      !removedComponents.has(item.targetComponentId),
  );
  clone.opportunities.solutionOptions.forEach((item: any) => {
    item.gapIds = filter(item.gapIds, removedGaps);
    item.targetComponentIds = filter(item.targetComponentIds, removedComponents);
  });
  clone.opportunities.transitionArchitectures.forEach((item: any) => {
    item.targetComponentIds = filter(item.targetComponentIds, removedComponents);
    item.workPackageIds = filter(item.workPackageIds, removedWorkPackages);
  });
  clone.roadmap.workPackages.forEach((item: any) => {
    item.targetComponentIds = filter(item.targetComponentIds, removedComponents);
  });
  clone.roadmap.dependencies = clone.roadmap.dependencies.filter(
    (item: any) =>
      !removedWorkPackages.has(item.predecessorWorkPackageId) &&
      !removedWorkPackages.has(item.successorWorkPackageId),
  );
  clone.roadmap.waves = clone.roadmap.waves
    .filter((item: any) => !removedTransitions.has(item.transitionArchitectureId))
    .map((item: any) => ({
      ...item,
      workPackageIds: filter(item.workPackageIds, removedWorkPackages),
    }));
  clone.roadmap.prioritization = clone.roadmap.prioritization.filter(
    (item: any) => !removedWorkPackages.has(item.workPackageId),
  );
  nextGovernance.forEach((item: any) => {
    item.targetComponentIds = filter(item.targetComponentIds, removedComponents);
    item.workPackageIds = filter(item.workPackageIds, removedWorkPackages);
    item.decisionIds = filter(item.decisionIds, removedDecisions);
  });
  const cleanedIds = nestedIds(clone);
  const removedAny = new Set(
    [...nestedIds(previous)].filter((id) => !cleanedIds.has(id)),
  );
  clone.changeManagement.requests.forEach((item: any) => {
    item.impact.affectedIds = filter(item.impact.affectedIds, removedAny);
  });
  clone.changeManagement.versionHistory.forEach((item: any) => {
    item.changeRequestIds = filter(item.changeRequestIds, removedChanges);
  });
  clone.decisions.forEach((item: any) => pruneTrace(item.traceability));
  clone.costLinks.forEach((item: any) => {
    item.gapIds = filter(item.gapIds, removedGaps);
    item.targetComponentIds = filter(item.targetComponentIds, removedComponents);
    item.workPackageIds = filter(item.workPackageIds, removedWorkPackages);
  });
  return clone;
}

/** Validates cross-record references after generated Zod has validated shape. */
export function validateContentReferences(content: Record<string, any>): void {
  const allIds = new Set<string>();
  const register = (value: any): void => {
    if (Array.isArray(value)) return value.forEach(register);
    if (value && typeof value === "object") {
      if (typeof value.id === "string") {
        if (allIds.has(value.id)) throw new InputValidationError(`Duplicate nested id "${value.id}"`);
        allIds.add(value.id);
      }
      Object.values(value).forEach(register);
    }
  };
  const ids = (items: any[]) => new Set<string>(items.map((item) => item.id));
  const references = (values: any[], known: Set<string>, label: string) => {
    values.forEach((value) => {
      if (typeof value !== "string" || !known.has(value)) {
        throw new InputValidationError(`${label} references unknown id "${String(value)}"`);
      }
    });
  };
  register(content);

  const requirements = content.requirements as any[];
  const gaps = content.gaps as any[];
  const components = content.targetArchitecture.components as any[];
  const relationships = content.targetArchitecture.relationships as any[];
  const options = content.opportunities.solutionOptions as any[];
  const transitions = content.opportunities.transitionArchitectures as any[];
  const workPackages = content.roadmap.workPackages as any[];
  const waves = content.roadmap.waves as any[];
  const dependencies = content.roadmap.dependencies as any[];
  const prioritization = content.roadmap.prioritization as any[];
  const governanceReviews = content.governance.reviews as any[];
  const governance = [
    ...content.governance.contracts,
    ...governanceReviews,
    ...content.governance.deviations,
    ...content.governance.waivers,
    ...content.governance.remediation,
  ] as any[];
  const changes = content.changeManagement.requests as any[];
  const versions = content.changeManagement.versionHistory as any[];
  const decisions = content.decisions as any[];
  const costLinks = content.costLinks as any[];
  const requirementIds = ids(requirements);
  const gapIds = ids(gaps);
  const componentIds = ids(components);
  const transitionIds = ids(transitions);
  const workPackageIds = ids(workPackages);
  const governanceReviewIds = ids(governanceReviews);
  const changeRequestIds = ids(changes);
  const decisionIds = ids(decisions);
  const trace = (item: any, label: string) => {
    references(item.traceability.requirementIds, requirementIds, `${label}.requirementIds`);
    references(item.traceability.gapIds, gapIds, `${label}.gapIds`);
    references(item.traceability.targetComponentIds, componentIds, `${label}.targetComponentIds`);
    references(item.traceability.workPackageIds, workPackageIds, `${label}.workPackageIds`);
    references(
      item.traceability.governanceReviewIds,
      governanceReviewIds,
      `${label}.governanceReviewIds`,
    );
  };

  requirements.forEach((item) => trace(item, "requirements.traceability"));
  gaps.forEach((item) => {
    if (item.targetBuildingBlockId && !componentIds.has(item.targetBuildingBlockId)) {
      throw new InputValidationError("gaps.targetBuildingBlockId references an unknown target component");
    }
    references(item.implementationDependencyIds, workPackageIds, "gaps.implementationDependencyIds");
    trace(item, "gaps.traceability");
  });
  components.forEach((item) => {
    references(item.addressesGapIds, gapIds, "targetArchitecture.components.addressesGapIds");
    references(
      item.deliveredByWorkPackageIds,
      workPackageIds,
      "targetArchitecture.components.deliveredByWorkPackageIds",
    );
  });
  relationships.forEach((item) => {
    references([item.sourceComponentId, item.targetComponentId], componentIds, "targetArchitecture.relationships");
  });
  options.forEach((item) => {
    references(item.gapIds, gapIds, "opportunities.solutionOptions.gapIds");
    references(item.targetComponentIds, componentIds, "opportunities.solutionOptions.targetComponentIds");
  });
  transitions.forEach((item) => {
    references(item.targetComponentIds, componentIds, "opportunities.transitionArchitectures.targetComponentIds");
    references(item.workPackageIds, workPackageIds, "opportunities.transitionArchitectures.workPackageIds");
  });
  workPackages.forEach((item) =>
    references(item.targetComponentIds, componentIds, "roadmap.workPackages.targetComponentIds"),
  );
  dependencies.forEach((item) =>
    references([item.predecessorWorkPackageId, item.successorWorkPackageId], workPackageIds, "roadmap.dependencies"),
  );
  waves.forEach((item) => {
    references([item.transitionArchitectureId], transitionIds, "roadmap.waves.transitionArchitectureId");
    references(item.workPackageIds, workPackageIds, "roadmap.waves.workPackageIds");
  });
  prioritization.forEach((item) =>
    references([item.workPackageId], workPackageIds, "roadmap.prioritization.workPackageId"),
  );
  governance.forEach((item) => {
    references(item.targetComponentIds, componentIds, "governance.targetComponentIds");
    references(item.workPackageIds, workPackageIds, "governance.workPackageIds");
    references(item.decisionIds, decisionIds, "governance.decisionIds");
  });
  changes.forEach((item) =>
    references(item.impact.affectedIds, allIds, "changeManagement.requests.impact.affectedIds"),
  );
  versions.forEach((item) =>
    references(item.changeRequestIds, changeRequestIds, "changeManagement.versionHistory.changeRequestIds"),
  );
  decisions.forEach((item) => trace(item, "decisions.traceability"));
  costLinks.forEach((item) => {
    references(item.gapIds, gapIds, "costLinks.gapIds");
    references(item.targetComponentIds, componentIds, "costLinks.targetComponentIds");
    references(item.workPackageIds, workPackageIds, "costLinks.workPackageIds");
  });
}

function serialize(row: typeof eaAssessmentsTable.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    clientName: row.clientName,
    status: row.status,
    version: row.version,
    currentPhase: row.currentPhase,
    content: row.content,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}

function owned(id: number, ownerUserId: string) {
  return and(
    eq(eaAssessmentsTable.id, id),
    eq(eaAssessmentsTable.ownerUserId, ownerUserId),
  );
}

type EaMutationAction = "patch" | "archive" | "delete" | "handoff";

export function getEaMutationRejection(
  existing: { status: string; version: number } | undefined,
  expectedVersion: number | undefined,
  action: EaMutationAction,
): { status: 404 | 409; error: string } | undefined {
  if (!existing) {
    return { status: 404, error: "Enterprise architecture assessment not found" };
  }
  if (existing.status === "archived") {
    const errors: Record<EaMutationAction, string> = {
      patch: "Archived assessments are immutable",
      archive: "Archived assessments are already archived",
      delete: "Archived assessments are retained and cannot be deleted",
      handoff: "Archived assessments cannot generate estimate handoffs",
    };
    return { status: 409, error: errors[action] };
  }
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    return {
      status: 409,
      error: "Assessment has changed; reload it and retry with its current expectedVersion",
    };
  }
  return undefined;
}

function baselineBlock(
  key: string,
  name: string,
  description: string,
  sourceType:
    | "intent"
    | "flow-class"
    | "system"
    | "model"
    | "assumption"
    | "pricing-architecture",
) {
  return { key, name, description, sourceType };
}

router.get(
  "/enterprise-architecture/baseline",
  requireAuth,
  async (_req, res, next): Promise<void> => {
    try {
      const result = {
        generatedAt: new Date().toISOString(),
        viewpoints: [
          {
            domain: "business",
            summary: "Reusable HRO intents and autonomous service patterns.",
            buildingBlocks: intents.map((item) =>
              baselineBlock(item.key, item.name, item.description, "intent"),
            ),
          },
          {
            domain: "data",
            summary: "Governed source data and evidence needed by HRO workflows.",
            buildingBlocks: systems.map((item) =>
              baselineBlock(
                item.key,
                item.name,
                `${item.description} ${item.integration.note}`,
                "system",
              ),
            ),
          },
          {
            domain: "application",
            summary: "Reusable flow classes that compose the application behavior.",
            buildingBlocks: flowClasses.map((item) =>
              baselineBlock(item.key, item.name, item.description, "flow-class"),
            ),
          },
          {
            domain: "technology",
            summary: "Deployment and consumption assumptions used by the existing models.",
            buildingBlocks: assumptions.map((item) =>
              baselineBlock(item.key, item.label, item.rationale, "assumption"),
            ),
          },
          {
            domain: "integration",
            summary: "System connector patterns exposed through governed agent tools.",
            buildingBlocks: systems.map((item) =>
              baselineBlock(
                item.key,
                item.integration.label,
                item.integration.note,
                "system",
              ),
            ),
          },
          {
            domain: "ai",
            summary: "Selectable model roles used by the existing cost and execution architecture.",
            buildingBlocks: modelCatalog.map((item) =>
              baselineBlock(item.key, item.label, item.description, "model"),
            ),
          },
          {
            domain: "security",
            summary: "Security is applied across identity, connectors, evidence, and tenant isolation.",
            buildingBlocks: [
              baselineBlock(
                "security-tier",
                "Security tier",
                "Reviewable standard, regulated, or enterprise scope passed to product pricing.",
                "pricing-architecture",
              ),
              baselineBlock(
                "governed-tools",
                "Governed tool access",
                "Agent actions use explicit system connector patterns rather than direct ungoverned writes.",
                "pricing-architecture",
              ),
            ],
          },
          {
            domain: "operating-model",
            summary: "Human checkpoints, support, and delivery sizing remain explicit.",
            buildingBlocks: flowClasses.map((item) =>
              baselineBlock(
                `operating-${item.key}`,
                `${item.name} operating pattern`,
                item.buildAssumption,
                "flow-class",
              ),
            ),
          },
        ],
        sourceCounts: {
          intents: intents.length,
          flowClasses: flowClasses.length,
          systems: systems.length,
          models: modelCatalog.length,
          assumptions: assumptions.length,
        },
      };
      res.json(GetEnterpriseArchitectureBaselineResponse.parse(result));
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/enterprise-architecture/assessments",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const query = ListEaAssessmentsQueryParams.parse(req.query);
      const ownerFilter = eq(eaAssessmentsTable.ownerUserId, req.authUserId!);
      const where = query.status
        ? and(ownerFilter, eq(eaAssessmentsTable.status, query.status))
        : ownerFilter;
      const rows = await db
        .select()
        .from(eaAssessmentsTable)
        .where(where)
        .orderBy(desc(eaAssessmentsTable.updatedAt));
      res.json(ListEaAssessmentsResponse.parse(rows.map(serialize)));
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/enterprise-architecture/assessments",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const body = CreateEaAssessmentBody.parse(req.body);
      validatePhaseCoverage(body.content);
      validateEaIntegers(body.content as Record<string, any>);
      validateContentReferences(body.content as Record<string, any>);
      const [row] = await db
        .insert(eaAssessmentsTable)
        .values({ ...body, ownerUserId: req.authUserId! })
        .returning();
      logger.info(
        { assessmentId: row!.id, ownerUserId: req.authUserId },
        "enterprise architecture assessment created",
      );
      res.status(201).json(CreateEaAssessmentResponse.parse(serialize(row!)));
    } catch (error) {
      next(error);
    }
  },
);

router.get(
  "/enterprise-architecture/assessments/:id",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const { id } = GetEaAssessmentParams.parse(req.params);
      requireInteger(id, "id", 1);
      const [row] = await db
        .select()
        .from(eaAssessmentsTable)
        .where(owned(id, req.authUserId!));
      if (!row) {
        res.status(404).json({ error: "Enterprise architecture assessment not found" });
        return;
      }
      res.json(GetEaAssessmentResponse.parse(serialize(row)));
    } catch (error) {
      next(error);
    }
  },
);

router.patch(
  "/enterprise-architecture/assessments/:id",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const { id } = UpdateEaAssessmentParams.parse(req.params);
      const body = UpdateEaAssessmentBody.parse(req.body);
      const { expectedVersion, ...updates } = body;
      requireInteger(id, "id", 1);
      requireInteger(expectedVersion, "expectedVersion", 1);
      if (Object.keys(updates).length === 0) {
        throw new InputValidationError("At least one assessment field must be updated");
      }
      if (body.content) {
        const [current] = await db
          .select({ content: eaAssessmentsTable.content })
          .from(eaAssessmentsTable)
          .where(
            and(
              owned(id, req.authUserId!),
              eq(eaAssessmentsTable.status, "active"),
              eq(eaAssessmentsTable.version, expectedVersion),
            ),
          );
        if (!current) {
          const [existing] = await db
            .select({ status: eaAssessmentsTable.status, version: eaAssessmentsTable.version })
            .from(eaAssessmentsTable)
            .where(owned(id, req.authUserId!));
          const rejection = getEaMutationRejection(existing, expectedVersion, "patch")!;
          res.status(rejection.status).json({ error: rejection.error });
          return;
        }
        const cleaned = pruneRemovedEaReferences(
          current.content as Record<string, any>,
          body.content as Record<string, any>,
        );
        validatePhaseCoverage(cleaned as { phaseProgress: Array<{ phase: string }> });
        validateEaIntegers(cleaned);
        validateContentReferences(cleaned);
        updates.content = cleaned as typeof body.content;
      }
      const [row] = await db
        .update(eaAssessmentsTable)
        .set({
          ...updates,
          version: sql`${eaAssessmentsTable.version} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            owned(id, req.authUserId!),
            eq(eaAssessmentsTable.status, "active"),
            eq(eaAssessmentsTable.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await db
          .select({ status: eaAssessmentsTable.status, version: eaAssessmentsTable.version })
          .from(eaAssessmentsTable)
          .where(owned(id, req.authUserId!));
        const rejection = getEaMutationRejection(existing, expectedVersion, "patch")!;
        res.status(rejection.status).json({ error: rejection.error });
        return;
      }
      logger.info(
        { assessmentId: id, ownerUserId: req.authUserId },
        "enterprise architecture assessment updated",
      );
      res.json(UpdateEaAssessmentResponse.parse(serialize(row)));
    } catch (error) {
      next(error);
    }
  },
);

router.delete(
  "/enterprise-architecture/assessments/:id",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const { id } = DeleteEaAssessmentParams.parse(req.params);
      const { expectedVersion } = DeleteEaAssessmentBody.parse(req.body);
      requireInteger(id, "id", 1);
      requireInteger(expectedVersion, "expectedVersion", 1);
      const [row] = await db
        .delete(eaAssessmentsTable)
        .where(
          and(
            owned(id, req.authUserId!),
            eq(eaAssessmentsTable.status, "active"),
            eq(eaAssessmentsTable.version, expectedVersion),
          ),
        )
        .returning({ id: eaAssessmentsTable.id });
      if (!row) {
        const [existing] = await db
          .select({ status: eaAssessmentsTable.status, version: eaAssessmentsTable.version })
          .from(eaAssessmentsTable)
          .where(owned(id, req.authUserId!));
        const rejection = getEaMutationRejection(existing, expectedVersion, "delete")!;
        res.status(rejection.status).json({ error: rejection.error });
        return;
      }
      logger.info(
        { assessmentId: id, ownerUserId: req.authUserId },
        "enterprise architecture assessment deleted",
      );
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/enterprise-architecture/assessments/:id/archive",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const { id } = ArchiveEaAssessmentParams.parse(req.params);
      const { expectedVersion } = ArchiveEaAssessmentBody.parse(req.body);
      requireInteger(id, "id", 1);
      requireInteger(expectedVersion, "expectedVersion", 1);
      const now = new Date();
      const [row] = await db
        .update(eaAssessmentsTable)
        .set({
          status: "archived",
          archivedAt: now,
          updatedAt: now,
          version: sql`${eaAssessmentsTable.version} + 1`,
        })
        .where(
          and(
            owned(id, req.authUserId!),
            eq(eaAssessmentsTable.status, "active"),
            eq(eaAssessmentsTable.version, expectedVersion),
          ),
        )
        .returning();
      if (!row) {
        const [existing] = await db
          .select()
          .from(eaAssessmentsTable)
          .where(owned(id, req.authUserId!));
        if (!existing) {
          res.status(404).json({ error: "Enterprise architecture assessment not found" });
          return;
        }
        if (existing.status === "archived") {
          res.json(ArchiveEaAssessmentResponse.parse(serialize(existing)));
          return;
        }
        const rejection = getEaMutationRejection(existing, expectedVersion, "archive")!;
        res.status(rejection.status).json({ error: rejection.error });
        return;
      }
      logger.info(
        { assessmentId: id, ownerUserId: req.authUserId },
        "enterprise architecture assessment archived",
      );
      res.json(ArchiveEaAssessmentResponse.parse(serialize(row)));
    } catch (error) {
      next(error);
    }
  },
);

router.post(
  "/enterprise-architecture/assessments/:id/handoff",
  requireAuth,
  async (req, res, next): Promise<void> => {
    try {
      const { id } = CreateEaAssessmentHandoffParams.parse(req.params);
      const request = CreateEaAssessmentHandoffBody.parse(req.body ?? {});
      requireInteger(id, "id", 1);
      if (request.scenarioId !== undefined) {
        requireInteger(request.scenarioId, "scenarioId", 1);
      }
      if (request.pricingSheetId !== undefined) {
        requireInteger(request.pricingSheetId, "pricingSheetId", 1);
      }
      const [row] = await db
        .select()
        .from(eaAssessmentsTable)
        .where(owned(id, req.authUserId!));
      if (!row) {
        res.status(404).json({ error: "Enterprise architecture assessment not found" });
        return;
      }
      if (row.status === "archived") {
        res.status(409).json({ error: "Archived assessments cannot generate estimate handoffs" });
        return;
      }

      const content = row.content as {
        gaps: Array<{ id: string; disposition: string }>;
        targetArchitecture: {
          components: Array<{ id: string; domain: string; name: string; componentType: string }>;
        };
        roadmap: { workPackages: Array<{ id: string; estimatedCost: number }> };
        currentState: Record<string, Array<{ id: string; name: string; kind: string }>>;
      };
      const components = content.targetArchitecture.components;
      const inventory = Object.values(content.currentState).flat();
      const countMatching = (terms: string[]) =>
        components.filter((item) =>
          terms.some((term) =>
            `${item.domain} ${item.name} ${item.componentType}`.toLowerCase().includes(term),
          ),
        ).length;
      const channels = Math.max(1, countMatching(["channel"]));
      const integrations = Math.max(
        content.currentState.integration.length,
        components.filter((item) => item.domain === "integration").length,
      );
      const systemCount = Math.max(
        content.currentState.application.length,
        components.filter((item) => item.domain === "application").length,
      );
      const agents = Math.max(1, countMatching(["agent", "ai"]));
      const workflows = Math.max(
        1,
        components.filter((item) => item.domain === "business").length,
        content.roadmap.workPackages.length,
      );
      const countries = inventory.filter((item) =>
        `${item.name} ${item.kind}`.toLowerCase().includes("country"),
      ).length;
      const securityText = components
        .filter((item) => item.domain === "security")
        .map((item) => `${item.name} ${item.componentType}`)
        .join(" ")
        .toLowerCase();
      const securityTier = securityText.includes("regulated")
        ? "regulated"
        : securityText.includes("enterprise")
          ? "enterprise"
          : "standard";
      const estimatedMigrationCost = content.roadmap.workPackages.reduce(
        (sum, item) => sum + item.estimatedCost,
        0,
      );
      const scope = {
        channels,
        integrations,
        systems: systemCount,
        agents,
        workflows,
        countries,
        tenantIsolation: countMatching(["dedicated", "silo"]) > 0 ? "siloed" : "pooled",
        securityTier,
        infrastructureTier:
          components.some((item) => item.domain === "technology") ? "production" : "starter",
        migrationEffort: {
          workPackages: content.roadmap.workPackages.length,
          estimatedCost: estimatedMigrationCost,
        },
        supportNeeds:
          content.currentState.operatingModel.length > 0 ? "review-required" : "not-assessed",
      };
      const traceability = {
        gapIds: content.gaps.map((item) => item.id),
        targetComponentIds: components.map((item) => item.id),
        workPackageIds: content.roadmap.workPackages.map((item) => item.id),
        requestedScenarioId: request.scenarioId ?? null,
        requestedPricingSheetId: request.pricingSheetId ?? null,
      };
      const result = {
        assessmentId: id,
        generatedAt: new Date().toISOString(),
        scenario: {
          name: `${row.clientName} architecture estimate`,
          scope,
          reviewNotes: [
            "Review transaction volumes, intent mix, labor assumptions, and adoption in Scenario Builder.",
            "No ROI or cost calculation has been performed by this handoff.",
          ],
        },
        productPricing: {
          name: `${row.clientName} architecture pricing scope`,
          scope,
          reviewNotes: [
            "Review all mapped quantities and tiers before loading Product Pricing.",
            "Product Pricing remains the source of truth for build, implementation, recurring cost, and price.",
          ],
        },
        traceability,
      };
      logger.info(
        { assessmentId: id, ownerUserId: req.authUserId, ...traceability },
        "enterprise architecture estimate handoff generated",
      );
      res.json(CreateEaAssessmentHandoffResponse.parse(result));
    } catch (error) {
      next(error);
    }
  },
);

export default router;