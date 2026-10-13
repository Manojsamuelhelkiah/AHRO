import { useState } from 'react';
import type { HroEmailTurnaround } from '@workspace/api-client-react';
import { Card } from '@/components/ui-shared';
import { fmtDate } from './common';

const hours = (value: number | null) => value == null ? 'Not measured' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;

export function ReviewTurnaround({ data }: { data: HroEmailTurnaround }) {
  const [period, setPeriod] = useState<'all' | 'weekly' | 'monthly'>('all');
  const cohorts = period === 'all' ? [] : data.cohorts[period];
  const bands = [
    ['Under 24 hours', data.waiting.under24Hours],
    ['24 to under 72 hours', data.waiting.from24To72Hours],
    ['72 hours to under 7 days', data.waiting.from72To168Hours],
    ['7 days or more', data.waiting.atLeast168Hours],
  ] as const;
  return (
    <Card className="space-y-3 p-4" data-testid="section-review-turnaround">
      <h2 className="text-base font-semibold">Human review turnaround</h2>
      <p className="text-xs text-[var(--text-muted)]">This client only · snapshot {fmtDate(data.asOf)}. Age starts at recorded intake receipt, not Gmail delivery. Pending requests include blocked items and reviewed requests still awaiting conversion.</p>
      <h3 className="text-sm font-medium">Current pending queue by receipt age</h3>
      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
        {bands.map(([label, count]) => <div key={label}><dt className="text-xs text-[var(--text-muted)]">{label}</dt><dd className="font-semibold">{count}</dd></div>)}
      </dl>
      {bands.every(([, count]) => count === 0) && <p className="text-xs text-[var(--text-muted)]">No pending client requests.</p>}
      <label className="flex flex-wrap items-center gap-2 text-sm">
        Compare receipt cohorts
        <select aria-label="Compare receipt cohorts" value={period}
          onChange={event => setPeriod(event.target.value as typeof period)}
          className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2">
          <option value="all">All retained requests</option>
          <option value="weekly">Weekly (Monday start, UTC)</option>
          <option value="monthly">Monthly (calendar month, UTC)</option>
        </select>
      </label>
      <p className="text-xs text-[var(--text-muted)]">Cohorts use recorded intake receipt dates, not human event dates. Period starts are inclusive and ends exclusive in UTC. Only periods with retained eligible requests appear, newest first; this is not a complete history of deleted requests. Current periods are partial. Reviews and held conversions after a receipt period ends still count through this snapshot. Pending counts are current, not historical backlog. Switching cohorts does not filter the current pending queue above.</p>
      {period !== 'all' && cohorts.length === 0 && <p className="text-sm">No retained requests for receipt-cohort comparison.</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-2 text-left text-xs text-[var(--text-muted)]">Measured durations {period === 'all' ? 'across all retained client requests' : `by ${period} receipt cohort`}, using dated successful human audit events. Repeated reviews count once, at the first review or rejection. Small samples and newer cohorts with pending requests are not evidence of better or worse reviewer performance.</caption>
          {period === 'all' ? <>
          <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-2 pr-3">From receipt to</th><th className="pr-3">Measured requests</th><th className="pr-3">Mean</th><th className="pr-3">Median</th><th className="pr-3">90th percentile</th><th>Missing dated evidence</th></tr></thead>
          <tbody>{([['First human review / rejection', data.firstReview], ['Conversion to held case', data.heldConversion]] as const).map(([label, summary]) => (
            <tr key={label} className="border-t border-[var(--border)]"><th scope="row" className="py-2 pr-3 text-left font-normal">{label}</th><td className="pr-3">{summary.sampleCount}</td><td className="pr-3">{hours(summary.meanHours)}</td><td className="pr-3">{hours(summary.medianHours)}</td><td className="pr-3">{hours(summary.p90Hours)}</td><td>{summary.missingEvidenceCount}</td></tr>
          ))}</tbody>
          </> : <ReceiptCohortRows data={cohorts} asOf={data.asOf} />}
        </table>
      </div>
      <p className="text-xs text-[var(--text-muted)]">Missing evidence counts requests marked reviewed/final without a usable dated event; those requests are not timed. Open requests without a review are pending, not missing evidence. Unbound platform-triage mail and linked synthetic cases are excluded. After explicit client assignment, timing includes prior intake waiting. These aggregates contain no message content, identities or individual reviewer metrics.</p>
      <p className="rounded-md bg-[var(--surface-alt)] p-2 text-xs">Conversion creates a held case requiring further approvals. It is not a completed HR outcome, evidence approval or operational release.</p>
    </Card>
  );
}

/** Shared by both selector modes; UTC ISO dates avoid browser timezone shifts. */
export function ReceiptCohortRows({ data, asOf }: { data: HroEmailTurnaround['cohorts']['weekly']; asOf: string }) {
  return <>
    <thead><tr className="text-left text-xs text-[var(--text-muted)]">
      {['Receipt period (UTC)', 'Retained requests', 'Pending now', 'From receipt to', 'Measured requests', 'Mean', 'Median', '90th percentile', 'Missing dated evidence']
        .map(label => <th key={label} className="py-2 pr-3">{label}</th>)}
    </tr></thead>
    <tbody>{data.flatMap(cohort => ([
      ['First human review / rejection', cohort.firstReview],
      ['Conversion to held case', cohort.heldConversion],
    ] as const).map(([label, summary], index) => <tr key={`${cohort.startAt}-${index}`} className="border-t border-[var(--border)]">
      {index === 0 && <>
        <th scope="rowgroup" rowSpan={2} className="py-2 pr-3 text-left font-normal whitespace-nowrap">
          {cohort.startAt.slice(0, 10)} to {cohort.endAt.slice(0, 10)} (exclusive)
          {Date.parse(cohort.endAt) > Date.parse(asOf) && <span className="block text-xs text-[var(--text-muted)]">Partial period</span>}
        </th>
        <td rowSpan={2} className="pr-3">{cohort.requestCount}</td>
        <td rowSpan={2} className="pr-3">{cohort.pendingCount}</td>
      </>}
      <th scope="row" className="py-2 pr-3 text-left font-normal">{label}</th>
      <td className="pr-3">{summary.sampleCount}</td><td className="pr-3">{hours(summary.meanHours)}</td>
      <td className="pr-3">{hours(summary.medianHours)}</td><td className="pr-3">{hours(summary.p90Hours)}</td>
      <td>{summary.missingEvidenceCount}</td>
    </tr>))}</tbody>
  </>;
}
