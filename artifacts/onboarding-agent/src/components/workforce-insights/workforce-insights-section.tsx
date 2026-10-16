import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Button, Input } from '@/components/ui-shared';
import type { WorkforceReviewCase, WorkforceWarningKind } from '@workspace/api-client-react';
import { useWorkforceScope } from './use-workforce-insights';
import { CreateReviewDialog, EditReviewDialog } from './review-dialogs';
import { KIND_LABEL, Legend, NotAssessed, PriorityBadge, ReviewStatusBadge, field, fmtDate, isLive } from './parts';

export function WorkforceInsightsSection() {
  const scope = useWorkforceScope();
  const { organizationId, data, denied, failed, query } = scope;
  const [search, setSearch] = useState('');
  const [statusF, setStatusF] = useState('');
  const [kindF, setKindF] = useState('');
  const [create, setCreate] = useState<{ caseId?: number; kind?: WorkforceWarningKind } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);

  // Clear dialog state and filters when the organization changes.
  useEffect(() => { setCreate(null); setEditId(null); setSearch(''); }, [organizationId]);

  const subjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    const examples = new Set(data?.riskExamples?.map(row => row.caseId) ?? []);
    return (data?.subjects ?? []).filter((s) => !q || `${s.displayName} ${s.reference}`.toLowerCase().includes(q))
      .sort((a, b) => Number(examples.has(b.caseId)) - Number(examples.has(a.caseId)));
  }, [data, search]);
  const reviews = useMemo(() => (data?.reviews ?? []).filter((r) => (!statusF || r.status === statusF) && (!kindF || r.kind === kindF)), [data, statusF, kindF]);
  const ownerLabel = (id: string) => data?.owners.find((o) => o.userId === id)?.label ?? id;
  const subjectOf = (r: WorkforceReviewCase) => data?.subjects.find((s) => s.caseId === r.caseId);
  const editing = data?.reviews.find((r) => r.id === editId);

  useEffect(() => {
    if (!data || !window.location.hash.startsWith('#review-')) return;
    const id = window.location.hash.slice(8);
    if (data.reviews.some((r) => r.id === id)) {
      document.getElementById(`review-${id}`)?.scrollIntoView({ block: 'center' });
    }
  }, [data]);

  return (
    <section className="mb-14" id="early-warning" data-testid="section-early-warning">
      <div className="mb-4 flex flex-col justify-between gap-3 md:flex-row md:items-end">
        <div>
          <h2 className="m-0 text-[22px] font-semibold tracking-tight text-[var(--text-primary)]">Early Warning: Talent at Risk and Resume Integrity</h2>
          <p className="mt-1 text-[14px] text-[var(--text-muted)]">Retention priorities, supportive follow-ups and resume verification reviews.</p>
        </div>
        {data?.canManage && <Button onClick={() => setCreate({})} disabled={data.subjects.length === 0} data-testid="button-new-review">Start human review</Button>}
      </div>

      {!organizationId ? <Notice>Select an organization to view early-warning reviews.</Notice>
        : denied ? <Notice testid="text-unavailable">Early-warning insights are unavailable. Administrator access is required.</Notice>
        : failed ? <Notice>Early-warning insights could not be loaded. <Button size="sm" variant="outline" className="ml-2" onClick={() => void query.refetch()}>Retry</Button></Notice>
        : !data ? <div className="h-32 animate-pulse rounded-[var(--radius-lg)] bg-[var(--surface-alt)]" aria-busy="true" />
        : (
          <div className="space-y-5">
            <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-[var(--shadow-sm)]">
              <div className="flex flex-wrap items-center gap-2 text-[13px]"><strong>Prediction model:</strong><span className="text-[var(--text-muted)]">Not connected</span></div>
              <div className="mt-2"><Legend /></div>
              <p className="mb-0 mt-2 text-[12px] text-[var(--text-muted)]" data-testid="text-coverage-note">{data.coverageNote}</p>
            </div>

            {!!data.riskExamples?.length && <div>
              <h3 className="mb-2 text-[15px] font-semibold">Talent at Risk</h3>
              <div className="grid min-w-0 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {data.riskExamples.map(example => {
                  const subject = data.subjects.find(row => row.caseId === example.caseId);
                  const review = data.reviews.find(row => row.caseId === example.caseId && row.kind === 'talent-risk' && isLive(row));
                  return <article key={example.id} className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4" data-testid={`risk-example-${example.caseId}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/cases/${example.caseId}`} className="font-semibold text-[var(--primary)] hover:underline">{subject?.displayName}</Link>
                      <span className="font-mono text-[12px]">{subject?.reference}</span>
                    </div>
                    <div className="my-3 flex flex-wrap items-center gap-2"><RiskBand band={example.band} /><strong className="text-[22px]">{Math.round((example.probability ?? 0) * 100)}%</strong><span className="text-[12px] text-[var(--text-muted)]">over {example.horizonDays} days</span></div>
                    <p className="text-[13px]">{example.factors.join(' ')}</p>
                    <p className="text-[12px] text-[var(--text-secondary)]">{example.recommendedActions.join(' ')}</p>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]">
                      <span className="text-[var(--text-muted)]">As of {fmtDate(example.assessedAt)}</span>
                      {review ? <a href={`#review-${review.id}`} className="inline-flex min-h-10 items-center font-semibold text-[var(--primary)] hover:underline">Open review</a>
                        : <Button size="sm" variant="outline" onClick={() => setCreate({ caseId: example.caseId, kind: 'talent-risk' })}>Review retention</Button>}
                    </div>
                  </article>;
                })}
              </div>
            </div>}

            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-[15px] font-semibold">Source-case subjects ({subjects.length})</h3>
                <Input aria-label="Search subjects" placeholder="Search name or reference" className="h-10 max-w-xs lg:h-8" value={search} onChange={(e) => setSearch(e.target.value)} data-testid="input-search-subjects" />
              </div>
              {subjects.length === 0 ? <Notice>{data.subjects.length === 0 ? 'No source cases are available yet.' : 'No subjects match your search.'}</Notice> : (
                <div className="overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)]">
                  <table className="w-full min-w-[640px] border-collapse text-left text-[13px]">
                    <thead><tr className="border-b border-[var(--border)] bg-[var(--surface-alt)] text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      <th scope="col" className="px-3 py-2">Subject</th><th scope="col" className="px-3 py-2">Talent at Risk</th><th scope="col" className="px-3 py-2">Resume integrity (model)</th><th scope="col" className="px-3 py-2">Human reviews</th><th scope="col" className="px-3 py-2" /></tr></thead>
                    <tbody>{subjects.map((s) => {
                      const live = data.reviews.filter((r) => r.caseId === s.caseId && isLive(r));
                      return (
                        <tr key={s.caseId} className="border-b border-[var(--border)] last:border-0" data-testid={`row-subject-${s.caseId}`}>
                          <td className="px-3 py-2"><Link href={`/cases/${s.caseId}`} className="font-semibold text-[var(--primary)] hover:underline">{s.displayName}</Link><div className="text-[11px] text-[var(--text-muted)]">{s.reference}</div></td>
                          <td className="px-3 py-2">{data.riskExamples?.find(row => row.caseId === s.caseId)
                            ? <RiskBand band={data.riskExamples.find(row => row.caseId === s.caseId)!.band} />
                            : <NotAssessed kind="talent-risk" />}</td>
                          <td className="px-3 py-2"><NotAssessed kind="resume-integrity" /></td>
                          <td className="px-3 py-2">{live.length ? `${live.length} active` : 'None active'}</td>
                          <td className="px-3 py-2 text-right">{data.canManage && <div className="flex justify-end gap-1">
                            <Button size="sm" variant="outline" className="h-8" onClick={() => setCreate({ caseId: s.caseId, kind: 'talent-risk' })}>Review retention</Button>
                            <Button size="sm" variant="outline" className="h-8" onClick={() => setCreate({ caseId: s.caseId, kind: 'resume-integrity' })}>Verify resume</Button></div>}</td>
                        </tr>);
                    })}</tbody>
                  </table>
                </div>)}
            </div>

            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="m-0 text-[15px] font-semibold">Human review cases ({reviews.length})</h3>
                <select aria-label="Filter by status" className={`${field} h-10 w-auto lg:h-8`} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
                  <option value="">Any status</option><option value="open">Open</option><option value="in-progress">In progress</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select>
                <select aria-label="Filter by kind" className={`${field} h-10 w-auto lg:h-8`} value={kindF} onChange={(e) => setKindF(e.target.value)}>
                  <option value="">Both kinds</option><option value="talent-risk">{KIND_LABEL['talent-risk']}</option><option value="resume-integrity">{KIND_LABEL['resume-integrity']}</option></select>
              </div>
              {reviews.length === 0 ? <Notice>No review cases match.</Notice> : (
                <ul className="m-0 list-none space-y-2 p-0">{reviews.map((r) => (
                  <li id={`review-${r.id}`} key={r.id} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-3" data-testid={`card-review-${r.id}`}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[12px] font-bold">{r.reference}</span><ReviewStatusBadge status={r.status} /><PriorityBadge priority={r.priority} />
                      <span className="text-[12px] text-[var(--text-secondary)]">{KIND_LABEL[r.kind]}</span>
                      {r.origin !== 'catalogue' && <span className="text-[11px] text-[var(--text-muted)]">{r.origin === 'human' ? 'Human-initiated' : 'Model-initiated'}</span>}
                    </div>
                    <p className="my-1.5 text-[13px]"><strong>{subjectOf(r)?.displayName ?? `Case ${r.caseId}`}</strong>: {r.reason}</p>
                    <p className="m-0 text-[12px] text-[var(--text-secondary)]">Recommended: {r.recommendedAction}</p>
                    {r.outcome && <p className="m-0 mt-1 text-[12px] text-[var(--text-secondary)]">Outcome: {r.outcome}</p>}
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[12px] text-[var(--text-muted)]">
                      <span>Owner {ownerLabel(r.ownerUserId)} - due {r.dueDate.slice(0, 10)} - updated {fmtDate(r.updatedAt)}</span>
                      <span className="flex items-center gap-3"><Link href={`/cases/${r.caseId}`} className="font-semibold text-[var(--primary)] hover:underline">Source case</Link>
                        <Button size="sm" variant="outline" className="h-8" onClick={() => setEditId(r.id)} data-testid={`button-edit-review-${r.id}`}>{data.canManage ? 'Update and history' : 'History'}</Button></span>
                    </div>
                  </li>))}</ul>)}
            </div>
          </div>)}

      {data && create && <CreateReviewDialog key={`${create.caseId}-${create.kind}`} scope={scope} data={data} presetCaseId={create.caseId} presetKind={create.kind} onClose={() => setCreate(null)} />}
      {data && editing && data.canManage && <EditReviewDialog key={editing.id + editing.updatedAt} scope={scope} data={data} review={editing} onClose={() => setEditId(null)} />}
      {data && editing && !data.canManage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) setEditId(null); }}>
          <div role="dialog" aria-modal="true" aria-label={`${editing.reference} history`} className="max-h-[85dvh] w-full max-w-md overflow-y-auto rounded-[var(--radius-lg)] bg-[var(--surface)] p-4">
            <h3 className="mt-0 text-[15px] font-semibold">{editing.reference} history</h3>
            <ul className="m-0 list-none space-y-1.5 p-0 text-[12px]">{editing.history.map((h, i) => <li key={i}><strong>{h.action}</strong> by {h.actor}, {fmtDate(h.at)}{h.outcome ? ` - ${h.outcome}` : ''}</li>)}</ul>
            <div className="mt-3 text-right"><Button size="sm" variant="outline" onClick={() => setEditId(null)}>Close</Button></div>
          </div></div>)}
    </section>
  );
}

function RiskBand({ band }: { band: string }) {
  const config = band === 'red' ? ['High risk', 'bg-red-50 text-red-800 border-red-200']
    : band === 'amber' ? ['Moderate risk', 'bg-amber-50 text-amber-800 border-amber-200']
    : ['Low risk', 'bg-emerald-50 text-emerald-800 border-emerald-200'];
  return <span className={`inline-flex rounded-full border px-2 py-1 text-[12px] font-semibold ${config[1]}`}>{config[0]}</span>;
}

function Notice({ children, testid }: { children: React.ReactNode; testid?: string }) {
  return <div data-testid={testid} className="rounded-[var(--radius-lg)] border border-dashed border-[var(--border)] bg-[var(--surface-alt)] p-4 text-[13px] text-[var(--text-muted)]">{children}</div>;
}
