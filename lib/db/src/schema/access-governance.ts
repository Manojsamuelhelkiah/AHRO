import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { organizationMembershipsTable, organizationsTable } from "./organizations";
import { onbCases } from "./onboarding";

export type GovernancePrincipalType = "human" | "agent";
export type GovernanceAccessScope = "tenant" | "case";
export type GovernanceResourceType = "field" | "flow" | "tool";
export type GovernanceGrantStatus = "pending" | "active" | "rejected";

/** Named nonhuman principals are tenant-owned and never represented as users. */
export const accessAgents = pgTable("access_agents", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  ownerUserId: text("owner_user_id").notNull(),
  status: text("status").$type<"active" | "retired">().notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({
    columns: [t.organizationId, t.ownerUserId],
    foreignColumns: [organizationMembershipsTable.organizationId, organizationMembershipsTable.clerkUserId],
    name: "access_agents_owner_membership_fk",
  }),
  unique("access_agents_org_name_unique").on(t.organizationId, t.name),
  check("access_agents_status_check", sql`${t.status} in ('active', 'retired')`),
  check("access_agents_version_check", sql`${t.version} > 0`),
  index("access_agents_org_active_idx").on(t.organizationId, t.revokedAt),
]);

/** A user group may contain either or both principal kinds. */
export const accessUserGroups = pgTable("access_user_groups", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  starterId: text("starter_id"),
  ownerUserId: text("owner_user_id").notNull(),
  status: text("status").$type<"active" | "retired">().notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({
    columns: [t.organizationId, t.ownerUserId],
    foreignColumns: [organizationMembershipsTable.organizationId, organizationMembershipsTable.clerkUserId],
    name: "access_user_groups_owner_membership_fk",
  }),
  unique("access_user_groups_org_name_unique").on(t.organizationId, t.name),
  unique("access_user_groups_org_starter_unique").on(t.organizationId, t.starterId),
  check("access_user_groups_status_check", sql`${t.status} in ('active', 'retired')`),
  check("access_user_groups_version_check", sql`${t.version} > 0`),
]);

export const accessUserGroupMembers = pgTable("access_user_group_members", {
  organizationId: text("organization_id").notNull(),
  groupId: text("group_id").notNull(),
  principalType: text("principal_type").$type<GovernancePrincipalType>().notNull(),
  principalId: text("principal_id").notNull(),
  status: text("status").$type<"pending" | "active" | "revoked">().notNull().default("active"),
  version: integer("version").notNull().default(1),
  requiresApproval: text("requires_approval").$type<"yes" | "no">().notNull().default("no"),
  attachedByUserId: text("attached_by_user_id").notNull(),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedByUserId: text("revoked_by_user_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.groupId, t.principalType, t.principalId] }),
  foreignKey({
    columns: [t.organizationId, t.groupId],
    foreignColumns: [accessUserGroups.organizationId, accessUserGroups.id],
    name: "access_user_group_members_group_fk",
  }).onDelete("cascade"),
  check("access_user_group_members_principal_type_check", sql`${t.principalType} in ('human', 'agent')`),
  check("access_user_group_members_status_check", sql`${t.status} in ('pending', 'active', 'revoked')`),
  check("access_user_group_members_version_check", sql`${t.version} > 0`),
  check("access_user_group_members_requires_approval_check", sql`${t.requiresApproval} in ('yes', 'no')`),
  check("access_user_group_members_approval_pair_check", sql`
    (${t.approvedByUserId} is null and ${t.approvedAt} is null) or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)
  `),
  check("access_user_group_members_approval_required_check", sql`
    ${t.status} <> 'active' or ${t.requiresApproval} = 'no' or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedByUserId} <> ${t.attachedByUserId})
  `),
  index("access_user_group_members_principal_idx").on(t.organizationId, t.principalType, t.principalId),
]);

export const accessSecurityGroups = pgTable("access_security_groups", {
  id: text("id").notNull(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id").notNull(),
  status: text("status").$type<"active" | "retired">().notNull().default("active"),
  version: integer("version").notNull().default(1),
  createdByUserId: text("created_by_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.id] }),
  foreignKey({
    columns: [t.organizationId, t.ownerUserId],
    foreignColumns: [organizationMembershipsTable.organizationId, organizationMembershipsTable.clerkUserId],
    name: "access_security_groups_owner_membership_fk",
  }),
  unique("access_security_groups_org_name_unique").on(t.organizationId, t.name),
  check("access_security_groups_status_check", sql`${t.status} in ('active', 'retired')`),
  check("access_security_groups_version_check", sql`${t.version} > 0`),
]);

/** Policy revisions are append-only by application convention; edits insert a new version. */
export const accessSecurityGroupPolicies = pgTable("access_security_group_policies", {
  organizationId: text("organization_id").notNull(),
  securityGroupId: text("security_group_id").notNull(),
  version: integer("version").notNull(),
  policy: jsonb("policy").$type<{
    fields: string[];
    flows: string[];
    tools: string[];
  }>().notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.securityGroupId, t.version] }),
  foreignKey({
    columns: [t.organizationId, t.securityGroupId],
    foreignColumns: [accessSecurityGroups.organizationId, accessSecurityGroups.id],
    name: "access_security_group_policies_group_fk",
  }).onDelete("cascade"),
  check("access_security_group_policies_version_check", sql`${t.version} > 0`),
  check("access_security_group_policies_approval_pair_check", sql`
    (${t.approvedByUserId} is null and ${t.approvedAt} is null) or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)
  `),
  index("access_security_group_policies_current_idx").on(t.organizationId, t.securityGroupId, t.version),
]);

