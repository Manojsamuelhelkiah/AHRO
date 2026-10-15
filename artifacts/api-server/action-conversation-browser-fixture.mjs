import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";

/** Disposable-schema seam only. Each scenario owns its own organization;
 * revocations and extra grants cannot alter another suite's fixtures. */
export function installConversationBrowserFixture(app, p, fixture, authenticatedUser) {
  if (process.env.ONBOARDING_E2E_TEST !== "true" || process.env.NODE_ENV !== "test")
    throw new Error("Conversation browser fixture is test-only");
  const ownedOrganizations = new Set();
  app.post("/api/test/action-conversation-fixture", async (req, res, next) => {
    try {
      if (authenticatedUser(req) !== fixture.actor) { res.status(403).json({ message: "Isolated operator required." }); return; }
      let organizationId;
      const caseId = Number(req.body?.caseId);
      if (req.body?.action) {
        const [c] = await p.db.select().from(p.onbCases).where(eq(p.onbCases.id, caseId));
        if (!c || !ownedOrganizations.has(c.organizationId)) { res.sendStatus(404); return; }
        organizationId = c.organizationId;
        if (["revoke-notes", "revoke-disclosure"].includes(req.body.action)) {
          await p.db.update(p.accessNamedGrants).set({ status: "rejected" }).where(and(
            eq(p.accessNamedGrants.organizationId, organizationId), eq(p.accessNamedGrants.principalId, fixture.actor),
            eq(p.accessNamedGrants.resourceKey, req.body.action === "revoke-notes" ? "data.case.notes.read" : "tool.external.dispatch"),
          ));
          res.json({ revoked: true }); return;
        }
        if (req.body.action === "history") {
          await p.db.insert(p.actionConversationMessages).values(Array.from({ length: 36 }, (_, i) => ({
            organizationId, caseId, author: fixture.actor, text: `Fictional historical annotation ${i + 1}`,
            mode: "note", state: "recorded", submissionId: randomUUID(), requestDigest: "owned-history-fixture",
          })));
          res.json({ seeded: true }); return;
        }
        if (req.body.action === "state") {
          const count = async table => {
            const [row] = await p.db.select({ n: sql`count(*)::int` }).from(table).where(and(eq(table.organizationId, organizationId), eq(table.caseId, caseId)));
            return row.n;
          };
          res.json({ messages: await count(p.actionConversationMessages), work: await count(p.onbActionCenterActions),
            communications: await count(p.onbCommunications), events: await count(p.onbEvents), stage: c.lifecycleStage });
          return;
        }
        res.sendStatus(400); return;
      }
      organizationId = `conversation-browser-${randomUUID()}`;
      ownedOrganizations.add(organizationId);
      await p.db.insert(p.organizationsTable).values({
        id: organizationId, name: "Isolated Conversation Test", slug: organizationId,
        joinCodeHash: `${randomUUID()}:unused`, createdByUserId: fixture.actor,
      });
      // These journeys revoke individual grants. A client administrator has
      // membership-based access independently of those grants, so exercise
      // revocation as an ordinary named member instead.
      await p.db.insert(p.organizationMembershipsTable).values({ organizationId, clerkUserId: fixture.actor, role: "member" });
      const keys = ["flow.case.read", "flow.case.edit", "data.case.notes.read", "data.case.notes.edit", "data.case.profile.read", "data.case.readiness.read",
        "data.identity.read", "data.medical.read", "data.payroll.read", "data.bgv.read",
        "data.identity.edit", "data.medical.edit", "data.payroll.edit", "data.bgv.edit", "tool.external.dispatch"];
      await p.db.insert(p.accessNamedGrants).values(keys.map(resourceKey => ({
        organizationId, principalType: "human", principalId: fixture.actor, scope: "tenant",
        resourceType: resourceKey.startsWith("tool.") ? "tool" : resourceKey.startsWith("flow.") ? "flow" : "field", resourceKey,
        source: "named", effect: "allow", status: "active", requiresApproval: "yes",
        createdByUserId: "fixture-independent-grantor", approvedByUserId: "fixture-independent-approver", approvedAt: new Date(),
      })));
      const { seedApprovedSensitiveLifecyclePolicies } = await import("./src/test-utils/sensitive-lifecycle-fixtures.ts");
      await seedApprovedSensitiveLifecyclePolicies(organizationId, { permittedProviders: [] });
      const data = { organizationId, workerName: "Conversation Browser Fixture", workerEmail: `conversation-${randomUUID()}@example.invalid`,
        hireType: "employee", workerCategory: "employee", role: "Engineer", department: "Testing", geography: "US", workforceContext: { workCountry: "US" },
        legalEntity: "Fixture US", managerName: "Fixture Manager", recruiterName: "Fixture Recruiter", joiningDate: "2031-01-01", createdByUserId: fixture.actor };
      const cases = await p.db.insert(p.onbCases).values([data, { ...data, workerName: "Other Conversation Fixture" }]).returning();
      const [work] = await p.db.insert(p.onbActionCenterActions).values({
        organizationId, caseId: cases[0].id, kind: "assign", actorUserId: fixture.actor,
        actorName: "Fixture Operator", requestId: randomUUID(), status: "open",
      }).returning();
      await p.db.insert(p.actionConversationMessages).values({
        organizationId, caseId: cases[0].id, author: fixture.actor, text: "Earlier interrupted triage request", mode: "triage", state: "pending",
        submissionId: randomUUID(), requestDigest: "owned-interrupted-fixture",
        dispatchStartedAt: new Date(Date.now() - 300_000), updatedAt: new Date(Date.now() - 300_000),
      });
      res.json({ organizationId, caseId: cases[0].id, otherCaseId: cases[1].id, workItemId: work.id });
    } catch (error) { next(error); }
  });
}
