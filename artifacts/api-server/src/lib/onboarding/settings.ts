import { db } from "@workspace/db";
import {
  onbCases,
  onbAuditHeads,
  onbChecklistTemplates,
  onbSettings,
  type OnbChecklistTemplateItem,
  type OnbChecklistEnforcementStage,
  type OnbReadinessItemRow,
} from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  parseDay1LogisticsDefault,
  SYNTHETIC_DAY1_LOGISTICS_DEFAULT,
  validateDay1LogisticsDefault,
  type Day1Logistics,
} from "./logistics-defaults";
import { UAT_RUN_SETTING_PREFIX } from "./uat-isolation";

/**
 * App-level settings persisted in the onb_settings key/value table so
 * non-technical HR staff can change them from the control tower UI
 * instead of editing environment variables.
 */

export const HR_ALERT_EMAIL_KEY = "hr_alert_email";

/** Append-only, governance-administered control policy; never derived from labels. */
export const NONWAIVABLE_SAFETY_POLICY_KEY = "nonwaivable_safety_checklist_ids";
/**
 * Optional approval-delivery address. Email decisions remain unavailable
 * unless a governance administrator separately grants the exact address to
 * the matching Clerk-verified tenant member on a current scoped assignment.
 * The delivery setting alone never authorizes a mailbox or persona.
 */
export const HR_APPROVER_EMAIL_KEY = "hr_approver_email";

/**
 * Opt-in switch for automatic SLA escalation voice calls: when set to "on",
 * the System Watcher places the escalation call itself (allowlist and rate
 * limits still apply) when a check goes overdue and the hire has gone quiet.
 * Absent/any other value means off — calls must never surprise anyone.
 */
export const AUTO_ESCALATION_CALLS_KEY = "auto_escalation_calls";
export const DAY1_LOGISTICS_DEFAULT_KEY = "day1_logistics_default";
export const CANDIDATE_LINK_RETENTION_DAYS_KEY = "candidate_link_retention_days";
export const DEFAULT_CANDIDATE_LINK_RETENTION_DAYS = 90;
export const ALLOWED_CANDIDATE_LINK_RETENTION_DAYS = [30, 90, 180, 365] as const;
export type CandidateLinkRetentionDays = typeof ALLOWED_CANDIDATE_LINK_RETENTION_DAYS[number];

/**
 * Tenant-owned connection metadata for an independently operated audit
 * archive. This deliberately contains no credential material: the adapter
 * resolves credentialSecretReferenceName in its own secret manager.
 */
export const EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY = "external_audit_archive_config";
export const EXTERNAL_AUDIT_ARCHIVE_DRILLS_KEY = "external_audit_archive_drills";
export const EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY = "external_audit_archive_generation";

export type ExternalAuditArchiveConfig = {
  providerId: string;
  archiveNamespace: string;
  retentionPolicyStatementOrReference: string;
  independentAdministratorContact: string;
  independentAdministratorRole: string;
  credentialSecretReferenceName: string;
};

const ARCHIVE_CONFIG_FIELDS = new Set([
  "providerId",
  "archiveNamespace",
  "retentionPolicyStatementOrReference",
  "independentAdministratorContact",
  "independentAdministratorRole",
  "credentialSecretReferenceName",
]);
const ARCHIVE_SECRET_FIELD = /secret|credential/i;

