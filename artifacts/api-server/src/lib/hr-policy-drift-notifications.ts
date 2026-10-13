import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import { db, onbSettings, organizationMembershipsTable } from "@workspace/db";
import { HrPolicyError, verifiedAuthority } from "./hr-policy-library";
import { hasHumanPermissions, recordedHumanPermissionDecisionCurrent } from "./human-permissions";

const PREFERENCE_PREFIX = "policy-drift-notifications:preference:";
const NOTICE_PREFIX = "policy-drift-notifications:notice:";
type Reason = "provider-changed" | "answer-regression" | "programme-paused";
type Preference = { actor: string; enabled: boolean; authorityId: number | null; version: number; generation: string };
type Notice = {
  id: string; programmeId: string; runId: string | null; reasons: Reason[]; createdAt: string;
  generation: string; authorityId: number; acknowledged: boolean;
};
const actorKey = (actor: string) => createHash("sha256").update(actor).digest("hex");
async function read(tx: any, org: string, key: string) {
  const [row] = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, org), eq(onbSettings.key, key)));
  return row ? JSON.parse(row.value) : null;
}
async function write(tx: any, org: string, key: string, value: unknown) {
  await tx.insert(onbSettings).values({ organizationId: org, key, value: JSON.stringify(value) })
    .onConflictDoUpdate({ target: [onbSettings.organizationId, onbSettings.key], set: { value: JSON.stringify(value), updatedAt: sql`now()` } });
}
async function fence(tx: any, org: string) {
  // Same lock as programme updates: preference changes and durable delivery serialize.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`policy-evaluation:${org}`}))`);
}
async function authority(tx: any, org: string, actor: string, receiptId?: number | null) {
  try {
    if (!receiptId || !await recordedHumanPermissionDecisionCurrent(tx, org, receiptId, ["tool.policy.manage"], undefined, undefined, actor)) return null;
    return { id: receiptId };
  }
  catch (error) {
    if (error instanceof HrPolicyError && error.statusCode === 403) return null;
    throw error;
  }
}
async function member(tx: any, org: string, actor: string) {
  const [row] = await tx.select().from(organizationMembershipsTable).where(and(
    eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, actor),
    isNull(organizationMembershipsTable.revokedAt))).for("update");
  if (!row) throw new HrPolicyError("Current tenant membership is required.", 403);
}
async function inbox(tx: any, org: string, actor: string) {
  await member(tx, org, actor);
  const preference = await read(tx, org, `${PREFERENCE_PREFIX}${actorKey(actor)}`) as Preference | null;
  const grant = await authority(tx, org, actor, preference?.authorityId);
  const enabled = Boolean(preference?.enabled && grant && preference.authorityId === grant.id);
  const rows: { value: string }[] = enabled ? await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, org),
    like(onbSettings.key, `${NOTICE_PREFIX}${actorKey(actor)}:%`))).orderBy(desc(onbSettings.updatedAt)) : [];
  // Row locks prevent revocation races, but the clock can still pass a grant's
  // expiry while loading history. Reauthorize immediately before disclosure.
  const finalGrant = await authority(tx, org, actor, preference?.authorityId);
  const deliveryCurrent = Boolean(enabled && finalGrant?.id === preference?.authorityId);
  const notices = rows.map((r: { value: string }) => JSON.parse(r.value) as Notice)
    .filter((n: Notice) => deliveryCurrent && !n.acknowledged && n.generation === preference!.generation && n.authorityId === finalGrant!.id)
    .map(({ id, programmeId, runId, reasons, createdAt }: Notice) => ({ id, programmeId, runId, reasons, createdAt }));
  // verifiedAuthority locks membership and authority through the response projection.
  return { enabled: deliveryCurrent, optedIn: Boolean(preference?.enabled),
    canSubscribe: await hasHumanPermissions(tx, { organizationId: org, actorUserId: actor, requiredKeys: ["tool.policy.manage"] }),
    version: preference?.version ?? 0, notices };
}
export async function policyDriftInbox(org: string, actor: string) {
  return db.transaction(async tx => { await fence(tx, org); return inbox(tx, org, actor); });
}
export async function updatePolicyDriftInbox(org: string, actor: string, input: {
  action: "enable" | "disable" | "acknowledge"; expectedVersion: number; noticeId?: string;
}) {
  return db.transaction(async tx => {
    await fence(tx, org);
    await member(tx, org, actor);
    const key = `${PREFERENCE_PREFIX}${actorKey(actor)}`;
    const old = await read(tx, org, key) as Preference | null;
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion !== (old?.version ?? 0))
      throw new HrPolicyError("Notification preference changed; refresh.", 409);
    if (input.action === "acknowledge") {
      const grant = await authority(tx, org, actor, old?.authorityId);
      if (!old?.enabled || !grant || old.authorityId !== grant.id || !input.noticeId || !/^[a-f0-9]{64}$/.test(input.noticeId))
        throw new HrPolicyError("This notification is not available.", 409);
      const noticeKey = `${NOTICE_PREFIX}${actorKey(actor)}:${input.noticeId}`;
      const notice = await read(tx, org, noticeKey) as Notice | null;
      if (!notice || notice.generation !== old.generation || notice.authorityId !== grant.id)
        throw new HrPolicyError("This notification is not available.", 409);
      await write(tx, org, noticeKey, { ...notice, acknowledged: true });
    } else {
      const grant = input.action === "enable" ? await verifiedAuthority(tx, org, actor, "hr-compliance") : null;
      await write(tx, org, key, { actor, enabled: input.action === "enable", authorityId: grant?.id ?? null,
        version: (old?.version ?? 0) + 1, generation: randomUUID() } satisfies Preference);
    }
    return inbox(tx, org, actor);
  });
}

/** Called inside the programme's transaction. Local inbox delivery only; no provider or email calls. */
export async function deliverPolicyDriftNotice(tx: any, org: string, event: {
  programmeId: string; runId: string | null; reasons: Reason[];
}) {
  if (!event.reasons.length) return;
  await fence(tx, org);
  const preferences = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, org),
    like(onbSettings.key, `${PREFERENCE_PREFIX}%`)));
  // programme/run, not reason or current consent generation: repeated ticks cannot redeliver.
  const id = createHash("sha256").update(JSON.stringify([event.programmeId, event.runId])).digest("hex");
  for (const row of preferences) {
    const p = JSON.parse(row.value) as Preference;
    if (!p.enabled) continue;
    const grant = await authority(tx, org, p.actor, p.authorityId);
    if (!grant || grant.id !== p.authorityId) continue;
    const notice: Notice = { id, ...event, createdAt: new Date().toISOString(), generation: p.generation,
      authorityId: grant.id, acknowledged: false };
    await tx.insert(onbSettings).values({ organizationId: org, key: `${NOTICE_PREFIX}${actorKey(p.actor)}:${id}`,
      value: JSON.stringify(notice) }).onConflictDoNothing();
  }
}
