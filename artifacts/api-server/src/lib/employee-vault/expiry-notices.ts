import { randomUUID } from "node:crypto";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import {
  db, employeeVaultProfiles as profiles, employeeVaultChecks as checks,
  employeeVaultRequests as requests, employeeVaultProducts as products,
  employeeVaultExpiryNotices as notices,
} from "@workspace/db";
import { fail, vaultWrite, type VaultTx } from "./core";

export const NOTICE_LEAD_MS = 7 * 86400000;
const checkLabels: Record<string, string> = {
  identity: "Identity check", criminal: "Criminal check", employment: "Employment check",
  education: "Education check", address: "Address check", sanctions: "Sanctions check",
  reference: "Reference check", medical: "Medical check",
};
export function expiryIsSoon(expiry: Date | null, now = new Date()) {
  return !!expiry && expiry > now && expiry.getTime() <= now.getTime() + NOTICE_LEAD_MS;
}

async function lockedProfile(tx: VaultTx, profileId: string, userId?: string) {
  const [p] = await tx.select().from(profiles).where(and(
    eq(profiles.id, profileId), userId ? eq(profiles.userId, userId) : undefined,
  )).for("update");
  return p;
}

async function enqueue(tx: VaultTx, profileId: string) {
  const now = new Date(), end = new Date(now.getTime() + NOTICE_LEAD_MS);
  const [dueChecks, dueGrants] = await Promise.all([
    tx.select().from(checks).where(and(eq(checks.profileId, profileId),
      eq(checks.state, "clear"), gt(checks.expiresAt, now), lte(checks.expiresAt, end))),
    tx.select({ grant: requests }).from(requests).innerJoin(products, eq(products.organizationId, requests.organizationId))
      .where(and(eq(requests.profileId, profileId), eq(requests.state, "approved"), eq(products.enabled, true),
        gt(requests.expiresAt, now), lte(requests.expiresAt, end))),
  ]);
  const rows = [
    ...dueChecks.map(c => ({ targetType: "check", targetId: c.id, targetVersion: 0, expiresAt: c.expiresAt! })),
    ...dueGrants.map(({ grant: r }) => ({ targetType: "grant", targetId: r.id, targetVersion: r.version, expiresAt: r.expiresAt })),
  ];
  if (rows.length) await tx.insert(notices).values(rows.map(r => ({ ...r, id: randomUUID(), profileId })))
    .onConflictDoNothing();
}

/**
 * Local inbox delivery is transactional and idempotent: no remote message is
 * sent, so there is no ambiguous provider write to reclaim in the effect journal.
 * Retries discover missing generations; the unique key keeps existing/dismissed
 * notices unchanged. User identity and preference are re-read under a row lock.
 */
export async function getExpiryInbox(profileId: string, userId: string) {
  return vaultWrite({ profileId, withdrawal: true }, async tx => {
    const p = await lockedProfile(tx, profileId, userId);
    if (!p) return fail(404, "Vault unavailable.");
    if (!p.expiryNoticesEnabled) return { expiryNoticesEnabled: false, expiryNotices: [] };
    await enqueue(tx, p.id);
    const stored = await tx.select().from(notices).where(and(eq(notices.profileId, p.id), isNull(notices.dismissedAt),
      gt(notices.expiresAt, new Date()))).orderBy(notices.expiresAt);
    const visible: { id: string; targetType: "check" | "grant"; label: string; expiresAt: string }[] = [];
    for (const n of stored) {
      if (!expiryIsSoon(n.expiresAt)) continue;
      if (n.targetType === "check") {
        const [c] = await tx.select().from(checks).where(and(eq(checks.id, n.targetId), eq(checks.profileId, p.id)));
        if (!c || c.state !== "clear" || c.expiresAt?.getTime() !== n.expiresAt.getTime()) continue;
        visible.push({ id: n.id, targetType: "check", label: `${checkLabels[c.kind] ?? "Verification check"} (${c.id})`, expiresAt: n.expiresAt.toISOString() });
      } else if (n.targetType === "grant") {
        const [r] = await tx.select({ grant: requests }).from(requests)
          .innerJoin(products, eq(products.organizationId, requests.organizationId))
          .where(and(eq(requests.id, n.targetId), eq(requests.profileId, p.id), eq(products.enabled, true)));
        if (!r || r.grant.state !== "approved" || r.grant.version !== n.targetVersion ||
          r.grant.expiresAt.getTime() !== n.expiresAt.getTime()) continue;
        // Free-text employer fields can contain findings or credential URLs.
        // Identify the grant using only its server-issued identifier.
        visible.push({ id: n.id, targetType: "grant", label: `Employer sharing grant ${r.grant.id}`, expiresAt: n.expiresAt.toISOString() });
      }
    }
    return { expiryNoticesEnabled: true, expiryNotices: visible };
  });
}

/** This independent preference never needs employer membership/processing authority. */
export async function setExpiryPreference(profileId: string, userId: string, enabled: boolean) {
  return db.transaction(async tx => {
    if (!await lockedProfile(tx, profileId, userId)) return fail(404, "Vault unavailable.");
    await tx.update(profiles).set({ expiryNoticesEnabled: enabled }).where(eq(profiles.id, profileId));
    return { enabled };
  });
}
export async function dismissExpiryNotice(profileId: string, userId: string, id: string) {
  await db.transaction(async tx => {
    if (!await lockedProfile(tx, profileId, userId)) return fail(404, "Vault unavailable.");
    const rows = await tx.update(notices).set({ dismissedAt: new Date() })
      .where(and(eq(notices.id, id), eq(notices.profileId, profileId))).returning({ id: notices.id });
    if (!rows.length) fail(404, "Notice unavailable.");
  });
}

/** Bounded fair sweep skips generations already outboxed, including dismissed ones. */
export async function runExpiryNoticeTick(profileId?: string) {
  const now = new Date(), end = new Date(now.getTime() + NOTICE_LEAD_MS);
  const due = await db.select({ id: profiles.id }).from(profiles).where(and(
    eq(profiles.expiryNoticesEnabled, true), profileId ? eq(profiles.id, profileId) : undefined,
    sql`(
      exists (select 1 from employee_vault_checks c where c.profile_id = ${profiles.id}
        and c.state = 'clear' and c.expires_at > ${now} and c.expires_at <= ${end}
        and not exists (select 1 from employee_vault_expiry_notices n where n.profile_id = c.profile_id
          and n.target_type = 'check' and n.target_id = c.id and n.target_version = 0 and n.expires_at = c.expires_at))
      or exists (select 1 from employee_vault_requests r join employee_vault_products p on p.organization_id = r.organization_id
        where r.profile_id = ${profiles.id} and r.state = 'approved' and p.enabled = true
        and r.expires_at > ${now} and r.expires_at <= ${end}
        and not exists (select 1 from employee_vault_expiry_notices n where n.profile_id = r.profile_id
          and n.target_type = 'grant' and n.target_id = r.id and n.target_version = r.version and n.expires_at = r.expires_at))
    )`,
  )).orderBy(profiles.id).limit(20);
  for (const p of due) await vaultWrite({ profileId: p.id, withdrawal: true }, async tx => {
    const current = await lockedProfile(tx, p.id);
    if (current?.expiryNoticesEnabled) await enqueue(tx, current.id);
  });
}
