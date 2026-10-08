import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { onbCases } from "./onboarding";

const date = (name: string) => timestamp(name, { withTimezone: true });
export type VaultEvidenceBinding = { id: string; revision: number; sha256: string };

/** Employee domain: never backfilled into an organization or inferred from email. */
export const employeeVaultProfiles = pgTable("employee_vault_profiles", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  createdAt: date("created_at").notNull().defaultNow(),
});
export const employeeVaultDocuments = pgTable("employee_vault_documents", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => employeeVaultProfiles.id),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  revision: integer("revision").notNull(),
  replacesId: text("replaces_id"),
  objectPath: text("object_path").notNull().unique(),
  state: text("state").notNull().default("reserved"),
  sha256: text("sha256"),
  scanSha256: text("scan_sha256"),
  scanId: text("scan_id"),
  leaseUntil: date("lease_until"),
  holdUntil: date("hold_until"),
  policyRevision: integer("policy_revision").notNull(),
  // Legacy rows stay null and unavailable; never infer prior collection consent.
  jurisdiction: text("jurisdiction"),
  createdAt: date("created_at").notNull().defaultNow(),
  updatedAt: date("updated_at").notNull().defaultNow(),
}, t => [
  unique("vault_document_profile_id_unique").on(t.profileId, t.id),
  index("vault_document_queue_idx").on(t.state, t.leaseUntil),
]);
/** Configured only by a reviewed operator provisioning process, never tenant/employee APIs. */
export const employeeVaultPolicies = pgTable("employee_vault_policies", {
  id: text("id").primaryKey(),
  revision: integer("revision").notNull(),
  approved: boolean("approved").notNull().default(false),
  approvalReference: text("approval_reference").notNull(),
  privacyNotice: text("privacy_notice").notNull(),
  storageApproved: boolean("storage_approved").notNull().default(false),
  scannerApproved: boolean("scanner_approved").notNull().default(false),
  jurisdiction: text("jurisdiction").notNull(),
  retentionDays: integer("retention_days").notNull(),
  receiptRetentionDays: integer("receipt_retention_days").notNull(),
  expiresAt: date("expires_at").notNull(),
});
export const employeeVaultIssuers = pgTable("employee_vault_issuers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  publicKeyPem: text("public_key_pem").notNull(),
  allowedKinds: jsonb("allowed_kinds").$type<string[]>().notNull(),
  jurisdictions: jsonb("jurisdictions").$type<string[]>().notNull(),
  approvalReference: text("approval_reference").notNull(),
  approved: boolean("approved").notNull().default(false),
  expiresAt: date("expires_at").notNull(),
});
export const employeeVaultChecks = pgTable("employee_vault_checks", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => employeeVaultProfiles.id),
  kind: text("kind").notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  bindings: jsonb("bindings").$type<VaultEvidenceBinding[]>().notNull(),
  state: text("state").notNull().default("unavailable"),
  issuerId: text("issuer_id").references(() => employeeVaultIssuers.id),
  sourceReference: text("source_reference"),
  evidenceDigest: text("evidence_digest"),
  sourceSignature: text("source_signature"),
  issuerApprovalReference: text("issuer_approval_reference"),
  verifiedAt: date("verified_at"),
  expiresAt: date("expires_at"),
  createdAt: date("created_at").notNull().defaultNow(),
}, t => [index("vault_check_profile_idx").on(t.profileId), unique("vault_check_profile_id_unique").on(t.profileId, t.id)]);
export const employeeVaultAudit = pgTable("employee_vault_audit", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => employeeVaultProfiles.id),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  objectId: text("object_id").notNull(),
  createdAt: date("created_at").notNull().defaultNow(),
});
/** Employer-owned product, request, and minimal consumption metadata. */
export const employeeVaultProducts = pgTable("employee_vault_products", {
  organizationId: text("organization_id").primaryKey().references(() => organizationsTable.id),
  enabled: boolean("enabled").notNull().default(false),
  version: integer("version").notNull().default(0),
  updatedBy: text("updated_by").notNull(),
  updatedAt: date("updated_at").notNull().defaultNow(),
});
export const employeeVaultRequests = pgTable("employee_vault_requests", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  employerName: text("employer_name").notNull(),
  purpose: text("purpose").notNull(),
  scope: jsonb("scope").$type<string[]>().notNull(),
  jurisdiction: text("jurisdiction").notNull(),
  requirementsDigest: text("requirements_digest").notNull(),
  profileId: text("profile_id").references(() => employeeVaultProfiles.id),
  state: text("state").notNull().default("pending"),
  version: integer("version").notNull().default(1),
  documentIds: jsonb("document_ids").$type<string[]>().notNull().default([]),
  checkIds: jsonb("check_ids").$type<string[]>().notNull().default([]),
  bindingConfirmedBy: text("binding_confirmed_by"),
  requestedBy: text("requested_by").notNull(),
  expiresAt: date("expires_at").notNull(),
  createdAt: date("created_at").notNull().defaultNow(),
}, t => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "vault_request_case_fk" }),
  unique("vault_request_tenant_id_unique").on(t.organizationId, t.id),
  index("vault_request_case_idx").on(t.organizationId, t.caseId),
]);
export const employeeVaultReceipts = pgTable("employee_vault_receipts", {
  id: text("id").primaryKey(),
  organizationId: text("organization_id").notNull().references(() => organizationsTable.id),
  caseId: integer("case_id").notNull(),
  requestId: text("request_id").notNull(),
  requestVersion: integer("request_version").notNull(),
  requirementsDigest: text("requirements_digest").notNull(),
  checkIds: jsonb("check_ids").$type<string[]>().notNull(),
  satisfied: jsonb("satisfied").$type<string[]>().notNull(),
  consumedAt: date("consumed_at").notNull().defaultNow(),
  lastEvaluatedAt: date("last_evaluated_at").notNull().defaultNow(),
  retainUntil: date("retain_until").notNull(),
  invalidatedAt: date("invalidated_at"),
}, t => [
  foreignKey({ columns: [t.organizationId, t.caseId], foreignColumns: [onbCases.organizationId, onbCases.id], name: "vault_receipt_case_fk" }),
  foreignKey({ columns: [t.organizationId, t.requestId], foreignColumns: [employeeVaultRequests.organizationId, employeeVaultRequests.id], name: "vault_receipt_request_fk" }),
  unique("vault_receipt_generation_unique").on(t.requestId, t.requestVersion, t.requirementsDigest),
  index("employee_vault_receipts_reconciliation_idx").on(t.lastEvaluatedAt),
]);