function archiveText(value: unknown, field: string, max = 500): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${field} is required and must be a non-empty string of at most ${max} characters.`);
  }
  return value.trim();
}

/**
 * Strict boundary parser used by organization signup and settings APIs.
 * Unknown fields are rejected so a caller cannot accidentally send a secret
 * value under a name we do not understand.
 */
export function parseExternalAuditArchiveConfig(input: unknown): ExternalAuditArchiveConfig | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("auditArchive must be an object when supplied.");
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ARCHIVE_CONFIG_FIELDS.has(key) || (ARCHIVE_SECRET_FIELD.test(key) && key !== "credentialSecretReferenceName")) {
      throw new Error(`Unsupported audit archive field "${key}". Secret values are never accepted.`);
    }
  }
  const parsed: ExternalAuditArchiveConfig = {
    providerId: archiveText(record.providerId, "providerId", 160),
    archiveNamespace: archiveText(record.archiveNamespace, "archiveNamespace", 240),
    retentionPolicyStatementOrReference: archiveText(
      record.retentionPolicyStatementOrReference,
      "retentionPolicyStatementOrReference",
      2_000,
    ),
    independentAdministratorContact: archiveText(record.independentAdministratorContact, "independentAdministratorContact", 320),
    independentAdministratorRole: archiveText(record.independentAdministratorRole, "independentAdministratorRole", 160),
    credentialSecretReferenceName: archiveText(record.credentialSecretReferenceName, "credentialSecretReferenceName", 240),
  };
  if (!/^(env:[A-Z][A-Z0-9_]*|vault:[A-Za-z0-9][A-Za-z0-9_./:-]{0,238})$/.test(parsed.credentialSecretReferenceName)) {
    throw new Error("credentialSecretReferenceName must use env:UPPER_SNAKE_NAME or vault:path reference syntax, not a secret value.");
  }
  return parsed;
}

export async function getExternalAuditArchiveConfig(
  organizationId: string,
): Promise<ExternalAuditArchiveConfig | null> {
  const stored = await getSetting(organizationId, EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY);
  if (!stored) return null;
  try {
    return parseExternalAuditArchiveConfig(JSON.parse(stored));
  } catch (error) {
    // Fail closed and visibly: invalid persisted metadata must not silently
    // select simulation or invoke an adapter with unsafe configuration.
    throw new Error(
      `Stored external audit archive configuration is invalid: ${error instanceof Error ? error.message : "invalid JSON"}`,
    );
  }
}

export type ExternalAuditArchiveDrillKind = "restore" | "legal_hold";
export type ExternalAuditArchiveDrillReceipt = {
  providerId: string;
  organizationId: string;
  configGeneration: number;
  archiveNamespace: string;
  kind: ExternalAuditArchiveDrillKind;
  passed: true;
  proof: string;
  issuedAt: string;
};
export type ExternalAuditArchiveDrill = {
  kind: ExternalAuditArchiveDrillKind;
  providerId: string;
  configGeneration: number;
  receipt: ExternalAuditArchiveDrillReceipt;
  recordedAt: string;
};

export function parseExternalAuditArchiveDrills(stored: string | null): ExternalAuditArchiveDrill[] {
  if (!stored) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new Error("Stored external audit archive drill records are invalid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("Stored external audit archive drill records must be an array.");
  return parsed.map((item, index) => {
    if (typeof item !== "object" || item === null) {
      throw new Error(`Stored external audit archive drill ${index} is invalid.`);
    }
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["kind", "providerId", "configGeneration", "receipt", "recordedAt"].includes(key))) {
      throw new Error(`Stored external audit archive drill ${index} contains unsupported fields.`);
    }
    if (record.kind !== "restore" && record.kind !== "legal_hold") {
      throw new Error(`Stored external audit archive drill ${index} has an invalid kind.`);
    }
    if (typeof record.providerId !== "string" || !record.providerId || record.providerId.length > 160 ||
      !Number.isSafeInteger(record.configGeneration) || (record.configGeneration as number) < 1 ||
      typeof record.recordedAt !== "string" || !record.recordedAt || record.recordedAt.length > 80 ||
      Number.isNaN(Date.parse(record.recordedAt))) {
      throw new Error(`Stored external audit archive drill ${index} has invalid metadata.`);
    }
    if (typeof record.receipt !== "object" || record.receipt === null) {
      throw new Error(`Stored external audit archive drill ${index} is missing its provider receipt.`);
    }
    const receipt = record.receipt as Record<string, unknown>;
    const receiptKeys = ["providerId", "organizationId", "configGeneration", "archiveNamespace", "kind", "passed", "proof", "issuedAt"];
    if (Object.keys(receipt).some((key) => !receiptKeys.includes(key)) ||
      Object.keys(receipt).length !== receiptKeys.length ||
      typeof receipt.providerId !== "string" ||
      receipt.providerId.length > 160 ||
      typeof receipt.organizationId !== "string" ||
      !receipt.organizationId ||
      receipt.organizationId.length > 200 ||
      !Number.isSafeInteger(receipt.configGeneration) ||
      (receipt.configGeneration as number) < 1 ||
      typeof receipt.archiveNamespace !== "string" ||
      receipt.archiveNamespace.length > 240 ||
      (receipt.kind !== "restore" && receipt.kind !== "legal_hold") ||
      receipt.passed !== true ||
      typeof receipt.proof !== "string" ||
      !receipt.proof ||
      receipt.proof.length > 20_000 ||
      typeof receipt.issuedAt !== "string" ||
      !receipt.issuedAt ||
      receipt.issuedAt.length > 80 ||
      Number.isNaN(Date.parse(receipt.issuedAt))) {
      throw new Error(`Stored external audit archive drill ${index} has an invalid provider receipt.`);
    }
    return {
      kind: record.kind,
      providerId: record.providerId,
      configGeneration: record.configGeneration as number,
      receipt: receipt as unknown as ExternalAuditArchiveDrillReceipt,
      recordedAt: record.recordedAt,
    };
  });
}

export async function getExternalAuditArchiveDrills(
  organizationId: string,
): Promise<ExternalAuditArchiveDrill[]> {
  return parseExternalAuditArchiveDrills(await getSetting(organizationId, EXTERNAL_AUDIT_ARCHIVE_DRILLS_KEY));
}

export async function acquireExternalAuditArchiveLock(
  tx: Pick<OnboardingDbTransaction, "execute">,
  organizationId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`external-audit-archive:${organizationId}`}, 0))`);
}

