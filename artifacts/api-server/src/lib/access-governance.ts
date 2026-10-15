import { and, desc, eq, gt, inArray, isNull, or, type AnyColumn } from "drizzle-orm";
import {
  accessAgents,
  accessGovernanceHistory,
  accessNamedGrants,
  accessPrincipalSecurityGroupAttachments,
  accessSecurityGroups,
  accessSecurityGroupAttachments,
  accessSecurityGroupPolicies,
  accessSecurityGroupUserGroups,
  accessUserGroups,
  accessUserGroupMembers,
  db,
  DEMO_ORGANIZATION_ID,
  onbCases,
  onbSettings,
  organizationMembershipsTable,
} from "@workspace/db";
import { sql } from "drizzle-orm";

/** Organizational labels only: no policies, membership, or specialist authority. */
export const USER_GROUP_STARTERS = [
  { id: "hr", name: "HR" },
  { id: "hiring-managers", name: "Hiring Managers" },
  { id: "it-operations", name: "IT Operations" },
  { id: "payroll", name: "Payroll" },
  { id: "compliance-reviewers", name: "Compliance Reviewers" },
  { id: "ai-agents", name: "AI Agents" },
] as const;

export function userGroupStarter(value: unknown) {
  return USER_GROUP_STARTERS.find((starter) => starter.id === value);
}

export function normalizedUserGroupName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * This is the reviewed server-side vocabulary. Database policy JSON and named
 * grants can only confer these exact keys; unknown values and wildcards are
 * ignored. Additions require code review, not tenant-controlled catalog data.
 */
export const ACCESS_GOVERNANCE_CATALOG = {
  fields: [
    "data.identity.read", "data.identity.edit",
    "data.medical.read", "data.medical.edit",
    "data.payroll.read", "data.payroll.edit",
    "data.bgv.read", "data.bgv.edit",
    "data.case.profile.read", "data.case.profile.edit",
    "data.case.readiness.read", "data.case.readiness.edit",
    "data.case.notes.read", "data.case.notes.edit",
    "data.documents.read", "data.documents.edit",
    "data.audit.read",
    // Operational continuity only; never business evidence or specialist authority.
    "data.context.metadata.read",
  ],
  flows: [
    "flow.case.read", "flow.case.edit",
    "flow.onboarding.read", "flow.onboarding.edit",
    "flow.document-review.read", "flow.document-review.edit",
  ],
  tools: [
    "tool.case.read", "tool.case.edit", "tool.context.read",
    "tool.documents.read", "tool.documents.edit",
    "tool.notification.send", "tool.workflow.run",
    "tool.external.dispatch", "tool.policy.manage",
    "tool.approval.decide",
  ],
} as const;

export type AccessGovernanceKey =
  | (typeof ACCESS_GOVERNANCE_CATALOG.fields)[number]
  | (typeof ACCESS_GOVERNANCE_CATALOG.flows)[number]
  | (typeof ACCESS_GOVERNANCE_CATALOG.tools)[number];

import { isPlatformSuperAdmin } from "./private-platform-admin";
import { demoPrincipalSettingKey, parseRegisteredDemoProfile } from "./demo-principal";

const FIELD_KEYS = new Set<string>(ACCESS_GOVERNANCE_CATALOG.fields);
const FLOW_KEYS = new Set<string>(ACCESS_GOVERNANCE_CATALOG.flows);
const TOOL_KEYS = new Set<string>(ACCESS_GOVERNANCE_CATALOG.tools);
const ALL_KEYS: readonly AccessGovernanceKey[] = [
  ...ACCESS_GOVERNANCE_CATALOG.fields,
  ...ACCESS_GOVERNANCE_CATALOG.flows,
  ...ACCESS_GOVERNANCE_CATALOG.tools,
];
const HIGH_SENSITIVITY_KEYS = new Set<AccessGovernanceKey>([
  "data.identity.read", "data.identity.edit",
  "data.medical.read", "data.medical.edit",
  "data.payroll.read", "data.payroll.edit",
  "data.bgv.read", "data.bgv.edit",
]);
const HUMAN_ONLY_KEYS = new Set<AccessGovernanceKey>(["tool.approval.decide", "data.context.metadata.read"]);

export type ResolveEffectiveAccessInput = {
  organizationId: string;
  principalType: "human" | "agent";
  principalId: string;
  caseId?: number;
  /** Required for agents; access is intersected with this active human. */
  initiatorUserId?: string;
  /** Caller context only. This value never creates or broadens authority. */
  purpose?: string;
};

export type EffectiveAccess = {
  allows: string[];
  reasons: Record<string, string[]>;
};

export class AccessGovernanceDeniedError extends Error {
  constructor(readonly resourceKey: string) {
    super(`ACCESS_GOVERNANCE_DENIED:${resourceKey}`);
    this.name = "AccessGovernanceDeniedError";
  }
}

type AccessGovernanceTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PrincipalSubject = { principalType: "human" | "agent"; principalId: string };

