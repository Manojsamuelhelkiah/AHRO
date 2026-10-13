/**
 * Personal operational input is a separate generation from the immutable
 * fictional source. A draft does not confer execution or evidence authority.
 */
export type OfflineCasePreparation = {
  schema: "offline-case-preparation/v1";
  organizationId: string;
  caseId: number;
  sourceKey: string;
  sourceFingerprint: string;
  revision: number;
  templateId: string;
  templateVersion: number;
  data: Record<string, string>;
  updatedByUserId: string;
  updatedAt: string;
};

/** Server-owned activation receipt. Source facts are never current evidence. */
export type OfflineCaseActivation = {
  schema: "offline-case-activation/v1";
  organizationId: string;
  caseId: number;
  sourceKey: string;
  sourceFingerprint: string;
  sourceSnapshot: Record<string, unknown>;
  generation: string;
  activatedAt: string;
  generationStartedAt?: string;
  previousGenerations?: Array<Record<string, unknown>>;
  activatedByUserId: string;
  preparationRevision: number;
  permissionDecisionId: number;
  identityFingerprint: string;
  policyFingerprint: string;
  workflowStartedAt?: string;
  workflowStartedByUserId?: string;
  workflowStartDecisionId?: number;
};
