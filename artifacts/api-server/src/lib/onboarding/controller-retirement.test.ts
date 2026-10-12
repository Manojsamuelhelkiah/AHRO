import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { db, onbCases, onbEffectJournal, DEMO_ORGANIZATION_ID } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { isRetiredControllerCase } from "./controller-retirement";
import { withCaseDispatchGuard } from "./dispatch-guard";
import { isExplicitSyntheticDemoCase } from "./demo-admin-access";
import { SYNTHETIC_OFFLINE_MARKER } from "./synthetic-offline";

test("retirement is a deny fence, never fictional authority", () => {
  for (const marker of [
    { controllerRetired: true }, { syntheticProvenance: "demo-controller-fictional" },
    { candidateEmailAuthorizedBy: "demo-controller" }, { checklistProfileId: "demo-controller" },
    { orchestrationCheckpoint: "demo-controller:offer" }, { notes: "[demo-controller-run:legacy]" },
  ]) assert.equal(isRetiredControllerCase(marker), true);
  assert.equal(isRetiredControllerCase({ notes: SYNTHETIC_OFFLINE_MARKER, syntheticProvenance: "synthetic-reset" }), false);
  assert.equal(isExplicitSyntheticDemoCase({ notes: SYNTHETIC_OFFLINE_MARKER,
    scenarioKey: null, syntheticProvenance: "synthetic-reset", controllerRetired: true }), false);
});

test("forward migration preserves populated evidence and scopes run references to their tenant", { skip: !process.env.DATABASE_URL }, async () => {
  const root = existsSync(resolve("lib/db/drizzle/0106_controller_retirement.sql")) ? "." : "../..";
  const migration = readFileSync(resolve(root, "lib/db/drizzle/0106_controller_retirement.sql"), "utf8");
  await db.transaction(async (tx) => {
    // Temporary tables shadow the actual relations on this connection only.
    await tx.execute(sql.raw(`CREATE TEMP TABLE onb_cases (id int PRIMARY KEY,
      organization_id text, synthetic_provenance text, candidate_email_authorized_by text,
      checklist_profile_id text, orchestration_checkpoint text, notes text) ON COMMIT DROP;
      CREATE TEMP TABLE onb_settings (organization_id text, key text, value text) ON COMMIT DROP;`));
    await tx.execute(sql.raw(`INSERT INTO onb_cases (id,organization_id,notes,candidate_email_authorized_by)
      VALUES (1,'a','Original evidence','demo-controller'), (2,'a','Unrelated',NULL),
      (3,'a','Run-linked',NULL), (4,'b','Other tenant',NULL);
      INSERT INTO onb_settings VALUES
      ('a','demo-controller.run.v1:archived','{"caseId":3,"outcome":"unknown"}'),
      ('a','demo-controller.run.v1:other','{"caseId":4}'),
      ('a','demo-controller.run.v1:damaged','not-json');`));
    await tx.execute(sql.raw(migration));
    const rows = await tx.execute(sql`SELECT id, controller_retired, notes FROM onb_cases ORDER BY id`);
    assert.deepEqual(rows.rows.map((r) => r.controller_retired), [true, false, true, false]);
    assert.equal(rows.rows[0]?.notes, "Original evidence");
    const evidence = await tx.execute(sql`SELECT value FROM onb_settings WHERE key='demo-controller.run.v1:archived'`);
    assert.equal(evidence.rows[0]?.value, '{"caseId":3,"outcome":"unknown"}');
  });
  // The identical immutable migration also works against an empty schema.
  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`CREATE TEMP TABLE onb_cases (id int, organization_id text,
      synthetic_provenance text, candidate_email_authorized_by text, checklist_profile_id text,
      orchestration_checkpoint text, notes text) ON COMMIT DROP;
      CREATE TEMP TABLE onb_settings (organization_id text, key text, value text) ON COMMIT DROP;`));
    await tx.execute(sql.raw(migration));
    const empty = await tx.execute(sql`SELECT count(*)::int AS n FROM onb_cases`);
    assert.equal(empty.rows[0]?.n, 0);
  });
});

test("retired dispatch never falls back to offline simulation or creates a new effect", { skip: !process.env.DATABASE_URL }, async () => {
  const [c] = await db.insert(onbCases).values({
    organizationId: DEMO_ORGANIZATION_ID, controllerRetired: true,
    workerName: "__Test Retired Controller__", workerEmail: "retired@example.invalid",
    hireType: "new-hire", workerCategory: "employee", role: "QA", department: "QA", geography: "US",
    legalEntity: "Test", managerName: "Test", recruiterName: "Test", joiningDate: "2026-10-12",
    notes: null, syntheticProvenance: null,
  }).returning();
  try {
    let calls = 0;
    await Promise.all(Array.from({ length: 3 }, () => withCaseDispatchGuard(c.id,
      async () => { calls++; return true; },
      { onOffline: async () => { calls++; return true; } })));
    assert.equal(calls, 0);
    assert.equal((await db.select().from(onbEffectJournal).where(eq(onbEffectJournal.caseId, c.id))).length, 0);
    // A stale already-entered parent context must re-read retirement before
    // a nested provider call; onOffline must not become a simulation fallback.
    await db.update(onbCases).set({ controllerRetired: false }).where(eq(onbCases.id, c.id));
    await withCaseDispatchGuard(c.id, async () => {
      await db.update(onbCases).set({ controllerRetired: true }).where(eq(onbCases.id, c.id));
      await withCaseDispatchGuard(c.id, async () => { calls++; return true; },
        { onOffline: async () => { calls++; return true; } });
      return true;
    });
    assert.equal(calls, 0);
  } finally {
    await db.delete(onbEffectJournal).where(eq(onbEffectJournal.caseId, c.id));
    await db.delete(onbCases).where(eq(onbCases.id, c.id));
  }
});