/** Request-local database inputs, never a permission cache. */
type AccessReadBatch = {
  now: Date;
  cases: Set<number>;
  activatedCases: Set<number>;
  members: Set<string>;
  administrators: Set<string>;
  sharedDemoPrincipals: Set<string>;
  agents: (typeof accessAgents.$inferSelect)[];
  memberships: (typeof accessUserGroupMembers.$inferSelect)[];
  userGroups: (typeof accessUserGroups.$inferSelect)[];
  groupLinks: (typeof accessSecurityGroupUserGroups.$inferSelect)[];
  directLinks: (typeof accessPrincipalSecurityGroupAttachments.$inferSelect)[];
  securityGroups: (typeof accessSecurityGroups.$inferSelect)[];
  attachments: (typeof accessSecurityGroupAttachments.$inferSelect)[];
  policies: (typeof accessSecurityGroupPolicies.$inferSelect)[];
  grants: (typeof accessNamedGrants.$inferSelect)[];
};

function matchesCaseScope(row: { scope: string; caseId: number | null }, caseId?: number) {
  return row.scope === "tenant" || (caseId !== undefined && row.scope === "case" && row.caseId === caseId);
}

/**
 * Load current tenant-scoped inputs once, then use the ordinary evaluator for
 * each case. A repeatable-read transaction prevents mixed policy generations.
 * No caller-supplied ownership or precomputed permission is trusted.
 */