/** Associates security policies with a mixed-principal user group. */
export const accessSecurityGroupUserGroups = pgTable("access_security_group_user_groups", {
  organizationId: text("organization_id").notNull(),
  securityGroupId: text("security_group_id").notNull(),
  userGroupId: text("user_group_id").notNull(),
  status: text("status").$type<"active" | "revoked">().notNull().default("active"),
  version: integer("version").notNull().default(1),
  requiresApproval: text("requires_approval").$type<"yes" | "no">().notNull().default("no"),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedPolicyVersion: integer("approved_policy_version"),
  attachedByUserId: text("attached_by_user_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.organizationId, t.securityGroupId, t.userGroupId] }),
  foreignKey({
    columns: [t.organizationId, t.securityGroupId],
    foreignColumns: [accessSecurityGroups.organizationId, accessSecurityGroups.id],
    name: "access_security_group_user_groups_security_group_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.userGroupId],
    foreignColumns: [accessUserGroups.organizationId, accessUserGroups.id],
    name: "access_security_group_user_groups_user_group_fk",
  }).onDelete("cascade"),
  check("access_security_group_user_groups_status_check", sql`${t.status} in ('active', 'revoked')`),
  check("access_security_group_user_groups_version_check", sql`${t.version} > 0`),
  check("access_security_group_user_groups_requires_approval_check", sql`${t.requiresApproval} in ('yes', 'no')`),
  check("access_security_group_user_groups_approval_pair_check", sql`
    (${t.approvedByUserId} is null and ${t.approvedAt} is null and ${t.approvedPolicyVersion} is null) or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedPolicyVersion} is not null)
  `),
  check("access_security_group_user_groups_approval_required_check", sql`
    ${t.status} <> 'active' or ${t.requiresApproval} = 'no' or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedByUserId} <> ${t.attachedByUserId})
  `),
]);

/** Attach a security group to a tenant or one case; no cross-tenant case FKs. */
export const accessSecurityGroupAttachments = pgTable("access_security_group_attachments", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  securityGroupId: text("security_group_id").notNull(),
  scope: text("scope").$type<GovernanceAccessScope>().notNull(),
  caseId: integer("case_id"),
  status: text("status").$type<"active" | "pending" | "rejected" | "revoked">().notNull().default("active"),
  version: integer("version").notNull().default(1),
  requiresApproval: text("requires_approval").$type<"yes" | "no">().notNull().default("no"),
  attachedByUserId: text("attached_by_user_id").notNull(),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedPolicyVersion: integer("approved_policy_version"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  attachedAt: timestamp("attached_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.organizationId, t.securityGroupId],
    foreignColumns: [accessSecurityGroups.organizationId, accessSecurityGroups.id],
    name: "access_security_group_attachments_security_group_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "access_security_group_attachments_organization_case_fk",
  }).onDelete("cascade"),
  check("access_security_group_attachments_scope_check", sql`
    (${t.scope} = 'tenant' and ${t.caseId} is null) or
    (${t.scope} = 'case' and ${t.caseId} is not null)
  `),
  check("access_security_group_attachments_status_check", sql`${t.status} in ('active', 'pending', 'rejected', 'revoked')`),
  check("access_security_group_attachments_version_check", sql`${t.version} > 0`),
  check("access_security_group_attachments_requires_approval_check", sql`${t.requiresApproval} in ('yes', 'no')`),
  check("access_security_group_attachments_approval_pair_check", sql`
    (${t.approvedByUserId} is null and ${t.approvedAt} is null and ${t.approvedPolicyVersion} is null) or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedPolicyVersion} is not null)
  `),
  check("access_security_group_attachments_approval_required_check", sql`
    ${t.status} <> 'active' or ${t.requiresApproval} = 'no' or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedByUserId} <> ${t.attachedByUserId})
  `),
  uniqueIndex("access_security_group_attachments_tenant_unique")
    .on(t.organizationId, t.securityGroupId)
    .where(sql`${t.scope} = 'tenant'`),
  uniqueIndex("access_security_group_attachments_case_unique")
    .on(t.organizationId, t.securityGroupId, t.caseId)
    .where(sql`${t.scope} = 'case'`),
  index("access_security_group_attachments_case_idx").on(t.organizationId, t.caseId),
]);