async function storedArchiveGeneration(
  tx: Pick<OnboardingDbTransaction, "select">,
  organizationId: string,
): Promise<number> {
  const [row] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY),
  ));
  const generation = row?.value ? Number(row.value) : 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Stored external audit archive generation is invalid.");
  }
  return generation;
}

export type ExternalAuditArchiveSnapshot = {
  config: ExternalAuditArchiveConfig | null;
  generation: number;
  head: typeof onbAuditHeads.$inferSelect | undefined;
};

export async function getExternalAuditArchiveSnapshot(
  organizationId: string,
): Promise<ExternalAuditArchiveSnapshot> {
  return db.transaction(async (tx) => {
    await acquireExternalAuditArchiveLock(tx, organizationId);
    return getExternalAuditArchiveSnapshotInTransaction(tx, organizationId);
  });
}

export async function getExternalAuditArchiveSnapshotInTransaction(
  tx: Pick<OnboardingDbTransaction, "select">,
  organizationId: string,
): Promise<ExternalAuditArchiveSnapshot> {
  const [configRow] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId),
    eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY),
  ));
  let config: ExternalAuditArchiveConfig | null = null;
  if (configRow?.value) {
    try {
      config = parseExternalAuditArchiveConfig(JSON.parse(configRow.value));
    } catch (error) {
      throw new Error(`Stored external audit archive configuration is invalid: ${error instanceof Error ? error.message : "invalid JSON"}`);
    }
  }
  const [head] = await tx.select().from(onbAuditHeads).where(eq(onbAuditHeads.organizationId, organizationId));
  return { config, generation: await storedArchiveGeneration(tx, organizationId), head };
}

export async function recordExternalAuditArchiveDrill(
  organizationId: string,
  drill: ExternalAuditArchiveDrill,
): Promise<void> {
  await db.transaction(async (tx) => {
    await acquireExternalAuditArchiveLock(tx, organizationId);
    const [configRow] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY),
    ));
    const [generationRow] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY),
    ));
    const config = configRow?.value ? parseExternalAuditArchiveConfig(JSON.parse(configRow.value)) : null;
    const generation = generationRow?.value ? Number(generationRow.value) : 0;
    if (!config ||
      generation !== drill.configGeneration ||
      config.providerId !== drill.providerId ||
      drill.receipt.providerId !== drill.providerId ||
      drill.receipt.organizationId !== organizationId ||
      drill.receipt.configGeneration !== generation ||
      drill.receipt.archiveNamespace !== config.archiveNamespace ||
      drill.receipt.kind !== drill.kind ||
      drill.receipt.passed !== true) {
      throw new Error("A passed drill must be recorded against the current configured tenant provider generation.");
    }
    const [existingRow] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_DRILLS_KEY),
    ));
    const existing = parseExternalAuditArchiveDrills(existingRow?.value ?? null);
    if (existing.some((item) =>
      item.kind === drill.kind &&
      item.providerId === drill.providerId &&
      item.configGeneration === generation
    )) {
      throw new Error(`A ${drill.kind} drill is already recorded for this provider generation.`);
    }
    await tx.insert(onbSettings).values({
      organizationId,
      key: EXTERNAL_AUDIT_ARCHIVE_DRILLS_KEY,
      value: JSON.stringify([...existing, drill]),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: JSON.stringify([...existing, drill]), updatedAt: sql`now()` },
    });
  });
}

