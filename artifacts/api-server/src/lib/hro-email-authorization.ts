import type { SeparationReceipt } from "@workspace/db";
import type { Tx } from "./offboarding/authority";
import { SeparationError } from "./offboarding/model";
import { hasHumanPermissions, isSharedDemoPrincipalInTransaction, permissionReceiptStillCurrent, type HumanPermissionReceipt } from "./human-permissions";

export class EmailIntakeAccessError extends SeparationError {
  constructor(public readonly code: "EMAIL_INTAKE_DEMO_RESTRICTED" | "EMAIL_INTAKE_ACCESS_REQUIRED") {
    super(code === "EMAIL_INTAKE_DEMO_RESTRICTED"
      ? "Public Demo access cannot open Email Intake. Sign in with verified Super Admin credentials; account initials are identity only."
      : "Current case-flow and profile read permissions are required in the selected client.", 403);
  }
}

/** Readiness is a tenant read, not a separation operation or route approval. */
export async function requireEmailIntakeRead(tx: Tx, organizationId: string, actorUserId: string) {
  if (await hasHumanPermissions(tx, { organizationId, actorUserId,
    requiredKeys: ["flow.case.read", "data.case.profile.read"] })) return;
  throw new EmailIntakeAccessError(await isSharedDemoPrincipalInTransaction(tx, actorUserId)
    ? "EMAIL_INTAKE_DEMO_RESTRICTED" : "EMAIL_INTAKE_ACCESS_REQUIRED");
}

const ROUTE_KEYS = ["flow.case.edit", "data.case.profile.edit"] as const;

export async function requireEmailRouteAdministrator(tx: Tx, organizationId: string, actorUserId: string) {
  if (!await hasHumanPermissions(tx, { organizationId, actorUserId,
    requiredKeys: ROUTE_KEYS, ownerAdminRequired: true })) {
    throw new SeparationError("A named client owner or admin with current case-flow and profile edit permissions is required to configure email intake.", 403);
  }
}

export async function emailRouteReceipt(tx: Tx, input: {
  organizationId: string; actor: string; reference: string; generation: number;
}): Promise<SeparationReceipt> {
  await requireEmailRouteAdministrator(tx, input.organizationId, input.actor);
  const recordedAt = new Date().toISOString();
  return {
    actor: input.actor, authorityId: `human-permission/v1:${input.actor}`, authorityRevision: 1,
    scope: "email-route-configuration", reference: input.reference, generation: input.generation,
    recordedAt, provenance: "human-source-attested",
    authorization: {
      schema: "human-permission/v1", organizationId: input.organizationId, caseId: null,
      actorUserId: input.actor, requiredKeys: [...ROUTE_KEYS], ownerAdminRequired: true,
      reviewedRevision: input.generation, evidenceGeneration: input.generation,
      decision: "mailbox-binding-reviewed", recordedAt,
    },
  };
}

export async function emailRouteReceiptCurrent(tx: Tx, org: string, receipt: SeparationReceipt | null, _country = "") {
  if (!receipt || receipt.scope !== "email-route-configuration" ||
    receipt.actor !== receipt.authorization?.actorUserId ||
    receipt.authorization?.decision !== "mailbox-binding-reviewed") return false;
  return permissionReceiptStillCurrent(tx, receipt.authorization as HumanPermissionReceipt, {
    organizationId: org, requiredKeys: ROUTE_KEYS, ownerAdminRequired: true,
    reviewedRevision: receipt.generation, evidenceGeneration: receipt.generation,
  });
}