/** Direct principal-to-policy-group assignments, independently approval-gated. */
export const accessPrincipalSecurityGroupAttachments = pgTable("access_principal_security_group_attachments", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  principalType: text("principal_type").$type<GovernancePrincipalType>().notNull(),
  principalId: text("principal_id").notNull(),
  securityGroupId: text("security_group_id").notNull(),
  scope: text("scope").$type<GovernanceAccessScope>().notNull(),
  caseId: integer("case_id"),
  status: text("status").$type<"active" | "pending" | "rejected" | "revoked">().notNull().default("pending"),
  version: integer("version").notNull().default(1),
  requiresApproval: text("requires_approval").$type<"yes" | "no">().notNull().default("yes"),
  attachedByUserId: text("attached_by_user_id").notNull(),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  approvedPolicyVersion: integer("approved_policy_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (t) => [
  foreignKey({
    columns: [t.organizationId, t.securityGroupId],
    foreignColumns: [accessSecurityGroups.organizationId, accessSecurityGroups.id],
    name: "access_principal_security_group_attachments_security_group_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "access_principal_security_group_attachments_organization_case_fk",
  }).onDelete("cascade"),
  check("access_principal_security_group_attachments_principal_type_check", sql`${t.principalType} in ('human', 'agent')`),
  check("access_principal_security_group_attachments_scope_check", sql`
    (${t.scope} = 'tenant' and ${t.caseId} is null) or
    (${t.scope} = 'case' and ${t.caseId} is not null)
  `),
  check("access_principal_security_group_attachments_status_check", sql`${t.status} in ('active', 'pending', 'rejected', 'revoked')`),
  check("access_principal_security_group_attachments_version_check", sql`${t.version} > 0`),
  check("access_principal_security_group_attachments_requires_approval_check", sql`${t.requiresApproval} in ('yes', 'no')`),
  check("access_principal_security_group_attachments_approval_pair_check", sql`
    (${t.approvedByUserId} is null and ${t.approvedAt} is null and ${t.approvedPolicyVersion} is null) or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedPolicyVersion} is not null)
  `),
  check("access_principal_security_group_attachments_approval_required_check", sql`
    ${t.status} <> 'active' or ${t.requiresApproval} = 'no' or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null and ${t.approvedByUserId} <> ${t.attachedByUserId})
  `),
  index("access_principal_security_group_attachments_lookup_idx").on(
    t.organizationId, t.principalType, t.principalId, t.status, t.revokedAt,
  ),
  uniqueIndex("access_principal_security_group_attachments_tenant_unique")
    .on(t.organizationId, t.principalType, t.principalId, t.securityGroupId)
    .where(sql`${t.scope} = 'tenant'`),
  uniqueIndex("access_principal_security_group_attachments_case_unique")
    .on(t.organizationId, t.principalType, t.principalId, t.securityGroupId, t.caseId)
    .where(sql`${t.scope} = 'case'`),
]);

