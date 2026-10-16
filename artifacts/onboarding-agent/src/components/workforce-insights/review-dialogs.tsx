import { useState } from 'react';
import type { WorkforceInsights, WorkforceReviewCase, WorkforceWarningKind } from '@workspace/api-client-react';
import { Button, Label } from '@/components/ui-shared';
import { KIND_LABEL, field, fmtDate, STATUS_LABEL } from './parts';
import { useWorkforceScope, mutationMessage, errorStatus } from './use-workforce-insights';

type Scope = ReturnType<typeof useWorkforceScope>;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={title} className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 shadow-xl sm:max-w-lg sm:rounded-[var(--radius-lg)]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h3 className="m-0 text-[15px] font-semibold">{title}</h3>
          <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close dialog">Close</Button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ErrorBox({ error, onReload }: { error: unknown; onReload: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="rounded-[var(--radius-md)] bg-[var(--status-red-bg)] p-2.5 text-[12px] text-[var(--status-red-fg)]">
      {mutationMessage(error)}
      {errorStatus(error) === 409 && <Button size="sm" variant="outline" className="ml-2 h-8" onClick={onReload}>Reload latest</Button>}
    </div>
  );
}

const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export function CreateReviewDialog({ scope, data, presetCaseId, presetKind, onClose }: {
  scope: Scope; data: WorkforceInsights; presetCaseId?: number; presetKind?: WorkforceWarningKind; onClose: () => void;
}) {
  const [version, setVersion] = useState(data.version);
  const [caseId, setCaseId] = useState<number | ''>(presetCaseId ?? '');
  const [kind, setKind] = useState<WorkforceWarningKind>(presetKind ?? 'talent-risk');
  const [priority, setPriority] = useState<'standard' | 'critical'>('standard');
  const [reason, setReason] = useState('');
  const [action, setAction] = useState('');
  const [owner, setOwner] = useState(data.owners[0]?.userId ?? '');
  const [due, setDue] = useState(plusDays(7));
  const [notice, setNotice] = useState<string | null>(null);
  const { mutate, isPending, error, reset } = scope.create;
  const valid = caseId !== '' && reason.trim() && action.trim() && owner && /^\d{4}-\d{2}-\d{2}$/.test(due);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const cid = Number(caseId);
    const before = new Set(data.reviews.map((r) => r.id));
    mutate({ data: { version, caseId, kind, priority, reason: reason.trim(), recommendedAction: action.trim(), ownerUserId: owner, dueDate: due } }, {
      onSuccess: (res) => {
        const created = res.reviews.some((r) => !before.has(r.id));
        if (created) { onClose(); return; }
        const dup = res.reviews.find((r) => r.caseId === cid && r.kind === kind && (r.status === 'open' || r.status === 'in-progress'));
        setNotice(`An open review already exists for this case and kind${dup ? ` (${dup.reference})` : ''}. No new review was created.`);
      },
    });
  };

  return (
    <Modal title="Start a human review" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3" data-testid="form-create-review">
        <p className="m-0 text-[12px] text-[var(--text-muted)]">This records a person's decision to look closer. It does not change any model assessment.{kind === 'resume-integrity' ? ' Resume concerns warrant verification, not a conclusion of fraud.' : ' Retention actions should be supportive.'}</p>
        <div><Label>Subject (existing source case)</Label>
          <select className={field} value={caseId} onChange={(e) => setCaseId(e.target.value ? Number(e.target.value) : '')} data-testid="select-review-case">
            <option value="">Select a case</option>
            {data.subjects.map((s) => <option key={s.caseId} value={s.caseId}>{s.displayName} - {s.reference}</option>)}
          </select></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Kind</Label><select className={field} value={kind} onChange={(e) => setKind(e.target.value as WorkforceWarningKind)} data-testid="select-review-kind">
            {(Object.keys(KIND_LABEL) as WorkforceWarningKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></div>
          <div><Label>Human review priority</Label><select className={field} value={priority} onChange={(e) => setPriority(e.target.value as 'standard' | 'critical')} data-testid="select-review-priority">
            <option value="standard">Standard</option><option value="critical">Critical</option></select></div>
        </div>
        <div><Label>Reason</Label><textarea className={`${field} h-20 py-2`} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} data-testid="input-review-reason" /></div>
        <div><Label>Recommended action</Label><textarea className={`${field} h-20 py-2`} maxLength={2000} value={action} onChange={(e) => setAction(e.target.value)} data-testid="input-review-action" /></div>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Owner</Label><select className={field} value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="select-review-owner">
            {data.owners.length === 0 && <option value="">No owners available</option>}
            {data.owners.map((o) => <option key={o.userId} value={o.userId}>{o.label}</option>)}</select></div>
          <div><Label>Due date</Label><input type="date" className={field} value={due} onChange={(e) => setDue(e.target.value)} data-testid="input-review-due" /></div>
        </div>
        {notice && <div role="status" className="rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-2.5 text-[12px] text-[var(--status-amber-fg)]">{notice}</div>}
        <ErrorBox error={error} onReload={() => {
          void scope.query.refetch().then(result => {
            if (result.data?.organizationId === data.organizationId && !result.isError) {
              setVersion(result.data.version);
              reset();
            }
          });
        }} />
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || isPending} data-testid="button-submit-review">{isPending ? 'Saving...' : 'Create review'}</Button></div>
      </form>
    </Modal>
  );
}

