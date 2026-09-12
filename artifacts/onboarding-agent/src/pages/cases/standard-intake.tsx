import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Eye, FileCheck2, RotateCcw, Upload, X } from 'lucide-react';
import { customFetch, getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import { Button, Input, Label } from '@/components/ui-shared';

type IntakeRow = {
  sourceEventId?: string;
  status: 'created' | 'reconciled' | 'conflict' | 'duplicate-active' | 'invalid' | 'blocked';
  caseId?: number;
  errors?: string[];
  message?: string;
  profileId?: string;
  profileVersion?: number;
};
type IntakeResponse = { rows?: IntakeRow[]; results?: IntakeRow[]; summary?: { created: number; reconciled: number; unresolved: number } };

const control = 'mt-1 h-8 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]';

function eventFromForm(form: HTMLFormElement) {
  const data = new FormData(form);
  return {
    sourceEventId: data.get('sourceEventId'),
    eventType: data.get('eventType'),
    acceptanceEvidenceReference: data.get('acceptanceEvidenceReference'),
    person: {
      personKey: data.get('personKey'),
      workerName: data.get('workerName'),
      workerEmail: data.get('workerEmail'),
      hireType: data.get('hireType'),
      workerCategory: data.get('workerCategory'),
      role: data.get('role'),
      department: data.get('department'),
      geography: data.get('geography'),
      legalEntity: data.get('legalEntity'),
      managerName: data.get('managerName'),
      recruiterName: data.get('recruiterName'),
      joiningDate: data.get('joiningDate'),
      workforceContext: { workCountry: data.get('workCountry') },
    },
  };
}

async function postIntake(path: string, events: unknown[]) {
  return customFetch<IntakeResponse>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    responseType: 'json',
  });
}

/**
 * Controlled UI for authenticated staff. Integration middleware uses the
 * separately documented /onboarding/ta-intake contract, never this form.
 */
