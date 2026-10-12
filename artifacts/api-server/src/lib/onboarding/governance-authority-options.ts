import { clerkClient } from "@clerk/express";
import { and, eq, isNull } from "drizzle-orm";
import { db, organizationMembershipsTable, onbGovernanceDecisions, onbGovernanceRequirements } from "@workspace/db";
import { GOVERNANCE_DECISIONS, GOVERNANCE_REQUIREMENTS } from "./governance-catalog";
import { GovernancePermissionError, isVerifiedGovernanceOperator, type GovernanceActor } from "./governance";
import { canonicalAuthorityRoleId } from "./workforce-policies";

export const POLICY_AUTHORITY_ROLES = [
  { id: "hr-policy-maintain", label: "HR Policy Maintainer" },
  { id: "hr-compliance", label: "HR Compliance Reviewer" },
  { id: "legal", label: "Legal Reviewer" },
  { id: "occupational-health", label: "Occupational Health Reviewer" },
  { id: "payroll", label: "Payroll Reviewer" },
  { id: "hr-policy-historical-review", label: "Historical Policy Reviewer" },
  { id: "hr-policy-handoff-resolve", label: "Policy Handoff Resolver" },
] as const;

export function authorityRoleOptions(extraRoles: string[] = []) {
  const roles = new Map<string, string>(POLICY_AUTHORITY_ROLES.map(({ id, label }) => [id, label]));
  for (const raw of [
    ...GOVERNANCE_DECISIONS.map((item) => item.accountableReviewRole),
    ...GOVERNANCE_REQUIREMENTS.map((item) => item.reviewOwner),
    ...extraRoles,
  ]) {
    const id = canonicalAuthorityRoleId(raw);
    if (id && !roles.has(id)) roles.set(id, raw);
  }
  return [...roles].map(([id, label]) => ({ id, label }));
}

type DirectoryLabel = { id: string; name: string | null; email: string | null };

async function directoryLabels(userIds: string[]): Promise<DirectoryLabel[]> {
  const users = await clerkClient.users.getUserList({ userId: userIds, limit: 100 });
  return users.data.map((user) => ({
    id: user.id,
    name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim() || null,
    email: user.emailAddresses.find((email) => email.id === user.primaryEmailAddressId)?.emailAddress ?? null,
  }));
}

export class GovernanceDirectoryUnavailableError extends Error {}

export async function getGovernanceAuthorityOptions(
  organizationId: string, actor: GovernanceActor,
  loadLabels: (ids: string[]) => Promise<DirectoryLabel[]> = directoryLabels,
) {
  const canVerify = isVerifiedGovernanceOperator(actor.userId, organizationId);
  const canNominate = actor.organizationRole === "owner" || actor.organizationRole === "admin";
  if (!canVerify && !canNominate) throw new GovernancePermissionError("Organization owner, admin, or verified governance operator required to choose authority members.");
  const members = await db.select({
    clerkUserId: organizationMembershipsTable.clerkUserId,
    role: organizationMembershipsTable.role,
  }).from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, organizationId),
    isNull(organizationMembershipsTable.revokedAt),
  )).orderBy(organizationMembershipsTable.clerkUserId);
  // Query only this client's active app members, never the global directory.
  const labels = new Map<string, { name: string | null; email: string | null }>();
  for (let offset = 0; offset < members.length; offset += 100) {
    try {
      const users = await loadLabels(members.slice(offset, offset + 100).map((member) => member.clerkUserId));
      for (const user of users) labels.set(user.id, { name: user.name, email: user.email });
    } catch {
      throw new GovernanceDirectoryUnavailableError("Could not load client member names from the identity directory. Retry before appointing an authority.");
    }
  }
  const [decisions, requirements] = await Promise.all([
    db.select({ role: onbGovernanceDecisions.accountableRole }).from(onbGovernanceDecisions).where(eq(onbGovernanceDecisions.organizationId, organizationId)),
    db.select({ role: onbGovernanceRequirements.reviewOwnerRole }).from(onbGovernanceRequirements).where(eq(onbGovernanceRequirements.organizationId, organizationId)),
  ]);
  return {
    organizationId, canNominate, canVerify,
    members: members.map((member) => ({ ...member, name: labels.get(member.clerkUserId)?.name ?? null, email: labels.get(member.clerkUserId)?.email ?? null })),
    roles: authorityRoleOptions([...decisions, ...requirements].map((item) => item.role)),
  };
}