/** Exact named grants only; high-sensitivity allows require human approval. */
export const accessNamedGrants = pgTable("access_named_grants", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  principalType: text("principal_type").$type<GovernancePrincipalType>().notNull(),
  principalId: text("principal_id").notNull(),
  scope: text("scope").$type<GovernanceAccessScope>().notNull(),
  caseId: integer("case_id"),
  resourceType: text("resource_type").$type<GovernanceResourceType>().notNull(),
  resourceKey: text("resource_key").notNull(),
  source: text("source").$type<"named" | "security-group">().notNull().default("security-group"),
  securityGroupId: text("security_group_id"),
  effect: text("effect").$type<"allow" | "deny">().notNull(),
  status: text("status").$type<GovernanceGrantStatus>().notNull().default("active"),
  requiresApproval: text("requires_approval").$type<"yes" | "no">().notNull().default("no"),
  createdByUserId: text("created_by_user_id").notNull(),
  approvedByUserId: text("approved_by_user_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedByUserId: text("revoked_by_user_id"),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  foreignKey({
    columns: [t.organizationId, t.caseId],
    foreignColumns: [onbCases.organizationId, onbCases.id],
    name: "access_named_grants_organization_case_fk",
  }).onDelete("cascade"),
  foreignKey({
    columns: [t.organizationId, t.securityGroupId],
    foreignColumns: [accessSecurityGroups.organizationId, accessSecurityGroups.id],
    name: "access_named_grants_security_group_fk",
  }).onDelete("cascade"),
  check("access_named_grants_principal_type_check", sql`${t.principalType} in ('human', 'agent')`),
  check("access_named_grants_scope_check", sql`
    (${t.scope} = 'tenant' and ${t.caseId} is null) or
    (${t.scope} = 'case' and ${t.caseId} is not null)
  `),
  check("access_named_grants_resource_type_check", sql`${t.resourceType} in ('field', 'flow', 'tool')`),
  check("access_named_grants_source_check", sql`${t.source} in ('named', 'security-group')`),
  check("access_named_grants_effect_check", sql`${t.effect} in ('allow', 'deny')`),
  check("access_named_grants_status_check", sql`${t.status} in ('pending', 'active', 'rejected')`),
  check("access_named_grants_approval_human_only_check", sql`
    (${t.approvedByUserId} is null and ${t.approvedAt} is null) or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)
  `),
  check("access_named_grants_requires_approval_check", sql`${t.requiresApproval} in ('yes', 'no')`),
  check("access_named_grants_approval_required_check", sql`
    ${t.status} <> 'active' or ${t.requiresApproval} = 'no' or
    (${t.approvedByUserId} is not null and ${t.approvedAt} is not null)
  `),
  index("access_named_grants_lookup_idx").on(
    t.organizationId, t.principalType, t.principalId, t.scope, t.caseId, t.status, t.revokedAt,
  ),
]);

/** Application-append-only evidence of policy, membership, attachment and grant changes. */
export const accessGovernanceHistory = pgTable("access_governance_history", {
  id: serial("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  actorUserId: text("actor_user_id"),
  detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("access_governance_history_org_created_idx").on(t.organizationId, t.createdAt),
  index("access_governance_history_entity_idx").on(t.organizationId, t.entityType, t.entityId),
]);

export type AccessAgentRow = typeof accessAgents.$inferSelect;
/** Setup metadata only; never consulted by access evaluation or dispatch. */
export const agentCatalogueBindings = pgTable("agent_catalogue_bindings", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  catalogueKey: text("catalogue_key").notNull(),
  catalogueVersion: text("catalogue_version").notNull(),
  agentId: text("agent_id").notNull(),
  principalVersion: integer("principal_version").notNull(),
  version: integer("version").notNull().default(1),
  requestId: text("request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  actorUserId: text("actor_user_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  primaryKey({ columns: [t.organizationId, t.catalogueKey] }),
  unique("agent_catalogue_bindings_principal_unique").on(t.organizationId, t.agentId),
  unique("agent_catalogue_bindings_request_unique").on(t.organizationId, t.requestId),
  foreignKey({ columns: [t.organizationId, t.agentId], foreignColumns: [accessAgents.organizationId, accessAgents.id] }),
  check("agent_catalogue_bindings_versions_check", sql`${t.version} > 0 and ${t.principalVersion} > 0`),
]);
/** Retains request identities even after explicit rebindings. */
export const agentCatalogueSetupReceipts = pgTable("agent_catalogue_setup_receipts", {
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  catalogueKey: text("catalogue_key").notNull(),
  bindingVersion: integer("binding_version").notNull(),
}, t => [primaryKey({ columns: [t.organizationId, t.requestId] })]);
export type AccessUserGroupRow = typeof accessUserGroups.$inferSelect;
export type AccessSecurityGroupPolicyRow = typeof accessSecurityGroupPolicies.$inferSelect;
export type AccessNamedGrantRow = typeof accessNamedGrants.$inferSelect;
export type AccessGovernanceHistoryRow = typeof accessGovernanceHistory.$inferSelect;