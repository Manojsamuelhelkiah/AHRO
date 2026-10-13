import assert from "node:assert/strict";
import { after, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db, onbCases, onbDocuments, onbCandidateLinks, onbCandidateSessions,
  onbSettings, organizationMembershipsTable, accessNamedGrants,
} from "@workspace/db";
import { resolveEffectiveAccess, resolveEffectiveAccessForCases } from "../access-governance";
import { demoPrincipalSettingKey } from "../demo-principal";
import { recordHumanPermissionDecision } from "../human-permissions";
import { PREPARATION_EDIT_KEYS } from "./offline-preparation";
import { operationalEligibilityInTransaction, operationalWorkflowHasStarted,
  operationalCandidateEmailEligible } from "./operational-eligibility";
import { CURATED_OFFLINE_EXAMPLES } from "./offline-example-extension";
import { canonicalIntakeHash } from "./hro-batch-templates";
import {
  HISTORICAL_CHILD_KINDS, activationRecord, currentOperationalRecordSql,
  operationalIdentityFingerprint, evidenceBelongsToOperationalGeneration,
} from "./operational-eligibility";

// Must run through run-tests.mjs's owned schema. The original candidate tokens
// are hashes only, and no provider, email, public fixture or workflow is used.
const organizationId = "demo";
let caseId: number;
const shared = "owned-generation-shared-demo";
const named = "owned-generation-named-reader";

after(async () => {
  if (!caseId) return;
  await db.delete(onbCandidateSessions).where(and(eq(onbCandidateSessions.organizationId, organizationId), eq(onbCandidateSessions.caseId, caseId)));
  await db.delete(onbCandidateLinks).where(and(eq(onbCandidateLinks.organizationId, organizationId), eq(onbCandidateLinks.caseId, caseId)));
  await db.delete(onbDocuments).where(and(eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId)));
  await db.delete(onbCases).where(and(eq(onbCases.organizationId, organizationId), eq(onbCases.id, caseId)));
  await db.delete(onbSettings).where(and(eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, demoPrincipalSettingKey(shared))));
  await db.delete(accessNamedGrants).where(and(eq(accessNamedGrants.organizationId, organizationId), inArray(accessNamedGrants.principalId, [shared, named])));
  await db.delete(organizationMembershipsTable).where(and(eq(organizationMembershipsTable.organizationId, organizationId),
    inArray(organizationMembershipsTable.clerkUserId, [shared, named])));
});