export async function resolveEffectiveAccessForCases(
  input: Omit<ResolveEffectiveAccessInput, "caseId">,
  caseIds: readonly number[],
): Promise<Map<number, EffectiveAccess>> {
  const ids = [...new Set(caseIds)];
  if (!ids.length) return new Map();
  return db.transaction(async (tx) => {
    const now = new Date();
    const live = (column: AnyColumn) => or(isNull(column), gt(column, now))!;
    const scope = (table: { scope: AnyColumn; caseId: AnyColumn }) =>
      or(eq(table.scope, "tenant"), and(eq(table.scope, "case"), inArray(table.caseId, ids)))!;
    const principals = [...new Set([input.principalId, input.initiatorUserId].filter((id): id is string => Boolean(id)))];
    const cases = await tx.select({ id: onbCases.id, activation: onbCases.operationalActivation }).from(onbCases).where(and(
      eq(onbCases.organizationId, input.organizationId), inArray(onbCases.id, ids),
    ));
    const agents = input.principalType === "agent" ? await tx.select().from(accessAgents).where(and(
      eq(accessAgents.organizationId, input.organizationId), eq(accessAgents.id, input.principalId),
      eq(accessAgents.status, "active"), isNull(accessAgents.revokedAt),
    )) : [];
    const memberships = await tx.select().from(accessUserGroupMembers).where(and(
      eq(accessUserGroupMembers.organizationId, input.organizationId),
      inArray(accessUserGroupMembers.principalId, principals), eq(accessUserGroupMembers.status, "active"),
      isNull(accessUserGroupMembers.revokedAt), live(accessUserGroupMembers.expiresAt),
    ));
    const groupIds = [...new Set(memberships.map(row => row.groupId))];
    const userGroups = groupIds.length ? await tx.select().from(accessUserGroups).where(and(
      eq(accessUserGroups.organizationId, input.organizationId), inArray(accessUserGroups.id, groupIds),
      eq(accessUserGroups.status, "active"),
    )) : [];
    const groupLinks = groupIds.length ? await tx.select().from(accessSecurityGroupUserGroups).where(and(
      eq(accessSecurityGroupUserGroups.organizationId, input.organizationId),
      inArray(accessSecurityGroupUserGroups.userGroupId, groupIds),
      eq(accessSecurityGroupUserGroups.status, "active"), live(accessSecurityGroupUserGroups.expiresAt),
    )) : [];
    const directLinks = await tx.select().from(accessPrincipalSecurityGroupAttachments).where(and(
      eq(accessPrincipalSecurityGroupAttachments.organizationId, input.organizationId),
      inArray(accessPrincipalSecurityGroupAttachments.principalId, principals),
      eq(accessPrincipalSecurityGroupAttachments.status, "active"),
      isNull(accessPrincipalSecurityGroupAttachments.revokedAt), live(accessPrincipalSecurityGroupAttachments.expiresAt),
      scope(accessPrincipalSecurityGroupAttachments),
    ));
    const securityGroupIds = [...new Set([...groupLinks, ...directLinks].map(row => row.securityGroupId))];
    const securityGroups = securityGroupIds.length ? await tx.select().from(accessSecurityGroups).where(and(
      eq(accessSecurityGroups.organizationId, input.organizationId), inArray(accessSecurityGroups.id, securityGroupIds),
      eq(accessSecurityGroups.status, "active"),
    )) : [];
    const attachments = securityGroupIds.length ? await tx.select().from(accessSecurityGroupAttachments).where(and(
      eq(accessSecurityGroupAttachments.organizationId, input.organizationId),
      inArray(accessSecurityGroupAttachments.securityGroupId, securityGroupIds),
      eq(accessSecurityGroupAttachments.status, "active"), live(accessSecurityGroupAttachments.expiresAt),
      scope(accessSecurityGroupAttachments),
    )) : [];
    const policies = securityGroupIds.length ? await tx.select().from(accessSecurityGroupPolicies).where(and(
      eq(accessSecurityGroupPolicies.organizationId, input.organizationId),
      inArray(accessSecurityGroupPolicies.securityGroupId, securityGroupIds),
    )).orderBy(desc(accessSecurityGroupPolicies.version)) : [];
    const grants = await tx.select().from(accessNamedGrants).where(and(
      eq(accessNamedGrants.organizationId, input.organizationId), inArray(accessNamedGrants.principalId, principals),
      scope(accessNamedGrants), eq(accessNamedGrants.status, "active"),
      isNull(accessNamedGrants.revokedAt), eq(accessNamedGrants.source, "named"),
    ));
    const memberIds = [...new Set([...principals, ...agents.map(row => row.ownerUserId),
      ...userGroups.map(row => row.ownerUserId), ...securityGroups.map(row => row.ownerUserId)])];
    const members = memberIds.length ? await tx.select({ userId: organizationMembershipsTable.clerkUserId, role: organizationMembershipsTable.role })
      .from(organizationMembershipsTable).where(and(
        eq(organizationMembershipsTable.organizationId, input.organizationId),
        inArray(organizationMembershipsTable.clerkUserId, memberIds), isNull(organizationMembershipsTable.revokedAt),
      )) : [];
    const demoRegistrations = principals.length ? await tx.select({ key: onbSettings.key, value: onbSettings.value })
      .from(onbSettings).where(and(
        eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
        inArray(onbSettings.key, principals.map(demoPrincipalSettingKey)),
      )) : [];
    const batch: AccessReadBatch = {
      now, cases: new Set(cases.map(row => row.id)),
      activatedCases: new Set(cases.filter(row => row.activation !== null).map(row => row.id)),
      members: new Set(members.map(row => row.userId)),
      administrators: new Set(members.filter(row => row.role === "owner" || row.role === "admin").map(row => row.userId)),
      sharedDemoPrincipals: new Set(principals.filter(id => demoRegistrations.some(row =>
        row.key === demoPrincipalSettingKey(id) && parseRegisteredDemoProfile(row.value)))),
      agents, memberships, userGroups, groupLinks, directLinks, securityGroups, attachments, policies, grants,
    };
    const result = new Map<number, EffectiveAccess>();
    for (const caseId of ids) result.set(caseId, await evaluateEffectiveAccess(tx, { ...input, caseId }, batch));
    return result;
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Expiry is exclusive; equality with the current instant is already expired. */
export function grantIsLive(expiresAt: Date | null, now: Date): boolean {
  return expiresAt === null || expiresAt.getTime() > now.getTime();
}

function knownKey(key: string): key is AccessGovernanceKey {
  return FIELD_KEYS.has(key) || FLOW_KEYS.has(key) || TOOL_KEYS.has(key);
}

/** True only for a key in the reviewed, server-owned capability catalog. */
export function isReviewedAccessKey(key: string): key is AccessGovernanceKey {
  return knownKey(key);
}

/** Enforces initiator intersection and the agent's human-only approval limit. */
export function isAccessAllowedForPrincipal(input: {
  principalType: "human" | "agent";
  key: string;
  principalAllows: boolean;
  initiatorAllows?: boolean;
}): boolean {
  if (!knownKey(input.key) || !input.principalAllows) return false;
  if (input.principalType === "human") return true;
  return !HUMAN_ONLY_KEYS.has(input.key) && input.initiatorAllows === true;
}

/** Sensitive policy owners are not recipients of the policy they own. */
export function isSensitivePolicyOwner(input: {
  principalType: "human" | "agent";
  principalId: string;
  securityGroupOwnerUserId: string;
  userGroupOwnerUserIds?: readonly string[];
}): boolean {
  return input.principalType === "human" &&
    (input.principalId === input.securityGroupOwnerUserId ||
      (input.userGroupOwnerUserIds ?? []).includes(input.principalId));
}

/** Independent high-sensitivity attachment approval is owner-bound and live. */
export function isActiveDistinctOwnerApprovalValid(input: {
  status: string;
  ownerUserId: string;
  attachedByUserId: string;
  approvedByUserId?: string | null;
  approvedAt?: Date | null;
  ownerIsActiveMember: boolean;
}): boolean {
  return input.status === "active" &&
    input.ownerIsActiveMember &&
    input.approvedByUserId === input.ownerUserId &&
    input.approvedByUserId !== input.attachedByUserId &&
    Boolean(input.approvedAt);
}

/** Policy-bound attachment approvals become stale when that policy is revised. */
export function isIndependentOwnerApprovalValid(input: {
  status: string;
  ownerUserId: string;
  attachedByUserId: string;
  approvedByUserId?: string | null;
  approvedAt?: Date | null;
  approvedPolicyVersion?: number | null;
  currentPolicyVersion?: number;
  ownerIsActiveMember: boolean;
}): boolean {
  return isActiveDistinctOwnerApprovalValid(input) &&
    input.currentPolicyVersion !== undefined &&
    input.approvedPolicyVersion === input.currentPolicyVersion;
}

/** Every member of a currently sensitive group needs independent approval. */
export function membershipNeedsIndependentApproval(input: {
  requiresApproval: "yes" | "no";
  hasCurrentSensitivePolicy: boolean;
}): boolean {
  return input.requiresApproval === "yes" || input.hasCurrentSensitivePolicy;
}

function catalogSection(key: AccessGovernanceKey): "fields" | "flows" | "tools" {
  if (FIELD_KEYS.has(key)) return "fields";
  if (FLOW_KEYS.has(key)) return "flows";
  return "tools";
}

function policyKeys(policy: unknown, section: "fields" | "flows" | "tools"): string[] {
  if (!policy || typeof policy !== "object") return [];
  const values = (policy as Record<string, unknown>)[section];
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

async function isActiveHumanMember(
  tx: AccessGovernanceTransaction,
  organizationId: string,
  userId: string,
  batch?: AccessReadBatch,
): Promise<boolean> {
  if (batch) return batch.members.has(userId);
  const [membership] = await tx.select({ id: organizationMembershipsTable.id })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, userId),
      isNull(organizationMembershipsTable.revokedAt),
    ))
    .limit(1);
  return Boolean(membership);
}

/** Live app-owned client role, never a display label or public Demo identity. */
export async function isClientAdministratorInTransaction(
  tx: AccessGovernanceTransaction,
  organizationId: string,
  userId: string,
  batch?: AccessReadBatch,
): Promise<boolean> {
  if (!organizationId || !userId) return false;
  if (batch) return batch.administrators.has(userId) && !batch.sharedDemoPrincipals.has(userId);
  const [membership] = await tx.select({ role: organizationMembershipsTable.role })
    .from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      eq(organizationMembershipsTable.clerkUserId, userId),
      isNull(organizationMembershipsTable.revokedAt),
    )).limit(1);
  if (membership?.role !== "owner" && membership?.role !== "admin") return false;
  const [registration] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
    eq(onbSettings.key, demoPrincipalSettingKey(userId)),
  )).limit(1);
  return !parseRegisteredDemoProfile(registration?.value);
}

