import { and, eq, lte, sql } from "drizzle-orm";
import { hroEmailRequests, onbAuditEntries, onbCases } from "@workspace/db";
import type { GetHroEmailIntakeResponse } from "@workspace/api-zod";
import type { z } from "zod";
import type { Tx } from "./offboarding/authority";
import { protectedAuditObjectReference } from "./onboarding/protected-audit";

/** Opaque identifiers stay server-side; only aggregate measurements are returned.
 * Mutable timestamps and case completion events are not measurement sources. */
export async function emailReviewTurnaround(tx: Tx, org: string, asOf = new Date()): Promise<z.infer<typeof GetHroEmailIntakeResponse>["turnaround"]> {
  // Protected audit object IDs are pseudonymized (and may be keyed). Reuse
  // the writer's exact server-only helper rather than guessing a SQL hash.
  const ids = (await tx.select({ id: hroEmailRequests.id }).from(hroEmailRequests)
    .where(and(eq(hroEmailRequests.organizationId, org), lte(hroEmailRequests.createdAt, asOf)))).map(r => r.id);
  const references = ids.map(protectedAuditObjectReference);
  const result = await tx.execute(sql`
    with audit_references as (
      select * from unnest(${sql.param(ids)}::text[], ${sql.param(references)}::text[]) as refs(request_id, audit_id)
    ), requests as (
      select r.id, refs.audit_id, r.status, r.created_at, r.reviewed_by is not null as review_recorded
      from ${hroEmailRequests} r join audit_references refs on refs.request_id = r.id
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
      select r.status, r.review_recorded,
        extract(epoch from (${asOf}::timestamptz - r.created_at)) / 3600.0 as age,
        extract(epoch from (e.review_at - r.created_at)) / 3600.0 as review_hours,
        extract(epoch from (e.conversion_at - r.created_at)) / 3600.0 as conversion_hours
      from requests r left join events e on e.object_id = r.audit_id
    )
    select
      count(*) filter (where status in ('received','needs-review','blocked') and age < 24)::integer as under24,
      count(*) filter (where status in ('received','needs-review','blocked') and age >= 24 and age < 72)::integer as from24,
      count(*) filter (where status in ('received','needs-review','blocked') and age >= 72 and age < 168)::integer as from72,
      count(*) filter (where status in ('received','needs-review','blocked') and age >= 168)::integer as from168,
      count(review_hours)::integer as review_count,
      count(*) filter (where (review_recorded or status in ('converted','rejected')) and review_hours is null)::integer as review_missing,
      avg(review_hours)::double precision as review_mean,
      percentile_cont(0.5) within group (order by review_hours) as review_median,
      percentile_cont(0.9) within group (order by review_hours) as review_p90,
      count(conversion_hours)::integer as conversion_count,
      count(*) filter (where status = 'converted' and conversion_hours is null)::integer as conversion_missing,
      avg(conversion_hours)::double precision as conversion_mean,
      percentile_cont(0.5) within group (order by conversion_hours) as conversion_median,
      percentile_cont(0.9) within group (order by conversion_hours) as conversion_p90
    from measured
  `);
  const row = result.rows[0];
  const duration = (prefix: string) => ({
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
    firstReview: duration("review"), heldConversion: duration("conversion"),
  };
}
