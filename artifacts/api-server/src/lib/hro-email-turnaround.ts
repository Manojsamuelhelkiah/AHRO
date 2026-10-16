import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { hroEmailRequests, onbAuditEntries, onbCases } from "@workspace/db";
import type { GetHroEmailIntakeResponse } from "@workspace/api-zod";
import type { z } from "zod";
import type { Tx } from "./offboarding/authority";
import { protectedAuditObjectReference } from "./onboarding/protected-audit";

/** Opaque identifiers stay server-side; only aggregate measurements are returned.
 * Mutable timestamps and case completion events are not measurement sources. */
export async function emailReviewTurnaround(tx: Tx, org: string, asOf = new Date()): Promise<z.infer<typeof GetHroEmailIntakeResponse>["turnaround"]> {
  // Keep the retained cohort in PostgreSQL, not an unbounded JS array or
  // query parameter. A private transaction-local table avoids persistent
  // correlation state/key-rotation invalidation. It contains identifiers only.
  // Unique names allow repeated/concurrent calls in the same transaction.
  const suffix = randomUUID().replaceAll("-", "");
  const refs = sql.identifier(`email_review_refs_${suffix}`);
  const cursor = sql.identifier(`email_review_cursor_${suffix}`);
  await tx.execute(sql`create temporary table ${refs}
    (request_id text not null, audit_id text not null) on commit drop`);
  // A forward-only cursor holds one cohort snapshot without OFFSET scans or
  // repeatedly updating/indexing the entire temporary mapping.
  await tx.execute(sql`declare ${cursor} no scroll cursor for
    select r.id as request_id from ${hroEmailRequests} r
    where r.organization_id = ${org} and r.created_at <= ${asOf}
      and not exists (select 1 from ${onbCases} c where c.organization_id = ${org}
        and c.id = r.case_id and c.synthetic_provenance is not null)`);
  for (;;) {
    const page = await tx.execute<{ request_id: string }>(sql`fetch forward 1000 from ${cursor}`);
    if (page.rows.length === 0) break;
    const ids = page.rows.map(r => r.request_id);
    // Reuse the writer's compaction, already-opaque and keyed HMAC rules.
    // Neither the key nor any employee/private fields enter SQL or responses.
    const references = ids.map(protectedAuditObjectReference);
    await tx.execute(sql`insert into ${refs} (request_id, audit_id)
      select * from unnest(${sql.param(ids)}::text[], ${sql.param(references)}::text[])`);
    if (ids.length < 1000) break;
  }
  await tx.execute(sql`close ${cursor}`);
  await tx.execute(sql`analyze ${refs}`);
  const result = await tx.execute(sql`
    with requests as (
       select r.id, refs.audit_id, r.status, r.created_at, r.conversion_origin, r.reviewed_by is not null as review_recorded
      from ${hroEmailRequests} r join ${refs} refs on refs.request_id = r.id
      where r.organization_id = ${org} and r.created_at <= ${asOf}
        and not exists (
          select 1 from ${onbCases} c where c.organization_id = ${org}
            and c.id = r.case_id and c.synthetic_provenance is not null
        )
    ), events as (
      select a.object_id,
        min(a.occurred_at) filter (where a.action in
          ('offboarding.email-intake-reviewed', 'offboarding.email-intake-rejected')) as review_at,
        min(a.occurred_at) filter (where a.action = 'offboarding.email-intake-converted-held') as conversion_at
      from ${onbAuditEntries} a join requests r on r.audit_id = a.object_id
      where a.organization_id = ${org} and a.actor_kind = 'authenticated'
        and a.outcome = 'success' and a.source = 'offboarding' and a.object_type = 'separation'
        and a.action in ('offboarding.email-intake-reviewed', 'offboarding.email-intake-rejected',
          'offboarding.email-intake-converted-held')
        and a.occurred_at >= r.created_at and a.occurred_at <= ${asOf}
      group by a.object_id
    ), measured as (
       select r.status, r.review_recorded, r.conversion_origin,
        date_trunc('week', r.created_at at time zone 'UTC') as week_start,
        date_trunc('month', r.created_at at time zone 'UTC') as month_start,
        extract(epoch from (${asOf}::timestamptz - r.created_at)) / 3600.0 as age,
        extract(epoch from (e.review_at - r.created_at)) / 3600.0 as review_hours,
        extract(epoch from (e.conversion_at - r.created_at)) / 3600.0 as conversion_hours
      from requests r left join events e on e.object_id = r.audit_id
    )
    select
      case when grouping(week_start) = 0 then 'weekly'
        when grouping(month_start) = 0 then 'monthly' else 'all' end as cohort_kind,
      coalesce(week_start, month_start) at time zone 'UTC' as cohort_start,
      count(*)::integer as request_count,
      count(*) filter (where status in ('received','needs-review','blocked'))::integer as pending_count,
      count(*) filter (where status in ('received','needs-review','blocked') and age < 24)::integer as under24,
      count(*) filter (where status in ('received','needs-review','blocked') and age >= 24 and age < 72)::integer as from24,
      count(*) filter (where status in ('received','needs-review','blocked') and age >= 72 and age < 168)::integer as from72,
      count(*) filter (where status in ('received','needs-review','blocked') and age >= 168)::integer as from168,
      count(review_hours)::integer as review_count,
       count(*) filter (where (review_recorded or status in ('converted','rejected')) and conversion_origin is distinct from 'automatic' and review_hours is null)::integer as review_missing,
      avg(review_hours)::double precision as review_mean,
      percentile_cont(0.5) within group (order by review_hours) as review_median,
      percentile_cont(0.9) within group (order by review_hours) as review_p90,
      count(conversion_hours)::integer as conversion_count,
       count(*) filter (where status = 'converted' and conversion_origin is distinct from 'automatic' and conversion_hours is null)::integer as conversion_missing,
      avg(conversion_hours)::double precision as conversion_mean,
      percentile_cont(0.5) within group (order by conversion_hours) as conversion_median,
      percentile_cont(0.9) within group (order by conversion_hours) as conversion_p90
    from measured
    group by grouping sets ((), (week_start), (month_start))
    order by cohort_start desc nulls last
  `);
  // Successful reads release disk space immediately even inside a long
  // transaction. On errors PostgreSQL's rollback/ON COMMIT DROP owns cleanup;
  // do not mask the original error with a query in an aborted transaction.
  await tx.execute(sql`drop table ${refs}`);
  const row = result.rows.find(r => r.cohort_kind === "all")!;
  const duration = (row: Record<string, unknown>, prefix: string) => ({
    sampleCount: Number(row[`${prefix}_count`]),
    missingEvidenceCount: Number(row[`${prefix}_missing`]),
    meanHours: row[`${prefix}_mean`] == null ? null : Number(row[`${prefix}_mean`]),
    medianHours: row[`${prefix}_median`] == null ? null : Number(row[`${prefix}_median`]),
    p90Hours: row[`${prefix}_p90`] == null ? null : Number(row[`${prefix}_p90`]),
  });
  return {
    asOf: asOf.toISOString(),
    waiting: { under24Hours: Number(row.under24), from24To72Hours: Number(row.from24),
      from72To168Hours: Number(row.from72), atLeast168Hours: Number(row.from168) },
    firstReview: duration(row, "review"), heldConversion: duration(row, "conversion"),
    cohorts: {
      basis: "recorded-intake-receipt", timeZone: "UTC",
      weekly: cohorts("weekly"), monthly: cohorts("monthly"),
    },
  };

  function cohorts(kind: "weekly" | "monthly") {
    return result.rows.filter(r => r.cohort_kind === kind).map(r => {
      const start = new Date(r.cohort_start as string | Date);
      const end = new Date(start);
      if (kind === "weekly") end.setUTCDate(end.getUTCDate() + 7);
      else end.setUTCMonth(end.getUTCMonth() + 1);
      return {
        startAt: start.toISOString(), endAt: end.toISOString(),
        requestCount: Number(r.request_count), pendingCount: Number(r.pending_count),
        firstReview: duration(r, "review"), heldConversion: duration(r, "conversion"),
      };
    });
  }
}
