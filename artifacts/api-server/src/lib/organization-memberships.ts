import { and, eq, isNull, sql } from "drizzle-orm";
import {
  db,
  onbAuthorityAssignments,
  onbGovernanceAuthorityAssignments,
  onbPolicyAuthorities,
  organizationMembershipsTable,
} from "@workspace/db";
import { appendProtectedAuditInTransaction } from "./onboarding/protected-audit";
import {
  assertGovernanceMutationAllowed,
  GovernanceDispatchBlockedError,
} from "./onboarding/governance-dispatch";
import type { OnboardingDbTransaction } from "./onboarding/settings";

import { isPlatformSuperAdmin } from "./private-platform-admin";
import { enrichMemberIdentities, type MemberIdentity, type DirectoryLabel } from "./member-identities";

export type OrganizationMembershipRole = "owner" | "admin" | "member";
export type OrganizationAdminRole = "admin" | "member";

export type OrganizationMember = {
  name?: MemberIdentity["name"];
  email?: MemberIdentity["email"];
  identityResolution?: MemberIdentity["identityResolution"];
  accountKind?: MemberIdentity["accountKind"];
  clerkUserId: string;
  role: OrganizationMembershipRole;
  createdAt: string;
};

export type RemovedOrganizationMember = OrganizationMember & {
  revokedAt: string;
  revision: number;
};

type MutationFailure = {
  kind: "error";
  status: 403 | 404 | 409;
  code: string;
  message: string;
};

type MutationSuccess = {
  kind: "ok";
  member: OrganizationMember & { revokedAt?: string };
};

export type MembershipMutationResult = MutationFailure | MutationSuccess;

const OWNER_REQUIRED: MutationFailure = {
  kind: "error",
  status: 403,
  code: "ORGANIZATION_OWNER_REQUIRED",
  message: "Only an organization owner may manage member roles, remove members, or reinstate members.",
};

function memberResponse(
  member: typeof organizationMembershipsTable.$inferSelect,
): OrganizationMember & { revokedAt?: string } {
  return {
    clerkUserId: member.clerkUserId,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
    ...(member.revokedAt ? { revokedAt: member.revokedAt.toISOString() } : {}),
  };
}

function removedMemberResponse(
  member: typeof organizationMembershipsTable.$inferSelect,
): RemovedOrganizationMember {
  if (!member.revokedAt) {
    throw new Error("Removed membership response requires a revocation timestamp");
  }
  return {
    clerkUserId: member.clerkUserId,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
    revokedAt: member.revokedAt.toISOString(),
    revision: member.membershipRevision,
  };
}

function conflict(message: string): MutationFailure {
  return {
    kind: "error",
    status: 409,
    code: "ORGANIZATION_MEMBERSHIP_CONFLICT",
    message,
  };
}

async function lockOrganization(tx: OnboardingDbTransaction, organizationId: string) {
  // This is intentionally the same tenant fence used by specialist authority
  // grant/revoke and final dispatch, so removal cannot race an authority write.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
  // Governance nomination/verification uses its namespaced dispatch fence.
  // Take it in a stable order after the base tenant fence before revoking
  // governance assignments.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`governance-dispatch-mutation:${organizationId}`}))`);
}

async function findActorAndTarget(
  tx: OnboardingDbTransaction,
  organizationId: string,
  actorUserId: string,
  targetUserId: string,
) {
  const [actor] = await tx
    .select()
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, actorUserId),
    ))
    .for("update");
  const [target] = await tx
    .select()
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, targetUserId),
    ))
    .for("update");
  return { actor, target };
}

export async function listOrganizationMembers(
  organizationId: string,
  actorUserId: string,
  loadLabels?: (ids: string[]) => Promise<DirectoryLabel[]>,
): Promise<
  | { kind: "ok"; members: OrganizationMember[] }
  | MutationFailure
> {
  const result = await db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, actorUserId),
        isNull(organizationMembershipsTable.revokedAt),
      ));
    if (!isPlatformSuperAdmin(actorUserId, organizationId) && (!actor || (actor.role !== "owner" && actor.role !== "admin"))) return OWNER_REQUIRED;
    const members = await tx
      .select({
        clerkUserId: organizationMembershipsTable.clerkUserId,
        role: organizationMembershipsTable.role,
        createdAt: organizationMembershipsTable.createdAt,
      })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        isNull(organizationMembershipsTable.revokedAt),
      ))
      .orderBy(organizationMembershipsTable.createdAt, organizationMembershipsTable.clerkUserId);
    return {
      kind: "ok" as const,
      members: members.map((member) => ({
        clerkUserId: member.clerkUserId,
        role: member.role,
        createdAt: member.createdAt.toISOString(),
      })),
    };
  });
  return result.kind === "ok" ? { ...result, members: await enrichMemberIdentities(result.members, loadLabels) } : result;
}

