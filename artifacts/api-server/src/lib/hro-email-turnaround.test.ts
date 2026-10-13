import assert from "node:assert/strict";
import { after, test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable, hroMailboxIngress, hroEmailRequests, onbCases } from "@workspace/db";
import { GetHroEmailIntakeResponse } from "@workspace/api-zod";
import { appendProtectedAuditInTransaction, type ProtectedAuditInput } from "./onboarding/protected-audit";
import { emailReviewTurnaround } from "./hro-email-turnaround";

after(() => pool.end());

test("review turnaround uses tenant-bound dated human audits, exact age bands and no private dimensions", async () => {
  const org = `turnaround-${randomUUID()}`, other = `${org}-other`;
  const asOf = new Date("2026-10-13T00:00:00Z"), at = (hours: number) => new Date(asOf.getTime() + hours * 3600_000);
  const rollback = new Error("rollback isolated fixtures");
  await assert.rejects(db.transaction(async tx => {
    for (const id of [org, other]) {
      await tx.insert(organizationsTable).values({ id, name: "Offline metric fixture", slug: id,
        joinCodeHash: `${id}-unused`, createdByUserId: "fixture" });
      await tx.insert(hroMailboxIngress).values({ id: `${id}-route`, organizationId: id, token: id,
        allowedSenders: [], createdBy: "fixture", enabled: 0, approval: {
          actor: "fixture", authorityId: "fixture", authorityRevision: 1, scope: "fixture",
          reference: "offline-only", generation: 1, recordedAt: at(-300).toISOString(), provenance: "human-source-attested",
        } });
    }
    const request = async (suffix: string, age: number, status = "needs-review", tenant: string | null = org, reviewed = false) => {
      const id = `${org}-${suffix}`;
      await tx.insert(hroEmailRequests).values({ id, organizationId: tenant, ingressId: tenant ? `${tenant}-route` : null,
        mailboxAddress: `${org}@example.invalid`, providerMessageId: id, status,
        createdAt: at(-age), updatedAt: at(1000), reviewedBy: reviewed ? "private-reviewer" : null,
        fields: tenant ? { worker_name: "PRIVATE EMPLOYEE" } : {}, attachments: [{ name: "PRIVATE FILE", status: "quarantined" }] });
      return id;
    };
    const event = async (id: string, action: string, hours: number,
      tenant = org, actorKind: ProtectedAuditInput["actorKind"] = "authenticated", outcome: ProtectedAuditInput["outcome"] = "success") => {
      await appendProtectedAuditInTransaction(tx, { organizationId: tenant, actorId: "private-reviewer",
        actorKind, actorAuthority: "fixture-only", action: `offboarding.${action}`, outcome,
        objectType: "separation", objectId: id, source: "offboarding", occurredAt: at(hours) });
    };
    const read = () => emailReviewTurnaround(tx, org, asOf);
    const empty = await read();
    assert.deepEqual(empty.waiting, { under24Hours: 0, from24To72Hours: 0, from72To168Hours: 0, atLeast168Hours: 0 });
    assert.deepEqual(empty.firstReview, { sampleCount: 0, missingEvidenceCount: 0, meanHours: null, medianHours: null, p90Hours: null });
    assert.deepEqual(empty.cohorts, { basis: "recorded-intake-receipt", timeZone: "UTC", weekly: [], monthly: [] });
    await request("young", 0, "received");
    const reviewed = await request("24", 24, "needs-review", org, true);
    await request("72", 72, "blocked");
    await request("168", 168, "blocked");
    await request("future", -1);
    await request("unbound", 200, "blocked", null);
    await request("other", 200, "blocked", other);
    const converted = await request("converted", 100, "converted", org, true);
    const rejected = await request("rejected", 20, "rejected", org, true);
    await request("legacy-converted", 80, "converted", org, true);
    const invalid = await request("invalid-review", 2, "rejected", org, true);
    await event(reviewed, "email-intake-reviewed", -12); // 12 hours
    await event(reviewed, "email-intake-reviewed", -1); // repeated review must not replace first
    await event(converted, "email-intake-reviewed", -90); // 10 hours
    await event(converted, "email-intake-converted-held", -80); // 20 hours
    await event(rejected, "email-intake-rejected", -18); // 2 hours
    await event(invalid, "email-intake-reviewed", -3); // before receipt
    await event(invalid, "email-intake-reviewed", 1); // future
    await event(invalid, "email-intake-reviewed", -1, other); // wrong tenant, even same object
    await event(invalid, "email-intake-reviewed", -1, org, "system"); // simulated/system
    await event(invalid, "email-intake-reviewed", -1, org, "authenticated", "denied");
    const [synthetic] = await tx.insert(onbCases).values({ organizationId: org, workerName: "Fixture", workerEmail: "denied@example.invalid",
      hireType: "external-fte", workerCategory: "employee", role: "Fixture", department: "Fixture", geography: "IN",
      legalEntity: "Fixture", managerName: "Fixture", recruiterName: "Fixture", joiningDate: "2026-01-01",
      syntheticProvenance: "synthetic-reset" }).returning();
    const simulated = await request("synthetic", 200, "converted", org, true);
    await tx.update(hroEmailRequests).set({ caseId: synthetic.id }).where(eq(hroEmailRequests.id, simulated));
    await event(simulated, "email-intake-reviewed", -10);
    await event(simulated, "email-intake-converted-held", -5);
    const summary = await read();
    assert.deepEqual(summary.waiting, { under24Hours: 1, from24To72Hours: 1, from72To168Hours: 1, atLeast168Hours: 1 });
    assert.equal(summary.firstReview.sampleCount, 3);
    assert.equal(summary.firstReview.missingEvidenceCount, 2);
    assert.equal(summary.firstReview.meanHours, 8);
    assert.equal(summary.firstReview.medianHours, 10);
    assert.ok(Math.abs(summary.firstReview.p90Hours! - 11.6) < 0.000001);
    assert.deepEqual(summary.heldConversion, { sampleCount: 1, missingEvidenceCount: 1, meanHours: 20, medianHours: 20, p90Hours: 20 });
    GetHroEmailIntakeResponse.shape.turnaround.parse(summary);
    assert.deepEqual(Object.keys(summary).sort(), ["asOf", "cohorts", "firstReview", "heldConversion", "waiting"]);
    assert.ok(!JSON.stringify(summary).includes("PRIVATE"));
    for (const periods of [summary.cohorts.weekly, summary.cohorts.monthly]) {
      assert.equal(periods.reduce((sum, c) => sum + c.requestCount, 0), 8);
      assert.equal(periods.reduce((sum, c) => sum + c.pendingCount, 0), 4);
      assert.equal(periods.reduce((sum, c) => sum + c.firstReview.sampleCount, 0), 3);
      assert.equal(periods.reduce((sum, c) => sum + c.firstReview.missingEvidenceCount, 0), 2);
      assert.equal(periods.reduce((sum, c) => sum + c.heldConversion.sampleCount, 0), 1);
      assert.equal(periods.reduce((sum, c) => sum + c.heldConversion.missingEvidenceCount, 0), 1);
    }
    // A later mutable update cannot alter any measured duration or waiting age.
    await tx.update(hroEmailRequests).set({ updatedAt: at(-1) }).where(eq(hroEmailRequests.organizationId, org));
    assert.deepEqual(await read(), summary);
    // Cohorts follow receipt, not the human event date, with exact UTC boundaries.
    const priorMonth = await request("sep-boundary", 312, "converted", org, true); // Sep 30
    await event(priorMonth, "email-intake-reviewed", -264); // Oct 2; 48h
    await event(priorMonth, "email-intake-converted-held", -240); // Oct 3; 72h
    const monthStart = await request("oct-boundary", 288, "rejected", org, true); // Oct 1 midnight
    await event(monthStart, "email-intake-rejected", -287); // 1h
    await request("sunday", 193, "blocked"); // Oct 4, 23:00
    await request("monday", 192, "blocked"); // Oct 5, 00:00
    const comparison = await read();
    const [october, september] = comparison.cohorts.monthly;
    assert.equal(october.startAt, "2026-10-01T00:00:00.000Z");
    assert.equal(october.endAt, "2026-11-01T00:00:00.000Z");
    assert.equal(october.requestCount, 11);
    assert.equal(september.startAt, "2026-09-01T00:00:00.000Z");
    assert.equal(september.endAt, october.startAt);
    assert.equal(september.requestCount, 1);
    assert.equal(september.pendingCount, 0);
    assert.equal(september.firstReview.meanHours, 48);
    assert.equal(september.heldConversion.meanHours, 72);
    const weeks = comparison.cohorts.weekly;
    assert.deepEqual(weeks.map(c => c.startAt), [
      "2026-10-12T00:00:00.000Z", "2026-10-05T00:00:00.000Z", "2026-09-28T00:00:00.000Z",
    ]);
    assert.equal(weeks[2].requestCount, 3); // Sep 30, Oct 1, Sunday Oct 4
    assert.equal(weeks[2].pendingCount, 1);
    assert.equal(weeks[2].firstReview.sampleCount, 2);
    assert.equal(weeks[2].firstReview.meanHours, 24.5);
    assert.equal(weeks[1].requestCount, 5); // Monday included in new week
    assert.equal(weeks[1].endAt, weeks[0].startAt);
    assert.equal(weeks.reduce((sum, c) => sum + c.pendingCount, 0), 6);
    assert.deepEqual(comparison.waiting, { ...summary.waiting, atLeast168Hours: 3 });
    GetHroEmailIntakeResponse.shape.turnaround.parse(comparison);
    const serialized = JSON.stringify(comparison);
    for (const privateValue of ["PRIVATE", "private-reviewer", org, "example.invalid", "worker_name"]) {
      assert.ok(!serialized.includes(privateValue), privateValue);
    }
    throw rollback;
  }), error => error === rollback);
});