export async function saveExternalAuditArchiveConfig(
  organizationId: string,
  input: unknown,
): Promise<ExternalAuditArchiveConfig | null> {
  const config = parseExternalAuditArchiveConfig(input);
  await db.transaction(async (tx) => {
    await acquireExternalAuditArchiveLock(tx, organizationId);
    const generation = (await storedArchiveGeneration(tx, organizationId)) + 1;
    if (config) {
      await tx.insert(onbSettings).values({
        organizationId,
        key: EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY,
        value: JSON.stringify(config),
      }).onConflictDoUpdate({
        target: [onbSettings.organizationId, onbSettings.key],
        set: { value: JSON.stringify(config), updatedAt: sql`now()` },
      });
    } else {
      await tx.delete(onbSettings).where(and(
        eq(onbSettings.organizationId, organizationId),
        eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_CONFIG_KEY),
      ));
    }
    await tx.insert(onbSettings).values({
      organizationId,
      key: EXTERNAL_AUDIT_ARCHIVE_GENERATION_KEY,
      value: String(generation),
    }).onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value: String(generation), updatedAt: sql`now()` },
    });
    // Drill receipts are bound to the previous provider and namespace. Never
    // carry them across a config replacement or clear operation.
    await tx.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, EXTERNAL_AUDIT_ARCHIVE_DRILLS_KEY),
    ));
  });
  return config;
}

export function isAllowedCandidateLinkRetentionDays(value: unknown): value is CandidateLinkRetentionDays {
  return typeof value === "number"
    && Number.isInteger(value)
    && ALLOWED_CANDIDATE_LINK_RETENTION_DAYS.includes(value as CandidateLinkRetentionDays);
}

export async function getCandidateLinkRetentionDays(
  organizationId: string,
): Promise<CandidateLinkRetentionDays> {
  const stored = await getSetting(organizationId, CANDIDATE_LINK_RETENTION_DAYS_KEY);
  const parsed = stored === null ? NaN : Number(stored);
  return isAllowedCandidateLinkRetentionDays(parsed)
    ? parsed
    : DEFAULT_CANDIDATE_LINK_RETENTION_DAYS;
}

export const LEGACY_CHECKLIST_VERSION = 1;
export const LEGACY_CHECKLIST: readonly OnbChecklistTemplateItem[] = [
  { id: "profile", label: "Identity, role, manager & joining date confirmed", order: 0, enabled: true, mandatory: true, enforcementStage: "before-workstreams", nonWaivableSafety: false },
  { id: "documentation", label: "Documents, statutory forms & work authorization", order: 1, enabled: true, mandatory: true, enforcementStage: "before-day1-review", nonWaivableSafety: false },
  { id: "payroll", label: "Payroll, bank, tax, benefits & HRIS activation", order: 2, enabled: true, mandatory: true, enforcementStage: "before-day1-review", nonWaivableSafety: false },
  { id: "access", label: "Identity, access, applications & email/collaboration", order: 3, enabled: true, mandatory: true, enforcementStage: "before-day1-review", nonWaivableSafety: false },
  { id: "assets", label: "Device, workspace, ID card & remote kit", order: 4, enabled: true, mandatory: true, enforcementStage: "before-day1-review", nonWaivableSafety: false },
  { id: "learning", label: "Induction, compliance learning, buddy & manager connect", order: 5, enabled: true, mandatory: true, enforcementStage: "before-day1-review", nonWaivableSafety: false },
  { id: "checkpoints", label: "Day-1/30/60/90 readiness checkpoints in place", order: 6, enabled: true, mandatory: true, enforcementStage: "before-day1-review", nonWaivableSafety: false },
] as const;

