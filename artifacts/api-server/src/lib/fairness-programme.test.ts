import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import { db, onbSettings, organizationMembershipsTable, organizationsTable, onbGovernanceAuthorityAssignments,
  onbAuditEntries } from "@workspace/db";
import { deleteTestOrganizations } from "../test-support/organization-fixtures";
import { applyFairnessAction, fairnessActionSchema, fairnessReport, getFairnessProgramme, validateCriteria, validateReviewSet } from "./fairness-programme";
import { FAIRNESS_PAIRS, compareFairnessPair, fairnessDigest } from "./fairness-catalog";
import { setSetting } from "./onboarding/settings";
import { minimizeAuditPayload } from "./onboarding/protected-audit";
import { checkHroAiBudget } from "./hro-context/ai-budget";
import { evaluateAgentInvocation } from "./agent-invocation";
import type { PolicyExtractSelection } from "./hr-policy-ai";
import { buildPolicySelectionRequest, POLICY_SELECTION_IDENTITY } from "./hr-policy-ai";

test("paired fixtures hold legitimate facts and policy constant; budgets retain all source text", () => {
  for (const pair of FAIRNESS_PAIRS) {
    assert.equal(pair.variants.length, 2);
    const normalized = pair.variants.map(v => v.question.replace(v.characteristic, ""));
    assert.equal(normalized[0], normalized[1]);
    assert.notEqual(pair.variants[0].characteristic, pair.variants[1].characteristic);
    assert.ok(checkHroAiBudget([{ content: pair.excerpt }, { content: pair.sourceContext }, { content: pair.variants[0].question }], 3000));
  }
  assert.throws(() => checkHroAiBudget([{ content: "x".repeat(30_000) }], 3000));
  assert.equal(POLICY_SELECTION_IDENTITY.promptDigest, fairnessDigest(buildPolicySelectionRequest("{question}", "{excerpt}", "{sourceContext}")));
});
test("paired equality is not correctness; incomplete, unequal and incorrect observations stay explicit", () => {
  const supported: PolicyExtractSelection = { outcome: "supported", excerptId: "extract-1", quotedText: FAIRNESS_PAIRS[0].excerpt };
  const insufficient: PolicyExtractSelection = { outcome: "insufficient", excerptId: null, quotedText: null };
  assert.equal(compareFairnessPair("supported", [supported, supported]).status, "observed-match");
  assert.equal(compareFairnessPair("supported", [insufficient, insufficient]).status, "investigate");
  assert.equal(compareFairnessPair("supported", [supported, insufficient]).differences.length, 2);
  assert.equal(compareFairnessPair("supported", [supported, null]).status, "blocked");
  assert.equal(compareFairnessPair("supported", []).status, "blocked");
  assert.throws(() => validateCriteria(["pronouns-supported"], []));
  assert.throws(() => validateCriteria(["pronouns-supported"], [
    { pairId: "names-supported", expected: "supported", rationale: "Reviewed facts" },
  ]));
  assert.throws(() => validateReviewSet([
    { role: "business", userId: "same", assignmentId: null, membershipRevision: 0, stage: "scope", revision: 1, bindingDigest: "", at: "", approved: true, note: "" },
    { role: "hr-compliance", userId: "same", assignmentId: 1, membershipRevision: 0, stage: "scope", revision: 1, bindingDigest: "", at: "", approved: true, note: "" },
    { role: "legal", userId: "third", assignmentId: 2, membershipRevision: 0, stage: "scope", revision: 1, bindingDigest: "", at: "", approved: true, note: "" },
  ]));
});
test("request boundary rejects real data, arbitrary decision types and tools; no new autonomous tool exists", () => {
  for (const extra of [{ employeeId: 1 }, { protectedCharacteristics: { ethnicity: "real" } }, { selector: "bypass" }, { toolKey: "tool.case.read" }]) {
    assert.equal(fairnessActionSchema.safeParse({ kind: "run", expectedVersion: 0, ...extra }).success, false);
  }
  assert.equal(fairnessActionSchema.safeParse({ kind: "define-scope", expectedVersion: 0, decisionType: "candidate-ranking", pairIds: ["names-supported"], note: "Reviewed synthetic scope" }).success, false);
  assert.equal(evaluateAgentInvocation({ trustedOrganizationId: "test", requestedAgentId: "a", registeredAgentId: "a", agentActive: true,
    agentOwnerUserId: "u", initiatingUserId: "u", caseBelongsToTenant: true, toolKey: "tool.fairness.rank", effectiveAccess: ["tool.fairness.rank"] }).allowed, false);
  const digest = fairnessDigest({ fixture: "synthetic" });
  assert.deepEqual(minimizeAuditPayload({ evidenceDigest: digest }, "fairness.run"), { evidenceDigest: digest });
  assert.deepEqual(minimizeAuditPayload({ evidenceDigest: digest }, "unrelated"), {});
  assert.deepEqual(minimizeAuditPayload({ evidenceDigest: "person@example.com" }, "fairness.run"), {});
});

