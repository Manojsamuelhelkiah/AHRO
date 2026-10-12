/**
 * Protected operator ceremony. Not an HTTP endpoint and never run at startup.
 * IDs must be independently confirmed with the intended account holder.
 */
import { randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { db, pool, onbSettings, DEMO_ORGANIZATION_ID } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { ADMIN_APPROVAL_KEY, approvedPrivateIdentity } from "../lib/private-platform-admin";
import { demoPrincipalSettingKey } from "../lib/demo-principal";
import { appendProtectedAudit } from "../lib/onboarding/protected-audit";

const [operation, environment, userId, expectedPrimaryEmailId, decisionRef] = process.argv.slice(2);
if (!["approve", "revoke"].includes(operation) || !["development", "production"].includes(environment) ||
  process.env.NODE_ENV !== environment || !userId?.startsWith("user_") ||
  (operation === "approve" ? !expectedPrimaryEmailId?.startsWith("idn_") : expectedPrimaryEmailId !== "-") ||
  !decisionRef?.trim() || decisionRef.length > 120) {
  throw new Error("Usage: NODE_ENV=<environment> pnpm admin:private <approve|revoke> <development|production> <confirmed-Clerk-user-id> <confirmed-primary-email-id> <private-decision-reference>");
}
// Prevent accidental approval of a test account while labeling it production.
const liveKey = process.env.CLERK_SECRET_KEY?.startsWith("sk_live_");
const testKey = process.env.CLERK_SECRET_KEY?.startsWith("sk_test_");
if ((environment === "production" && !liveKey) || (environment === "development" && !testKey)) {
  throw new Error("Clerk credential environment does not match the explicit approval environment.");
}
const lock = await pool.connect();
try {
await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [`private-platform-admin:${userId}`]);
const user = await clerkClient.users.getUser(userId);
if (operation === "approve" && user.primaryEmailAddressId !== expectedPrimaryEmailId) throw new Error("Confirmed primary identity does not match the provider account.");
const [demo] = await db.select({ value: onbSettings.value }).from(onbSettings).where(and(
  eq(onbSettings.organizationId, DEMO_ORGANIZATION_ID), eq(onbSettings.key, demoPrincipalSettingKey(userId)),
)).limit(1);
if (operation === "approve" && (demo || user.emailAddresses.some(email => email.emailAddress.toLowerCase().endsWith("@example.com")))) {
  throw new Error("Shared/demo identities cannot receive private administrator approval.");
}
const approval = {
  userId, primaryEmailId: expectedPrimaryEmailId, environment,
  generation: randomUUID(), decisionRef: decisionRef.trim(),
};
if (operation === "approve" && !approvedPrivateIdentity({
  ...user, privateMetadata: { ...user.privateMetadata, [ADMIN_APPROVAL_KEY]: approval },
}, environment)) throw new Error("Provider-verified primary email and enrolled MFA are required before approval.");

// Record the operator decision before changing provider eligibility. A failed
// provider update leaves an attempted event, never a fabricated success.
await appendProtectedAudit({
  organizationId: "platform-audit", actorId: null, actorKind: "system",
  actorAuthority: "protected-workspace-operator", action: `platform-admin.${operation}`,
  outcome: "attempted", objectType: "provider-account", objectId: userId,
  source: "protected-operator-cli", payload: { safeStatus: environment, approvalVersion: approval.generation, reasonProvided: true },
});
// Remove eligibility first so revocation fails closed even if session cleanup fails.
await clerkClient.users.updateUserMetadata(userId, { privateMetadata: { [ADMIN_APPROVAL_KEY]: null } });
for (;;) {
  const sessions = await clerkClient.sessions.getSessionList({ userId, status: "active", limit: 100 });
  if (!sessions.data.length) break;
  await Promise.all(sessions.data.map(session => clerkClient.sessions.revokeSession(session.id)));
}
if (operation === "approve") {
  await clerkClient.users.updateUserMetadata(userId, { privateMetadata: { [ADMIN_APPROVAL_KEY]: approval } });
}
await appendProtectedAudit({
  organizationId: "platform-audit", actorId: null, actorKind: "system",
  actorAuthority: "protected-workspace-operator", action: `platform-admin.${operation}`,
  outcome: "success", objectType: "provider-account", objectId: userId,
  source: "protected-operator-cli", payload: { safeStatus: environment, approvalVersion: approval.generation, reasonProvided: true },
});
console.log(`Private administrator ${operation} completed in ${environment}. All old sessions revoked; a fresh MFA sign-in is required.`);
} finally {
  await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`private-platform-admin:${userId}`]);
  lock.release();
  await pool.end();
}
