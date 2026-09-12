import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@workspace/db";
import { onbApprovals, onbCases, onbChecklistProfiles, onbConnectors, onbPolicyAuthorities, onbPolicyEvidence, onbSensitiveLifecyclePolicies, organizationsTable } from "@workspace/db/schema";
import { verifyChecklistEvidence } from "./checklist";
import { decideApproval } from "./approval-decisions";
import {
  checklistProfileMatchingAttributes,
  resolveEffectiveWorkforcePolicy,
} from "./checklist-profiles";
import { WORKFORCE_STARTER_TEMPLATES } from "./workforce-policies";
import { seedApprovedSensitiveLifecyclePolicies } from "../../test-utils/sensitive-lifecycle-fixtures";

const hasDb = Boolean(process.env.DATABASE_URL);
const organizationId = `workforce-safety-${randomUUID()}`;
let caseId = 0;

describe("workforce evidence safety (real DB)", { skip: !hasDb }, () => {
  after(async () => {
    if (caseId) {
      await db.delete(onbPolicyEvidence).where(eq(onbPolicyEvidence.caseId, caseId));
      await db.delete(onbPolicyAuthorities).where(eq(onbPolicyAuthorities.caseId, caseId));
      await db.delete(onbCases).where(eq(onbCases.id, caseId));
    }
    await db.delete(onbConnectors).where(eq(onbConnectors.organizationId, organizationId));
    await db.delete(onbChecklistProfiles).where(eq(onbChecklistProfiles.organizationId, organizationId));
    await db.delete(onbSensitiveLifecyclePolicies).where(eq(onbSensitiveLifecyclePolicies.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  });

  test("scoped authority, prerequisites, and version fences are enforced", async () => {
    await db.insert(organizationsTable).values({ id: organizationId, name: "Workforce safety test", slug: organizationId, joinCodeHash: organizationId, createdByUserId: "test" });
    await seedApprovedSensitiveLifecyclePolicies(organizationId);
    const snapshot = [
      { id: "safety", label: "Safety sign-off", order: 1, enabled: true, mandatory: true, evidenceRequired: true, enforcementStage: "before-workstreams" as const, responsibleRole: "hse", completionAuthority: "designated-human" as const },
      { id: "medical", label: "Medical fitness", order: 2, enabled: true, mandatory: true, evidenceRequired: true, enforcementStage: "before-workstreams" as const, responsibleRole: "occupational-health", completionAuthority: "designated-human" as const, prerequisites: ["safety"] },
    ];
    const [created] = await db.insert(onbCases).values({
      organizationId, workerName: "Test", workerEmail: "safety@example.invalid", workerCategory: "employee", hireType: "new-hire", role: "Operator", department: "Ops", geography: "US", legalEntity: "Test", managerName: "M", recruiterName: "R", joiningDate: "2030-01-01",
      workforceContext: { workCountry: "US", site: "yard", safetyCritical: true, siteExposure: true, workEnvironment: "site" },
      checklistSnapshot: snapshot, readiness: snapshot.map((x) => ({ key: x.id, label: x.label, status: "pending" })),
    }).returning({ id: onbCases.id });
    caseId = created.id;
    await db.insert(onbPolicyAuthorities).values([
      { organizationId, userId: "hse-user", authorityRole: "hse", caseId, itemId: "safety", site: "yard", assignedBy: "owner" },
      { organizationId, userId: "med-user", authorityRole: "occupational-health", caseId, itemId: "medical", site: "yard", assignedBy: "owner" },
    ]);
    const expected = { contextVersion: 1, templateVersion: 1, profileId: "default", profileVersion: 1 };
    const premature = await verifyChecklistEvidence({ organizationId, caseId, itemId: "medical", evidenceReference: "ref-med", authorityRole: "occupational-health", decision: "verified", reason: "fit", verifier: "Med", verifierUserId: "med-user", expected });
    assert.deepEqual(premature, { ok: false, code: "prerequisites-unmet" });
    const safety = await verifyChecklistEvidence({ organizationId, caseId, itemId: "safety", evidenceReference: "ref-hse", authorityRole: "hse", decision: "verified", reason: "signed", verifier: "HSE", verifierUserId: "hse-user", expected });
    assert.equal(safety.ok, true);
    const stale = await verifyChecklistEvidence({ organizationId, caseId, itemId: "medical", evidenceReference: "ref-med", authorityRole: "occupational-health", decision: "verified", reason: "fit", verifier: "Med", verifierUserId: "med-user", expected: { ...expected, contextVersion: 99 } });
    assert.deepEqual(stale, { ok: false, code: "stale-policy" });
    const foreign = await verifyChecklistEvidence({ organizationId, caseId, itemId: "medical", evidenceReference: "ref-med", authorityRole: "occupational-health", decision: "verified", reason: "fit", verifier: "HSE", verifierUserId: "hse-user", expected });
    assert.deepEqual(foreign, { ok: false, code: "not-designated" });
    const medical = await verifyChecklistEvidence({ organizationId, caseId, itemId: "medical", evidenceReference: "ref-med", authorityRole: "occupational-health", decision: "verified", reason: "fit", verifier: "Med", verifierUserId: "med-user", expected });
    assert.equal(medical.ok, true);
    const evidence = await db.select().from(onbPolicyEvidence).where(and(eq(onbPolicyEvidence.caseId, caseId), eq(onbPolicyEvidence.itemId, "medical")));
    assert.equal(evidence.length, 1);
    assert.equal(evidence[0].verifiedByUserId, "med-user");

    // Real persisted office starter gate: organization scope is not a wildcard
    // and must never authorize a site-bound or incomplete context.
    const officeGate = {
      id: "office-identity-review", label: "Identity and lawful verification review",
      order: 7, enabled: true, mandatory: true, evidenceRequired: true,
      enforcementStage: "before-workstreams" as const, responsibleRole: "hr",
      completionAuthority: "designated-human" as const,
    };
    await db.update(onbCases).set({
      workforceContext: { workCountry: "US", workEnvironment: "office", siteExposure: false, safetyCritical: false, hazards: [] },
      workforceContextVersion: 2,
      checklistSnapshot: [officeGate],
      readiness: [{ key: officeGate.id, label: officeGate.label, status: "pending" }],
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbPolicyAuthorities).values({
      organizationId, userId: "office-hr", authorityRole: "hr", caseId,
      itemId: officeGate.id, site: "__organization__", assignedBy: "owner",
    });
    const officeInput = {
      organizationId, caseId, itemId: officeGate.id, evidenceReference: "office-source-1",
      authorityRole: "hr", decision: "verified" as const, reason: "Identity source reviewed",
      verifier: "Office HR", verifierUserId: "office-hr",
      expected: { ...expected, contextVersion: 2 },
    };
    assert.equal((await verifyChecklistEvidence(officeInput)).ok, true);
    const [officeEvidence] = await db.select().from(onbPolicyEvidence).where(and(
      eq(onbPolicyEvidence.caseId, caseId), eq(onbPolicyEvidence.itemId, officeGate.id),
    ));
    assert.ok(officeEvidence.authorityAssignmentId.includes("__organization__"));
    await db.update(onbCases).set({
      workforceContext: { workCountry: "US", workEnvironment: "site", site: "yard", siteExposure: true, safetyCritical: true },
      workforceContextVersion: 3,
    }).where(eq(onbCases.id, caseId));
    assert.deepEqual(await verifyChecklistEvidence({
      ...officeInput, expected: { ...expected, contextVersion: 3 },
    }), { ok: false, code: "not-designated" });
    await db.update(onbCases).set({
      workforceContext: { workCountry: "US" }, workforceContextVersion: 4,
    }).where(eq(onbCases.id, caseId));
    assert.deepEqual(await verifyChecklistEvidence({
      ...officeInput, expected: { ...expected, contextVersion: 4 },
    }), { ok: false, code: "not-designated" });

    // A rejection after Gate C has been approved must reopen the actual
    // human-queue approval cycle. A replacement evidence verification only
    // restores checklist readiness; it cannot reuse the stale HR decision.
    const rejectionGate = {
      id: "rejection-safety", label: "Safety evidence reassessment",
      order: 1, enabled: true, mandatory: true, evidenceRequired: true,
      enforcementStage: "before-workstreams" as const, responsibleRole: "hse",
      completionAuthority: "designated-human" as const,
    };
    await db.update(onbCases).set({
      workforceContext: { workCountry: "US", workEnvironment: "site", site: "yard", siteExposure: true, safetyCritical: true },
      workforceContextVersion: 5,
      checklistSnapshot: [rejectionGate],
      readiness: [{ key: rejectionGate.id, label: rejectionGate.label, status: "ready" }],
      lifecycleStage: "day1-review",
      orchestrationStatus: "waiting-approval",
      orchestrationCheckpoint: "waiting:gate-c",
    }).where(eq(onbCases.id, caseId));
    await db.insert(onbPolicyAuthorities).values({
      organizationId, userId: "rejection-hse", authorityRole: "hse", caseId,
      itemId: rejectionGate.id, site: "yard", assignedBy: "owner",
    });
    const [approvedGateC] = await db.insert(onbApprovals).values({
      organizationId, caseId, agent: "human-queue",
      ruleRef: "Gate C — Day-1 readiness confirmation",
      hitlPattern: "approve-before-act", recommendation: "Complete",
      rationale: "All mandatory evidence was previously verified.",
      resumeAction: "complete",
      idempotencyKey: `gateway-c:${caseId}:human-queue`,
      status: "approved", version: 1, decidedBy: "hr-original",
      decidedAt: new Date(), comment: "Original HR approval",
    }).returning();
    const rejectionInput = {
      organizationId, caseId, itemId: rejectionGate.id,
      evidenceReference: "rejection-source", authorityRole: "hse",
      decision: "rejected" as const, reason: "Source no longer valid",
      verifier: "HSE reassessor", verifierUserId: "rejection-hse",
      expected: { ...expected, contextVersion: 5 },
    };
    assert.equal((await verifyChecklistEvidence(rejectionInput)).ok, true);
    let [reopenedGateC] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approvedGateC.id));
    assert.equal(reopenedGateC.status, "pending");
    assert.equal(reopenedGateC.version, 2);
    assert.equal(reopenedGateC.decidedBy, null);
    assert.equal(reopenedGateC.decidedAt, null);

    assert.equal((await verifyChecklistEvidence({
      ...rejectionInput,
      decision: "verified",
      evidenceReference: "replacement-source",
      reason: "Replacement source verified",
    })).ok, true);
    [reopenedGateC] = await db.select().from(onbApprovals).where(eq(onbApprovals.id, approvedGateC.id));
    assert.equal(reopenedGateC.status, "pending");
    assert.equal(reopenedGateC.version, 2);
    assert.deepEqual(await decideApproval({
      organizationId, approvalId: approvedGateC.id, expectedVersion: 1,
      decision: "approved", decidedBy: "hr-original",
      comment: "Attempt to reuse old decision",
    }), {
      outcome: "stale", reason: "version-mismatch", currentVersion: 2, status: "pending",
    });

    // Batch enrollment uses the same mapper and database resolver as single
    // intake. Explicit safety-critical site work must select every canonical
    // frontline hard gate; an unknown fact must not be treated as false.
    const frontline = WORKFORCE_STARTER_TEMPLATES.find((template) => template.key === "frontline-site")!;
    await db.insert(onbChecklistProfiles).values({
      organizationId,
      profileId: "frontline-batch",
      version: 1,
      name: frontline.name,
      criteria: frontline.criteria,
      overrides: frontline.overrides,
      processPolicy: { ...frontline.processPolicy, semanticsVersion: 2 },
      priority: 100,
      enabled: true,
      createdBy: "integration-test",
    });
    const batchBase = {
      workerBand: null,
      role: "Site operator",
      hireType: "contractor",
      workerCategory: "contractor",
      geography: "US",
      department: "Operations",
      legalEntity: "Test",
    };
    const batchContext = {
      workEnvironment: "site" as const,
      hiringMode: "batch" as const,
      site: "yard",
      siteExposure: true,
      safetyCritical: true,
    };
    const batchPolicy = await resolveEffectiveWorkforcePolicy(
      organizationId,
      batchContext,
      batchBase,
    );
    const batchProfile = batchPolicy.profile;
    assert.equal(batchProfile.profileId, "frontline-batch");
    assert.deepEqual(batchPolicy.attributes, checklistProfileMatchingAttributes(batchContext, batchBase));
    assert.equal(batchPolicy.classification?.label, "blue-collar-frontline");
    assert.equal(batchPolicy.effectiveItems.some((item) => item.id === "workforce-context-review"), false);
    for (const id of [
      "medical-fitness-clearance",
      "safety-sign-off",
      "safety-competency",
      "badge-ppe-tools-release",
    ]) {
      assert.equal(batchProfile.items.find((item) => item.id === id)?.mandatory, true);
      assert.equal(batchProfile.items.find((item) => item.id === id)?.evidenceRequired, true);
    }
    const falsePolicy = await resolveEffectiveWorkforcePolicy(
      organizationId,
      {
        workEnvironment: "office",
        hiringMode: "batch",
        siteExposure: false,
        safetyCritical: false,
      },
      batchBase,
    );
    assert.equal(falsePolicy.attributes.safetyCritical, "false");
    assert.equal(falsePolicy.classification?.label, "white-collar");
    assert.equal(falsePolicy.effectiveItems.some((item) => item.id === "workforce-context-review"), false);
    const unknownPolicy = await resolveEffectiveWorkforcePolicy(
      organizationId,
      { hiringMode: "batch" },
      batchBase,
    );
    assert.equal(unknownPolicy.attributes.safetyCritical, null);
    assert.equal(unknownPolicy.classification?.label, "needs-review");
    assert.equal(unknownPolicy.effectiveItems.some((item) => item.id === "workforce-context-review"), true);
  });
});