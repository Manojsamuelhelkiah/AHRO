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
  onbCases,
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
    "tool.case.read", "tool.case.edit",
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
): Promise<boolean> {
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

async function caseBelongsToTenant(
  tx: AccessGovernanceTransaction,
  organizationId: string,
  caseId: number,
): Promise<boolean> {
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
): Promise<SubjectCapabilities> {
  const allows = new Set<AccessGovernanceKey>();
  const denies = new Set<AccessGovernanceKey>();
  const reasons = new Map<AccessGovernanceKey, string[]>();
  const now = new Date();
  const unexpired = (column: AnyColumn) =>
    or(isNull(column), gt(column, now))!;
  const groupMemberships = await tx.select().from(accessUserGroupMembers)
    .where(and(
      eq(accessUserGroupMembers.organizationId, input.organizationId),
      eq(accessUserGroupMembers.principalType, subject.principalType),
      eq(accessUserGroupMembers.principalId, subject.principalId),
      eq(accessUserGroupMembers.status, "active"),
      isNull(accessUserGroupMembers.revokedAt),
      unexpired(accessUserGroupMembers.expiresAt),
    ));
  const groupIds = [...new Set(groupMemberships.map((row) => row.groupId))];
  const activeUserGroups = groupIds.length
    ? await tx.select().from(accessUserGroups).where(and(
      eq(accessUserGroups.organizationId, input.organizationId),
      inArray(accessUserGroups.id, groupIds),
      eq(accessUserGroups.status, "active"),
    ))
    : [];
  const userGroupById = new Map(activeUserGroups.map((group) => [group.id, group]));
  const liveUserGroupIds: string[] = [];
  for (const group of activeUserGroups) {
    if (await isActiveHumanMember(tx, input.organizationId, group.ownerUserId)) {
      liveUserGroupIds.push(group.id);
    }
  }

  const groupLinks = liveUserGroupIds.length
    ? await tx.select().from(accessSecurityGroupUserGroups).where(and(
      eq(accessSecurityGroupUserGroups.organizationId, input.organizationId),
      inArray(accessSecurityGroupUserGroups.userGroupId, liveUserGroupIds),
      eq(accessSecurityGroupUserGroups.status, "active"),
      unexpired(accessSecurityGroupUserGroups.expiresAt),
    ))
    : [];
  const directLinks = await tx.select().from(accessPrincipalSecurityGroupAttachments).where(and(
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
  const activeSecurityGroups = securityGroupIds.length
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
  const scopedAttachments = securityGroupIds.length
    ? await tx.select().from(accessSecurityGroupAttachments).where(and(
      eq(accessSecurityGroupAttachments.organizationId, input.organizationId),
      inArray(accessSecurityGroupAttachments.securityGroupId, securityGroupIds),
      eq(accessSecurityGroupAttachments.status, "active"),
      unexpired(accessSecurityGroupAttachments.expiresAt),
      attachmentScope!,
    ))
    : [];

  for (const securityGroup of activeSecurityGroups) {
    if (!(await isActiveHumanMember(tx, input.organizationId, securityGroup.ownerUserId))) continue;
    const [policy] = await tx.select().from(accessSecurityGroupPolicies).where(and(
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
      await isActiveHumanMember(tx, input.organizationId, policy.approvedByUserId)
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
    );
    const groupPathIsLive = groupPaths.some((link) => relevantScopedAttachments.some((scopeLink) => {
      if (scopeLink.securityGroupId !== securityGroup.id) return false;
      const userGroup = userGroupById.get(link.userGroupId);
      const membership = groupMemberships.find((candidate) => candidate.groupId === link.userGroupId);
      if (!userGroup || !membership || !liveUserGroupIds.includes(userGroup.id)) return false;
      if (!hasSensitivePolicy) return true;

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
  const grants = await tx.select().from(accessNamedGrants).where(and(
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
 * roles (including owner), legacy specialist authorities, and display labels
 * never create a permission.
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
  const keys = ALL_KEYS as readonly AccessGovernanceKey[];
  const reasons = Object.fromEntries(keys.map((key) => [key, [] as string[]]));
  const allows = new Set<string>();
  if (!input.organizationId || !input.principalId) {
    for (const key of keys) reasons[key].push("Missing tenant or principal.");
    return { allows: [], reasons };
  }
  if (input.caseId !== undefined) {
    if (!Number.isSafeInteger(input.caseId) || input.caseId < 1 ||
      !(await caseBelongsToTenant(tx, input.organizationId, input.caseId))) {
      for (const key of keys) reasons[key].push("Case does not belong to the requested tenant.");
      return { allows: [], reasons };
    }
  }

  if (input.principalType === "human" && isPlatformSuperAdmin(input.principalId, input.organizationId)) {
    for (const key of keys) reasons[key].push("Session-authenticated platform administrator; current request tenant verified. Independent specialist, evidence, privacy and execution safeguards still apply.");
    return { allows: [...keys], reasons };
  }

  let primary: PrincipalSubject;
  let initiator: PrincipalSubject | undefined;
  if (input.principalType === "human") {
    if (!(await isActiveHumanMember(tx, input.organizationId, input.principalId))) {
      for (const key of keys) reasons[key].push("Human principal is not an active tenant member.");
      return { allows: [], reasons };
    }
    primary = { principalType: "human", principalId: input.principalId };
  } else {
    const [agent] = await tx.select({
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
    if (!agent || !(await isActiveHumanMember(tx, input.organizationId, agent.ownerUserId))) {
      for (const key of keys) reasons[key].push("Agent is unknown or revoked in this tenant.");
      return { allows: [], reasons };
    }
    if (!input.initiatorUserId ||
      !(await isActiveHumanMember(tx, input.organizationId, input.initiatorUserId))) {
      for (const key of keys) reasons[key].push("Agent requires an active initiating human tenant member.");
      return { allows: [], reasons };
    }
    primary = { principalType: "agent", principalId: input.principalId };
    initiator = { principalType: "human", principalId: input.initiatorUserId };
  }

  const principalCapabilities = await resolveSubjectCapabilities(tx, input, primary);
  const initiatorCapabilities = initiator
    ? await resolveSubjectCapabilities(tx, input, initiator)
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