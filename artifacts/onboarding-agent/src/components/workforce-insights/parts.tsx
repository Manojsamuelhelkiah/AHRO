import { Link } from 'wouter';
import type { WorkforceReviewCase, WorkforceWarningKind } from '@workspace/api-client-react';

export const KIND_LABEL: Record<WorkforceWarningKind, string> = {
  'talent-risk': 'Talent at risk',
  'resume-integrity': 'Resume integrity review',
};
export const STATUS_LABEL: Record<WorkforceReviewCase['status'], string> = {
  open: 'Open', 'in-progress': 'In progress', resolved: 'Resolved', dismissed: 'Dismissed',
};
export const isLive = (r: WorkforceReviewCase) => r.status === 'open' || r.status === 'in-progress';

const chip = 'inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold';

/** Model indicator: no model is connected, so this is always grey and never numeric. */
export function NotAssessed({ kind }: { kind?: WorkforceWarningKind }) {
  return (
    <span className={chip} style={{ background: 'var(--status-gray-bg)', color: 'var(--status-gray-fg)' }} data-testid={`indicator-not-assessed${kind ? `-${kind}` : ''}`}>
      Not assessed
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: WorkforceReviewCase['priority'] }) {
  const crit = priority === 'critical';
  return (
    <span className={chip} title="Human review priority set by a person. It is not a model risk score."
      style={{ background: crit ? 'var(--status-red-bg)' : 'var(--surface-alt)', color: crit ? 'var(--status-red-fg)' : 'var(--text-secondary)', border: '1px solid var(--border)' }}>
      Review priority: {crit ? 'Critical' : 'Standard'}
    </span>
  );
}

export function ReviewStatusBadge({ status }: { status: WorkforceReviewCase['status'] }) {
  const m = {
    open: ['var(--status-amber-bg)', 'var(--status-amber-fg)'],
    'in-progress': ['var(--status-info-bg)', 'var(--status-info-fg)'],
    resolved: ['var(--status-green-bg)', 'var(--status-green-fg)'],
    dismissed: ['var(--status-gray-bg)', 'var(--status-gray-fg)'],
  }[status];
  return <span className={chip} style={{ background: m[0], color: m[1] }}>{STATUS_LABEL[status]}</span>;
}

export function Legend() {
  const items: [string, string, string][] = [
    ['Red', 'Higher model concern', 'var(--status-red)'],
    ['Amber', 'Moderate model concern', 'var(--status-amber)'],
    ['Green', 'Lower model concern', 'var(--status-green)'],
    ['Grey', 'Insufficient data / not assessed', 'var(--status-gray)'],
  ];
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[12px] text-[var(--text-secondary)]" aria-label="Model indicator legend">
      {items.map(([n, d, c]) => (
        <li key={n} className="flex items-center gap-1.5"><span aria-hidden className="h-2.5 w-2.5 rounded-full" style={{ background: c }} /><strong>{n}</strong> {d}</li>
      ))}
    </ul>
  );
}

export function ReviewLinks({ review }: { review: WorkforceReviewCase }) {
  return (
    <span className="flex flex-wrap gap-3 text-[12px] font-semibold">
      <Link href={`/analytics#review-${review.id}`} className="inline-flex min-h-11 items-center text-[var(--primary)] hover:underline focus-visible:outline focus-visible:outline-2" data-testid={`link-review-${review.id}`}>Review details</Link>
      <Link href={`/cases/${review.caseId}`} className="inline-flex min-h-11 items-center text-[var(--primary)] hover:underline focus-visible:outline focus-visible:outline-2" data-testid={`link-source-case-${review.id}`}>Source case</Link>
    </span>
  );
}

export const field = 'h-10 w-full min-w-0 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2.5 text-[13px] focus:border-[var(--primary)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]';
export const fmtDate = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(); };