const STAGES = new Set(["before-workstreams", "before-employee-communications", "before-day1-review"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WORKSTREAM_OWNED_IDS = new Set(["documentation", "payroll", "access", "assets", "learning", "checkpoints"]);
const STAGE_ORDER: Record<string, number> = {
  "before-workstreams": 0,
  "before-employee-communications": 1,
  "before-day1-review": 2,
};

export function validateChecklist(items: OnbChecklistTemplateItem[]): string | null {
  if (items.length < 1 || items.length > 100) return "Checklist must contain between 1 and 100 items.";
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const item of items) {
    if (!ID_PATTERN.test(item.id)) return `Checklist item id "${item.id}" must be a stable lowercase identifier.`;
    if (ids.has(item.id)) return `Duplicate checklist item id "${item.id}".`;
    ids.add(item.id);
    if (!item.label.trim() || item.label.trim().length > 200) return `Checklist item "${item.id}" needs a label of 1–200 characters.`;
    if (!Number.isInteger(item.order) || item.order < 0) return `Checklist item "${item.id}" has an invalid order.`;
    if (orders.has(item.order)) return `Duplicate checklist order ${item.order}.`;
    orders.add(item.order);
    if (!STAGES.has(item.enforcementStage)) return `Checklist item "${item.id}" has an invalid enforcement stage.`;
    if (
      item.enabled &&
      item.mandatory &&
      item.enforcementStage === "before-workstreams" &&
      WORKSTREAM_OWNED_IDS.has(item.id)
    ) {
      return `System-managed checklist item "${item.id}" cannot block before workstreams because its status is produced by those workstreams.`;
    }
  }
  const sorted = [...orders].sort((a, b) => a - b);
  if (sorted.some((order, index) => order !== index)) return "Checklist order must be contiguous and start at 0.";
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    if (!item.enabled) continue;
    for (const prerequisiteId of item.prerequisites ?? []) {
      if (prerequisiteId === item.id) return `Checklist item "${item.id}" cannot depend on itself.`;
      const prerequisite = byId.get(prerequisiteId);
      if (!prerequisite) return `Checklist item "${item.id}" has unknown prerequisite "${prerequisiteId}".`;
      if (!prerequisite.enabled) return `Checklist item "${item.id}" depends on disabled prerequisite "${prerequisiteId}".`;
      if (prerequisite.order >= item.order) return `Checklist prerequisite "${prerequisiteId}" must be earlier than "${item.id}".`;
      if (STAGE_ORDER[prerequisite.enforcementStage] > STAGE_ORDER[item.enforcementStage]) {
        return `Checklist prerequisite "${prerequisiteId}" cannot be enforced later than "${item.id}".`;
      }
    }
  }
  return null;
}

function parseRestrictedSafetyIds(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string" && ID_PATTERN.test(id))
      ? new Set(parsed)
      : new Set();
  } catch { return new Set(); }
}
export async function getEffectiveChecklist(
  organizationId: string,
  client: ChecklistReadClient = db,
): Promise<{
  version: number;
  items: OnbChecklistTemplateItem[];
}> {
  const [row] = await client.select().from(onbChecklistTemplates)
    .where(eq(onbChecklistTemplates.organizationId, organizationId))
    .orderBy(desc(onbChecklistTemplates.version)).limit(1);
  return row
    ? { version: row.version, items: row.items.map((item) => ({ ...item, nonWaivableSafety: item.nonWaivableSafety === true })) }
    : { version: LEGACY_CHECKLIST_VERSION, items: LEGACY_CHECKLIST.map((item) => ({ ...item })) };
}

export function readinessFromChecklist(items: readonly OnbChecklistTemplateItem[]): OnbReadinessItemRow[] {
  return items.filter((item) => item.enabled).sort((a, b) => a.order - b.order).map((item) => ({
    key: item.id,
    id: item.id,
    label: item.label,
    status: "pending",
    order: item.order,
    mandatory: item.mandatory,
    enforcementStage: item.enforcementStage,
    evidenceRequired: item.evidenceRequired,
    responsibleRole: item.responsibleRole,
    completionAuthority: item.completionAuthority,
    executor: item.executor,
    prerequisites: item.prerequisites,
  }));
}

export function mandatoryChecklistReady(
  c: Pick<typeof onbCases.$inferSelect, "checklistSnapshot" | "readiness">,
): boolean {
  const snapshot = c.checklistSnapshot.length ? c.checklistSnapshot : LEGACY_CHECKLIST;
  const status = new Map(c.readiness.map((item) => [item.key, item.status]));
  return snapshot.every(
    (item) => !item.enabled || !item.mandatory || status.get(item.id) === "ready",
  );
}

export function checklistStageBlockers(
  c: Pick<typeof onbCases.$inferSelect, "checklistSnapshot" | "readiness">,
  stage: OnbChecklistEnforcementStage,
): OnbChecklistTemplateItem[] {
  const snapshot = c.checklistSnapshot.length ? c.checklistSnapshot : LEGACY_CHECKLIST;
  const status = new Map(c.readiness.map((item) => [item.key, item.status]));
  return snapshot.filter(
    (item) =>
      item.enabled &&
      item.mandatory &&
      item.enforcementStage === stage &&
      status.get(item.id) !== "ready",
  );
}

