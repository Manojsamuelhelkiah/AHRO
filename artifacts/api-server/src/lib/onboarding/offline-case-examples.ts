import { templateOriginalIntent } from "./original-intent";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { isDeepStrictEqual } from "node:util";
import { db, onbCases, organizationsTable, organizationMembershipsTable, onbSettings, accessNamedGrants } from "@workspace/db";
import { OFFLINE_CASE_EXAMPLES } from "./offline-example-inventory";
import { CURATED_OFFLINE_EXAMPLES, OFFLINE_EXTENSION_EXAMPLES } from "./offline-example-extension";
import { demoPrincipalSettingKey, parseRegisteredDemoProfile } from "../demo-principal";
import { isFictionalOfflineExampleCase } from "./offline-example-display";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export const OFFLINE_EXAMPLE_CONFIRMATION = "add-60-offline-examples-to-demo";
export const OFFLINE_EXTENSION_CONFIRMATION = "extend-demo-to-ten-offline-scenarios-per-family";

export function assertOfflineExampleProvisioning(organizationId: string, confirmation: string) {
  if (organizationId !== "demo" || confirmation !== OFFLINE_EXAMPLE_CONFIRMATION) {
    throw new Error("Offline examples require the explicitly confirmed Demo workspace.");
  }
}

export async function acquireOfflineExampleInventoryLock(tx: Transaction) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('onboarding.offline-examples.additional-v1'))`);
}

/** Exact read-only grants, evaluated through the ordinary access evaluator.
 * Prior denied/revoked grants are never overwritten or revived. No sensitive
 * identity permission, edit permission, tool, or specialist authority is issued.
 */
export async function provisionOfflineExampleReadAccess(tx: Transaction, organizationId: string, confirmation: string, caseIds?: readonly number[]) {
  assertOfflineExampleProvisioning(organizationId, confirmation);
  await acquireOfflineExampleInventoryLock(tx);
  const [tenant] = await tx.select({ slug: organizationsTable.slug, name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).for("share");
  if (tenant?.slug !== "demo" || tenant.name !== "Demo Organization") {
    throw new Error("The existing Demo workspace identity could not be verified.");
  }
  const members = await tx.select({ userId: organizationMembershipsTable.clerkUserId })
    .from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, organizationId),
      isNull(organizationMembershipsTable.revokedAt),
    ));
  const registry = await tx.select().from(onbSettings).where(eq(onbSettings.organizationId, organizationId));
  const principals = members.filter(member => registry.some(setting =>
    setting.key === demoPrincipalSettingKey(member.userId) && parseRegisteredDemoProfile(setting.value) !== null));
  const cases = (await tx.select().from(onbCases).where(eq(onbCases.organizationId, organizationId)))
    .filter(row => isFictionalOfflineExampleCase(row) && (!caseIds || caseIds.includes(row.id)));
  const readKeys = ["flow.case.read", "data.case.profile.read", "data.case.notes.read", "data.case.readiness.read"];
  const existing = await tx.select().from(accessNamedGrants).where(eq(accessNamedGrants.organizationId, organizationId));
  const seen = new Set(existing.filter(grant => grant.principalType === "human" && grant.scope === "case")
    .map(grant => `${grant.principalId}:${grant.caseId}:${grant.resourceKey}`));
  const missing = principals.flatMap(member => cases.flatMap(row => readKeys
    .filter(key => !seen.has(`${member.userId}:${row.id}:${key}`))
    .map(resourceKey => ({
      organizationId,
      principalType: "human" as const,
      principalId: member.userId,
      scope: "case" as const,
      caseId: row.id,
      resourceType: resourceKey.startsWith("flow.") ? "flow" as const : "field" as const,
      resourceKey,
      source: "named" as const,
      effect: "allow" as const,
      createdByUserId: "offline-example-provisioning",
    }))));
  if (missing.length) await tx.insert(accessNamedGrants).values(missing);
  return missing.length;
}

/**
 * Narrow additive exception, not a replacement for any retired seed service.
 * No HTTP caller or startup hook. All deny fences are in the initial INSERT.
 * The single inventory lock serializes retries; a conflicting slot fails closed.
 */
export async function provisionOfflineExamplesInTransaction(tx: Transaction, organizationId: string, confirmation: string) {
  assertOfflineExampleProvisioning(organizationId, confirmation);
  await acquireOfflineExampleInventoryLock(tx);
  const [tenant] = await tx.select({ id: organizationsTable.id, slug: organizationsTable.slug, name: organizationsTable.name })
    .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).for("share");
  if (tenant?.id !== "demo" || tenant.slug !== "demo" || tenant.name !== "Demo Organization") {
    throw new Error("The existing Demo workspace identity could not be verified.");
  }
  const existing = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, organizationId),
    inArray(onbCases.scenarioKey, OFFLINE_CASE_EXAMPLES.map(item => item.key)),
  ));
  const seen = new Set<string>();
  for (const row of existing) {
    const example = OFFLINE_CASE_EXAMPLES.find(item => item.key === row.scenarioKey)!;
    if (seen.has(example.key) || Object.entries(example.values).some(([field, expected]) =>
      !isDeepStrictEqual(row[field as keyof typeof row], expected))) {
      throw new Error("An offline example slot is duplicated or has conflicting data; no records were changed.");
    }
    seen.add(example.key);
  }
  const missing = OFFLINE_CASE_EXAMPLES.filter(item => !seen.has(item.key));
  if (missing.length) await tx.insert(onbCases).values(missing.map(item => ({
    organizationId, ...item.values,
    originalIntent: templateOriginalIntent(item.values.processPolicySnapshot.batchIntake.templateId, "curated-fictional-intake"),
  })));
  const readGrantsCreated = await provisionOfflineExampleReadAccess(tx, organizationId, confirmation);
  return {
    created: missing.length,
    existing: existing.length,
    total: OFFLINE_CASE_EXAMPLES.length,
    readGrantsCreated,
    families: Object.fromEntries([...new Set(OFFLINE_CASE_EXAMPLES.map(item => item.family))].map(family => [family, 5])),
  };
}

export async function provisionDemoOfflineExamples(organizationId: string, confirmation: string) {
  assertOfflineExampleProvisioning(organizationId, confirmation);
  return db.transaction(tx => provisionOfflineExamplesInTransaction(tx, organizationId, confirmation));
}

/** Separately confirmed extension; the original inventory and command are unchanged. */
export async function provisionOfflineExtensionInTransaction(tx: Transaction, organizationId: string, confirmation: string) {
  if (organizationId !== "demo" || confirmation !== OFFLINE_EXTENSION_CONFIRMATION) {
    throw new Error("Offline extension requires the explicitly confirmed Demo workspace.");
  }
  await acquireOfflineExampleInventoryLock(tx);
  const [tenant] = await tx.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)).for("share");
  if (tenant?.slug !== "demo" || tenant.name !== "Demo Organization") {
    throw new Error("The existing Demo workspace identity could not be verified.");
  }
  // All curated identities must be unique and immutable, even in another tenant.
  // Require the original baseline rather than silently expanding the old command.
  const existing = await tx.select().from(onbCases).where(
    inArray(onbCases.scenarioKey, CURATED_OFFLINE_EXAMPLES.map(item => item.key)),
  ).for("share");
  const seen = new Set<string>();
  for (const row of existing) {
    const example = CURATED_OFFLINE_EXAMPLES.find(item => item.key === row.scenarioKey)!;
    if (row.organizationId !== organizationId || seen.has(example.key) ||
        Object.entries(example.values).some(([field, expected]) => !isDeepStrictEqual(row[field as keyof typeof row], expected))) {
      throw new Error("An offline example slot is duplicated or has conflicting data; no records were changed.");
    }
    seen.add(example.key);
  }
  if (OFFLINE_CASE_EXAMPLES.some(item => !seen.has(item.key))) {
    throw new Error("The original sixty curated Demo slots must exist before the extension; no records were changed.");
  }
  const missing = OFFLINE_EXTENSION_EXAMPLES.filter(item => !seen.has(item.key));
  if (missing.length) await tx.insert(onbCases).values(missing.map(item => ({
    organizationId, ...item.values,
    originalIntent: templateOriginalIntent(item.values.processPolicySnapshot.batchIntake.templateId, "curated-fictional-intake"),
  })));
  const readGrantsCreated = await provisionOfflineExampleReadAccess(tx, organizationId, OFFLINE_EXAMPLE_CONFIRMATION);
  return {
    created: missing.length,
    existing: OFFLINE_EXTENSION_EXAMPLES.length - missing.length,
    total: CURATED_OFFLINE_EXAMPLES.length,
    readGrantsCreated,
    families: Object.fromEntries([...new Set(CURATED_OFFLINE_EXAMPLES.map(item => item.family))]
      .map(family => [family, CURATED_OFFLINE_EXAMPLES.filter(item => item.family === family).length])),
  };
}
