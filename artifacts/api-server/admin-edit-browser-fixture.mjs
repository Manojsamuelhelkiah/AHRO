/**
 * Owned-schema edit fixtures only. No workflow initialization, source files,
 * notification authorization, or provider approval is created here.
 */
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";

export async function installAdminEditFixture(app, { dbPackage, sessions, org, actor }) {
  assert.equal(process.env.ADMIN_EDIT_E2E_TEST, "true");
  assert.equal(process.env.ONBOARDING_E2E_TEST, "true");
  // The parent adapter has already checked the schema. Check again before
  // making any fixture writes so this helper cannot be used independently.
  const { rows: [scope] } = await dbPackage.pool.query("SELECT current_schema() s, current_schemas(false)::text[] scopes");
  assert.match(scope.s, /^browser_regression_[0-9]+_[a-f0-9]+$/);
  assert.deepEqual(scope.scopes, [scope.s]);
  const { db, accessNamedGrants, onbSensitiveLifecyclePolicies, onbCases, onbDocuments,
    onbCandidateUploads, onbEvents, onbAuditEntries, onbCommunications, onbEffectJournal } = dbPackage;
  const { recordHumanPermissionDecision } = await import("./src/lib/human-permissions.ts");
  const { SENSITIVE_DATA_CLASSES } = await import("./src/lib/onboarding/sensitive-lifecycle.ts");
  const policyReviewer = `${actor}-policy-reviewer`;
  await db.insert(dbPackage.organizationMembershipsTable).values({
    organizationId: org, clerkUserId: policyReviewer, role: "member",
  });
  await db.insert(accessNamedGrants).values({
    organizationId: org, principalType: "human", principalId: policyReviewer,
    resourceType: "tool", resourceKey: "tool.policy.manage", scope: "tenant", effect: "allow",
    source: "named", createdByUserId: "isolated-independent-grantor",
    approvedByUserId: "isolated-independent-approver", approvedAt: new Date(),
  });
  const receipt = await db.transaction(tx => recordHumanPermissionDecision(tx, {
    organizationId: org, actorUserId: policyReviewer, requiredKeys: ["tool.policy.manage"],
    reviewedRevision: 1, decision: "policy-approved",
  }));
  await db.insert(onbSensitiveLifecyclePolicies).values(SENSITIVE_DATA_CLASSES.map(dataClass => ({
    organizationId: org, dataClass, jurisdiction: "US", revision: 1, retentionDays: 1,
    purpose: "Disposable local admin-edit regression", lawfulBasis: "Fictional test evidence only",
    providerSharingApproved: false, permittedProviders: [],
    policyReference: "isolated-edit-policy", approvalReference: "isolated-edit-review",
    approvedByUserId: policyReviewer, approvedAuthorityAssignmentId: receipt.id, isCurrent: true,
  })));
  const itemId = "admin-manual-item";
  const base = {
    organizationId: org, workerEmail: "admin-edit-case@example.invalid", workerPhone: "+15550000001",
    hireType: "external-fte", workerCategory: "employee", role: "Engineer", department: "Test",
    geography: "US", legalEntity: "Fixture", joiningDate: "2035-01-01",
    managerName: "Fixture Manager", recruiterName: "Fixture Recruiter", createdByUserId: actor,
    lifecycleStage: "preboarding", orchestrationStatus: "paused",
    workforceContext: { workCountry: "US", workEnvironment: "office", department: "Before edit" },
    checklistSnapshot: [{
      id: itemId, label: "Administrative manual check", enabled: true, mandatory: false,
      order: 0, evidenceRequired: false, executor: "human-task",
      enforcementStage: "before-day1", responsibleRole: "hr", completionAuthority: "designated-human",
    }],
    readiness: [{ key: itemId, label: "Administrative manual check", status: "pending", order: 0 }],
  };
  const fixtures = [];
  for (const mode of ["development", "private"]) {
  for (const historical of [false, true]) {
    const [c] = await db.insert(onbCases).values({
      ...base, workerName: historical ? "Retained Admin Edit Fixture" : "Active Admin Edit Fixture",
      ...(historical ? { controllerRetired: true, syntheticProvenance: "demo-controller-fictional" } : {}),
    }).returning();
    const [doc] = await db.insert(onbDocuments).values({
      organizationId: org, caseId: c.id, key: "id-proof", category: "identity",
      label: "Government photo ID (passport / national ID)", required: true, status: "received",
    }).returning();
    const [upload] = await db.insert(onbCandidateUploads).values({
      organizationId: org, caseId: c.id, documentId: doc.id,
      // No object exists or is accessed: this journey records a human note,
      // never downloads, scans, or approves source authenticity.
      objectPath: `isolated/${scope.s}/${c.id}/no-source.pdf`, originalName: "fictional-id.pdf",
      contentType: "application/pdf", sizeBytes: 10, validationState: "manual_review",
      checksumSha256: "a".repeat(64), malwareScanState: "unavailable",
      validationReasons: [{ code: "manual_review", message: "Fictional evidence awaiting correction" }],
    }).returning();
    fixtures.push({ mode, historical, caseId: c.id, evidenceId: upload.id });
  }
  }
  app.get("/api/test/admin-edit/state/:caseId", async (req, res, next) => {
    try {
      if (sessions.get(req.cookies?.browser_e2e_session) !== actor) return res.sendStatus(403);
      const fixture = fixtures.find(f => f.caseId === Number(req.params.caseId));
      if (!fixture) return res.sendStatus(404);
      const where = table => and(eq(table.organizationId, org), eq(table.caseId, fixture.caseId));
      const [cases, documents, uploads, events, communications, effects, audit] = await Promise.all([
        db.select().from(onbCases).where(and(eq(onbCases.organizationId, org), eq(onbCases.id, fixture.caseId))),
        db.select().from(onbDocuments).where(where(onbDocuments)),
        db.select().from(onbCandidateUploads).where(where(onbCandidateUploads)),
        db.select().from(onbEvents).where(where(onbEvents)),
        db.select().from(onbCommunications).where(where(onbCommunications)),
        db.select().from(onbEffectJournal).where(where(onbEffectJournal)),
        db.select().from(onbAuditEntries).where(eq(onbAuditEntries.organizationId, org)),
      ]);
      res.json({ cases, documents, uploads, events, communications, effects, audit,
        providerBoundary: "deny-external-providers", schema: scope.s });
    } catch (error) { next(error); }
  });
  return Object.fromEntries(["development", "private"].map(mode => [mode, {
    active: fixtures.find(f => f.mode === mode && !f.historical),
    historical: fixtures.find(f => f.mode === mode && f.historical),
    itemId,
  }]));
}