test("governed programme persists reviews, prevents stale/unauthorized runs, records discrepancies and fences late results", async () => {
  const suffix = randomUUID();
  const org = `fairness-test-${suffix}`, otherOrg = `fairness-other-${suffix}`;
  const business = `business-${suffix}`, hr = `hr-${suffix}`, legal = `legal-${suffix}`, ordinary = `member-${suffix}`;
  const orgIds = [org, otherOrg];
  await db.insert(organizationsTable).values(orgIds.map((id, i) => ({ id, name: `Synthetic fairness ${i}`, slug: id, joinCodeHash: fairnessDigest(id), createdByUserId: business })));
  await db.insert(organizationMembershipsTable).values([
    { organizationId: org, clerkUserId: business, role: "owner" },
    { organizationId: org, clerkUserId: hr, role: "member" },
    { organizationId: org, clerkUserId: legal, role: "member" },
    { organizationId: org, clerkUserId: ordinary, role: "member" },
    { organizationId: otherOrg, clerkUserId: business, role: "owner" },
  ]);
  const [hrGrant] = await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "hr-compliance", assigneeUserId: hr,
    verificationStatus: "verified", verifiedByUserId: "test-operator", verificationReference: "Synthetic regression authority only",
  }).returning();
  await db.insert(onbGovernanceAuthorityAssignments).values({
    organizationId: org, authorityRole: "legal", assigneeUserId: legal,
    verificationStatus: "verified", verifiedByUserId: "test-operator", verificationReference: "Synthetic regression authority only",
  });
  const read = () => getFairnessProgramme(org, business);
  const action = async (user: string, input: Record<string, unknown>, selector?: NonNullable<Parameters<typeof applyFairnessAction>[3]>["selector"]) =>
    applyFairnessAction(org, user, { ...input, expectedVersion: (await read()).programme.version }, selector ? { selector } : undefined);
  const note = "Reviewed synthetic legitimate facts and irrelevant label variations.";
  const reviews = async (kind: "review-scope" | "review-criteria") => {
    for (const [role, user] of [["business", business], ["hr-compliance", hr], ["legal", legal]]) {
      await action(user, { kind, role, approved: true, note });
    }
  };
  try {
    await assert.rejects(() => getFairnessProgramme(org, "non-member"));
    await assert.rejects(() => action(ordinary, { kind: "define-scope", decisionType: "policy-extract-recommendation", pairIds: ["pronouns-supported"], note }));
    await assert.rejects(() => action(business, { kind: "set-criteria", criteria: [{ pairId: "pronouns-supported", expected: "supported", rationale: note }] }));
    await action(business, { kind: "define-scope", decisionType: "policy-extract-recommendation", pairIds: ["pronouns-supported"], note });
    await assert.rejects(() => action(business, { kind: "review-scope", role: "hr-compliance", approved: true, note }));
    await assert.rejects(() => action(business, { kind: "set-criteria", criteria: [{ pairId: "pronouns-supported", expected: "supported", rationale: note }] }));
    await reviews("review-scope");
    assert.equal((await read()).capabilities.scopeApproved, true);
    await action(business, { kind: "set-criteria", criteria: [{ pairId: "pronouns-supported", expected: "supported", rationale: note }] });
    await assert.rejects(() => action(business, { kind: "run" }));
    await reviews("review-criteria");
    assert.equal((await read()).capabilities.criteriaApproved, true);
    assert.equal((await getFairnessProgramme(otherOrg, business)).programme.scope, null);
    await assert.rejects(() => applyFairnessAction(org, business, { kind: "run", expectedVersion: 0 }));
    await assert.rejects(() => setSetting(org, "hro-fairness-programme-v1", null));

    // Explicit injected dependency is internal to this function, never an HTTP field.
    let calls = 0;
    const discrepancy = await action(business, { kind: "run" }, async (_question, excerpt, _context, receipt) => {
      calls++;
      receipt?.({ requestedModel: "gpt-5-nano", resolvedModel: "fixture-model-snapshot", providerResponseId: `synthetic-${calls}`, systemFingerprint: null });
      return calls % 2 === 1 ? { outcome: "supported", excerptId: "extract-1", quotedText: excerpt } : { outcome: "insufficient", excerptId: null, quotedText: null };
    });
    assert.equal(calls, 2);
    const run = discrepancy.programme.runs[0];
    assert.equal(run.observations[0].status, "investigate");
    assert.equal(run.observations[0].modelReceipts[0]?.resolvedModel, "fixture-model-snapshot");
    assert.ok(run.fixtures[0].sourceContext.includes("FICTIONAL"));
    assert.equal(fairnessReport(discrepancy.programme).coverage.unresolvedDifferences.length, 1);
    await assert.rejects(() => action(ordinary, { kind: "investigate", runId: run.id, pairId: "pronouns-supported", disposition: "explained", note }));
    await action(hr, { kind: "investigate", runId: run.id, pairId: "pronouns-supported", disposition: "remediation-required", note });
    assert.equal((await read()).programme.runs[0].observations[0].status, "investigate");
    const failed = await action(business, { kind: "run" }, async () => { throw new Error("Provider not available"); });
    assert.equal(failed.programme.runs[0].status, "blocked");
    assert.deepEqual(failed.programme.runs[0].observations[0].outputs, [null, null]);
    assert.ok(fairnessReport(failed.programme).limitations.some(l => /neither statistical nor legal/.test(l)));

    // An expired grant cannot authorize a run; membership removal/reinstatement
    // also invalidates an otherwise unchanged verified reviewer grant.
    await db.update(onbGovernanceAuthorityAssignments).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(onbGovernanceAuthorityAssignments.id, hrGrant.id));
    assert.equal((await read()).capabilities.criteriaApproved, false);
    await assert.rejects(() => action(business, { kind: "run" }));
    await db.update(onbGovernanceAuthorityAssignments).set({ expiresAt: null }).where(eq(onbGovernanceAuthorityAssignments.id, hrGrant.id));
    await db.update(organizationMembershipsTable).set({ membershipRevision: 2 }).where(and(eq(organizationMembershipsTable.organizationId, org), eq(organizationMembershipsTable.clerkUserId, hr)));
    assert.equal((await read()).capabilities.scopeApproved, false);
    await action(hr, { kind: "review-scope", role: "hr-compliance", approved: true, note });
    await reviews("review-criteria");

    // Two concurrent revisions do not silently overwrite each other's criteria.
    const sharedVersion = (await read()).programme.version;
    const concurrent = await Promise.allSettled([1, 2].map(() => applyFairnessAction(org, business, {
      kind: "set-criteria", expectedVersion: sharedVersion,
      criteria: [{ pairId: "pronouns-supported", expected: "supported", rationale: note }],
    })));
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length, 1);
    assert.equal((await read()).capabilities.criteriaApproved, false);
    await reviews("review-criteria");

    // Recovery is explicit, never a background repeat of uncertain AI requests.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    let signal!: () => void;
    const entered = new Promise<void>(resolve => { signal = resolve; });
    const inFlight = action(business, { kind: "run" }, async (_question, excerpt) => {
      signal(); await held;
      return { outcome: "supported", excerptId: "extract-1", quotedText: excerpt };
    });
    await entered;
    await assert.rejects(() => action(business, { kind: "run" }));
    await assert.rejects(() => action(business, { kind: "recover" }));
    const [raw] = await db.select().from(onbSettings).where(and(eq(onbSettings.organizationId, org), eq(onbSettings.key, "hro-fairness-programme-v1")));
    const interrupted = JSON.parse(raw.value);
    interrupted.runs[0].at = new Date(Date.now() - 11 * 60_000).toISOString();
    await db.update(onbSettings).set({ value: JSON.stringify(interrupted) }).where(and(
      eq(onbSettings.organizationId, org), eq(onbSettings.key, raw.key),
    ));
    await action(business, { kind: "recover" });
    release(); await inFlight;
    assert.equal((await read()).programme.runs[0].status, "blocked");
    assert.equal((await read()).programme.runs[0].observations.length, 0);

    // Revocation while the model is in flight withholds all results.
    let raceCalls = 0;
    const fenced = await action(business, { kind: "run" }, async (_question, excerpt) => {
      raceCalls++;
      await db.update(onbGovernanceAuthorityAssignments).set({ revokedAt: new Date() }).where(eq(onbGovernanceAuthorityAssignments.id, hrGrant.id));
      return { outcome: "supported", excerptId: "extract-1", quotedText: excerpt };
    });
    assert.equal(raceCalls, 1);
    assert.equal(fenced.programme.runs[0].status, "blocked");
    assert.equal(fenced.programme.runs[0].observations.length, 0);
    assert.match(fenced.programme.runs[0].limitation!, /authority changed/);
    assert.equal(fenced.capabilities.criteriaApproved, false);
    await assert.rejects(() => action(business, { kind: "run" }));

    // Revised scope discards criteria/approvals but retains immutable prior run evidence.
    await action(business, { kind: "define-scope", decisionType: "policy-extract-recommendation", pairIds: ["names-supported"], note });
    const revised = (await read()).programme;
    assert.equal(revised.criteria.length, 0);
    assert.equal(revised.scopeReviews.length, 0);
    assert.equal(revised.runs.length, 4);
    assert.equal(revised.runs[3].fixtures[0].id, "pronouns-supported");
    assert.ok(revised.evidence.some(e => e.kind === "review-criteria" && e.details));
    const audits = await db.select().from(onbAuditEntries).where(and(eq(onbAuditEntries.organizationId, org), eq(onbAuditEntries.action, "fairness.run")));
    assert.equal(audits.length, 4);
    assert.ok(audits.every(a => (a.payload as Record<string, unknown>).evidenceDigest));
  } finally {
    // Protected audit is append-only even in regression fixtures. Keep its
    // synthetic tenant shell instead of weakening triggers to clean a test.
    await db.delete(onbGovernanceAuthorityAssignments).where(inArray(onbGovernanceAuthorityAssignments.organizationId, orgIds));
    await db.delete(onbSettings).where(inArray(onbSettings.organizationId, orgIds));
    await db.delete(organizationMembershipsTable).where(inArray(organizationMembershipsTable.organizationId, orgIds));
    await deleteTestOrganizations(eq(organizationsTable.id, otherOrg));
  }
});
