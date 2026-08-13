import { db } from "@workspace/db";
import { onbSettings } from "@workspace/db/schema";
import { eq, sql } from "drizzle-orm";

/**
 * App-level settings persisted in the onb_settings key/value table so
 * non-technical HR staff can change them from the control tower UI
 * instead of editing environment variables.
 */

export const HR_ALERT_EMAIL_KEY = "hr_alert_email";

/** Lenient-but-sane email shape check: one @, no spaces, a dot in the domain. */
export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function getSetting(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: onbSettings.value })
    .from(onbSettings)
    .where(eq(onbSettings.key, key));
  return row?.value ?? null;
}

/** Upsert a setting; pass null to clear it (fall back to env defaults). */
export async function setSetting(key: string, value: string | null): Promise<void> {
  if (value === null) {
    await db.delete(onbSettings).where(eq(onbSettings.key, key));
    return;
  }
  await db
    .insert(onbSettings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: onbSettings.key,
      set: { value, updatedAt: sql`now()` },
    });
}
