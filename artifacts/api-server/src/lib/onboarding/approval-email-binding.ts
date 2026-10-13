import { clerkClient } from "@clerk/express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db, onbSettings, onbEvents, organizationMembershipsTable } from "@workspace/db";
import { isSharedDemoPrincipalInTransaction } from "../human-permissions";
import { SeparationError } from "../offboarding/model";
import { remoteMemberBindingKey } from "./decision-authority";

/** Personal verified-email opt-in. This is identity binding, never an access grant. */
export async function bindApprovalEmail(organizationId: string, actorUserId: string, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new SeparationError("Email binding must be an object.", 400);
  const body = raw as Record<string, unknown>;
  if (Object.keys(body).some(k => !["email", "enabled"].includes(k)) || typeof body.email !== "string" ||
    typeof body.enabled !== "boolean" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
    throw new SeparationError("Choose a verified email address and whether to enable replies.", 400);
  const email = body.email.trim().toLowerCase();
  if (body.enabled) {
    const users = await clerkClient.users.getUserList({ emailAddress: [email], limit: 2 });
    const owners = users.data.filter(user => user.emailAddresses.some(address =>
      address.emailAddress.toLowerCase() === email && address.verification?.status === "verified"));
    if (owners.length !== 1 || owners[0]!.id !== actorUserId)
      throw new SeparationError("Bind only your own uniquely verified sign-in email address.", 403);
  }
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`approval-email-binding:${organizationId}:${email}`}, 0))`);
    const [member] = await tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId), eq(organizationMembershipsTable.clerkUserId, actorUserId),
      isNull(organizationMembershipsTable.revokedAt),
    ));
    if (!member || await isSharedDemoPrincipalInTransaction(tx, actorUserId))
      throw new SeparationError("An active named client member is required.", 403);
    const key = remoteMemberBindingKey(email);
    const [prior] = await tx.select().from(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key))).for("update");
    if (prior && JSON.parse(prior.value).userId !== actorUserId)
      throw new SeparationError("Another member's binding cannot be replaced or withdrawn.", 403);
    if (body.enabled) {
      const value = JSON.stringify({ schema: "named-member-email/v1", userId: actorUserId, email, consentedAt: new Date().toISOString() });
      await tx.insert(onbSettings).values({ organizationId, key, value }).onConflictDoUpdate({
        target: [onbSettings.organizationId, onbSettings.key], set: { value },
      });
    } else {
      await tx.delete(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, key)));
    }
    await tx.insert(onbEvents).values({
      organizationId, caseId: null, agent: "member-settings", engine: "human", hitlPattern: "explicit-identity-consent",
      title: body.enabled ? "Member approval email binding recorded" : "Member approval email binding withdrawn",
      detail: "Identity binding does not grant approval permission or release pending work.",
    });
    return { email, enabled: body.enabled };
  });
}
