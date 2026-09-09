import { db } from "@workspace/db";
import { onbSettings } from "@workspace/db/schema";
import { and, eq, sql } from "drizzle-orm";

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