export async function listRemovedOrganizationMembers(
  organizationId: string,
  actorUserId: string,
  loadLabels?: (ids: string[]) => Promise<DirectoryLabel[]>,
): Promise<
  | { kind: "ok"; members: RemovedOrganizationMember[] }
  | MutationFailure
> {
  const result = await db.transaction(async (tx) => {
    const [actor] = await tx
      .select({ role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, actorUserId),
        isNull(organizationMembershipsTable.revokedAt),
      ));
    if (!isPlatformSuperAdmin(actorUserId, organizationId) && (!actor || actor.role !== "owner")) return OWNER_REQUIRED;
    const members = await tx
      .select()
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        sql`${organizationMembershipsTable.revokedAt} IS NOT NULL`,
      ))
      .orderBy(organizationMembershipsTable.revokedAt, organizationMembershipsTable.clerkUserId);
    return {
      kind: "ok" as const,
      members: members.map(removedMemberResponse),
    };
  });
  return result.kind === "ok" ? { ...result, members: await enrichMemberIdentities(result.members, loadLabels) } : result;
}

export async function changeOrganizationMemberRole(input: {
  organizationId: string;
  actorUserId: string;
  targetUserId: string;
  expectedRole: OrganizationMembershipRole;
  role: OrganizationAdminRole;
}): Promise<MembershipMutationResult> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const { actor, target } = await findActorAndTarget(
      tx,
      input.organizationId,
      input.actorUserId,
      input.targetUserId,
    );
    if (!isPlatformSuperAdmin(input.actorUserId, input.organizationId) && (!actor || actor.revokedAt || actor.role !== "owner")) return OWNER_REQUIRED;
    if (input.targetUserId === input.actorUserId) {
      return conflict("An owner cannot change their own membership role.");
    }
    if (!target || target.revokedAt) {
      return {
        kind: "error",
        status: 404,
        code: "ORGANIZATION_MEMBER_NOT_FOUND",
        message: "The target is not an active member of this organization.",
      };
    }
    if (target.role !== input.expectedRole) {
      return conflict("The target membership changed; reload the member list and retry.");
    }
    if (target.role === "owner") {
      return {
        kind: "error",
        status: 409,
        code: "ORGANIZATION_OWNER_PROTECTED",
        message: "Owner memberships cannot be changed through member administration.",
      };
    }
    if (target.role === input.role) return { kind: "ok" as const, member: memberResponse(target) };
    const [updated] = await tx
      .update(organizationMembershipsTable)
      .set({ role: input.role })
      .where(and(
        eq(organizationMembershipsTable.id, target.id),
        eq(organizationMembershipsTable.role, input.expectedRole),
        isNull(organizationMembershipsTable.revokedAt),
      ))
      .returning();
    if (!updated) return conflict("The target membership changed; reload the member list and retry.");
    await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      actorKind: "authenticated",
      actorAuthority: "organization-owner",
      action: "organization.membership.role-changed",
      outcome: "success",
      objectType: "organization-membership",
      objectId: input.targetUserId,
      source: "organization-memberships",
      payload: { safeStatus: input.role, reasonProvided: true },
    });
    return { kind: "ok" as const, member: memberResponse(updated) };
  });
}

