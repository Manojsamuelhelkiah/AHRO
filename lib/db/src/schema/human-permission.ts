/** Historical authorization evidence, not professional qualification or a grant. */
export type HumanPermissionDecision = {
  schema: "human-permission/v1";
  organizationId: string;
  caseId: number | null;
  actorUserId: string;
  requiredKeys: string[];
  reviewedRevision: number;
  evidenceGeneration: number;
  decision: string;
  recordedAt: string;
  ownerAdminRequired: boolean;
};