export async function saveChecklistVersion(
  organizationId: string,
  expectedVersion: number,
  items: OnbChecklistTemplateItem[],
  createdBy: string,
  validateLockedPolicy?: (tx: OnboardingDbTransaction) => Promise<void>,
): Promise<{ version: number; items: OnbChecklistTemplateItem[] }> {
  const error = validateChecklist(items);
  if (error) throw new Error(error);
  return db.transaction(async (tx) => {
    await acquireChecklistPolicyLock(tx, organizationId);
    await validateLockedPolicy?.(tx);
    const [latest] = await tx.select({
      version: onbChecklistTemplates.version,
      items: onbChecklistTemplates.items,
    })
      .from(onbChecklistTemplates)
      .where(eq(onbChecklistTemplates.organizationId, organizationId))
      .orderBy(desc(onbChecklistTemplates.version)).limit(1);
    const currentVersion = latest?.version ?? LEGACY_CHECKLIST_VERSION;
    if (expectedVersion !== currentVersion) {
      const conflict = new Error(`Checklist changed since it was loaded (current version ${currentVersion}).`);
      conflict.name = "ChecklistVersionConflict";
      throw conflict;
    }
    const previousItems = latest?.items ?? LEGACY_CHECKLIST;
    const nextIds = new Set(items.map((item) => item.id));
    const removed = previousItems.find((item) => !nextIds.has(item.id));
    if (removed) {
      throw new Error(`Checklist item "${removed.id}" cannot be deleted; disable it so existing identity and history remain stable.`);
    }
    const version = currentVersion + 1;
    const [policy] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, NONWAIVABLE_SAFETY_POLICY_KEY),
    )).for("update");
    const protectedIds = parseRestrictedSafetyIds(policy?.value ?? null);
    const priorPolicy = new Map(previousItems.map((item) => [item.id, item.nonWaivableSafety === true]));
    // This policy is deliberately not accepted from editable profile input.
    // Existing protected IDs retain their bit; newly configured IDs default
    // false and require a separately governed data-policy change to become
    // protected.
    const normalized = items.map((item) => {
      const nonWaivableSafety = priorPolicy.get(item.id) === true || protectedIds.has(item.id);
      return {
        ...item, label: item.label.trim(), nonWaivableSafety,
        // Template editors cannot turn a protected control off or optional.
        enabled: nonWaivableSafety ? true : item.enabled,
        mandatory: nonWaivableSafety ? true : item.mandatory,
      };
    });
    await tx.insert(onbChecklistTemplates).values({ organizationId, version, items: normalized, createdBy });
    return { version, items: normalized };
  });
}

export async function autoEscalationCallsEnabled(organizationId: string): Promise<boolean> {
  return (await getSetting(organizationId, AUTO_ESCALATION_CALLS_KEY)) === "on";
}

export async function getDay1LogisticsDefault(organizationId: string): Promise<Day1Logistics> {
  const stored = await getSetting(organizationId, DAY1_LOGISTICS_DEFAULT_KEY);
  return stored
    ? parseDay1LogisticsDefault(stored)
    : { ...SYNTHETIC_DAY1_LOGISTICS_DEFAULT };
}

export async function setDay1LogisticsDefault(
  organizationId: string,
  input: unknown,
): Promise<Day1Logistics> {
  const logistics = validateDay1LogisticsDefault(input);
  await setSetting(organizationId, DAY1_LOGISTICS_DEFAULT_KEY, JSON.stringify(logistics));
  return logistics;
}

/** Lenient-but-sane email shape check: one @, no spaces, a dot in the domain. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function getSetting(organizationId: string, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: onbSettings.value })
    .from(onbSettings)
    .where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key)));
  return row?.value ?? null;
}

/** Upsert a setting; pass null to clear it (fall back to env defaults). */
export async function setSetting(organizationId: string, key: string, value: string | null): Promise<void> {
  if (key.startsWith(UAT_RUN_SETTING_PREFIX)) {
    throw new Error("UAT run ownership is server-managed and cannot be changed or deleted through settings.");
  }
  if (value === null) {
    await db.delete(onbSettings).where(and(
      eq(onbSettings.organizationId, organizationId),
      eq(onbSettings.key, key),
    ));
    return;
  }
  await db
    .insert(onbSettings)
    .values({ organizationId, key, value })
    .onConflictDoUpdate({
      target: [onbSettings.organizationId, onbSettings.key],
      set: { value, updatedAt: sql`now()` },
    });
}

export type OnboardingDbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function acquireChecklistPolicyLock(
  tx: Pick<OnboardingDbTransaction, "execute">,
  organizationId: string,
): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`checklist-policy:${organizationId}`}))`);
}

type ChecklistReadClient = Pick<typeof db, "select">;