export async function removeOrganizationMember(input: {
  organizationId: string;
  actorUserId: string;
  targetUserId: string;
  expectedRole: OrganizationMembershipRole;
}): Promise<MembershipMutationResult> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    try {
      await assertGovernanceMutationAllowed(tx, input.organizationId);
    } catch (error) {
      if (error instanceof GovernanceDispatchBlockedError) {
        return {
          kind: "error" as const,
          status: 409 as const,
          code: "GOVERNANCE_DISPATCH_IN_FLIGHT",
          message: error.message,
        };
      }
      throw error;
    }
    const { actor, target } = await findActorAndTarget(
      tx,
      input.organizationId,
      input.actorUserId,
      input.targetUserId,
    );
    if (!isPlatformSuperAdmin(input.actorUserId, input.organizationId) && (!actor || actor.revokedAt || actor.role !== "owner")) return OWNER_REQUIRED;
    if (input.targetUserId === input.actorUserId) {
      return conflict("An owner cannot remove their own membership.");
    }
    if (!target || target.revokedAt) {
      return {
        kind: "error",
        status: 404,
        code: "ORGANIZATION_MEMBER_NOT_FOUND",
        message: "The target is not an active member of this organization.",
      };
    }
    if (target.role !== input.expectedRole) {
      return conflict("The target membership changed; reload the member list and retry.");
    }
    if (target.role === "owner") {
      return {
        kind: "error",
        status: 409,
        code: "ORGANIZATION_OWNER_PROTECTED",
        message: "The last owner cannot be removed, and owner memberships are protected.",
      };
    }
    const revokedAt = new Date();
    const [updated] = await tx
      .update(organizationMembershipsTable)
      .set({
        revokedAt,
        membershipRevision: sql`${organizationMembershipsTable.membershipRevision} + 1`,
      })
      .where(and(
        eq(organizationMembershipsTable.id, target.id),
        eq(organizationMembershipsTable.role, input.expectedRole),
        isNull(organizationMembershipsTable.revokedAt),
      ))
      .returning();
    if (!updated) return conflict("The target membership changed; reload the member list and retry.");

    await tx.update(onbAuthorityAssignments).set({
      status: "revoked",
      revision: sql`${onbAuthorityAssignments.revision} + 1`,
      revokedAt,
      revokedByUserId: input.actorUserId,
      revokeReason: "Organization membership revoked",
      updatedAt: revokedAt,
    }).where(and(
      eq(onbAuthorityAssignments.organizationId, input.organizationId),
      eq(onbAuthorityAssignments.personUserId, input.targetUserId),
      eq(onbAuthorityAssignments.status, "active"),
    ));
    await tx.update(onbPolicyAuthorities).set({ revokedAt }).where(and(
      eq(onbPolicyAuthorities.organizationId, input.organizationId),
      eq(onbPolicyAuthorities.userId, input.targetUserId),
      isNull(onbPolicyAuthorities.revokedAt),
    ));
    await tx.update(onbGovernanceAuthorityAssignments).set({
      revokedAt,
      revokedByUserId: input.actorUserId,
    }).where(and(
      eq(onbGovernanceAuthorityAssignments.organizationId, input.organizationId),
      eq(onbGovernanceAuthorityAssignments.assigneeUserId, input.targetUserId),
      isNull(onbGovernanceAuthorityAssignments.revokedAt),
    ));
    await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      actorKind: "authenticated",
      actorAuthority: "organization-owner",
      action: "organization.membership.revoked",
      outcome: "success",
      objectType: "organization-membership",
      objectId: input.targetUserId,
      source: "organization-memberships",
      payload: { safeStatus: "revoked", reasonProvided: true },
    });
    return { kind: "ok" as const, member: memberResponse(updated) };
  });
}

export async function reinstateOrganizationMember(input: {
  organizationId: string;
  actorUserId: string;
  targetUserId: string;
  expectedRevokedAt: Date;
  expectedRevision: number;
  reason: string;
}): Promise<MembershipMutationResult> {
  return db.transaction(async (tx) => {
    await lockOrganization(tx, input.organizationId);
    const { actor, target } = await findActorAndTarget(
      tx,
      input.organizationId,
      input.actorUserId,
      input.targetUserId,
    );
    if (!isPlatformSuperAdmin(input.actorUserId, input.organizationId) && (!actor || actor.revokedAt || actor.role !== "owner")) return OWNER_REQUIRED;
    if (!target || !target.revokedAt) {
      return {
        kind: "error" as const,
        status: 404 as const,
        code: "ORGANIZATION_REMOVED_MEMBER_NOT_FOUND",
        message: "The target is not a removed member of this organization.",
      };
    }
    if (
      target.revokedAt.getTime() !== input.expectedRevokedAt.getTime() ||
      target.membershipRevision !== input.expectedRevision
    ) {
      return conflict("The removal changed; reload the removed-member list and retry.");
    }
    // The lifecycle revision is the durable CAS version. revokedAt remains a
    // display/audit timestamp and is checked alongside it for an exact
    // tombstone precondition.
    const [updated] = await tx
      .update(organizationMembershipsTable)
      .set({
        revokedAt: null,
        role: "member",
        membershipRevision: sql`${organizationMembershipsTable.membershipRevision} + 1`,
      })
      .where(and(
        eq(organizationMembershipsTable.id, target.id),
        eq(organizationMembershipsTable.role, target.role),
        eq(organizationMembershipsTable.revokedAt, input.expectedRevokedAt),
        eq(organizationMembershipsTable.membershipRevision, input.expectedRevision),
      ))
      .returning();
    if (!updated) return conflict("The removal changed; reload the removed-member list and retry.");
    await appendProtectedAuditInTransaction(tx, {
      organizationId: input.organizationId,
      actorId: input.actorUserId,
      actorKind: "authenticated",
      actorAuthority: "organization-owner",
      action: "organization.membership.reinstated",
      outcome: "success",
      objectType: "organization-membership",
      objectId: input.targetUserId,
      source: "organization-memberships",
      payload: {
        safeStatus: "member",
        reasonProvided: true,
        reason: input.reason,
      },
    });
    return { kind: "ok" as const, member: memberResponse(updated) };
  });
}