export function StandardIntakeForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const [events, setEvents] = useState<unknown[]>([]);
  const [rows, setRows] = useState<IntakeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const preview = useMutation({ mutationFn: (input: unknown[]) => postIntake('/api/onboarding/standard-intake/preview', input) });
  const commit = useMutation({ mutationFn: (input: { path: string; events: unknown[] }) => postIntake(input.path, input.events) });
  const displayRows = rows.length ? rows : (preview.data?.rows ?? []);
  const unresolved = useMemo(() => displayRows.some((row) => !['created', 'reconciled'].includes(row.status)), [displayRows]);

  const showError = (caught: unknown) => {
    const response = caught as { response?: { data?: { message?: string } }; message?: string };
    setError(response.response?.data?.message || response.message || 'The intake request could not be completed.');
  };
  const inspect = () => {
    if (!events.length) { setError('Add at least one source event before previewing.'); return; }
    setError(null);
    preview.mutate(events, { onError: showError });
  };
  const save = (path: string) => {
    if (!events.length) { setError('Add at least one source event before creating cases.'); return; }
    setError(null);
    commit.mutate({ path, events }, {
      onSuccess: (result) => {
        setRows(result.results ?? []);
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
      },
      onError: showError,
    });
  };
  const addEvent = (form: HTMLFormElement) => {
    const event = eventFromForm(form);
    setEvents((current) => [...current, event]);
    setRows([]);
    form.reset();
  };

  return (
    <section className="mb-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-md">
      <header className="flex items-start justify-between border-b border-[var(--border)] bg-[var(--surface-alt)] p-[var(--space-lg)]">
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">Trusted standard intake</h3>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Queue accepted-offer or scheduled-preboarding events for preview. Each valid source event creates one held case and its own policy/checklist snapshot; no messages or provider actions are started.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} aria-label="Close trusted standard intake"><X className="h-4 w-4" /></Button>
      </header>
      <div className="space-y-4 p-[var(--space-lg)]">
        <form onSubmit={(event) => { event.preventDefault(); addEvent(event.currentTarget); }} className="grid grid-cols-1 gap-3 rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3 md:grid-cols-3">
          <div><Label>Source event ID</Label><Input required name="sourceEventId" className={control} /></div>
          <div><Label>Event type</Label><select required name="eventType" className={control}><option value="accepted-offer">Accepted offer</option><option value="scheduled-preboarding">Scheduled preboarding</option></select></div>
          <div><Label>Acceptance evidence reference</Label><Input required name="acceptanceEvidenceReference" className={control} placeholder="Approved source-system reference" /></div>
          <div><Label>Stable person key</Label><Input required name="personKey" className={control} /></div>
          <div><Label>Worker name</Label><Input required name="workerName" className={control} /></div>
          <div><Label>Worker email</Label><Input required type="email" name="workerEmail" className={control} /></div>
          <div><Label>Hire type</Label><select required name="hireType" className={control}><option value="external-fte">External FTE</option><option value="contractor">Contractor</option><option value="rehire">Rehire</option><option value="internal-transfer">Internal transfer</option></select></div>
          <div><Label>Worker category</Label><Input required name="workerCategory" className={control} defaultValue="employee" /></div>
          <div><Label>Joining date</Label><Input required type="date" name="joiningDate" className={control} /></div>
          <div><Label>Role</Label><Input required name="role" className={control} /></div>
          <div><Label>Department</Label><Input required name="department" className={control} /></div>
          <div><Label>Geography</Label><Input required name="geography" className={control} /></div>
          <div><Label>Legal entity</Label><Input required name="legalEntity" className={control} /></div>
          <div><Label>Manager</Label><Input required name="managerName" className={control} /></div>
          <div><Label>Recruiter</Label><Input required name="recruiterName" className={control} /></div>
          <div><Label>Work country</Label><Input required name="workCountry" className={control} /></div>
          <div className="md:col-span-3 flex justify-end"><Button type="submit" variant="outline"><FileCheck2 className="mr-1 h-4 w-4" /> Add source event</Button></div>
        </form>
        <div className="rounded border border-[var(--border)] p-3 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2"><strong>{events.length} event{events.length === 1 ? '' : 's'} queued</strong><div className="flex gap-2"><Button type="button" size="sm" variant="outline" onClick={inspect} disabled={!events.length || preview.isPending}><Eye className="mr-1 h-3.5 w-3.5" /> Preview & validate</Button><Button type="button" size="sm" onClick={() => save('/api/onboarding/standard-intake/events')} disabled={!events.length || commit.isPending}><Upload className="mr-1 h-3.5 w-3.5" /> Create held cases</Button>{unresolved && <Button type="button" size="sm" variant="outline" onClick={() => save('/api/onboarding/standard-intake/replay')} disabled={commit.isPending}><RotateCcw className="mr-1 h-3.5 w-3.5" /> Replay unresolved</Button>}</div></div>
          <p className="mt-2 text-[var(--text-muted)]">Preview validates every row against its own policy context. Correct only unresolved source events and replay them with the same IDs; already-created rows reconcile without duplicates.</p>
        </div>
        {error && <p role="alert" className="text-xs text-[var(--status-red)]">{error}</p>}
        {displayRows.length > 0 && <div className="space-y-1 rounded border border-[var(--border)] p-3 text-xs">{displayRows.map((row, index) => <div key={`${row.sourceEventId ?? 'invalid'}-${index}`} className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border)] py-1 last:border-0"><span className="font-semibold">{row.sourceEventId ?? `Row ${index + 1}`}</span><span className={['created', 'reconciled'].includes(row.status) ? 'text-[var(--status-green)]' : 'text-[var(--status-amber)]'}>{row.status}</span>{row.caseId && <span>case #{row.caseId}</span>}{row.profileId && <span>policy {row.profileId} v{row.profileVersion}</span>}{(row.message || row.errors?.join(' ')) && <span className="text-[var(--text-muted)]">{row.message || row.errors?.join(' ')}</span>}</div>)}</div>}
        {commit.data?.summary && <p className="flex items-center gap-1 text-xs text-[var(--status-green)]"><Check className="h-4 w-4" /> {commit.data.summary.created} created, {commit.data.summary.reconciled} reconciled, {commit.data.summary.unresolved} unresolved.</p>}
      </div>
    </section>
  );
}