import { eq, and, inArray } from "drizzle-orm";

/** Only imported by the disposable-schema browser server; never production. */
export function installCaseListBrowserFixture(app, p, fixture, authenticatedUser) {
  if (process.env.ONBOARDING_E2E_TEST !== "true" || process.env.NODE_ENV !== "test")
    throw new Error("Case list fixture is test-only");
  let owned;
  app.post("/api/test/case-list-fixture", async (req, res, next) => {
    try {
      if (authenticatedUser(req) !== fixture.actor) { res.sendStatus(403); return; }
      if (!owned) {
        await p.db.insert(p.organizationMembershipsTable).values({
          organizationId: "demo", clerkUserId: fixture.actor, role: "admin",
        }).onConflictDoNothing();
        const common = { organizationId: "demo", workerName: "Working List Browser Fixture",
          workerEmail: "never-send@example.invalid", workerCategory: "employee", role: "Test", department: "Test",
          geography: "US", legalEntity: "Test", managerName: "Test", recruiterName: "Test", joiningDate: "2031-01-01",
          lifecycleStage: "completed", orchestrationStatus: "completed", createdByUserId: fixture.actor };
        owned = await p.db.insert(p.onbCases).values([
          { ...common, hireType: "employee" }, { ...common, hireType: "offboarding" },
        ]).returning();
      }
      if (req.body?.action === "state") {
        const ids = owned.map(row => row.id);
        const read = table => p.db.select().from(table).where(and(eq(table.organizationId, "demo"), inArray(table.caseId, ids)));
        res.json({ cases: await p.db.select().from(p.onbCases).where(inArray(p.onbCases.id, ids)),
          communications: await read(p.onbCommunications), events: await read(p.onbEvents),
          actions: await read(p.onbActionCenterActions), effects: await read(p.onbEffectJournal),
          approvals: await read(p.onbApprovals), documents: await read(p.onbDocuments) });
        return;
      }
      res.json({ cases: owned.map(row => ({ id: row.id, family: row.hireType === "offboarding" ? "Offboarding" : "Onboarding",
        reference: `HRO-${row.createdAt.getFullYear()}-${String(row.id).padStart(5, "0")}` })) });
    } catch (error) { next(error); }
  });
}