async function caseBelongsToTenant(
  tx: AccessGovernanceTransaction,
  organizationId: string,
  caseId: number,
  batch?: AccessReadBatch,
): Promise<boolean> {
  if (batch) return batch.cases.has(caseId);
  const [record] = await tx.select({ id: onbCases.id })
    .from(onbCases)
    .where(and(eq(onbCases.id, caseId), eq(onbCases.organizationId, organizationId)))
    .limit(1);
  return Boolean(record);
}

type SubjectCapabilities = {
  allows: Set<AccessGovernanceKey>;
  denies: Set<AccessGovernanceKey>;
  reasons: Map<AccessGovernanceKey, string[]>;
};

function addReason(
  reasons: Map<AccessGovernanceKey, string[]>,
  key: AccessGovernanceKey,
  reason: string,
) {
  const existing = reasons.get(key) ?? [];
  existing.push(reason);
  reasons.set(key, existing);
}

async function resolveSubjectCapabilities(
  tx: AccessGovernanceTransaction,
  input: ResolveEffectiveAccessInput,
  subject: PrincipalSubject,
  batch?: AccessReadBatch,
): Promise<SubjectCapabilities> {
  const allows = new Set<AccessGovernanceKey>();
  const denies = new Set<AccessGovernanceKey>();
  const reasons = new Map<AccessGovernanceKey, string[]>();
  const now = batch?.now ?? new Date();
  const unexpired = (column: AnyColumn) =>
    or(isNull(column), gt(column, now))!;
  const groupMemberships = batch ? batch.memberships.filter(row =>
    row.principalType === subject.principalType && row.principalId === subject.principalId
  ) : await tx.select().from(accessUserGroupMembers)
    .where(and(
      eq(accessUserGroupMembers.organizationId, input.organizationId),
      eq(accessUserGroupMembers.principalType, subject.principalType),
      eq(accessUserGroupMembers.principalId, subject.principalId),
      eq(accessUserGroupMembers.status, "active"),
      isNull(accessUserGroupMembers.revokedAt),
      unexpired(accessUserGroupMembers.expiresAt),
    ));
  const groupIds = [...new Set(groupMemberships.map((row) => row.groupId))];
  const activeUserGroups = batch ? batch.userGroups.filter(row => groupIds.includes(row.id)) : groupIds.length
    ? await tx.select().from(accessUserGroups).where(and(
      eq(accessUserGroups.organizationId, input.organizationId),
      inArray(accessUserGroups.id, groupIds),
      eq(accessUserGroups.status, "active"),
    ))
    : [];
  const userGroupById = new Map(activeUserGroups.map((group) => [group.id, group]));
  const liveUserGroupIds: string[] = [];
  for (const group of activeUserGroups) {
    if (await isActiveHumanMember(tx, input.organizationId, group.ownerUserId, batch)) {
      liveUserGroupIds.push(group.id);
    }
  }

  const groupLinks = batch ? batch.groupLinks.filter(row => liveUserGroupIds.includes(row.userGroupId)) : liveUserGroupIds.length
    ? await tx.select().from(accessSecurityGroupUserGroups).where(and(
      eq(accessSecurityGroupUserGroups.organizationId, input.organizationId),
      inArray(accessSecurityGroupUserGroups.userGroupId, liveUserGroupIds),
      eq(accessSecurityGroupUserGroups.status, "active"),
      unexpired(accessSecurityGroupUserGroups.expiresAt),
    ))
    : [];
  const directLinks = batch ? batch.directLinks.filter(row =>
    row.principalType === subject.principalType && row.principalId === subject.principalId &&
    matchesCaseScope(row, input.caseId)
  ) : await tx.select().from(accessPrincipalSecurityGroupAttachments).where(and(
    eq(accessPrincipalSecurityGroupAttachments.organizationId, input.organizationId),
    eq(accessPrincipalSecurityGroupAttachments.principalType, subject.principalType),
    eq(accessPrincipalSecurityGroupAttachments.principalId, subject.principalId),
    eq(accessPrincipalSecurityGroupAttachments.status, "active"),
    isNull(accessPrincipalSecurityGroupAttachments.revokedAt),
    unexpired(accessPrincipalSecurityGroupAttachments.expiresAt),
    input.caseId === undefined
      ? eq(accessPrincipalSecurityGroupAttachments.scope, "tenant")
      : or(
        eq(accessPrincipalSecurityGroupAttachments.scope, "tenant"),
        and(
          eq(accessPrincipalSecurityGroupAttachments.scope, "case"),
          eq(accessPrincipalSecurityGroupAttachments.caseId, input.caseId),
        ),
      )!,
  ));

  const securityGroupIds = [...new Set([
    ...groupLinks.map((link) => link.securityGroupId),
    ...directLinks.map((link) => link.securityGroupId),
  ])];
  const activeSecurityGroups = batch ? batch.securityGroups.filter(row => securityGroupIds.includes(row.id)) : securityGroupIds.length
    ? await tx.select().from(accessSecurityGroups).where(and(
      eq(accessSecurityGroups.organizationId, input.organizationId),
      inArray(accessSecurityGroups.id, securityGroupIds),
      eq(accessSecurityGroups.status, "active"),
    ))
    : [];

  const attachmentScope = input.caseId === undefined
    ? eq(accessSecurityGroupAttachments.scope, "tenant")
    : or(
      eq(accessSecurityGroupAttachments.scope, "tenant"),
      and(
        eq(accessSecurityGroupAttachments.scope, "case"),
        eq(accessSecurityGroupAttachments.caseId, input.caseId),
      ),
    );
  const scopedAttachments = batch ? batch.attachments.filter(row =>
    securityGroupIds.includes(row.securityGroupId) && matchesCaseScope(row, input.caseId)
  ) : securityGroupIds.length
    ? await tx.select().from(accessSecurityGroupAttachments).where(and(
      eq(accessSecurityGroupAttachments.organizationId, input.organizationId),
      inArray(accessSecurityGroupAttachments.securityGroupId, securityGroupIds),
      eq(accessSecurityGroupAttachments.status, "active"),
      unexpired(accessSecurityGroupAttachments.expiresAt),
      attachmentScope!,
    ))
    : [];

  for (const securityGroup of activeSecurityGroups) {
    if (!(await isActiveHumanMember(tx, input.organizationId, securityGroup.ownerUserId, batch))) continue;
    const [policy] = batch ? batch.policies.filter(row => row.securityGroupId === securityGroup.id).slice(0, 1) : await tx.select().from(accessSecurityGroupPolicies).where(and(
      eq(accessSecurityGroupPolicies.organizationId, input.organizationId),
      eq(accessSecurityGroupPolicies.securityGroupId, securityGroup.id),
    )).orderBy(desc(accessSecurityGroupPolicies.version)).limit(1);
    if (!policy) continue;

    const hasSensitivePolicy = ALL_KEYS.some((key) =>
      HIGH_SENSITIVITY_KEYS.has(key) &&
      policyKeys(policy.policy, catalogSection(key)).includes(key),
    );
    const policyApprovalValid = !hasSensitivePolicy || (
      policy.approvedByUserId === securityGroup.ownerUserId &&
      policy.approvedByUserId !== policy.createdByUserId &&
      Boolean(policy.approvedAt) &&
      await isActiveHumanMember(tx, input.organizationId, policy.approvedByUserId, batch)
    );
    if (!policyApprovalValid) {
      for (const key of ALL_KEYS) {
        if (HIGH_SENSITIVITY_KEYS.has(key) && policyKeys(policy.policy, catalogSection(key)).includes(key)) {
          addReason(reasons, key, `Policy v${policy.version} needs independent approval by its active security-group owner.`);
        }
      }
    }

    const relevantScopedAttachments = scopedAttachments.filter((row) =>
      row.securityGroupId === securityGroup.id,
    );
    const groupPaths = groupLinks.filter((link) => link.securityGroupId === securityGroup.id);
    const directPaths = directLinks.filter((link) => link.securityGroupId === securityGroup.id);
    const ownerIsActiveMember = await isActiveHumanMember(
      tx,
      input.organizationId,
      securityGroup.ownerUserId,
      batch,
    );
    const groupPathIsLive = groupPaths.some((link) => relevantScopedAttachments.some((scopeLink) => {
      if (scopeLink.securityGroupId !== securityGroup.id) return false;
      const userGroup = userGroupById.get(link.userGroupId);
      const membership = groupMemberships.find((candidate) => candidate.groupId === link.userGroupId);
      if (!userGroup || !membership || !liveUserGroupIds.includes(userGroup.id)) return false;
      const memberNeedsApproval = membershipNeedsIndependentApproval({
        requiresApproval: membership.requiresApproval,
        hasCurrentSensitivePolicy: hasSensitivePolicy,
      });
      const membershipApprovalValid = !memberNeedsApproval || isActiveDistinctOwnerApprovalValid({
        status: membership.status,
        ownerUserId: userGroup.ownerUserId,
        attachedByUserId: membership.attachedByUserId,
        approvedByUserId: membership.approvedByUserId,
        approvedAt: membership.approvedAt,
        ownerIsActiveMember: true,
      });
      // A stewardship transfer also fences non-sensitive memberships until
      // reviewed. Do not bypass that explicit gate for low-sensitivity policies.
      if (!membershipApprovalValid) return false;
      if (!hasSensitivePolicy) return true;
      return membershipApprovalValid &&
        isIndependentOwnerApprovalValid({
          status: link.status,
          ownerUserId: securityGroup.ownerUserId,
          attachedByUserId: link.attachedByUserId,
          approvedByUserId: link.approvedByUserId,
          approvedAt: link.approvedAt,
          approvedPolicyVersion: link.approvedPolicyVersion,
          currentPolicyVersion: policy.version,
          ownerIsActiveMember,
        }) &&
        isIndependentOwnerApprovalValid({
          status: scopeLink.status,
          ownerUserId: securityGroup.ownerUserId,
          attachedByUserId: scopeLink.attachedByUserId,
          approvedByUserId: scopeLink.approvedByUserId,
          approvedAt: scopeLink.approvedAt,
          approvedPolicyVersion: scopeLink.approvedPolicyVersion,
          currentPolicyVersion: policy.version,
          ownerIsActiveMember,
        });
    }));
    const directPathIsLive = directPaths.some((link) =>
      !hasSensitivePolicy || isIndependentOwnerApprovalValid({
        status: link.status,
        ownerUserId: securityGroup.ownerUserId,
        attachedByUserId: link.attachedByUserId,
        approvedByUserId: link.approvedByUserId,
        approvedAt: link.approvedAt,
        approvedPolicyVersion: link.approvedPolicyVersion,
        currentPolicyVersion: policy.version,
        ownerIsActiveMember,
      }),
    );

    const sensitiveOwnerIsPrincipal = isSensitivePolicyOwner({
      principalType: subject.principalType,
      principalId: subject.principalId,
      securityGroupOwnerUserId: securityGroup.ownerUserId,
      userGroupOwnerUserIds: groupPaths.flatMap((link) => {
        const ownerUserId = userGroupById.get(link.userGroupId)?.ownerUserId;
        return ownerUserId ? [ownerUserId] : [];
      }),
    });
    for (const key of ALL_KEYS) {
      if (!policyKeys(policy.policy, catalogSection(key)).includes(key)) continue;
      if (HIGH_SENSITIVITY_KEYS.has(key) && sensitiveOwnerIsPrincipal) {
        addReason(reasons, key, "Security-group and user-group owners cannot derive their own sensitive policy access.");
        continue;
      }
      if (HIGH_SENSITIVITY_KEYS.has(key) && (!policyApprovalValid || !(groupPathIsLive || directPathIsLive))) {
        addReason(reasons, key, "High-sensitivity policy, membership, or attachment approval is missing, stale, or not owner-independent.");
        continue;
      }
      if (!(groupPathIsLive || directPathIsLive)) continue;
      allows.add(key);
      addReason(reasons, key, `Current security-group policy ${securityGroup.id}@v${policy.version} via active attachment.`);
    }
  }

  const scopePredicate = input.caseId === undefined
    ? eq(accessNamedGrants.scope, "tenant")
    : or(
      eq(accessNamedGrants.scope, "tenant"),
      and(
        eq(accessNamedGrants.scope, "case"),
        eq(accessNamedGrants.caseId, input.caseId),
      ),
    );
  const grants = batch ? batch.grants.filter(row =>
    row.principalType === subject.principalType && row.principalId === subject.principalId &&
    matchesCaseScope(row, input.caseId)
  ) : await tx.select().from(accessNamedGrants).where(and(
    eq(accessNamedGrants.organizationId, input.organizationId),
    eq(accessNamedGrants.principalType, subject.principalType),
    eq(accessNamedGrants.principalId, subject.principalId),
    scopePredicate!,
    eq(accessNamedGrants.status, "active"),
    isNull(accessNamedGrants.revokedAt),
    eq(accessNamedGrants.source, "named"),
  ));
  for (const grant of grants) {
    const key = grant.resourceKey;
    if (!knownKey(key)) continue;
    const expectedType = catalogSection(key) === "fields"
      ? "field"
      : catalogSection(key) === "flows" ? "flow" : "tool";
    if (grant.resourceType !== expectedType) continue;
    if (grant.effect === "deny") {
      denies.add(key);
      addReason(reasons, key, "Explicit named deny grant.");
      continue;
    }
    if (
      HIGH_SENSITIVITY_KEYS.has(key) &&
      (!grant.approvedByUserId || !grant.approvedAt)
    ) {
      addReason(reasons, key, "High-sensitivity named grant lacks recorded human approval.");
      continue;
    }
    allows.add(key);
    addReason(reasons, key, "Active exact-key named grant.");
  }
  return { allows, denies, reasons };
}

