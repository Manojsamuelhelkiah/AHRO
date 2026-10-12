import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Response } from "express";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import {
  accessAgents,
  accessGovernanceHistory,
  accessPrincipalSecurityGroupAttachments,
  accessSecurityGroupAttachments,
  accessSecurityGroupPolicies,
  accessSecurityGroups,
  accessSecurityGroupUserGroups,
  accessUserGroupMembers,
  accessUserGroups,
  db,
  organizationMembershipsTable,
} from "@workspace/db";
import type { OnboardingDbTransaction } from "../lib/onboarding/settings";
import { getOrganizationId } from "../lib/organization-scope";
import {
  ACCESS_GOVERNANCE_CATALOG,
  USER_GROUP_STARTERS,
  userGroupStarter,
  normalizedUserGroupName,
  isActiveDistinctOwnerApprovalValid,
  isIndependentOwnerApprovalValid,
  grantIsLive,
  isReviewedAccessKey,
  resolveEffectiveAccess,
} from "../lib/access-governance";

const router: IRouter = Router();
type PrincipalType = "user" | "agent";
type ResourceType = "field" | "flow" | "tool";
type CatalogEntry = { key: string; label: string; sensitivity: string; kind: ResourceType };

// This is the allow-list for policy keys. Anything not represented here fails
// closed at write and evaluation time.
const ACCESS_CATALOG: CatalogEntry[] = [
  ...ACCESS_GOVERNANCE_CATALOG.fields.map((key) => ({
    key,
    label: key.replace(/^data\./, "").replace(/[._]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    sensitivity: /^(data\.(identity|medical|payroll|bgv))/.test(key) ? "high" : "medium",
    kind: "field" as const,
  })),
  ...ACCESS_GOVERNANCE_CATALOG.flows.map((key) => ({
    key,
    label: key.replace(/^flow\./, "").replace(/[.-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    sensitivity: "medium",
    kind: "flow" as const,
  })),
  ...ACCESS_GOVERNANCE_CATALOG.tools.map((key) => ({
    key,
    label: key.replace(/^tool\./, "").replace(/[.-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
    sensitivity: "medium",
    kind: "tool" as const,
  })),
];
const CATALOG_BY_KEY = new Map(ACCESS_CATALOG.map((entry) => [entry.key, entry]));

function fail(res: Response, status: number, message: string, code: string): void {
  res.status(status).json({ message, code });
}

// Run after transaction rollback: PostgreSQL rejects queries inside a failed
// transaction. Match only the name constraint, never starter IDs or other keys.
async function respondToGroupNameConflict(
  res: Response, error: unknown, organizationId: string,
  type: "user-group" | "security-group", name: unknown,
): Promise<boolean> {
  if (typeof name !== "string") return false;
  const constraint = type === "user-group"
    ? "access_user_groups_org_name_unique" : "access_security_groups_org_name_unique";
  let cause = error;
  const seen = new Set<unknown>();
  let matched = false;
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const pgError = cause as { code?: string; constraint?: string; cause?: unknown };
    if (pgError.code === "23505" && pgError.constraint === constraint) {
      matched = true;
      break;
    }
    cause = pgError.cause;
  }
  if (!matched) return false;
  const table = type === "user-group" ? accessUserGroups : accessSecurityGroups;
  const [group] = await db.select({ id: table.id, name: table.name, status: table.status })
    .from(table).where(and(eq(table.organizationId, organizationId), eq(table.name, name.trim()))).limit(1);
  const label = type === "user-group" ? "user group" : "security group";
  res.status(409).json({
    code: "ACCESS_GROUP_NAME_CONFLICT",
    message: group
      ? `A ${label} named “${group.name}” already exists in this organization${group.status === "retired" ? " and is retired" : ""}. View the existing group or choose a different name.`
      : `This ${label} name is already in use in this organization. Refresh the group list and choose a different name.`,
    ...(group ? { existingGroup: { ...group, type } } : {}),
  });
  return true;
}

function bodyObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validPrincipalType(value: unknown): value is PrincipalType {
  return value === "user" || value === "agent";
}

function optionalCaseId(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) return null;
  const caseId = Number(value);
  return Number.isSafeInteger(caseId) ? caseId : null;
}

function parseExpiry(value: unknown, active: boolean): Date | null | undefined {
  if (value === undefined) return null;
  if (!active || value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return undefined;
  const expiresAt = new Date(value);
  return Number.isFinite(expiresAt.getTime()) && expiresAt.getTime() > Date.now() ? expiresAt : undefined;
}

function toSchemaPrincipalType(value: PrincipalType): "human" | "agent" {
  return value === "user" ? "human" : "agent";
}

function parseAllows(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((key) => typeof key !== "string")) return null;
  const allows = [...new Set(value as string[])];
  if (allows.some((key) => !isReviewedAccessKey(key))) return null;
  return allows;
}

function isSensitive(key: string): boolean {
  const sensitivity = CATALOG_BY_KEY.get(key)?.sensitivity;
  return sensitivity === "high" || sensitivity === "critical";
}

function resourceType(key: string): ResourceType {
  return CATALOG_BY_KEY.get(key)!.kind;
}

function groupAllows(policy: { fields: string[]; flows: string[]; tools: string[] }): string[] {
  return [...policy.fields, ...policy.flows, ...policy.tools];
}

function currentPolicy(policies: typeof accessSecurityGroupPolicies.$inferSelect[]) {
  return policies.reduce<typeof policies[number] | undefined>(
    (latest, row) => !latest || row.version > latest.version ? row : latest,
    undefined,
  );
}

function eventStatus(
  history: (typeof accessGovernanceHistory.$inferSelect)[],
  entityType: string,
  entityId: string,
): string {
  const latest = history.find((event) =>
    event.entityType === entityType &&
    event.entityId === entityId &&
    (event.eventType === `${entityType}.created` || event.eventType === `${entityType}.status`),
  );
  const status = latest?.detail?.status;
  return status === "retired" ? "retired" : "active";
}

async function lockTenant(tx: OnboardingDbTransaction, organizationId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`);
}

async function recordHistory(
  tx: OnboardingDbTransaction,
  input: {
    organizationId: string;
    actorUserId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    detail?: Record<string, string | number | boolean | null>;
  },
): Promise<void> {
  await tx.insert(accessGovernanceHistory).values({
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    detail: input.detail ?? {},
  });
}

async function hasActivePrincipal(
  tx: OnboardingDbTransaction,
  organizationId: string,
  principalType: PrincipalType,
  principalId: string,
): Promise<boolean> {
  if (principalType === "user") {
    const [member] = await tx.select({ id: organizationMembershipsTable.clerkUserId })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        eq(organizationMembershipsTable.clerkUserId, principalId),
        isNull(organizationMembershipsTable.revokedAt),
      ))
      .limit(1);
    return Boolean(member);
  }
  const [agent] = await tx.select({ id: accessAgents.id })
    .from(accessAgents)
    .where(and(
      eq(accessAgents.organizationId, organizationId),
      eq(accessAgents.id, principalId),
      eq(accessAgents.status, "active"),
      isNull(accessAgents.revokedAt),
    ))
    .limit(1);
  return Boolean(agent);
}

async function isActiveOrganizationOwner(
  tx: OnboardingDbTransaction,
  organizationId: string,
  userId: string,
): Promise<boolean> {
  const [owner] = await tx.select({ id: organizationMembershipsTable.clerkUserId })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, userId),
      eq(organizationMembershipsTable.role, "owner"),
      isNull(organizationMembershipsTable.revokedAt),
    ))
    .limit(1);
  return Boolean(owner);
}

async function policyForGroup(
  tx: OnboardingDbTransaction,
  organizationId: string,
  securityGroupId: string,
) {
  const rows = await tx.select().from(accessSecurityGroupPolicies)
    .where(and(
      eq(accessSecurityGroupPolicies.organizationId, organizationId),
      eq(accessSecurityGroupPolicies.securityGroupId, securityGroupId),
    ));
  return currentPolicy(rows);
}

async function highSensitivityGroupsForUserGroup(
  tx: OnboardingDbTransaction,
  organizationId: string,
  userGroupId: string,
): Promise<Array<{ id: string; ownerUserId: string; policyVersion: number }>> {
  const links = await tx.select({ securityGroupId: accessSecurityGroupUserGroups.securityGroupId })
    .from(accessSecurityGroupUserGroups)
    .where(and(
      eq(accessSecurityGroupUserGroups.organizationId, organizationId),
      eq(accessSecurityGroupUserGroups.userGroupId, userGroupId),
      eq(accessSecurityGroupUserGroups.status, "active"),
    ));
  const sensitiveGroups: Array<{ id: string; ownerUserId: string; policyVersion: number }> = [];
  for (const link of links) {
    const [group] = await tx.select().from(accessSecurityGroups).where(and(
      eq(accessSecurityGroups.organizationId, organizationId),
      eq(accessSecurityGroups.id, link.securityGroupId),
      eq(accessSecurityGroups.status, "active"),
    )).limit(1);
    if (!group) continue;
    const policy = await policyForGroup(tx, organizationId, group.id);
    if (policy && groupAllows(policy.policy).some(isSensitive)) {
      sensitiveGroups.push({ id: group.id, ownerUserId: group.ownerUserId, policyVersion: policy.version });
    }
  }
  return sensitiveGroups;
}

async function isMembershipApprovalCurrent(
  tx: OnboardingDbTransaction,
  organizationId: string,
  userGroup: typeof accessUserGroups.$inferSelect,
  membership: typeof accessUserGroupMembers.$inferSelect,
  sensitiveGroups: Array<{ id: string; ownerUserId: string; policyVersion: number }>,
): Promise<boolean> {
  if (membership.requiresApproval === "no" && sensitiveGroups.length === 0) return true;
  return isActiveDistinctOwnerApprovalValid({
    status: membership.status,
    ownerUserId: userGroup.ownerUserId,
    attachedByUserId: membership.attachedByUserId,
    approvedByUserId: membership.approvedByUserId,
    approvedAt: membership.approvedAt,
    ownerIsActiveMember: await isActiveOrganizationOwner(tx, organizationId, userGroup.ownerUserId),
  });
}

async function requestSensitiveMembershipReviews(
  tx: OnboardingDbTransaction,
  organizationId: string,
  userGroup: typeof accessUserGroups.$inferSelect,
  requestedByUserId: string,
  policyVersions: string,
): Promise<void> {
  const activeMembers = await tx.select().from(accessUserGroupMembers).where(and(
    eq(accessUserGroupMembers.organizationId, organizationId),
    eq(accessUserGroupMembers.groupId, userGroup.id),
    or(
      eq(accessUserGroupMembers.status, "active"),
      eq(accessUserGroupMembers.status, "pending"),
    ),
    isNull(accessUserGroupMembers.revokedAt),
    or(isNull(accessUserGroupMembers.expiresAt), gt(accessUserGroupMembers.expiresAt, new Date())),
  ));
  if (activeMembers.length && requestedByUserId === userGroup.ownerUserId) {
    throw Object.assign(new Error("The user-group owner cannot request membership approval on their own policy path."), { status: 409, code: "ACCESS_INDEPENDENT_REVIEW_REQUIRED" });
  }
  for (const member of activeMembers) {
    if (member.principalType === "human" && member.principalId === userGroup.ownerUserId) {
      await tx.update(accessUserGroupMembers).set({
        status: "revoked",
        revokedByUserId: requestedByUserId,
        revokedAt: new Date(),
        approvedByUserId: null,
        approvedAt: null,
        version: member.version + 1,
      }).where(and(
        eq(accessUserGroupMembers.organizationId, organizationId),
        eq(accessUserGroupMembers.groupId, userGroup.id),
        eq(accessUserGroupMembers.principalType, member.principalType),
        eq(accessUserGroupMembers.principalId, member.principalId),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: requestedByUserId, eventType: "user-group.member",
        entityType: "user-group", entityId: userGroup.id,
        detail: { principalType: "user", principalId: member.principalId, active: false },
      });
      continue;
    }
    await tx.update(accessUserGroupMembers).set({
      status: "pending",
      requiresApproval: "yes",
      attachedByUserId: requestedByUserId,
      approvedByUserId: null,
      approvedAt: null,
      revokedByUserId: null,
      revokedAt: null,
      version: member.version + 1,
    }).where(and(
      eq(accessUserGroupMembers.organizationId, organizationId),
      eq(accessUserGroupMembers.groupId, userGroup.id),
      eq(accessUserGroupMembers.principalType, member.principalType),
      eq(accessUserGroupMembers.principalId, member.principalId),
    ));
    await recordHistory(tx, {
      organizationId, actorUserId: requestedByUserId, eventType: "user-group.member.pending",
      entityType: "user-group", entityId: userGroup.id,
      detail: {
        principalType: member.principalType === "human" ? "user" : "agent",
        principalId: member.principalId,
        active: true,
        policyVersions,
      },
    });
  }
}

function latestLinkEvent(
  events: (typeof accessGovernanceHistory.$inferSelect)[],
  entityType: string,
  entityId: string,
  eventTypes: readonly string[],
  matches: (detail: Record<string, unknown>) => boolean,
) {
  return events.find((event) =>
    event.entityType === entityType &&
    event.entityId === entityId &&
    eventTypes.includes(event.eventType) &&
    matches(event.detail ?? {}),
  );
}

async function sensitivePoliciesForUserGroupRequests(
  tx: OnboardingDbTransaction,
  organizationId: string,
  userGroupId: string,
): Promise<Array<{ id: string; ownerUserId: string; policyVersion: number }>> {
  const groups = await highSensitivityGroupsForUserGroup(tx, organizationId, userGroupId);
  const events = await tx.select().from(accessGovernanceHistory)
    .where(and(
      eq(accessGovernanceHistory.organizationId, organizationId),
      eq(accessGovernanceHistory.entityType, "user-group"),
      eq(accessGovernanceHistory.entityId, userGroupId),
    ))
    .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id));
  const latestBySecurityGroup = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const securityGroupId = event.detail?.securityGroupId;
    if (typeof securityGroupId !== "string" || latestBySecurityGroup.has(securityGroupId) ||
      ![
        "user-group.security-group.attached",
        "user-group.security-group.pending",
        "user-group.security-group.approved",
        "user-group.security-group.detached",
      ].includes(event.eventType)) continue;
    latestBySecurityGroup.set(securityGroupId, event);
  }
  for (const [securityGroupId, event] of latestBySecurityGroup) {
    if (event.eventType !== "user-group.security-group.pending" ||
      groups.some((group) => group.id === securityGroupId)) continue;
    const [group] = await tx.select().from(accessSecurityGroups).where(and(
      eq(accessSecurityGroups.organizationId, organizationId),
      eq(accessSecurityGroups.id, securityGroupId),
      eq(accessSecurityGroups.status, "active"),
    )).limit(1);
    if (!group) continue;
    const policy = await policyForGroup(tx, organizationId, securityGroupId);
    if (policy && groupAllows(policy.policy).some(isSensitive)) {
      groups.push({ id: securityGroupId, ownerUserId: group.ownerUserId, policyVersion: policy.version });
    }
  }
  return groups;
}

async function resolveRouteAccess(
  organizationId: string,
  principalType: PrincipalType,
  principalId: string,
  options: { caseId?: number; initiatorUserId?: string } = {},
) {
  return resolveEffectiveAccess({
    organizationId,
    principalType: principalType === "user" ? "human" : "agent",
    principalId,
    ...(options.caseId === undefined ? {} : { caseId: options.caseId }),
    ...(options.initiatorUserId === undefined
      ? {}
      : { initiatorUserId: options.initiatorUserId }),
  });
}

async function snapshot(organizationId: string) {
  const now = new Date();
  const [members, agents, userGroups, securityGroups, policies, memberships, attachments, scopeAttachments, directAttachments, allEvents] =
    await Promise.all([
      db.select({
        clerkUserId: organizationMembershipsTable.clerkUserId,
        role: organizationMembershipsTable.role,
      }).from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        isNull(organizationMembershipsTable.revokedAt),
      )),
      db.select().from(accessAgents).where(eq(accessAgents.organizationId, organizationId)),
      db.select().from(accessUserGroups).where(eq(accessUserGroups.organizationId, organizationId)),
      db.select().from(accessSecurityGroups).where(eq(accessSecurityGroups.organizationId, organizationId)),
      db.select().from(accessSecurityGroupPolicies).where(eq(accessSecurityGroupPolicies.organizationId, organizationId)),
      db.select().from(accessUserGroupMembers).where(eq(accessUserGroupMembers.organizationId, organizationId)),
      db.select().from(accessSecurityGroupUserGroups).where(eq(accessSecurityGroupUserGroups.organizationId, organizationId)),
      db.select().from(accessSecurityGroupAttachments).where(eq(accessSecurityGroupAttachments.organizationId, organizationId)),
      db.select().from(accessPrincipalSecurityGroupAttachments)
        .where(eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId)),
      db.select().from(accessGovernanceHistory)
        .where(eq(accessGovernanceHistory.organizationId, organizationId))
        .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id)),
    ]);
  const policiesByGroup = new Map<string, typeof policies>();
  for (const policy of policies) {
    const groupPolicies = policiesByGroup.get(policy.securityGroupId) ?? [];
    groupPolicies.push(policy);
    policiesByGroup.set(policy.securityGroupId, groupPolicies);
  }
  const membersByGroup = new Map<string, Array<{ principalType: string; principalId: string; expiresAt: string | null }>>();
  for (const member of memberships) {
    if (member.status !== "active" || member.revokedAt || !grantIsLive(member.expiresAt, now)) continue;
    const userGroup = userGroups.find((group) => group.id === member.groupId);
    if (!userGroup || userGroup.status !== "active" || !await isMembershipApprovalCurrent(
      db as unknown as OnboardingDbTransaction,
      organizationId,
      userGroup,
      member,
      await highSensitivityGroupsForUserGroup(
        db as unknown as OnboardingDbTransaction, organizationId, userGroup.id,
      ),
    )) continue;
    const principalType = member.principalType === "human" ? "user" : "agent";
    if (principalType === "user" && member.principalId === userGroup.ownerUserId) continue;
    if (!await hasActivePrincipal(db as unknown as OnboardingDbTransaction, organizationId, principalType, member.principalId)) continue;
    const list = membersByGroup.get(member.groupId) ?? [];
    list.push({ principalType, principalId: member.principalId, expiresAt: member.expiresAt?.toISOString() ?? null });
    membersByGroup.set(member.groupId, list);
  }
  const securityGroupsByUserGroup = new Map<string, Set<string>>();
  for (const attachment of attachments) {
    const group = securityGroups.find((item) => item.id === attachment.securityGroupId);
    if (attachment.status !== "active" || !grantIsLive(attachment.expiresAt, now) || !group || group.status !== "active" ||
      userGroups.find((item) => item.id === attachment.userGroupId)?.status !== "active") continue;
    const scopeLink = scopeAttachments.find((item) =>
      item.securityGroupId === group.id && item.scope === "tenant" &&
      item.status === "active" && grantIsLive(item.expiresAt, now) && item.caseId === null,
    );
    if (!scopeLink) continue;
    const policy = currentPolicy(policiesByGroup.get(group.id) ?? []);
    if (!policy) continue;
    if (groupAllows(policy.policy).some(isSensitive)) {
      const ownerIsActiveMember = await hasActivePrincipal(
        db as unknown as OnboardingDbTransaction, organizationId, "user", group.ownerUserId,
      );
      if (!isIndependentOwnerApprovalValid({
          status: attachment.status,
          ownerUserId: group.ownerUserId,
          attachedByUserId: attachment.attachedByUserId,
          approvedByUserId: attachment.approvedByUserId,
          approvedAt: attachment.approvedAt,
          approvedPolicyVersion: attachment.approvedPolicyVersion,
          currentPolicyVersion: policy.version,
          ownerIsActiveMember,
        }) ||
        !isIndependentOwnerApprovalValid({
          status: scopeLink.status,
          ownerUserId: group.ownerUserId,
          attachedByUserId: scopeLink.attachedByUserId,
          approvedByUserId: scopeLink.approvedByUserId,
          approvedAt: scopeLink.approvedAt,
          approvedPolicyVersion: scopeLink.approvedPolicyVersion,
          currentPolicyVersion: policy.version,
          ownerIsActiveMember,
        })) continue;
    }
    const list = securityGroupsByUserGroup.get(attachment.userGroupId) ?? new Set<string>();
    list.add(attachment.securityGroupId);
    securityGroupsByUserGroup.set(attachment.userGroupId, list);
  }
  const normalizedGrants: Array<{
    principalType: string;
    principalId: string;
    securityGroupId: string;
    status: "active";
    version: number;
    expiresAt: string | null;
  }> = [];
  const pendingGrants: Array<{
    principalType: string;
    principalId: string;
    securityGroupId: string;
    status: "pending";
    requestedByUserId: string;
    bindingVersion: number;
    policyVersion: number;
  }> = [];
  for (const binding of directAttachments) {
    const principalType = binding.principalType === "human" ? "user" : "agent";
    const principalId = binding.principalId;
    const securityGroupId = binding.securityGroupId;
    const group = securityGroups.find((item) => item.id === securityGroupId);
    const policy = currentPolicy(policiesByGroup.get(securityGroupId) ?? []);
    if (binding.status === "revoked" || binding.revokedAt || !grantIsLive(binding.expiresAt, now) || !group || group.status !== "active" || !policy) continue;
    if (!await hasActivePrincipal(db as unknown as OnboardingDbTransaction, organizationId, principalType, principalId)) continue;
    const keys = groupAllows(policy.policy);
    if (keys.some((key) => !isReviewedAccessKey(key))) continue;
    const relation = { principalType, principalId, securityGroupId };
    if (binding.status === "pending") {
      pendingGrants.push({
        ...relation, status: "pending", requestedByUserId: binding.attachedByUserId,
        bindingVersion: binding.version, policyVersion: policy.version,
      });
      continue;
    }
    if (keys.some(isSensitive)) {
      const policyApproved = Boolean(
        policy.approvedByUserId === group.ownerUserId && policy.approvedAt &&
        policy.approvedByUserId !== policy.createdByUserId,
      );
      if (!policyApproved || !isIndependentOwnerApprovalValid({
        status: binding.status,
        ownerUserId: group.ownerUserId,
        attachedByUserId: binding.attachedByUserId,
        approvedByUserId: binding.approvedByUserId,
        approvedAt: binding.approvedAt,
        approvedPolicyVersion: binding.approvedPolicyVersion,
        currentPolicyVersion: policy.version,
        ownerIsActiveMember: await hasActivePrincipal(
          db as unknown as OnboardingDbTransaction, organizationId, "user", group.ownerUserId,
        ),
      })) {
        pendingGrants.push({
          ...relation, status: "pending", requestedByUserId: binding.attachedByUserId,
          bindingVersion: binding.version, policyVersion: policy.version,
        });
        continue;
      }
    }
    normalizedGrants.push({ ...relation, status: "active", version: binding.version, expiresAt: binding.expiresAt?.toISOString() ?? null });
  }
  const latestUserGroupAttachments = new Map<string, (typeof allEvents)[number]>();
  for (const event of allEvents) {
    if (event.entityType !== "user-group" ||
      !["user-group.security-group.attached", "user-group.security-group.pending", "user-group.security-group.approved", "user-group.security-group.detached"].includes(event.eventType)) continue;
    const securityGroupId = event.detail?.securityGroupId;
    if (typeof securityGroupId !== "string") continue;
    const key = `${event.entityId}:${securityGroupId}`;
    if (!latestUserGroupAttachments.has(key)) latestUserGroupAttachments.set(key, event);
  }
  const pendingAttachments = [...latestUserGroupAttachments.values()].flatMap((event) => {
    if (event.eventType !== "user-group.security-group.pending") return [];
    const securityGroupId = event.detail?.securityGroupId;
    const userGroup = userGroups.find((item) => item.id === event.entityId);
    const securityGroup = securityGroups.find((item) => item.id === securityGroupId);
    const policy = currentPolicy(policiesByGroup.get(String(securityGroupId)) ?? []);
    if (!userGroup || userGroup.status !== "active" || !securityGroup ||
      securityGroup.status !== "active" || !policy) return [];
    return [{
      userGroupId: userGroup.id,
      securityGroupId: securityGroup.id,
      requestedByUserId: event.actorUserId,
      policyVersion: policy.version,
    }];
  });
  const latestMembershipStates = new Map<string, (typeof allEvents)[number]>();
  for (const event of allEvents) {
    if (event.entityType !== "user-group" ||
      !["user-group.member.pending", "user-group.member.approved", "user-group.member"].includes(event.eventType)) continue;
    const principalType = event.detail?.principalType;
    const principalId = event.detail?.principalId;
    if (!validPrincipalType(principalType) || typeof principalId !== "string") continue;
    const key = `${event.entityId}:${principalType}:${principalId}`;
    if (!latestMembershipStates.has(key)) latestMembershipStates.set(key, event);
  }
  const pendingMembers: Array<{
    groupId: string;
    principalType: PrincipalType;
    principalId: string;
    requestedByUserId: string | null;
    expectedVersion: number;
    policyVersions: string;
  }> = [];
  for (const event of latestMembershipStates.values()) {
    if (event.eventType !== "user-group.member.pending") continue;
    const detail = event.detail ?? {};
    const group = userGroups.find((item) => item.id === event.entityId);
    const principalType = detail.principalType;
    const principalId = detail.principalId;
    if (!group || group.status !== "active" || !validPrincipalType(principalType) ||
      typeof principalId !== "string" ||
      !await hasActivePrincipal(db as unknown as OnboardingDbTransaction, organizationId, principalType, principalId)) continue;
    const pendingMember = memberships.find((item) =>
      item.groupId === group.id && item.principalType === toSchemaPrincipalType(principalType) &&
      item.principalId === principalId && item.status === "pending" && grantIsLive(item.expiresAt, now),
    );
    if (!pendingMember) continue;
    pendingMembers.push({
      groupId: group.id,
      principalType,
      principalId,
      requestedByUserId: event.actorUserId,
      expectedVersion: group.version,
      policyVersions: typeof detail.policyVersions === "string"
        ? detail.policyVersions.split(",").filter(Boolean).map((entry) => {
          const securityGroupId = entry.split("@")[0];
          const policy = currentPolicy(policiesByGroup.get(securityGroupId) ?? []);
          return policy ? `${securityGroupId}@${policy.version}` : "";
        }).filter(Boolean).sort().join(",")
        : "",
    });
  }

  return {
    catalog: ACCESS_CATALOG,
    members,
    agents: agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      ownerUserId: agent.ownerUserId,
      status: agent.status,
      version: agent.version,
    })),
    userGroups: userGroups.map((group) => ({
      id: group.id,
      name: group.name,
      starterId: group.starterId,
      ownerUserId: group.ownerUserId,
      status: group.status,
      version: group.version,
      members: membersByGroup.get(group.id) ?? [],
      securityGroups: [...(securityGroupsByUserGroup.get(group.id) ?? [])],
      securityGroupAttachments: attachments.filter((link) =>
        link.userGroupId === group.id && (securityGroupsByUserGroup.get(group.id)?.has(link.securityGroupId) ?? false),
      ).map((link) => ({ securityGroupId: link.securityGroupId, expiresAt: link.expiresAt?.toISOString() ?? null })),
    })),
    userGroupStarters: USER_GROUP_STARTERS,
    securityGroups: securityGroups.map((group) => {
      const policy = currentPolicy(policiesByGroup.get(group.id) ?? []);
      const rawAllows = policy ? groupAllows(policy.policy) : [];
      const hasUnknownKey = rawAllows.some((key) => !isReviewedAccessKey(key));
      const allows = rawAllows.filter(isReviewedAccessKey);
      const status = group.status;
      const sensitive = allows.some(isSensitive);
      const groupOwnerActive = members.some((member) => member.clerkUserId === group.ownerUserId);
      return {
        id: group.id,
        name: group.name,
        ownerUserId: group.ownerUserId,
        status,
        version: policy?.version ?? 0,
        allows,
        approvalStatus: hasUnknownKey
          ? "blocked"
          : sensitive && (!policy?.approvedByUserId || policy.approvedByUserId !== group.ownerUserId ||
            policy.approvedByUserId === policy.createdByUserId || !groupOwnerActive)
            ? "pending"
            : "approved",
      };
    }),
    grants: normalizedGrants,
    pendingGrants,
    pendingAttachments,
    pendingMembers,
    history: allEvents.slice(0, 250).map((entry) => ({
      id: entry.id,
      eventType: entry.eventType,
      entityType: entry.entityType,
      entityId: entry.entityId,
      actorUserId: entry.actorUserId,
      detail: entry.detail,
      createdAt: entry.createdAt.toISOString(),
    })),
  };
}

router.get("/", async (req, res, next) => {
  try {
    const role = req.organizationRole;
    if (role !== "owner" && role !== "admin") {
      fail(res, 403, "Organization owner or administrator access is required.", "ACCESS_READ_FORBIDDEN");
      return;
    }
    res.json(await snapshot(getOrganizationId(req)));
  } catch (error) {
    next(error);
  }
});

router.get("/preview", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner" && req.organizationRole !== "admin") {
      fail(res, 403, "Organization owner or administrator access is required.", "ACCESS_READ_FORBIDDEN");
      return;
    }
    const principalType = req.query.principalType;
    const principalId = req.query.principalId;
    if (!validPrincipalType(principalType) || !nonEmptyString(principalId)) {
      fail(res, 400, "A valid principalType and principalId are required.", "ACCESS_INVALID_PRINCIPAL");
      return;
    }
    const caseId = optionalCaseId(req.query.caseId);
    if (caseId === null) {
      fail(res, 400, "caseId must be a positive integer.", "ACCESS_INVALID_CASE");
      return;
    }
    const initiatorUserId = req.query.initiatorUserId;
    if (initiatorUserId !== undefined && !nonEmptyString(initiatorUserId)) {
      fail(res, 400, "initiatorUserId must be a non-empty user ID.", "ACCESS_INVALID_INITIATOR");
      return;
    }
    if (principalType === "agent" && !nonEmptyString(initiatorUserId)) {
      fail(res, 400, "Agent access preview requires an explicit initiatorUserId.", "ACCESS_AGENT_INITIATOR_REQUIRED");
      return;
    }
    const organizationId = getOrganizationId(req);
    res.json(await resolveRouteAccess(
      organizationId,
      principalType,
      principalId,
      {
        caseId,
        ...(principalType === "agent" && nonEmptyString(initiatorUserId)
          ? { initiatorUserId: initiatorUserId.trim() }
          : {}),
      },
    ));
  } catch (error) {
    next(error);
  }
});

router.get("/field-access", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner" && req.organizationRole !== "admin") {
      fail(res, 403, "Organization owner or administrator access is required.", "ACCESS_READ_FORBIDDEN");
      return;
    }
    const field = req.query.field;
    if (!nonEmptyString(field) || !CATALOG_BY_KEY.has(field) || CATALOG_BY_KEY.get(field)?.kind !== "field") {
      fail(res, 400, "A known catalog field key is required.", "ACCESS_UNKNOWN_CATALOG_KEY");
      return;
    }
    const caseId = optionalCaseId(req.query.caseId);
    if (caseId === null) {
      fail(res, 400, "caseId must be a positive integer.", "ACCESS_INVALID_CASE");
      return;
    }
    const initiatorUserId = req.query.initiatorUserId;
    if (initiatorUserId !== undefined && !nonEmptyString(initiatorUserId)) {
      fail(res, 400, "initiatorUserId must be a non-empty user ID.", "ACCESS_INVALID_INITIATOR");
      return;
    }
    const organizationId = getOrganizationId(req);
    const [members, agents] = await Promise.all([
      db.select().from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, organizationId),
        isNull(organizationMembershipsTable.revokedAt),
      )),
      db.select().from(accessAgents).where(and(
        eq(accessAgents.organizationId, organizationId),
        isNull(accessAgents.revokedAt),
      )),
    ]);
    const principals = [
      ...members.map((member) => ({ principalType: "user", principalId: member.clerkUserId })),
      ...agents.map((agent) => ({ principalType: "agent", principalId: agent.id })),
    ];
    const results: Array<{ principalType: string; principalId: string; reasons: string[] }> = [];
    for (const principal of principals) {
      const effective = await resolveRouteAccess(
        organizationId,
        principal.principalType as PrincipalType,
        principal.principalId,
        {
          caseId,
          ...(principal.principalType === "agent" && nonEmptyString(initiatorUserId)
            ? { initiatorUserId: initiatorUserId.trim() }
            : {}),
        },
      );
      if (effective.allows.includes(field)) {
        results.push({ ...principal, reasons: effective.reasons[field] ?? [] });
      }
    }
    res.json({ principals: results });
  } catch (error) {
    next(error);
  }
});

router.post("/agents", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !nonEmptyString(body.name) || !nonEmptyString(body.ownerUserId)) {
      fail(res, 400, "name and ownerUserId are required.", "ACCESS_INVALID_AGENT");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    let agentId = "";
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      if (!await hasActivePrincipal(tx, organizationId, "user", body.ownerUserId as string)) {
        throw Object.assign(new Error("Agent owner must be an active human member of this organization."), { status: 400, code: "ACCESS_INVALID_AGENT_OWNER" });
      }
      agentId = randomUUID();
      await tx.insert(accessAgents).values({
        id: agentId,
        organizationId,
        name: (body.name as string).trim(),
        ownerUserId: body.ownerUserId as string,
        status: "active",
        version: 1,
        createdByUserId: actor,
      });
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "agent.created", entityType: "agent", entityId: agentId,
        detail: { status: "active", ownerUserId: body.ownerUserId as string },
      });
    });
    res.status(201).json({ agent: { id: agentId, name: body.name, ownerUserId: body.ownerUserId, status: "active", version: 1 } });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.patch("/agents/:id", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || body.status !== "retired" || !Number.isInteger(body.expectedVersion)) {
      fail(res, 400, "status=retired and expectedVersion are required.", "ACCESS_INVALID_AGENT_UPDATE");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [agent] = await tx.select().from(accessAgents).where(and(
        eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, req.params.id),
      )).limit(1);
      if (!agent) throw Object.assign(new Error("Agent not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      if (agent.version !== body.expectedVersion) throw Object.assign(new Error("Agent version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      if (agent.status === "retired" || agent.revokedAt) return;
      await tx.update(accessAgents).set({ status: "retired", version: agent.version + 1, revokedAt: new Date() }).where(and(
        eq(accessAgents.organizationId, organizationId), eq(accessAgents.id, agent.id),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "agent.status", entityType: "agent", entityId: agent.id,
        detail: { status: "retired" },
      });
    });
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.post("/user-groups", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    const starter = userGroupStarter(body?.starterId);
    if (!body || (body.starterId !== undefined
      ? !starter || body.name !== undefined
      : !nonEmptyString(body.name))) {
      fail(res, 400, "Choose a valid starterId or provide a custom name, not both.", "ACCESS_INVALID_USER_GROUP");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    const id = randomUUID();
    const result = await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      if (starter && !await isActiveOrganizationOwner(tx, organizationId, actor)) {
        throw Object.assign(new Error("Only an active organization owner may create groups."), { status: 403, code: "ORGANIZATION_OWNER_REQUIRED" });
      }
      if (starter) {
        const groups = await tx.select().from(accessUserGroups)
          .where(eq(accessUserGroups.organizationId, organizationId));
        const bound = groups.find((group) => group.starterId === starter.id);
        if (bound) return { userGroup: bound, created: false, reusedLegacy: false };
        // Never overwrite a legacy group's members, owner, lifecycle, or version.
        const matches = groups.filter((group) =>
          normalizedUserGroupName(group.name) === normalizedUserGroupName(starter.name));
        if (matches.length > 1 || matches.some((group) => group.starterId !== null)) {
          throw Object.assign(new Error(`Multiple or conflicting existing groups match ${starter.name}. Rename the conflicting custom groups explicitly before choosing this starter.`), { status: 409, code: "ACCESS_STARTER_AMBIGUOUS" });
        }
        if (matches[0]) {
          const existing = matches[0];
          await tx.update(accessUserGroups).set({ starterId: starter.id }).where(and(
            eq(accessUserGroups.organizationId, organizationId), eq(accessUserGroups.id, existing.id),
          ));
          await recordHistory(tx, {
            organizationId, actorUserId: actor, eventType: "user-group.starter-linked",
            entityType: "user-group", entityId: existing.id, detail: { starterId: starter.id },
          });
          return { userGroup: { ...existing, starterId: starter.id }, created: false, reusedLegacy: true };
        }
      }
      const name = starter?.name ?? (body.name as string).trim();
      const [userGroup] = await tx.insert(accessUserGroups).values({
        id, organizationId, name, starterId: starter?.id ?? null, ownerUserId: actor,
        status: "active", version: 1, createdByUserId: actor,
      }).returning();
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "user-group.created", entityType: "user-group", entityId: id,
        detail: { status: "active", ...(starter ? { starterId: starter.id } : {}) },
      });
      return { userGroup, created: true, reusedLegacy: false };
    });
    // Existing groups may already have access configured; don't describe them as empty.
    res.status(result.created ? 201 : 200).json({
      ...result,
      userGroup: result.created ? { ...result.userGroup, members: [], securityGroups: [], securityGroupAttachments: [] } : result.userGroup,
    });
  } catch (error) {
    if (req.body?.starterId === undefined &&
      await respondToGroupNameConflict(res, error, getOrganizationId(req), "user-group", req.body?.name)) return;
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.patch("/user-groups/:id", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !Number.isInteger(body.expectedVersion) ||
      (body.name !== undefined && !nonEmptyString(body.name)) ||
      (body.status !== undefined && body.status !== "retired")) {
      fail(res, 400, "A valid name/status and expectedVersion are required.", "ACCESS_INVALID_USER_GROUP_UPDATE");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [group] = await tx.select().from(accessUserGroups).where(and(
        eq(accessUserGroups.organizationId, organizationId), eq(accessUserGroups.id, req.params.id),
      )).limit(1);
      if (!group) throw Object.assign(new Error("User group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      if (group.version !== body.expectedVersion) throw Object.assign(new Error("User group version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      const status = group.status;
      if (status === "retired") throw Object.assign(new Error("Retired user groups cannot be changed."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      await tx.update(accessUserGroups).set({
        ...(body.name !== undefined ? { name: (body.name as string).trim() } : {}),
        ...(body.status === "retired" ? { status: "retired" as const } : {}),
        version: group.version + 1,
      }).where(and(
        eq(accessUserGroups.organizationId, organizationId), eq(accessUserGroups.id, group.id),
      ));
      if (body.status === "retired") {
        const groupBindings = await tx.select().from(accessSecurityGroupUserGroups).where(and(
          eq(accessSecurityGroupUserGroups.organizationId, organizationId),
          eq(accessSecurityGroupUserGroups.userGroupId, group.id),
          eq(accessSecurityGroupUserGroups.status, "active"),
        ));
        await tx.update(accessUserGroupMembers).set({
          status: "revoked", revokedByUserId: actor, revokedAt: new Date(),
          approvedByUserId: null, approvedAt: null,
          version: sql`${accessUserGroupMembers.version} + 1`,
        }).where(and(
          eq(accessUserGroupMembers.organizationId, organizationId), eq(accessUserGroupMembers.groupId, group.id),
        ));
        await tx.update(accessSecurityGroupUserGroups).set({
          status: "revoked", approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
          version: sql`${accessSecurityGroupUserGroups.version} + 1`,
        }).where(and(
          eq(accessSecurityGroupUserGroups.organizationId, organizationId), eq(accessSecurityGroupUserGroups.userGroupId, group.id),
        ));
        for (const binding of groupBindings) {
          const [otherActive] = await tx.select({ id: accessSecurityGroupUserGroups.userGroupId })
            .from(accessSecurityGroupUserGroups)
            .where(and(
              eq(accessSecurityGroupUserGroups.organizationId, organizationId),
              eq(accessSecurityGroupUserGroups.securityGroupId, binding.securityGroupId),
              eq(accessSecurityGroupUserGroups.status, "active"),
            ))
            .limit(1);
          if (!otherActive) {
            await tx.update(accessSecurityGroupAttachments).set({
              status: "revoked", approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
              version: sql`${accessSecurityGroupAttachments.version} + 1`,
            }).where(and(
              eq(accessSecurityGroupAttachments.organizationId, organizationId),
              eq(accessSecurityGroupAttachments.securityGroupId, binding.securityGroupId),
              eq(accessSecurityGroupAttachments.scope, "tenant"),
              isNull(accessSecurityGroupAttachments.caseId),
            ));
          }
        }
      }
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: body.status === "retired" ? "user-group.status" : "user-group.updated",
        entityType: "user-group", entityId: group.id,
        detail: {
          ...(body.status === "retired" ? { status: "retired" } : {}),
          ...(body.name !== undefined ? { nameChanged: true } : {}),
        },
      });
    });
    res.json({ ok: true });
  } catch (error) {
    if (await respondToGroupNameConflict(res, error, getOrganizationId(req), "user-group", req.body?.name)) return;
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.put("/user-groups/:id/members", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !validPrincipalType(body.principalType) || !nonEmptyString(body.principalId) || typeof body.active !== "boolean") {
      fail(res, 400, "principalType, principalId, and active are required.", "ACCESS_INVALID_MEMBERSHIP");
      return;
    }
    const principalType = body.principalType as PrincipalType;
    const principalId = body.principalId as string;
    const active = body.active as boolean;
    let expiresAt = parseExpiry(body.expiresAt, active);
    if (expiresAt === undefined) {
      fail(res, 400, "expiresAt must be a future date-time with a timezone, or null.", "ACCESS_INVALID_EXPIRY");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    let membershipStatus = active ? "active" : "revoked";
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [group] = await tx.select().from(accessUserGroups).where(and(
        eq(accessUserGroups.organizationId, organizationId), eq(accessUserGroups.id, req.params.id),
      )).limit(1);
      if (!group || group.status !== "active") {
        throw Object.assign(new Error("Active user group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      }
      if (active && !await hasActivePrincipal(tx, organizationId, principalType, principalId)) {
        throw Object.assign(new Error("Group members must be active organization humans or registered agents."), { status: 400, code: "ACCESS_INVALID_PRINCIPAL" });
      }
      const where = and(
        eq(accessUserGroupMembers.organizationId, organizationId),
        eq(accessUserGroupMembers.groupId, req.params.id),
        eq(accessUserGroupMembers.principalType, toSchemaPrincipalType(principalType)),
        eq(accessUserGroupMembers.principalId, principalId),
      );
      const [existingMember] = await tx.select().from(accessUserGroupMembers).where(where).limit(1);
      if (active && body.expiresAt === undefined && existingMember) expiresAt = existingMember.expiresAt;
      const sensitiveGroups = active
        ? await highSensitivityGroupsForUserGroup(tx, organizationId, group.id)
        : [];
      const currentMembershipApproval = existingMember
        ? await isMembershipApprovalCurrent(
          tx, organizationId, group, existingMember, sensitiveGroups,
        )
        : false;
      const expiryChanged = existingMember?.expiresAt?.getTime() !== expiresAt?.getTime() &&
        !(existingMember?.expiresAt === null && expiresAt === null);
      if (active && sensitiveGroups.length &&
        (existingMember?.status !== "active" || !currentMembershipApproval || expiryChanged || !grantIsLive(existingMember.expiresAt, new Date()))) {
        if (actor === group.ownerUserId || principalId === actor || (principalType === "user" && (
          principalId === group.ownerUserId ||
          sensitiveGroups.some((securityGroup) => securityGroup.ownerUserId === principalId)
        ))) {
          throw Object.assign(new Error("A group owner cannot request their own approval or add themselves or a security-group owner to a sensitive user-group binding."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
        }
        membershipStatus = "pending";
        await recordHistory(tx, {
          organizationId, actorUserId: actor, eventType: "user-group.member.pending",
          entityType: "user-group", entityId: group.id,
          detail: {
            principalType, principalId, active: true, expiresAt: expiresAt?.toISOString() ?? null,
            policyVersions: sensitiveGroups.map(({ id, policyVersion }) => `${id}@${policyVersion}`).sort().join(","),
          },
        });
        await tx.insert(accessUserGroupMembers).values({
          organizationId,
          groupId: group.id,
          principalType: toSchemaPrincipalType(principalType),
          principalId,
          status: "pending",
          expiresAt,
          version: existingMember ? existingMember.version + 1 : 1,
          requiresApproval: "yes",
          attachedByUserId: actor,
          approvedByUserId: null,
          approvedAt: null,
          revokedByUserId: null,
          revokedAt: null,
        }).onConflictDoUpdate({
          target: [
            accessUserGroupMembers.organizationId,
            accessUserGroupMembers.groupId,
            accessUserGroupMembers.principalType,
            accessUserGroupMembers.principalId,
          ],
          set: {
            status: "pending",
            expiresAt,
            requiresApproval: "yes",
            attachedByUserId: actor,
            approvedByUserId: null,
            approvedAt: null,
            revokedByUserId: null,
            revokedAt: null,
            version: sql`${accessUserGroupMembers.version} + 1`,
          },
        });
        await tx.update(accessUserGroups).set({ version: group.version + 1 }).where(and(
          eq(accessUserGroups.organizationId, organizationId),
          eq(accessUserGroups.id, group.id),
        ));
        return;
      }
      if (active && sensitiveGroups.length && existingMember?.status === "active" &&
        currentMembershipApproval && !expiryChanged) return;
      if (active) {
        await tx.insert(accessUserGroupMembers).values({
          organizationId, groupId: req.params.id, principalType: toSchemaPrincipalType(principalType),
          principalId, attachedByUserId: actor, status: "active", version: 1,
          expiresAt,
          requiresApproval: "no", approvedByUserId: null, approvedAt: null,
        }).onConflictDoUpdate({
          target: [
            accessUserGroupMembers.organizationId,
            accessUserGroupMembers.groupId,
            accessUserGroupMembers.principalType,
            accessUserGroupMembers.principalId,
          ],
          set: {
            status: "active",
            expiresAt,
            revokedAt: null,
            revokedByUserId: null,
            attachedByUserId: actor,
            requiresApproval: "no",
            approvedByUserId: null,
            approvedAt: null,
            version: sql`${accessUserGroupMembers.version} + 1`,
          },
        });
      } else {
        await tx.update(accessUserGroupMembers).set({
          status: "revoked", revokedByUserId: actor, revokedAt: new Date(),
          approvedByUserId: null, approvedAt: null,
          version: sql`${accessUserGroupMembers.version} + 1`,
        }).where(where);
      }
      await tx.update(accessUserGroups).set({ version: group.version + 1 }).where(and(
        eq(accessUserGroups.organizationId, organizationId),
        eq(accessUserGroups.id, group.id),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "user-group.member",
        entityType: "user-group", entityId: req.params.id,
        detail: {
          principalType,
          principalId,
          active,
          expiresAt: active ? expiresAt?.toISOString() ?? null : null,
        },
      });
    });
    res.json({ ok: true, status: membershipStatus });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.post("/user-groups/:id/members/approve", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may review sensitive group membership.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !validPrincipalType(body.principalType) ||
      !nonEmptyString(body.principalId) || !Number.isInteger(body.expectedVersion)) {
      fail(res, 400, "principalType, principalId, and expectedVersion are required.", "ACCESS_INVALID_MEMBERSHIP_APPROVAL");
      return;
    }
    const principalType = body.principalType as PrincipalType;
    const principalId = body.principalId as string;
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [group] = await tx.select().from(accessUserGroups).where(and(
        eq(accessUserGroups.organizationId, organizationId),
        eq(accessUserGroups.id, req.params.id),
      )).limit(1);
      if (!group || group.status !== "active") {
        throw Object.assign(new Error("Active user group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      }
      if (group.version !== body.expectedVersion) {
        throw Object.assign(new Error("User group version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      }
      if (!await hasActivePrincipal(tx, organizationId, principalType, principalId)) {
        throw Object.assign(new Error("The member must be an active organization principal."), { status: 400, code: "ACCESS_INVALID_PRINCIPAL" });
      }
      if (principalId === actor || (principalType === "user" && principalId === group.ownerUserId)) {
        throw Object.assign(new Error("Owners cannot approve their own sensitive membership."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
      }
      const sensitiveGroups = await highSensitivityGroupsForUserGroup(tx, organizationId, group.id);
      if (!sensitiveGroups.length) {
        throw Object.assign(new Error("This membership no longer requires independent review; resubmit it."), { status: 409, code: "ACCESS_REVIEW_NOT_REQUIRED" });
      }
      if (actor !== group.ownerUserId || !await isActiveOrganizationOwner(tx, organizationId, actor)) {
        throw Object.assign(new Error("Only the active user-group owner may approve this membership."), { status: 403, code: "ACCESS_OWNER_REQUIRED" });
      }
      if (principalType === "user" && sensitiveGroups.some((securityGroup) => securityGroup.ownerUserId === principalId)) {
        throw Object.assign(new Error("A security-group owner cannot receive their own policy through a user-group membership."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
      }
      const history = await tx.select().from(accessGovernanceHistory)
        .where(eq(accessGovernanceHistory.organizationId, organizationId))
        .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id));
      const matchesMember = (detail: Record<string, unknown>) =>
        detail.principalType === principalType && detail.principalId === principalId;
      const latest = latestLinkEvent(
        history, "user-group", group.id,
        ["user-group.member.pending", "user-group.member.approved", "user-group.member"],
        matchesMember,
      );
      if (latest?.eventType !== "user-group.member.pending") {
        throw Object.assign(new Error("A pending sensitive membership request was not found."), { status: 409, code: "ACCESS_MEMBERSHIP_NOT_PENDING" });
      }
      const pending = latestLinkEvent(
        history, "user-group", group.id, ["user-group.member.pending"], matchesMember,
      );
      if (!pending || !pending.actorUserId || pending.actorUserId === actor) {
        throw Object.assign(new Error("A different active organization owner must independently approve this membership."), { status: 403, code: "ACCESS_INDEPENDENT_REVIEW_REQUIRED" });
      }
      const expectedPolicyVersions = sensitiveGroups.map(({ id, policyVersion }) => `${id}@${policyVersion}`).sort().join(",");
      const pendingPolicyGroupIds = typeof pending.detail?.policyVersions === "string"
        ? pending.detail.policyVersions.split(",").filter(Boolean).map((entry) => entry.split("@")[0]).sort().join(",")
        : "";
      const currentPolicyGroupIds = sensitiveGroups.map(({ id }) => id).sort().join(",");
      if (pendingPolicyGroupIds !== currentPolicyGroupIds) {
        throw Object.assign(new Error("Sensitive security-group attachments changed after the membership request; resubmit it."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      }
      const membershipWhere = and(
        eq(accessUserGroupMembers.organizationId, organizationId),
        eq(accessUserGroupMembers.groupId, group.id),
        eq(accessUserGroupMembers.principalType, toSchemaPrincipalType(principalType)),
        eq(accessUserGroupMembers.principalId, principalId),
        eq(accessUserGroupMembers.status, "pending"),
      );
      const [membership] = await tx.select().from(accessUserGroupMembers).where(membershipWhere).limit(1);
      if (!membership || membership.revokedAt || membership.attachedByUserId !== pending.actorUserId) {
        throw Object.assign(new Error("A pending sensitive membership request was not found."), { status: 409, code: "ACCESS_MEMBERSHIP_NOT_PENDING" });
      }
      if (!grantIsLive(membership.expiresAt, new Date())) {
        throw Object.assign(new Error("The requested membership has expired; submit a new request."), { status: 409, code: "ACCESS_INVALID_EXPIRY" });
      }
      await tx.update(accessUserGroupMembers).set({
        status: "active",
        requiresApproval: "yes",
        approvedByUserId: actor,
        approvedAt: new Date(),
        revokedByUserId: null,
        revokedAt: null,
        version: membership.version + 1,
      }).where(membershipWhere);
      await tx.update(accessUserGroups).set({ version: group.version + 1 }).where(and(
        eq(accessUserGroups.organizationId, organizationId),
        eq(accessUserGroups.id, group.id),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "user-group.member.approved",
        entityType: "user-group", entityId: group.id,
        detail: {
          principalType, principalId, active: true,
          requestedByUserId: pending.actorUserId, expiresAt: membership.expiresAt?.toISOString() ?? null,
          policyVersions: expectedPolicyVersions,
        },
      });
    });
    res.json({ ok: true, status: "active" });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.put("/user-groups/:id/security-groups", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !nonEmptyString(body.securityGroupId) || typeof body.active !== "boolean") {
      fail(res, 400, "securityGroupId and active are required.", "ACCESS_INVALID_ATTACHMENT");
      return;
    }
    const securityGroupId = body.securityGroupId as string;
    const active = body.active as boolean;
    let expiresAt = parseExpiry(body.expiresAt, active);
    if (expiresAt === undefined) {
      fail(res, 400, "expiresAt must be a future date-time with a timezone, or null.", "ACCESS_INVALID_EXPIRY");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    let attachmentStatus = active ? "active" : "revoked";
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [group] = await tx.select().from(accessUserGroups).where(and(
        eq(accessUserGroups.organizationId, organizationId), eq(accessUserGroups.id, req.params.id),
      )).limit(1);
      const [securityGroup] = await tx.select().from(accessSecurityGroups).where(and(
        eq(accessSecurityGroups.organizationId, organizationId),
        eq(accessSecurityGroups.id, securityGroupId),
      )).limit(1);
      if (!group || !securityGroup) throw Object.assign(new Error("The requested group was not found in this organization."), { status: 404, code: "ACCESS_NOT_FOUND" });
      const history = await tx.select().from(accessGovernanceHistory)
        .where(eq(accessGovernanceHistory.organizationId, organizationId))
        .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id));
      if (group.status !== "active" || securityGroup.status !== "active") {
        throw Object.assign(new Error("Retired groups cannot be attached."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      if (active) {
        const [ownerMembership] = await tx.select({ id: accessUserGroupMembers.principalId })
          .from(accessUserGroupMembers)
          .where(and(
            eq(accessUserGroupMembers.organizationId, organizationId),
            eq(accessUserGroupMembers.groupId, group.id),
            eq(accessUserGroupMembers.principalType, "human"),
            eq(accessUserGroupMembers.principalId, securityGroup.ownerUserId),
            eq(accessUserGroupMembers.status, "active"),
            isNull(accessUserGroupMembers.revokedAt),
            or(isNull(accessUserGroupMembers.expiresAt), gt(accessUserGroupMembers.expiresAt, new Date())),
          ))
          .limit(1);
        if (ownerMembership) {
          throw Object.assign(new Error("A security-group owner cannot receive their own policy through a user-group attachment."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
        }
      }
      const policy = await policyForGroup(tx, organizationId, securityGroup.id);
      if (!policy) throw Object.assign(new Error("Security group policy not found."), { status: 409, code: "ACCESS_POLICY_UNAVAILABLE" });
      const keys = groupAllows(policy.policy);
      if (keys.some((key) => !isReviewedAccessKey(key))) {
        throw Object.assign(new Error("The policy contains an unknown catalog key and cannot be attached."), { status: 409, code: "ACCESS_UNKNOWN_CATALOG_KEY" });
      }
      if (active && keys.some(isSensitive)) {
        const [userGroupOwnerMembership] = await tx.select({ id: accessUserGroupMembers.principalId })
          .from(accessUserGroupMembers)
          .where(and(
            eq(accessUserGroupMembers.organizationId, organizationId),
            eq(accessUserGroupMembers.groupId, group.id),
            eq(accessUserGroupMembers.principalType, "human"),
            eq(accessUserGroupMembers.principalId, group.ownerUserId),
            eq(accessUserGroupMembers.status, "active"),
            isNull(accessUserGroupMembers.revokedAt),
            or(isNull(accessUserGroupMembers.expiresAt), gt(accessUserGroupMembers.expiresAt, new Date())),
          ))
          .limit(1);
        if (userGroupOwnerMembership) {
          throw Object.assign(new Error("A user-group owner cannot receive sensitive policy through their own group."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
        }
      }
      const where = and(
        eq(accessSecurityGroupUserGroups.organizationId, organizationId),
        eq(accessSecurityGroupUserGroups.userGroupId, group.id),
        eq(accessSecurityGroupUserGroups.securityGroupId, securityGroup.id),
      );
      const [existingLink] = await tx.select().from(accessSecurityGroupUserGroups).where(where).limit(1);
      if (active && body.expiresAt === undefined && existingLink) expiresAt = existingLink.expiresAt;
      if (active) {
        if (keys.some(isSensitive)) {
          const membershipPolicies = [
            ...await sensitivePoliciesForUserGroupRequests(tx, organizationId, group.id),
            { id: securityGroup.id, ownerUserId: securityGroup.ownerUserId, policyVersion: policy.version },
          ].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
          const policyVersions = membershipPolicies
            .map(({ id, policyVersion }) => `${id}@${policyVersion}`).sort().join(",");
          await requestSensitiveMembershipReviews(tx, organizationId, group, actor, policyVersions);
          attachmentStatus = "pending";
          await recordHistory(tx, {
            organizationId, actorUserId: actor, eventType: "user-group.security-group.pending",
            entityType: "user-group", entityId: group.id,
            detail: { securityGroupId: securityGroup.id, policyVersion: policy.version, expiresAt: expiresAt?.toISOString() ?? null },
          });
          await tx.update(accessUserGroups).set({ version: group.version + 1 }).where(and(
            eq(accessUserGroups.organizationId, organizationId),
            eq(accessUserGroups.id, group.id),
          ));
          return;
        }
        if (existingLink) {
          await tx.update(accessSecurityGroupUserGroups).set({
            status: "active", version: existingLink.version + 1, requiresApproval: "no",
            expiresAt,
            approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null, attachedByUserId: actor,
          }).where(where);
        } else {
          await tx.insert(accessSecurityGroupUserGroups).values({
            organizationId, userGroupId: group.id, securityGroupId: securityGroup.id,
            status: "active", version: 1, requiresApproval: "no", attachedByUserId: actor,
            expiresAt,
            approvedPolicyVersion: null,
          });
        }
        const tenantScope = and(
          eq(accessSecurityGroupAttachments.organizationId, organizationId),
          eq(accessSecurityGroupAttachments.securityGroupId, securityGroup.id),
          eq(accessSecurityGroupAttachments.scope, "tenant"),
          isNull(accessSecurityGroupAttachments.caseId),
        );
        const [existingScope] = await tx.select().from(accessSecurityGroupAttachments).where(tenantScope).limit(1);
        if (existingScope) {
          await tx.update(accessSecurityGroupAttachments).set({
            status: "active", version: existingScope.version + 1, requiresApproval: "no",
            expiresAt: null,
            approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null, attachedByUserId: actor,
          }).where(eq(accessSecurityGroupAttachments.id, existingScope.id));
        } else {
          await tx.insert(accessSecurityGroupAttachments).values({
            organizationId, securityGroupId: securityGroup.id, scope: "tenant", caseId: null,
            status: "active", version: 1, requiresApproval: "no", attachedByUserId: actor,
            approvedPolicyVersion: null,
          });
        }
      } else {
        await tx.update(accessSecurityGroupUserGroups).set({
          status: "revoked", approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
          version: sql`${accessSecurityGroupUserGroups.version} + 1`,
        }).where(where);
        const [otherLink] = await tx.select({ id: accessSecurityGroupUserGroups.userGroupId })
          .from(accessSecurityGroupUserGroups).where(and(
            eq(accessSecurityGroupUserGroups.organizationId, organizationId),
            eq(accessSecurityGroupUserGroups.securityGroupId, securityGroup.id),
            eq(accessSecurityGroupUserGroups.status, "active"),
          )).limit(1);
        if (!otherLink) {
          await tx.update(accessSecurityGroupAttachments).set({
            status: "revoked", approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
            version: sql`${accessSecurityGroupAttachments.version} + 1`,
          }).where(and(
            eq(accessSecurityGroupAttachments.organizationId, organizationId),
            eq(accessSecurityGroupAttachments.securityGroupId, securityGroup.id),
            eq(accessSecurityGroupAttachments.scope, "tenant"),
            isNull(accessSecurityGroupAttachments.caseId),
          ));
        }
      }
      await tx.update(accessUserGroups).set({ version: group.version + 1 }).where(and(
        eq(accessUserGroups.organizationId, organizationId),
        eq(accessUserGroups.id, group.id),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: active ? "user-group.security-group.attached" : "user-group.security-group.detached",
        entityType: "user-group", entityId: group.id,
        detail: { securityGroupId: securityGroup.id, active, policyVersion: policy.version, expiresAt: active ? expiresAt?.toISOString() ?? null : null },
      });
    });
    res.json({ ok: true, status: attachmentStatus });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.post("/user-groups/:id/security-groups/approve", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may review group access bindings.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !nonEmptyString(body.securityGroupId) || !Number.isInteger(body.expectedVersion)) {
      fail(res, 400, "securityGroupId and expectedVersion are required.", "ACCESS_INVALID_ATTACHMENT_APPROVAL");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    const securityGroupId = body.securityGroupId as string;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [userGroup] = await tx.select().from(accessUserGroups).where(and(
        eq(accessUserGroups.organizationId, organizationId),
        eq(accessUserGroups.id, req.params.id),
      )).limit(1);
      const [securityGroup] = await tx.select().from(accessSecurityGroups).where(and(
        eq(accessSecurityGroups.organizationId, organizationId),
        eq(accessSecurityGroups.id, securityGroupId),
      )).limit(1);
      if (!userGroup || !securityGroup || userGroup.status !== "active" || securityGroup.status !== "active") {
        throw Object.assign(new Error("The requested group binding was not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      }
      if (securityGroup.ownerUserId !== actor || !await isActiveOrganizationOwner(tx, organizationId, actor)) {
        throw Object.assign(new Error("Only the active security-group owner may approve this attachment."), { status: 403, code: "ACCESS_OWNER_REQUIRED" });
      }
      const policy = await policyForGroup(tx, organizationId, securityGroup.id);
      if (!policy || policy.version !== body.expectedVersion) {
        throw Object.assign(new Error("Security group version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      }
      const keys = groupAllows(policy.policy);
      if (keys.some((key) => !isReviewedAccessKey(key))) {
        throw Object.assign(new Error("The policy contains an unknown catalog key and cannot be approved."), { status: 409, code: "ACCESS_UNKNOWN_CATALOG_KEY" });
      }
      if (!keys.some(isSensitive)) {
        throw Object.assign(new Error("Independent attachment review is only required for high-sensitivity policies."), { status: 409, code: "ACCESS_REVIEW_NOT_REQUIRED" });
      }
      const [userGroupOwnerMembership] = await tx.select({ id: accessUserGroupMembers.principalId })
        .from(accessUserGroupMembers)
        .where(and(
          eq(accessUserGroupMembers.organizationId, organizationId),
          eq(accessUserGroupMembers.groupId, userGroup.id),
          eq(accessUserGroupMembers.principalType, "human"),
          eq(accessUserGroupMembers.principalId, userGroup.ownerUserId),
          eq(accessUserGroupMembers.status, "active"),
          isNull(accessUserGroupMembers.revokedAt),
          or(isNull(accessUserGroupMembers.expiresAt), gt(accessUserGroupMembers.expiresAt, new Date())),
        ))
        .limit(1);
      if (userGroupOwnerMembership) {
        throw Object.assign(new Error("A user-group owner cannot receive sensitive policy through their own group."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
      }
      if (policy.approvedByUserId !== securityGroup.ownerUserId || !policy.approvedAt ||
        policy.approvedByUserId === policy.createdByUserId) {
        throw Object.assign(new Error("The security-group owner must first independently approve the policy."), { status: 409, code: "ACCESS_POLICY_REVIEW_REQUIRED" });
      }
      const history = await tx.select().from(accessGovernanceHistory)
        .where(eq(accessGovernanceHistory.organizationId, organizationId))
        .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id));
      if (userGroup.status !== "active" || securityGroup.status !== "active") {
        throw Object.assign(new Error("Retired groups cannot be approved for access."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      const [ownerMembership] = await tx.select({ id: accessUserGroupMembers.principalId })
        .from(accessUserGroupMembers)
        .where(and(
          eq(accessUserGroupMembers.organizationId, organizationId),
          eq(accessUserGroupMembers.groupId, userGroup.id),
          eq(accessUserGroupMembers.principalType, "human"),
          eq(accessUserGroupMembers.principalId, securityGroup.ownerUserId),
          eq(accessUserGroupMembers.status, "active"),
          isNull(accessUserGroupMembers.revokedAt),
          or(isNull(accessUserGroupMembers.expiresAt), gt(accessUserGroupMembers.expiresAt, new Date())),
        ))
        .limit(1);
      if (ownerMembership) {
        throw Object.assign(new Error("A security-group owner cannot receive their own policy through a user-group attachment."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
      }
      const latestAttachmentEvent = latestLinkEvent(
        history, "user-group", userGroup.id,
        ["user-group.security-group.attached", "user-group.security-group.pending", "user-group.security-group.approved", "user-group.security-group.detached"],
        (detail) => detail.securityGroupId === securityGroup.id,
      );
      if (latestAttachmentEvent?.eventType !== "user-group.security-group.pending") {
        throw Object.assign(new Error("A pending user-group attachment was not found."), { status: 409, code: "ACCESS_ATTACHMENT_NOT_PENDING" });
      }
      const pending = latestLinkEvent(
        history, "user-group", userGroup.id, ["user-group.security-group.pending"],
        (detail) => detail.securityGroupId === securityGroup.id,
      );
      if (!pending) {
        throw Object.assign(new Error("A pending user-group attachment was not found."), { status: 409, code: "ACCESS_ATTACHMENT_NOT_PENDING" });
      }
      if (!pending.actorUserId || pending.actorUserId === actor) {
        throw Object.assign(new Error("The security-group owner cannot approve their own attachment request."), { status: 403, code: "ACCESS_INDEPENDENT_REVIEW_REQUIRED" });
      }
      const associationWhere = and(
        eq(accessSecurityGroupUserGroups.organizationId, organizationId),
        eq(accessSecurityGroupUserGroups.securityGroupId, securityGroup.id),
        eq(accessSecurityGroupUserGroups.userGroupId, userGroup.id),
      );
      const [existingAssociation] = await tx.select().from(accessSecurityGroupUserGroups).where(associationWhere).limit(1);
      const attachmentApproval = {
        status: "active" as const,
        requiresApproval: "yes" as const,
        approvedByUserId: actor,
        approvedAt: new Date(),
        approvedPolicyVersion: policy.version,
        attachedByUserId: pending.actorUserId,
        expiresAt: typeof pending.detail?.expiresAt === "string" ? new Date(pending.detail.expiresAt) : null,
      };
      if (attachmentApproval.expiresAt && !grantIsLive(attachmentApproval.expiresAt, new Date())) {
        throw Object.assign(new Error("The requested attachment has expired; submit a new request."), { status: 409, code: "ACCESS_INVALID_EXPIRY" });
      }
      if (existingAssociation) {
        await tx.update(accessSecurityGroupUserGroups).set({
          ...attachmentApproval,
          version: existingAssociation.version + 1,
        }).where(associationWhere);
      } else {
        await tx.insert(accessSecurityGroupUserGroups).values({
          organizationId, securityGroupId: securityGroup.id, userGroupId: userGroup.id,
          ...attachmentApproval, version: 1,
        });
      }
      const scopeWhere = and(
        eq(accessSecurityGroupAttachments.organizationId, organizationId),
        eq(accessSecurityGroupAttachments.securityGroupId, securityGroup.id),
        eq(accessSecurityGroupAttachments.scope, "tenant"),
        isNull(accessSecurityGroupAttachments.caseId),
      );
      const [existingScope] = await tx.select().from(accessSecurityGroupAttachments).where(scopeWhere).limit(1);
      if (existingScope) {
        await tx.update(accessSecurityGroupAttachments).set({
          ...attachmentApproval, expiresAt: null,
          version: existingScope.version + 1,
        }).where(eq(accessSecurityGroupAttachments.id, existingScope.id));
      } else {
        await tx.insert(accessSecurityGroupAttachments).values({
          organizationId, securityGroupId: securityGroup.id, scope: "tenant", caseId: null,
          ...attachmentApproval, expiresAt: null, version: 1,
        });
      }
      await tx.update(accessUserGroups).set({ version: userGroup.version + 1 }).where(and(
        eq(accessUserGroups.organizationId, organizationId),
        eq(accessUserGroups.id, userGroup.id),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "user-group.security-group.approved",
        entityType: "user-group", entityId: userGroup.id,
        detail: { securityGroupId: securityGroup.id, policyVersion: policy.version, expiresAt: attachmentApproval.expiresAt?.toISOString() ?? null },
      });
    });
    res.json({ ok: true, status: "active" });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.post("/security-groups", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    const allows = body ? parseAllows(body.allows) : null;
    if (!body || !nonEmptyString(body.name) || !allows) {
      fail(res, 400, "name and known catalog allows are required.", "ACCESS_INVALID_SECURITY_GROUP");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    const ownerUserId = nonEmptyString(body.ownerUserId) ? body.ownerUserId : actor;
    if (!await isActiveOrganizationOwner(db as unknown as OnboardingDbTransaction, organizationId, ownerUserId)) {
      fail(res, 400, "Security group owner must be an active organization owner.", "ACCESS_INVALID_GROUP_OWNER");
      return;
    }
    if (allows.some(isSensitive) && ownerUserId === actor) {
      fail(res, 400, "High-sensitivity policies require a different active organization owner for independent review.", "ACCESS_GROUP_OWNER_REQUIRED");
      return;
    }
    const id = randomUUID();
    let version = 1;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      await tx.insert(accessSecurityGroups).values({
        id, organizationId, name: (body.name as string).trim(), ownerUserId,
        status: "active", version: 1, createdByUserId: actor,
      });
      await tx.insert(accessSecurityGroupPolicies).values({
        organizationId, securityGroupId: id, version, policy: {
          fields: allows.filter((key) => resourceType(key) === "field"),
          flows: allows.filter((key) => resourceType(key) === "flow"),
          tools: allows.filter((key) => resourceType(key) === "tool"),
        }, createdByUserId: actor,
      });
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "security-group.created",
        entityType: "security-group", entityId: id, detail: { status: "active" },
      });
    });
    res.status(201).json({
      securityGroup: {
        id, name: body.name, ownerUserId, status: "active", version,
        allows, approvalStatus: allows.some(isSensitive) ? "pending" : "approved",
      },
    });
  } catch (error) {
    if (await respondToGroupNameConflict(res, error, getOrganizationId(req), "security-group", req.body?.name)) return;
    next(error);
  }
});

router.patch("/security-groups/:id", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    const allows = body?.allows === undefined ? undefined : parseAllows(body.allows);
    if (!body || !Number.isInteger(body.expectedVersion) ||
      (body.name !== undefined && !nonEmptyString(body.name)) ||
      (body.ownerUserId !== undefined && !nonEmptyString(body.ownerUserId)) ||
      (body.status !== undefined && body.status !== "retired") ||
      (body.allows !== undefined && !allows)) {
      fail(res, 400, "A valid name, ownerUserId, status, allows, and expectedVersion are required.", "ACCESS_INVALID_SECURITY_GROUP_UPDATE");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    let newVersion = 0;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [group] = await tx.select().from(accessSecurityGroups).where(and(
        eq(accessSecurityGroups.organizationId, organizationId), eq(accessSecurityGroups.id, req.params.id),
      )).limit(1);
      if (!group) throw Object.assign(new Error("Security group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      const policy = await policyForGroup(tx, organizationId, group.id);
      if (!policy || policy.version !== body.expectedVersion) throw Object.assign(new Error("Security group version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      const history = await tx.select().from(accessGovernanceHistory)
        .where(eq(accessGovernanceHistory.organizationId, organizationId))
        .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id));
      if (group.status === "retired" || eventStatus(history, "security-group", group.id) === "retired") {
        throw Object.assign(new Error("Retired security groups cannot be changed."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      const existingAllows = groupAllows(policy.policy);
      if (existingAllows.some((key) => !isReviewedAccessKey(key))) {
        throw Object.assign(new Error("The current policy contains an unknown catalog key and cannot be changed."), { status: 409, code: "ACCESS_UNKNOWN_CATALOG_KEY" });
      }
      const nextAllows = allows ?? existingAllows;
      const ownerUserId = (body.ownerUserId as string | undefined) ?? group.ownerUserId;
      if (body.ownerUserId !== undefined &&
        !await isActiveOrganizationOwner(tx, organizationId, ownerUserId)) {
        throw Object.assign(new Error("Security group owner must be an active organization owner."), { status: 400, code: "ACCESS_INVALID_GROUP_OWNER" });
      }
      if (body.status !== "retired" && nextAllows.some(isSensitive) && ownerUserId === actor) {
        throw Object.assign(new Error("High-sensitivity policies require independent approval by a different security-group owner."), { status: 409, code: "ACCESS_GROUP_OWNER_REQUIRED" });
      }
      newVersion = policy.version + 1;
      await tx.insert(accessSecurityGroupPolicies).values({
        organizationId, securityGroupId: group.id, version: newVersion,
        policy: {
          fields: nextAllows.filter((key) => resourceType(key) === "field"),
          flows: nextAllows.filter((key) => resourceType(key) === "flow"),
          tools: nextAllows.filter((key) => resourceType(key) === "tool"),
        },
        createdByUserId: actor,
      });
      const retiring = body.status === "retired";
      await tx.update(accessSecurityGroups).set({
        ...(body.name !== undefined ? { name: (body.name as string).trim() } : {}),
        ownerUserId,
        status: retiring ? "retired" : "active",
        version: newVersion,
      }).where(and(
        eq(accessSecurityGroups.organizationId, organizationId),
        eq(accessSecurityGroups.id, group.id),
      ));
      if (retiring) {
        await tx.update(accessPrincipalSecurityGroupAttachments).set({
          status: "revoked", revokedAt: new Date(),
          approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
          version: sql`${accessPrincipalSecurityGroupAttachments.version} + 1`,
        }).where(and(
          eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
          eq(accessPrincipalSecurityGroupAttachments.securityGroupId, group.id),
          or(
            eq(accessPrincipalSecurityGroupAttachments.status, "active"),
            eq(accessPrincipalSecurityGroupAttachments.status, "pending"),
          ),
        ));
      } else if (nextAllows.some(isSensitive)) {
        const activeDirect = await tx.select().from(accessPrincipalSecurityGroupAttachments).where(and(
          eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
          eq(accessPrincipalSecurityGroupAttachments.securityGroupId, group.id),
          or(
            eq(accessPrincipalSecurityGroupAttachments.status, "active"),
            eq(accessPrincipalSecurityGroupAttachments.status, "pending"),
          ),
        ));
        for (const attachment of activeDirect) {
          await recordHistory(tx, {
            organizationId, actorUserId: actor, eventType: "grant.pending",
            entityType: "principal-security-group",
            entityId: `${attachment.principalType === "human" ? "user" : "agent"}:${attachment.principalId}:${group.id}`,
            detail: {
              principalType: attachment.principalType === "human" ? "user" : "agent",
              principalId: attachment.principalId, securityGroupId: group.id, policyVersion: newVersion,
            },
          });
        }
        await tx.update(accessPrincipalSecurityGroupAttachments).set({
          status: "pending", requiresApproval: "yes", approvedByUserId: null, approvedAt: null,
          approvedPolicyVersion: null,
          attachedByUserId: actor,
          version: sql`${accessPrincipalSecurityGroupAttachments.version} + 1`,
        }).where(and(
          eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
          eq(accessPrincipalSecurityGroupAttachments.securityGroupId, group.id),
          or(
            eq(accessPrincipalSecurityGroupAttachments.status, "active"),
            eq(accessPrincipalSecurityGroupAttachments.status, "pending"),
          ),
        ));
      } else {
        await tx.update(accessPrincipalSecurityGroupAttachments).set({
          status: "active", requiresApproval: "no", approvedByUserId: null, approvedAt: null,
          approvedPolicyVersion: null,
          version: sql`${accessPrincipalSecurityGroupAttachments.version} + 1`,
        }).where(and(
          eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
          eq(accessPrincipalSecurityGroupAttachments.securityGroupId, group.id),
          eq(accessPrincipalSecurityGroupAttachments.status, "pending"),
        ));
      }
      if (retiring || nextAllows.some(isSensitive)) {
        const activeGroupLinks = await tx.select().from(accessSecurityGroupUserGroups).where(and(
          eq(accessSecurityGroupUserGroups.organizationId, organizationId),
          eq(accessSecurityGroupUserGroups.securityGroupId, group.id),
          eq(accessSecurityGroupUserGroups.status, "active"),
        ));
        if (!retiring) {
          const affectedUserGroupIds = new Set(activeGroupLinks.map((attachment) => attachment.userGroupId));
          const latestAttachmentEvents = new Map<string, (typeof history)[number]>();
          for (const event of history) {
            if (event.entityType !== "user-group" ||
              !["user-group.security-group.attached", "user-group.security-group.pending", "user-group.security-group.approved", "user-group.security-group.detached"].includes(event.eventType) ||
              event.detail?.securityGroupId !== group.id) continue;
            if (!latestAttachmentEvents.has(event.entityId)) latestAttachmentEvents.set(event.entityId, event);
          }
          for (const [userGroupId, event] of latestAttachmentEvents) {
            if (event.eventType === "user-group.security-group.pending") affectedUserGroupIds.add(userGroupId);
          }
          for (const userGroupId of affectedUserGroupIds) {
            const [userGroup] = await tx.select().from(accessUserGroups).where(and(
              eq(accessUserGroups.organizationId, organizationId),
              eq(accessUserGroups.id, userGroupId),
              eq(accessUserGroups.status, "active"),
            )).limit(1);
            if (userGroup) {
              const membershipPolicies = [
                ...await sensitivePoliciesForUserGroupRequests(tx, organizationId, userGroup.id),
                { id: group.id, ownerUserId, policyVersion: newVersion },
              ].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
              await requestSensitiveMembershipReviews(
                tx,
                organizationId,
                userGroup,
                actor,
                membershipPolicies.map(({ id, policyVersion }) => `${id}@${policyVersion}`).sort().join(","),
              );
              await tx.update(accessUserGroups).set({
                version: sql`${accessUserGroups.version} + 1`,
              }).where(and(
                eq(accessUserGroups.organizationId, organizationId),
                eq(accessUserGroups.id, userGroup.id),
              ));
            }
            await recordHistory(tx, {
              organizationId, actorUserId: actor, eventType: "user-group.security-group.pending",
              entityType: "user-group", entityId: userGroupId,
              detail: { securityGroupId: group.id, policyVersion: newVersion },
            });
          }
        }
        await tx.update(accessSecurityGroupUserGroups).set({
          status: "revoked", approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
          version: sql`${accessSecurityGroupUserGroups.version} + 1`,
        }).where(and(
          eq(accessSecurityGroupUserGroups.organizationId, organizationId),
          eq(accessSecurityGroupUserGroups.securityGroupId, group.id),
          eq(accessSecurityGroupUserGroups.status, "active"),
        ));
        await tx.update(accessSecurityGroupAttachments).set({
          status: "revoked", approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
          version: sql`${accessSecurityGroupAttachments.version} + 1`,
        }).where(and(
          eq(accessSecurityGroupAttachments.organizationId, organizationId),
          eq(accessSecurityGroupAttachments.securityGroupId, group.id),
          or(
            eq(accessSecurityGroupAttachments.status, "active"),
            eq(accessSecurityGroupAttachments.status, "pending"),
          ),
        ));
      }
      if (retiring) {
        await recordHistory(tx, {
          organizationId, actorUserId: actor, eventType: "security-group.status",
          entityType: "security-group", entityId: group.id, detail: { status: "retired" },
        });
      }
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "security-group.policy",
        entityType: "security-group", entityId: group.id, detail: { version: newVersion },
      });
    });
    res.json({ ok: true, version: newVersion });
  } catch (error) {
    if (await respondToGroupNameConflict(res, error, getOrganizationId(req), "security-group", req.body?.name)) return;
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.put("/grants", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may manage access governance.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !validPrincipalType(body.principalType) || !nonEmptyString(body.principalId) ||
      !nonEmptyString(body.securityGroupId) || typeof body.active !== "boolean") {
      fail(res, 400, "principalType, principalId, securityGroupId, and active are required.", "ACCESS_INVALID_GRANT");
      return;
    }
    const principalType = body.principalType as PrincipalType;
    const principalId = body.principalId as string;
    const securityGroupId = body.securityGroupId as string;
    const active = body.active as boolean;
    let expiresAt = parseExpiry(body.expiresAt, active);
    if (expiresAt === undefined) {
      fail(res, 400, "expiresAt must be a future date-time with a timezone, or null.", "ACCESS_INVALID_EXPIRY");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    let grantStatus = active ? "active" : "revoked";
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      if (!await hasActivePrincipal(tx, organizationId, principalType, principalId)) {
        throw Object.assign(new Error("Grants may target only active organization humans or registered agents."), { status: 400, code: "ACCESS_INVALID_PRINCIPAL" });
      }
      const [group] = await tx.select().from(accessSecurityGroups).where(and(
        eq(accessSecurityGroups.organizationId, organizationId),
        eq(accessSecurityGroups.id, securityGroupId),
      )).limit(1);
      if (!group) throw Object.assign(new Error("Security group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      if (group.status !== "active") {
        throw Object.assign(new Error("Retired security groups cannot be granted."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      if (principalType === "user" && principalId === group.ownerUserId) {
        throw Object.assign(new Error("Security-group owners cannot grant themselves access through direct bindings."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
      }
      const policy = await policyForGroup(tx, organizationId, group.id);
      if (!policy) throw Object.assign(new Error("Security group policy not found."), { status: 409, code: "ACCESS_POLICY_UNAVAILABLE" });
      const keys = groupAllows(policy.policy);
      if (keys.some((key) => !CATALOG_BY_KEY.has(key))) {
        throw Object.assign(new Error("The policy contains an unknown catalog key and cannot be granted."), { status: 409, code: "ACCESS_UNKNOWN_CATALOG_KEY" });
      }
      const sensitiveBinding = keys.some(isSensitive);
      const bindingWhere = and(
        eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
        eq(accessPrincipalSecurityGroupAttachments.principalType, toSchemaPrincipalType(principalType)),
        eq(accessPrincipalSecurityGroupAttachments.principalId, principalId),
        eq(accessPrincipalSecurityGroupAttachments.securityGroupId, securityGroupId),
        eq(accessPrincipalSecurityGroupAttachments.scope, "tenant"),
        isNull(accessPrincipalSecurityGroupAttachments.caseId),
      );
      const [existing] = await tx.select().from(accessPrincipalSecurityGroupAttachments)
        .where(bindingWhere).limit(1);
      if (active && body.expiresAt === undefined && existing) expiresAt = existing.expiresAt;
      if (active) {
        const alreadyApproved = Boolean(
          existing?.status === "active" &&
          grantIsLive(existing.expiresAt, new Date()) &&
          existing.expiresAt?.getTime() === expiresAt?.getTime() &&
          (!sensitiveBinding || isIndependentOwnerApprovalValid({
            status: existing.status,
            ownerUserId: group.ownerUserId,
            attachedByUserId: existing.attachedByUserId,
            approvedByUserId: existing.approvedByUserId,
            approvedAt: existing.approvedAt,
            approvedPolicyVersion: existing.approvedPolicyVersion,
            currentPolicyVersion: policy.version,
            ownerIsActiveMember: await hasActivePrincipal(tx, organizationId, "user", group.ownerUserId),
          })),
        );
        if (sensitiveBinding && !alreadyApproved) grantStatus = "pending";
        if (existing) {
          await tx.update(accessPrincipalSecurityGroupAttachments).set({
            status: alreadyApproved ? "active" : sensitiveBinding ? "pending" : "active",
            requiresApproval: sensitiveBinding ? "yes" : "no",
            attachedByUserId: alreadyApproved ? existing.attachedByUserId : actor,
            approvedByUserId: alreadyApproved ? existing.approvedByUserId : null,
            approvedAt: alreadyApproved ? existing.approvedAt : null,
            approvedPolicyVersion: alreadyApproved ? existing.approvedPolicyVersion : null,
            revokedAt: null,
            expiresAt,
            version: existing.version + (alreadyApproved ? 0 : 1),
          }).where(bindingWhere);
        } else {
          await tx.insert(accessPrincipalSecurityGroupAttachments).values({
            organizationId,
            principalType: toSchemaPrincipalType(principalType),
            principalId,
            securityGroupId,
            scope: "tenant",
            caseId: null,
            status: sensitiveBinding ? "pending" : "active",
            version: 1,
            requiresApproval: sensitiveBinding ? "yes" : "no",
            attachedByUserId: actor,
            expiresAt,
            approvedPolicyVersion: null,
          });
        }
        await recordHistory(tx, {
          organizationId, actorUserId: actor,
          eventType: grantStatus === "pending" ? "grant.pending" : "grant.active",
          entityType: "principal-security-group",
          entityId: `${principalType}:${principalId}:${securityGroupId}`,
          detail: { principalType, principalId, securityGroupId, policyVersion: policy.version, expiresAt: expiresAt?.toISOString() ?? null },
        });
      } else if (existing && existing.status !== "revoked") {
        await tx.update(accessPrincipalSecurityGroupAttachments).set({
          status: "revoked", revokedAt: new Date(), version: existing.version + 1,
          approvedByUserId: null, approvedAt: null, approvedPolicyVersion: null,
        }).where(bindingWhere);
        grantStatus = "revoked";
        await recordHistory(tx, {
          organizationId, actorUserId: actor, eventType: "grant.revoked",
          entityType: "principal-security-group",
          entityId: `${principalType}:${principalId}:${securityGroupId}`,
          detail: { principalType, principalId, securityGroupId, policyVersion: policy.version },
        });
      }
    });
    res.json({
      ok: true,
      status: grantStatus,
    });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.post("/grants/approve", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may review direct access bindings.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !validPrincipalType(body.principalType) ||
      !nonEmptyString(body.principalId) ||
      !nonEmptyString(body.securityGroupId) ||
      !Number.isInteger(body.expectedVersion)) {
      fail(res, 400, "principalType, principalId, securityGroupId, and expectedVersion are required.", "ACCESS_INVALID_GRANT_APPROVAL");
      return;
    }
    const principalType = body.principalType as PrincipalType;
    const principalId = body.principalId as string;
    const securityGroupId = body.securityGroupId as string;
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      if (!await hasActivePrincipal(tx, organizationId, principalType, principalId)) {
        throw Object.assign(new Error("The grant target must be an active organization principal."), { status: 400, code: "ACCESS_INVALID_PRINCIPAL" });
      }
      const [group] = await tx.select().from(accessSecurityGroups).where(and(
        eq(accessSecurityGroups.organizationId, organizationId),
        eq(accessSecurityGroups.id, securityGroupId),
      )).limit(1);
      if (!group) throw Object.assign(new Error("Security group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      if (group.status !== "active") {
        throw Object.assign(new Error("Retired security groups cannot be approved."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      if (principalType === "user" && principalId === group.ownerUserId) {
        throw Object.assign(new Error("Security-group owners cannot approve direct access to themselves."), { status: 403, code: "ACCESS_OWNER_SELF_GRANT_FORBIDDEN" });
      }
      if (group.ownerUserId !== actor || !await isActiveOrganizationOwner(tx, organizationId, actor)) {
        throw Object.assign(new Error("Only the active security-group owner may approve this direct binding."), { status: 403, code: "ACCESS_OWNER_REQUIRED" });
      }
      const policy = await policyForGroup(tx, organizationId, securityGroupId);
      if (!policy || policy.version !== body.expectedVersion) {
        throw Object.assign(new Error("Security group version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      }
      const keys = groupAllows(policy.policy);
      if (keys.some((key) => !isReviewedAccessKey(key))) {
        throw Object.assign(new Error("The policy contains an unknown catalog key and cannot be approved."), { status: 409, code: "ACCESS_UNKNOWN_CATALOG_KEY" });
      }
      if (!keys.some(isSensitive)) {
        throw Object.assign(new Error("Independent grant review is only required for high-sensitivity policies."), { status: 409, code: "ACCESS_REVIEW_NOT_REQUIRED" });
      }
      if (policy.approvedByUserId !== group.ownerUserId || !policy.approvedAt ||
        policy.approvedByUserId === policy.createdByUserId) {
        throw Object.assign(new Error("The security-group owner must first independently approve the policy."), { status: 409, code: "ACCESS_POLICY_REVIEW_REQUIRED" });
      }
      const bindingWhere = and(
        eq(accessPrincipalSecurityGroupAttachments.organizationId, organizationId),
        eq(accessPrincipalSecurityGroupAttachments.principalType, toSchemaPrincipalType(principalType)),
        eq(accessPrincipalSecurityGroupAttachments.principalId, principalId),
        eq(accessPrincipalSecurityGroupAttachments.securityGroupId, securityGroupId),
        eq(accessPrincipalSecurityGroupAttachments.scope, "tenant"),
        isNull(accessPrincipalSecurityGroupAttachments.caseId),
      );
      const [binding] = await tx.select().from(accessPrincipalSecurityGroupAttachments)
        .where(bindingWhere).limit(1);
      if (!binding || binding.status !== "pending" || binding.revokedAt) {
        throw Object.assign(new Error("A pending direct grant request was not found."), { status: 409, code: "ACCESS_GRANT_NOT_PENDING" });
      }
      if (!grantIsLive(binding.expiresAt, new Date())) {
        throw Object.assign(new Error("The requested grant has expired; submit a new request."), { status: 409, code: "ACCESS_INVALID_EXPIRY" });
      }
      if (binding.attachedByUserId === actor) {
        throw Object.assign(new Error("The security-group owner cannot approve their own direct binding request."), { status: 403, code: "ACCESS_INDEPENDENT_REVIEW_REQUIRED" });
      }
      await tx.update(accessPrincipalSecurityGroupAttachments).set({
        status: "active", requiresApproval: "yes",
        approvedByUserId: actor, approvedAt: new Date(),
        approvedPolicyVersion: policy.version,
        version: binding.version + 1,
      }).where(bindingWhere);
      await recordHistory(tx, {
        organizationId,
        actorUserId: actor,
        eventType: "grant.approved",
        entityType: "principal-security-group",
        entityId: `${principalType}:${principalId}:${securityGroupId}`,
        detail: { principalType, principalId, securityGroupId, policyVersion: policy.version, expiresAt: binding.expiresAt?.toISOString() ?? null },
      });
    });
    res.json({ ok: true, status: "active" });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

router.post("/security-groups/:id/approve", async (req, res, next) => {
  try {
    if (req.organizationRole !== "owner") {
      fail(res, 403, "Only an organization owner may review access policies.", "ORGANIZATION_OWNER_REQUIRED");
      return;
    }
    const body = bodyObject(req.body);
    if (!body || !Number.isInteger(body.expectedVersion)) {
      fail(res, 400, "expectedVersion is required.", "ACCESS_INVALID_APPROVAL");
      return;
    }
    const organizationId = getOrganizationId(req);
    const actor = req.authUserId!;
    let approved = false;
    await db.transaction(async (tx) => {
      await lockTenant(tx, organizationId);
      const [group] = await tx.select().from(accessSecurityGroups).where(and(
        eq(accessSecurityGroups.organizationId, organizationId), eq(accessSecurityGroups.id, req.params.id),
      )).limit(1);
      if (!group) throw Object.assign(new Error("Security group not found."), { status: 404, code: "ACCESS_NOT_FOUND" });
      if (group.status !== "active") {
        throw Object.assign(new Error("Retired security groups cannot be approved."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      if (group.ownerUserId !== actor || !await isActiveOrganizationOwner(tx, organizationId, actor)) {
        throw Object.assign(new Error("Only the active security-group owner may approve this policy."), { status: 403, code: "ACCESS_OWNER_REQUIRED" });
      }
      const policy = await policyForGroup(tx, organizationId, group.id);
      if (!policy || policy.version !== body.expectedVersion) throw Object.assign(new Error("Security group version is stale; reload and try again."), { status: 409, code: "ACCESS_VERSION_CONFLICT" });
      const history = await tx.select().from(accessGovernanceHistory)
        .where(eq(accessGovernanceHistory.organizationId, organizationId))
        .orderBy(desc(accessGovernanceHistory.createdAt), desc(accessGovernanceHistory.id));
      if (eventStatus(history, "security-group", group.id) === "retired") {
        throw Object.assign(new Error("Retired security groups cannot be approved."), { status: 409, code: "ACCESS_GROUP_RETIRED" });
      }
      const allows = groupAllows(policy.policy);
      if (allows.some((key) => !isReviewedAccessKey(key))) {
        throw Object.assign(new Error("The policy contains an unknown catalog key and cannot be approved."), { status: 409, code: "ACCESS_UNKNOWN_CATALOG_KEY" });
      }
      if (!allows.some(isSensitive)) {
        throw Object.assign(new Error("Independent review is only required for high-sensitivity policies."), { status: 409, code: "ACCESS_REVIEW_NOT_REQUIRED" });
      }
      if (policy.createdByUserId === actor) {
        throw Object.assign(new Error("The security-group owner must be different from the policy editor."), { status: 403, code: "ACCESS_INDEPENDENT_REVIEW_REQUIRED" });
      }
      await tx.insert(accessSecurityGroupPolicies).values({
        organizationId,
        securityGroupId: group.id,
        version: policy.version + 1,
        policy: policy.policy,
        createdByUserId: policy.createdByUserId,
        approvedByUserId: actor,
        approvedAt: new Date(),
      });
      await tx.update(accessSecurityGroups).set({ version: policy.version + 1 }).where(and(
        eq(accessSecurityGroups.organizationId, organizationId),
        eq(accessSecurityGroups.id, group.id),
      ));
      await recordHistory(tx, {
        organizationId, actorUserId: actor, eventType: "security-group.approved",
        entityType: "security-group", entityId: group.id, detail: { version: policy.version + 1 },
      });
      approved = true;
    });
    res.json({ ok: approved, approvalStatus: "approved" });
  } catch (error) {
    if (error instanceof Error && "status" in error) {
      const coded = error as Error & { status: number; code: string };
      fail(res, coded.status, error.message, coded.code);
      return;
    }
    next(error);
  }
});

export default router;