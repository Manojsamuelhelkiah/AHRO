import { db } from "@workspace/db";
import {
  onbCases,
  onbChecklistTemplates,
  onbSettings,
  type OnbChecklistTemplateItem,
  type OnbChecklistEnforcementStage,
  type OnbReadinessItemRow,
} from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * App-level settings persisted in the onb_settings key/value table so
 * non-technical HR staff can change them from the control tower UI
 * instead of editing environment variables.
 */

export const HR_ALERT_EMAIL_KEY = "hr_alert_email";

/**
 * Optional remote HR approver for demos: when set, every new pending
 * approval is emailed to this address and a reply containing
 * approve/reject from this exact sender decides it. Email is an
 * unauthenticated channel, so ONLY this address is ever trusted.
 */
export const HR_APPROVER_EMAIL_KEY = "hr_approver_email";

/**
 * Opt-in switch for automatic SLA escalation voice calls: when set to "on",
 * the System Watcher places the escalation call itself (allowlist and rate
 * limits still apply) when a check goes overdue and the hire has gone quiet.
 * Absent/any other value means off — calls must never surprise anyone.
 */
export const AUTO_ESCALATION_CALLS_KEY = "auto_escalation_calls";

export const LEGACY_CHECKLIST_VERSION = 1;
export const LEGACY_CHECKLIST: readonly OnbChecklistTemplateItem[] = [
  { id: "profile", label: "Identity, role, manager & joining date confirmed", order: 0, enabled: true, mandatory: true, enforcementStage: "before-workstreams" },
  { id: "documentation", label: "Documents, statutory forms & work authorization", order: 1, enabled: true, mandatory: true, enforcementStage: "before-day1-review" },
  { id: "payroll", label: "Payroll, bank, tax, benefits & HRIS activation", order: 2, enabled: true, mandatory: true, enforcementStage: "before-day1-review" },
  { id: "access", label: "Identity, access, applications & email/collaboration", order: 3, enabled: true, mandatory: true, enforcementStage: "before-day1-review" },
  { id: "assets", label: "Device, workspace, ID card & remote kit", order: 4, enabled: true, mandatory: true, enforcementStage: "before-day1-review" },
  { id: "learning", label: "Induction, compliance learning, buddy & manager connect", order: 5, enabled: true, mandatory: true, enforcementStage: "before-day1-review" },
  { id: "checkpoints", label: "Day-1/30/60/90 readiness checkpoints in place", order: 6, enabled: true, mandatory: true, enforcementStage: "before-day1-review" },
] as const;

const STAGES = new Set(["before-workstreams", "before-employee-communications", "before-day1-review"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const WORKSTREAM_OWNED_IDS = new Set(["documentation", "payroll", "access", "assets", "learning", "checkpoints"]);

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
  return null;
}

export async function getEffectiveChecklist(organizationId: string): Promise<{
  version: number;
  items: OnbChecklistTemplateItem[];
}> {
  const [row] = await db.select().from(onbChecklistTemplates)
    .where(eq(onbChecklistTemplates.organizationId, organizationId))
    .orderBy(desc(onbChecklistTemplates.version)).limit(1);
  return row
    ? { version: row.version, items: row.items.map((item) => ({ ...item })) }
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
): Promise<{ version: number; items: OnbChecklistTemplateItem[] }> {
  const error = validateChecklist(items);
  if (error) throw new Error(error);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${organizationId}))`);
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
    const normalized = items.map((item) => ({ ...item, label: item.label.trim() }));
    await tx.insert(onbChecklistTemplates).values({ organizationId, version, items: normalized, createdBy });
    return { version, items: normalized };
  });
}

export async function autoEscalationCallsEnabled(organizationId: string): Promise<boolean> {
  return (await getSetting(organizationId, AUTO_ESCALATION_CALLS_KEY)) === "on";
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
