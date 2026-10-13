import assert from "node:assert/strict";
import { after, test } from "node:test";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db, pool, organizationsTable, hroMailboxIngress, onbCases, hroEmailRequests } from "@workspace/db";
import type { Tx } from "./offboarding/authority";
import { emailReviewTurnaround } from "./hro-email-turnaround";
import { appendProtectedAuditInTransaction } from "./onboarding/protected-audit";

after(() => pool.end());

test("retained cohorts keep correlation queries and aggregate payloads bounded", async t => {
  const rollback = new Error("rollback volume fixtures");
  await assert.rejects(db.transaction(async tx => {
    const org = `volume-${randomUUID()}`;
    await tx.insert(organizationsTable).values({ id: org, name: "Offline volume fixture",
      slug: org, joinCodeHash: "unused", createdByUserId: "fixture" });
    await tx.insert(hroMailboxIngress).values({ id: org, organizationId: org, token: org,
      allowedSenders: [], createdBy: "fixture", enabled: 0, approval: {
        actor: "fixture", authorityId: "fixture", authorityRevision: 1, scope: "fixture",
        reference: "offline-only", generation: 1, recordedAt: "2026-01-01T00:00:00Z",
        provenance: "human-source-attested",
      } });
    const asOf = new Date("2026-10-01T00:00:00Z");
    const [synthetic] = await tx.insert(onbCases).values({ organizationId: org, workerName: "Fixture",
      workerEmail: "denied@example.invalid", hireType: "external-fte", workerCategory: "employee",
      role: "Fixture", department: "Fixture", geography: "IN", legalEntity: "Fixture",
      managerName: "Fixture", recruiterName: "Fixture", joiningDate: "2026-01-01",
      syntheticProvenance: "synthetic-reset" }).returning();
    await tx.insert(hroEmailRequests).values({ id: `${org}-synthetic`, organizationId: org,
      ingressId: org, mailboxAddress: "offline@example.invalid", providerMessageId: `${org}-synthetic`,
      caseId: synthetic.id, status: "converted", reviewedBy: "private-reviewer",
      createdAt: new Date(asOf.getTime() - 200 * 3600_000) });
    for (const action of ["email-intake-reviewed", "email-intake-converted-held"]) {
      await appendProtectedAuditInTransaction(tx, { organizationId: org, actorId: "private-reviewer",
        actorKind: "authenticated", actorAuthority: "fixture-only", action: `offboarding.${action}`,
        outcome: "success", objectType: "separation", objectId: `${org}-synthetic`,
        source: "offboarding", occurredAt: asOf });
    }
    const dialect = new PgDialect();
    const measuredIds: number[] = [];
    const age = (n: number) => n % 8 === 4 ? 100 : n % 8 === 5 ? 20 : [0, 24, 72, 168][n % 4];
    const delay = (n: number) => Math.min(age(n), n % 3);
    const duration = (values: number[], missingEvidenceCount: number) => {
      values.sort((a, b) => a - b);
      const percentile = (p: number) => {
        const index = (values.length - 1) * p, lower = Math.floor(index);
        return values[lower] + (values[Math.ceil(index)] - values[lower]) * (index - lower);
      };
      return { sampleCount: values.length, missingEvidenceCount,
        meanHours: values.reduce((a, b) => a + b, 0) / values.length,
        medianHours: percentile(0.5), p90Hours: percentile(0.9) };
    };
    for (const size of [10_000, 100_000]) {
      await tx.execute(sql`
        insert into hro_email_requests
          (id, organization_id, ingress_id, mailbox_address, provider_message_id, status,
            reviewed_by, created_at, updated_at)
        select ${org} || '-' || lpad(n::text, 6, '0'), ${org}, ${org}, 'offline@example.invalid',
          ${org} || '-' || n,
          case n % 8 when 4 then 'converted' when 5 then 'rejected' else 'needs-review' end,
          case n % 8 when 6 then 'private-reviewer' else null end,
          ${asOf}::timestamptz - (case n % 8 when 4 then 100 when 5 then 20
            else (array[0,24,72,168])[1 + n % 4] end) * interval '1 hour',
          ${asOf}::timestamptz + interval '1000 hours'
        from generate_series(${size === 10_000 ? 1 : 10_001}::integer, ${size}::integer) n
      `);
      // Sparse historical audits in a large retained queue, including references
      // around page boundaries and evidence with no mutable reviewer marker.
      for (const n of size === 10_000 ? [998, 999, 1000, 1001, 1004, 1005, 9996] :
        [10001, 10004, 10005, 10006, 99996, 99999, 100000]) {
        measuredIds.push(n);
        const event = (action: string, hours: number) => appendProtectedAuditInTransaction(tx, {
          organizationId: org, actorId: "private-reviewer", actorKind: "authenticated",
          actorAuthority: "fixture-only", action: `offboarding.${action}`, outcome: "success",
          objectType: "separation", objectId: `${org}-${String(n).padStart(6, "0")}`,
          source: "offboarding", occurredAt: new Date(asOf.getTime() + (hours - age(n)) * 3600_000),
        });
        await event(n % 8 === 5 ? "email-intake-rejected" : "email-intake-reviewed", delay(n));
        await event("email-intake-reviewed", Math.min(age(n), delay(n) + 1));
        if (n % 8 === 4) await event("email-intake-converted-held", delay(n) + 3);
      }
      let maxParameterBytes = 0, maxReturnedRows = 0, queries = 0;
      const measuredTx = new Proxy(tx, {
        get(target, property, receiver) {
          if (property !== "execute") return Reflect.get(target, property, receiver);
          return async (query: Parameters<Tx["execute"]>[0]) => {
            const compiled = dialect.sqlToQuery(query as ReturnType<typeof sql>);
            maxParameterBytes = Math.max(maxParameterBytes, Buffer.byteLength(JSON.stringify(compiled.params)));
            queries++;
            const result = await target.execute(query);
            maxReturnedRows = Math.max(maxReturnedRows, result.rows.length);
            return result;
          };
        },
      }) as Tx;
      const start = performance.now();
      const result = await emailReviewTurnaround(measuredTx, org, asOf);
      t.diagnostic(JSON.stringify({ size, elapsedMs: Math.round(performance.now() - start),
        maxParameterBytes, maxReturnedRows, queries, responseBytes: Buffer.byteLength(JSON.stringify(result)) }));
      assert.deepEqual(result.waiting, { under24Hours: size / 8, from24To72Hours: size / 8,
        from72To168Hours: size / 4, atLeast168Hours: size / 4 });
      assert.deepEqual(result.firstReview, duration(measuredIds.map(delay),
        3 * size / 8 - measuredIds.filter(n => [4, 5, 6].includes(n % 8)).length));
      const conversions = measuredIds.filter(n => n % 8 === 4);
      assert.deepEqual(result.heldConversion, duration(conversions.map(n => delay(n) + 3),
        size / 8 - conversions.length));
      assert.ok(maxParameterBytes < 150_000, `unbounded SQL parameters: ${maxParameterBytes}`);
      assert.ok(maxReturnedRows <= 1000, `unbounded correlation rows: ${maxReturnedRows}`);
      // Payload grows with receipt periods, not with retained request volume.
      // This fixture spans two weeks and two months at both queue sizes.
      const { cohorts, ...overall } = result;
      assert.ok(Buffer.byteLength(JSON.stringify(overall)) < 1000);
      for (const periods of [cohorts.weekly, cohorts.monthly]) {
        assert.equal(periods.length, 2);
        assert.equal(periods.reduce((sum, c) => sum + c.requestCount, 0), size);
        assert.equal(periods.reduce((sum, c) => sum + c.pendingCount, 0), 3 * size / 4);
        assert.equal(periods.reduce((sum, c) => sum + c.firstReview.sampleCount, 0), result.firstReview.sampleCount);
        assert.equal(periods.reduce((sum, c) => sum + c.firstReview.missingEvidenceCount, 0), result.firstReview.missingEvidenceCount);
        assert.equal(periods.reduce((sum, c) => sum + c.heldConversion.sampleCount, 0), result.heldConversion.sampleCount);
        assert.equal(periods.reduce((sum, c) => sum + c.heldConversion.missingEvidenceCount, 0), result.heldConversion.missingEvidenceCount);
        for (const period of periods) assert.ok(Buffer.byteLength(JSON.stringify(period)) < 1000);
      }
      assert.ok(!JSON.stringify(result).includes("private-reviewer"));
      const remaining = await tx.execute(sql`select count(*)::integer as count from pg_class
        where relnamespace = pg_my_temp_schema() and relname like 'email_review_refs_%'`);
      assert.equal(remaining.rows[0].count, 0, "successful summaries release temporary correlation tables");
      const cursors = await tx.execute(sql`select count(*)::integer as count from pg_cursors
        where name like 'email_review_cursor_%'`);
      assert.equal(cursors.rows[0].count, 0, "successful summaries close their correlation cursors");
    }
    const failure = new Error("interrupted summary fixture");
    await assert.rejects(tx.transaction(async nested => {
      const interrupted = new Proxy(nested, {
        get(target, property, receiver) {
          if (property !== "execute") return Reflect.get(target, property, receiver);
          return async (query: Parameters<Tx["execute"]>[0]) => {
            if (dialect.sqlToQuery(query as ReturnType<typeof sql>).sql.startsWith("fetch")) throw failure;
            return target.execute(query);
          };
        },
      }) as Tx;
      await emailReviewTurnaround(interrupted, org, asOf);
    }), error => error === failure);
    const leftovers = await tx.execute(sql`select count(*)::integer as count from pg_class
      where relnamespace = pg_my_temp_schema() and relname like 'email_review_refs_%'`);
    assert.equal(leftovers.rows[0].count, 0, "rollback releases interrupted correlation work");
    throw rollback;
  }), error => error === rollback);
});