test("future-dated original records and previous generations never become live evidence", async () => {
  const source = CURATED_OFFLINE_EXAMPLES[0]!;
  const [original] = await db.insert(onbCases).values({
    ...source.values, organizationId,
  }).returning();
  assert.ok(original);
  caseId = original.id;
  for (const principal of [shared, named]) {
    await db.insert(organizationMembershipsTable).values({ organizationId, clerkUserId: principal, role: "member" });
    await db.insert(accessNamedGrants).values({
      organizationId, principalType: "human", principalId: principal, scope: "tenant",
      resourceType: "flow", resourceKey: "flow.case.read", source: "named", effect: "allow", status: "active",
      createdByUserId: "owned-independent-reviewer", approvedByUserId: "owned-independent-reviewer", approvedAt: new Date(),
    });
  }
  await db.insert(onbSettings).values({ organizationId, key: demoPrincipalSettingKey(shared), value: "reviewer" });
  assert.ok((await resolveEffectiveAccess({
    organizationId, principalType: "human", principalId: shared, caseId,
  })).allows.includes("flow.case.read"));
  const future = new Date(Date.now() + 86_400_000);
  const [oldDocument] = await db.insert(onbDocuments).values({
    organizationId, caseId, key: "original-file", label: "Fictional original", category: "identity",
    createdAt: future,
  }).returning();
  const [oldLink] = await db.insert(onbCandidateLinks).values({
    organizationId, caseId, tokenHash: "owned-original-token-hash", issuedBy: "fixture",
    createdAt: future, expiresAt: future,
  }).returning();
  const [oldSession] = await db.insert(onbCandidateSessions).values({
    organizationId, caseId, idHash: "owned-original-session-hash", linkId: oldLink!.id,
    createdAt: future, expiresAt: future,
  }).returning();
  const retainedRecords = Object.fromEntries(HISTORICAL_CHILD_KINDS.map(kind => [kind, []])) as
    Record<string, unknown[]>;
  retainedRecords.documents = [oldDocument!];
  retainedRecords.candidateLinks = [oldLink!];
  retainedRecords.candidateSessions = [oldSession!];
  const start = new Date();
  const current = {
    ...original, workerName: "Actual authorized worker", workerEmail: "worker@verified-workforce.org",
    workerPhone: null,
  };
  for (const key of PREPARATION_EDIT_KEYS.filter(key => key !== "flow.case.read")) {
    await db.insert(accessNamedGrants).values({
      organizationId, principalType: "human", principalId: named, scope: "tenant",
      resourceType: key.startsWith("flow.") ? "flow" : "field", resourceKey: key,
      source: "named", effect: "allow", status: "active", createdByUserId: "owned-independent-reviewer",
      approvedByUserId: "owned-independent-reviewer", approvedAt: start,
    });
  }
  const receipt = await db.transaction(tx => recordHumanPermissionDecision(tx, {
    organizationId, caseId, actorUserId: named, requiredKeys: PREPARATION_EDIT_KEYS,
    reviewedRevision: 1, evidenceGeneration: 1, decision: "isolated-activation-binding",
  }));
  const activation = {
    schema: "offline-case-activation/v1" as const,
    organizationId, caseId, sourceKey: source.key,
    sourceFingerprint: canonicalIntakeHash(source.values),
    sourceSnapshot: JSON.parse(JSON.stringify({ ...original, retainedRecords })),
    generation: "11111111-1111-4111-8111-111111111111",
    activatedAt: start.toISOString(), generationStartedAt: start.toISOString(),
    activatedByUserId: named, preparationRevision: 1,
    permissionDecisionId: receipt.id, identityFingerprint: operationalIdentityFingerprint(current),
    policyFingerprint: canonicalIntakeHash({ workforceContext: current.workforceContext,
      processPolicySnapshot: current.processPolicySnapshot }), previousGenerations: [],
  };
  const [activated] = await db.update(onbCases).set({
    workerName: current.workerName, workerEmail: current.workerEmail,
    operationalActivation: activation,
    operationalPreparation: {
      schema: "offline-case-preparation/v1", organizationId, caseId, sourceKey: source.key,
      sourceFingerprint: activation.sourceFingerprint, revision: 1, templateId: "joiners-standard-onboarding",
      templateVersion: 1, data: { employee_name: current.workerName, employee_email: current.workerEmail },
      updatedByUserId: named, updatedAt: start.toISOString(),
    },
  }).where(eq(onbCases.id, caseId)).returning();
  assert.ok(activationRecord(activated!));
  assert.equal(operationalWorkflowHasStarted(activated!), false);
  assert.equal(operationalCandidateEmailEligible(activated!), true, "valid actual contact is separate from original fictional provenance");
  assert.deepEqual(await db.transaction(tx => operationalEligibilityInTransaction(tx, activated!)),
    { allowed: true, reason: null });
  const beforeStart = await db.transaction(tx => operationalEligibilityInTransaction(tx, activated!, { requireStarted: true }));
  assert.equal(beforeStart.allowed, false);
  assert.match(beforeStart.reason!, /Start the operational workflow explicitly/);
  const revokeKey = "data.bgv.read";
  await db.update(accessNamedGrants).set({ status: "rejected" }).where(and(
    eq(accessNamedGrants.organizationId, organizationId), eq(accessNamedGrants.principalId, named),
    eq(accessNamedGrants.resourceKey, revokeKey),
  ));
  assert.equal((await db.transaction(tx => operationalEligibilityInTransaction(tx, activated!))).allowed, false,
    "revocation must pause operation even though the activation metadata remains valid");
  await db.update(accessNamedGrants).set({ status: "active" }).where(and(
    eq(accessNamedGrants.organizationId, organizationId), eq(accessNamedGrants.principalId, named),
    eq(accessNamedGrants.resourceKey, revokeKey),
  ));
  for (const resolve of [
    () => resolveEffectiveAccess({ organizationId, principalType: "human", principalId: shared, caseId }),
    async () => (await resolveEffectiveAccessForCases({ organizationId, principalType: "human", principalId: shared }, [caseId])).get(caseId)!,
  ]) assert.deepEqual((await resolve()).allows, [], "shared Demo must not inherit real worker access");
  assert.ok((await resolveEffectiveAccess({ organizationId, principalType: "human", principalId: named, caseId }))
    .allows.includes("flow.case.read"), "current named access is unaffected");
  const [fresh] = await db.insert(onbDocuments).values({
    organizationId, caseId, key: "current-file", label: "Fresh separate record", category: "identity",
  }).returning();
  const visibleDocuments = await db.select({ id: onbDocuments.id }).from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId),
    currentOperationalRecordSql(onbDocuments.organizationId, onbDocuments.caseId, onbDocuments.createdAt),
  ));
  assert.deepEqual(visibleDocuments.map(row => row.id), [fresh!.id]);
  const visibleLinks = await db.select({ id: onbCandidateLinks.id }).from(onbCandidateLinks).where(and(
    eq(onbCandidateLinks.organizationId, organizationId), eq(onbCandidateLinks.caseId, caseId),
    currentOperationalRecordSql(onbCandidateLinks.organizationId, onbCandidateLinks.caseId, onbCandidateLinks.createdAt),
  ));
  assert.deepEqual(visibleLinks, []);
  const visibleSessions = await db.select({ idHash: onbCandidateSessions.idHash }).from(onbCandidateSessions).where(and(
    eq(onbCandidateSessions.organizationId, organizationId), eq(onbCandidateSessions.caseId, caseId),
    currentOperationalRecordSql(onbCandidateSessions.organizationId, onbCandidateSessions.caseId, onbCandidateSessions.createdAt),
  ));
  assert.deepEqual(visibleSessions, []);
  assert.equal(evidenceBelongsToOperationalGeneration(activated!, future, oldDocument!.id, "documents"), false);
  assert.equal(evidenceBelongsToOperationalGeneration(activated!, fresh!.createdAt, fresh!.id, "documents"), true);

  const updatedActivation = {
    ...activation,
    generation: "22222222-2222-4222-8222-222222222222",
    generationStartedAt: start.toISOString(),
    previousGenerations: [{
      generation: activation.generation, startedAt: activation.generationStartedAt,
      retainedRecords: { ...Object.fromEntries(HISTORICAL_CHILD_KINDS.map(kind => [kind, []])),
        documents: [fresh] },
    }],
  };
  const [reconfirmed] = await db.update(onbCases).set({ operationalActivation: updatedActivation })
    .where(eq(onbCases.id, caseId)).returning();
  assert.ok(activationRecord(reconfirmed!));
  assert.equal(evidenceBelongsToOperationalGeneration(reconfirmed!, fresh!.createdAt, fresh!.id, "documents"), false);
  const afterReconfirmation = await db.select({ id: onbDocuments.id }).from(onbDocuments).where(and(
    eq(onbDocuments.organizationId, organizationId), eq(onbDocuments.caseId, caseId),
    currentOperationalRecordSql(onbDocuments.organizationId, onbDocuments.caseId, onbDocuments.createdAt),
  ));
  assert.deepEqual(afterReconfirmation, []);
});