/**
 * Resolve the union of current security-group policy and named grants for a
 * tenant member. Agents must name an active initiating human and receive only
 * the intersection of both principals' effective permissions. Membership
 * Active named client owners/admins receive all catalog permissions in their
 * own tenant. Ordinary members still need explicit grants/policies. Legacy
 * specialist authorities and display labels never create permissions.
 *
 * `purpose` is recorded only as caller context and is not an authorization
 * input. A provided caseId must identify a case in organizationId.
 */
export async function resolveEffectiveAccess(
  input: ResolveEffectiveAccessInput,
): Promise<EffectiveAccess> {
  return db.transaction((tx) => resolveEffectiveAccessInTransaction(tx, input));
}

/** Transaction-scoped equivalent for callers already inside a DB transaction. */
export async function resolveEffectiveAccessInTransaction(
  tx: AccessGovernanceTransaction,
  input: ResolveEffectiveAccessInput,
): Promise<EffectiveAccess> {
  return evaluateEffectiveAccess(tx, input);
}

async function evaluateEffectiveAccess(
  tx: AccessGovernanceTransaction,
  input: ResolveEffectiveAccessInput,
  batch?: AccessReadBatch,
): Promise<EffectiveAccess> {
  const keys = ALL_KEYS as readonly AccessGovernanceKey[];
  const reasons = Object.fromEntries(keys.map((key) => [key, [] as string[]]));
  const allows = new Set<string>();
  if (!input.organizationId || !input.principalId) {
    for (const key of keys) reasons[key].push("Missing tenant or principal.");
    return { allows: [], reasons };
  }
  if (input.caseId !== undefined) {
    if (!Number.isSafeInteger(input.caseId) || input.caseId < 1 ||
      !(await caseBelongsToTenant(tx, input.organizationId, input.caseId, batch))) {
      for (const key of keys) reasons[key].push("Case does not belong to the requested tenant.");
      return { allows: [], reasons };
    }
    const activated = batch
      ? batch.activatedCases.has(input.caseId)
      : Boolean((await tx.select({ activation: onbCases.operationalActivation }).from(onbCases).where(and(
        eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
      )).limit(1))[0]?.activation);
    if (activated) {
      const human = input.principalType === "human" ? input.principalId : input.initiatorUserId;
      const [registration] = human ? await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
        eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID),
        eq(onbSettings.key, demoPrincipalSettingKey(human)),
      )).limit(1) : [];
      if (parseRegisteredDemoProfile(registration?.value)) {
        for (const key of keys) reasons[key].push("Activated examples contain real operational data; a shared public Demo identity cannot inherit access to those records.");
        return { allows: [], reasons };
      }
    }
  }

  if (input.principalType === "human" && isPlatformSuperAdmin(input.principalId, input.organizationId)) {
    for (const key of keys) reasons[key].push("Session-authenticated platform administrator; current request tenant verified. Independent specialist, evidence, privacy and execution safeguards still apply.");
    return { allows: [...keys], reasons };
  }

  if (input.principalType === "human" &&
    await isClientAdministratorInTransaction(tx, input.organizationId, input.principalId, batch)) {
    for (const key of keys) reasons[key].push("Active client administrator; full administrative access within this client only. Independent evidence, consent and execution safeguards still apply.");
    return { allows: [...keys], reasons };
  }

  let primary: PrincipalSubject;
  let initiator: PrincipalSubject | undefined;
  if (input.principalType === "human") {
    if (!(await isActiveHumanMember(tx, input.organizationId, input.principalId, batch))) {
      for (const key of keys) reasons[key].push("Human principal is not an active tenant member.");
      return { allows: [], reasons };
    }
    primary = { principalType: "human", principalId: input.principalId };
  } else {
    const [agent] = batch ? batch.agents : await tx.select({
      id: accessAgents.id,
      ownerUserId: accessAgents.ownerUserId,
    })
      .from(accessAgents)
      .where(and(
        eq(accessAgents.organizationId, input.organizationId),
        eq(accessAgents.id, input.principalId),
        eq(accessAgents.status, "active"),
        isNull(accessAgents.revokedAt),
      ))
      .limit(1);
    if (!agent || !(await isActiveHumanMember(tx, input.organizationId, agent.ownerUserId, batch))) {
      for (const key of keys) reasons[key].push("Agent is unknown or revoked in this tenant.");
      return { allows: [], reasons };
    }
    if (!input.initiatorUserId ||
      !(await isActiveHumanMember(tx, input.organizationId, input.initiatorUserId, batch))) {
      for (const key of keys) reasons[key].push("Agent requires an active initiating human tenant member.");
      return { allows: [], reasons };
    }
    primary = { principalType: "agent", principalId: input.principalId };
    initiator = { principalType: "human", principalId: input.initiatorUserId };
  }

  const principalCapabilities = await resolveSubjectCapabilities(tx, input, primary, batch);
  const administrativeInitiator = initiator
    ? await isClientAdministratorInTransaction(tx, input.organizationId, initiator.principalId, batch)
    : false;
  const initiatorCapabilities = initiator && administrativeInitiator
    ? { allows: new Set<string>(keys), denies: new Set<string>(),
      reasons: new Map(keys.map(key => [key, ["Initiating human is an active administrator of this client."]])) }
    : initiator
    ? await resolveSubjectCapabilities(tx, input, initiator, batch)
    : undefined;
  for (const key of keys) {
    const principalAllowed =
      principalCapabilities.allows.has(key) && !principalCapabilities.denies.has(key);
    const initiatorAllowed = initiatorCapabilities
      ? initiatorCapabilities.allows.has(key) && !initiatorCapabilities.denies.has(key)
      : true;
    const entries = [
      ...(principalCapabilities.reasons.get(key) ?? []),
      ...(initiatorCapabilities?.reasons.get(key) ?? []),
    ];
    if (principalCapabilities.denies.has(key)) entries.push("Explicit named deny overrides allows.");
    if (initiatorCapabilities?.denies.has(key)) entries.push("Initiating human has an explicit named deny.");
    if (initiator && !initiatorAllowed) entries.push("Agent access is intersected with its initiating human.");
    if (!principalAllowed) entries.push("No current governance policy or exact named grant permits this key.");
    if (input.principalType === "agent" && HUMAN_ONLY_KEYS.has(key)) {
      entries.push("This permission is human-only; agents cannot exercise it.");
    }
    if (isAccessAllowedForPrincipal({
      principalType: input.principalType,
      key,
      principalAllows: principalAllowed,
      initiatorAllows: initiatorAllowed,
    })) {
      allows.add(key);
      entries.push(initiator ? "Agent and initiating human both allow this key." : "Active tenant membership verified.");
    }
    if (!entries.length) entries.push("No current grant; historical specialist assignments are not automatically mapped.");
    reasons[key] = [...new Set(entries)];
  }
  return { allows: [...allows], reasons };
}

/**
 * Serialize a governed operation against concurrent policy/grant changes.
 * Grant/revoke/attachment writers must acquire the same tenant advisory lock.
 * The callback runs in the same transaction as the access check.
 */
export async function withAccessGovernanceFence<T>(
  input: ResolveEffectiveAccessInput,
  resourceKey: string,
  mutate: (tx: AccessGovernanceTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.organizationId}))`);
    const effective = await resolveEffectiveAccessInTransaction(tx, input);
    if (!effective.allows.includes(resourceKey)) {
      throw new AccessGovernanceDeniedError(resourceKey);
    }
    return mutate(tx);
  });
}

/** Append a governance event in the caller's transaction; rows are DB-immutable. */
export async function appendAccessGovernanceHistory(
  tx: AccessGovernanceTransaction,
  input: {
    organizationId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    actorUserId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(accessGovernanceHistory).values({
    organizationId: input.organizationId,
    eventType: input.eventType,
    entityType: input.entityType,
    entityId: input.entityId,
    actorUserId: input.actorUserId ?? null,
    detail: input.detail ?? {},
  });
}