export function EditReviewDialog({ scope, data, review, onClose }: { scope: Scope; data: WorkforceInsights; review: WorkforceReviewCase; onClose: () => void }) {
  const [version, setVersion] = useState(data.version);
  const [status, setStatus] = useState<WorkforceReviewCase['status']>(review.status);
  const [owner, setOwner] = useState(review.ownerUserId);
  const [due, setDue] = useState(review.dueDate.slice(0, 10));
  const [outcome, setOutcome] = useState(review.outcome);
  const { mutate, isPending, error, reset } = scope.update;
  const closing = status === 'resolved' || status === 'dismissed';
  const valid = owner && /^\d{4}-\d{2}-\d{2}$/.test(due) && (!closing || outcome.trim());
  const owners = data.owners.some((o) => o.userId === owner) ? data.owners : [...data.owners, { userId: owner, label: owner }];

  return (
    <Modal title={`${review.reference} - update`} onClose={onClose}>
      <form className="space-y-3" data-testid="form-edit-review" onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        mutate({ reviewId: review.id, data: { version, status, ownerUserId: owner, dueDate: due, outcome: outcome.trim() } }, { onSuccess: onClose });
      }}>
        <div className="grid grid-cols-2 gap-2">
          <div><Label>Status</Label><select className={field} value={status} onChange={(e) => setStatus(e.target.value as typeof status)} data-testid="select-edit-status">
            {(Object.keys(STATUS_LABEL) as (keyof typeof STATUS_LABEL)[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}</select></div>
          <div><Label>Due date</Label><input type="date" className={field} value={due} onChange={(e) => setDue(e.target.value)} data-testid="input-edit-due" /></div>
        </div>
        <div><Label>Owner</Label><select className={field} value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="select-edit-owner">
          {owners.map((o) => <option key={o.userId} value={o.userId}>{o.label}</option>)}</select></div>
        <div><Label>Outcome{closing ? ' (required to resolve or dismiss)' : ''}</Label>
          <textarea className={`${field} h-20 py-2`} maxLength={2000} value={outcome} onChange={(e) => setOutcome(e.target.value)} data-testid="input-edit-outcome" /></div>
        <ErrorBox error={error} onReload={() => {
          void scope.query.refetch().then(result => {
            if (result.data?.organizationId !== data.organizationId || result.isError) return;
            const latest = result.data.reviews.find(row => row.id === review.id);
            if (!latest) return;
            setVersion(result.data.version);
            setStatus(latest.status);
            setOwner(latest.ownerUserId);
            setDue(latest.dueDate);
            setOutcome(latest.outcome);
            reset();
          });
        }} />
        {errorStatus(error) === 409 && <p className="text-xs text-[var(--text-muted)]">Reload latest replaces this draft with the saved review. Review it before saving again.</p>}
        <div>
          <div className="mb-1 text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)]">History</div>
          {review.history.length === 0 ? <p className="m-0 text-[12px] text-[var(--text-muted)]">No history recorded.</p> :
            <ul className="m-0 list-none space-y-1.5 p-0">{review.history.map((h, i) => (
              <li key={i} className="rounded bg-[var(--surface-alt)] p-2 text-[12px]"><strong>{h.action}</strong> by {h.actor} <span className="text-[var(--text-muted)]">{fmtDate(h.at)}</span>{h.outcome && <div className="mt-0.5 text-[var(--text-secondary)]">{h.outcome}</div>}</li>))}</ul>}
        </div>
        <div className="flex justify-end gap-2"><Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!valid || isPending} data-testid="button-save-review">{isPending ? 'Saving...' : 'Save changes'}</Button></div>
      </form>
    </Modal>
  );
}
