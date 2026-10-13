import type { HroEmailTurnaround } from '@workspace/api-client-react';
import { Card } from '@/components/ui-shared';
import { fmtDate } from './common';

const hours = (value: number | null) => value == null ? 'Not measured' : `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;

export function ReviewTurnaround({ data }: { data: HroEmailTurnaround }) {
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
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <caption className="mb-2 text-left text-xs text-[var(--text-muted)]">Measured durations across all retained client requests, using dated successful human audit events. Repeated reviews count once, at the first review or rejection.</caption>
          <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-2 pr-3">From receipt to</th><th className="pr-3">Measured requests</th><th className="pr-3">Mean</th><th className="pr-3">Median</th><th className="pr-3">90th percentile</th><th>Missing dated evidence</th></tr></thead>
          <tbody>{([['First human review / rejection', data.firstReview], ['Conversion to held case', data.heldConversion]] as const).map(([label, summary]) => (
            <tr key={label} className="border-t border-[var(--border)]"><th scope="row" className="py-2 pr-3 text-left font-normal">{label}</th><td className="pr-3">{summary.sampleCount}</td><td className="pr-3">{hours(summary.meanHours)}</td><td className="pr-3">{hours(summary.medianHours)}</td><td className="pr-3">{hours(summary.p90Hours)}</td><td>{summary.missingEvidenceCount}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--text-muted)]">Missing evidence counts requests marked reviewed/final without a usable dated event; those requests are not timed. Open requests without a review are pending, not missing evidence. Unbound platform-triage mail and linked synthetic cases are excluded. After explicit client assignment, timing includes prior intake waiting. These aggregates contain no message content, identities or individual reviewer metrics.</p>
      <p className="rounded-md bg-[var(--surface-alt)] p-2 text-xs">Conversion creates a held case requiring further approvals. It is not a completed HR outcome, evidence approval or operational release.</p>
    </Card>
  );
}
