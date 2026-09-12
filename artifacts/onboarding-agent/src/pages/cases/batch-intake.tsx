import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { AlertTriangle, Check, Plus, Trash2, Upload, X } from 'lucide-react';
import { Button, Input, Label, cn } from '@/components/ui-shared';
import { listJobProfiles, releaseBatchIntakeCase, submitBatchIntake, updateWorkforceContext, type BatchIntakePerson, type WorkforceContext } from '@/lib/workforce-policy-api';
import { getListOnboardingCasesQueryKey } from '@workspace/api-client-react';

const control = 'h-8 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 text-xs outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]';
const jobProfileKey = ['onboarding', 'job-profiles'];

function nextWeek() {
  return new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
}
function blankPerson(): BatchIntakePerson {
  return {
    personKey: crypto.randomUUID(), workerName: '', workerEmail: '', channelPreference: 'email',
    hireType: 'external-fte', workerCategory: 'employee', role: '', department: '',
    geography: '', legalEntity: '', managerName: '', recruiterName: '', joiningDate: nextWeek(),
    urgency: 'normal', workforceContext: { hiringMode: 'batch' },
  };
}
function isReady(person: BatchIntakePerson) {
  return Boolean(person.workerName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(person.workerEmail) &&
    person.role.trim() && person.department.trim() && person.geography.trim() && person.legalEntity.trim() &&
    person.managerName.trim() && person.recruiterName.trim() && person.joiningDate &&
    person.workforceContext?.workCountry?.trim());
}

export function BatchIntakeForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const profiles = useQuery({ queryKey: jobProfileKey, queryFn: listJobProfiles });
  const submit = useMutation({ mutationFn: (data: { idempotencyKey: string; name: string; people: BatchIntakePerson[] }) => submitBatchIntake(data) });
  const release = useMutation({ mutationFn: ({ batchId, caseId }: { batchId: string; caseId: number }) => releaseBatchIntakeCase(batchId, caseId) });
  const [batchName, setBatchName] = useState('');
  const [retryKey] = useState(() => crypto.randomUUID());
  const [people, setPeople] = useState<BatchIntakePerson[]>([blankPerson()]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof submitBatchIntake>> | null>(null);
  const edit = (index: number, patch: Partial<BatchIntakePerson>) =>
    setPeople((current) => current.map((person, position) => position === index ? { ...person, ...patch } : person));
  const editContext = (index: number, key: keyof WorkforceContext, value: string | boolean | string[] | undefined) =>
    setPeople((current) => current.map((person, position) => position === index ? {
      ...person,
      workforceContext: { ...updateWorkforceContext(person.workforceContext ?? {}, key, value), hiringMode: 'batch' },
    } : person));
  const create = () => {
    setError(null);
    if (!batchName.trim() || people.some((person) => !isReady(person))) {
      setError('Give the batch a name and complete every required person row before creating held cases.');
      return;
    }
    submit.mutate({ idempotencyKey: retryKey, name: batchName.trim(), people }, {
      onSuccess: (response) => {
        setResult(response);
        queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
      },
      onError: (error: Error) => setError(error.message),
    });
  };
  return (
    <div className="mb-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-md">
      <div className="flex items-start justify-between border-b border-[var(--border)] bg-[var(--surface-alt)] p-[var(--space-lg)]">
        <div><h3 className="text-sm font-semibold text-[var(--text-primary)]">Batch intake</h3><p className="mt-1 text-xs text-[var(--text-muted)]">Creates one held case per person with an individual context and immutable policy snapshot. This intake does not send messages, call providers, or start orchestration.</p></div>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="h-4 w-4" /></Button>
      </div>
      <div className="space-y-4 p-[var(--space-lg)]">
        <div className="max-w-md"><Label>Batch name</Label><Input className="mt-1" value={batchName} onChange={(event) => setBatchName(event.target.value)} placeholder="e.g. Pune warehouse April cohort" /></div>
        <div className="rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" /> Every row gets its own resolved policy. Unknown safety applicability stays unknown and generates the required human context review gate; it is never inferred from a cohort average.</div>
        {people.map((person, index) => (
          <div key={person.personKey} className="rounded border border-[var(--border)] bg-[var(--surface-alt)] p-3">
            <div className="mb-2 flex items-center justify-between"><strong className="text-xs text-[var(--text-primary)]">Person {index + 1}</strong>{people.length > 1 && <Button size="sm" variant="ghost" className="h-7 text-[var(--status-red)]" onClick={() => setPeople((current) => current.filter((_, position) => position !== index))}><Trash2 className="h-3.5 w-3.5" /></Button>}</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-4">
              <input className={control} placeholder="Name *" value={person.workerName} onChange={(event) => edit(index, { workerName: event.target.value })} />
              <input className={control} placeholder="Email *" type="email" value={person.workerEmail} onChange={(event) => edit(index, { workerEmail: event.target.value })} />
              <input className={control} placeholder="Role *" value={person.role} onChange={(event) => edit(index, { role: event.target.value })} />
              <input className={control} placeholder="Department *" value={person.department} onChange={(event) => edit(index, { department: event.target.value })} />
              <input className={control} placeholder="Geography *" value={person.geography} onChange={(event) => edit(index, { geography: event.target.value })} />
              <input className={control} placeholder="Legal entity *" value={person.legalEntity} onChange={(event) => edit(index, { legalEntity: event.target.value })} />
              <input className={control} placeholder="Manager *" value={person.managerName} onChange={(event) => edit(index, { managerName: event.target.value })} />
              <input className={control} placeholder="Recruiter *" value={person.recruiterName} onChange={(event) => edit(index, { recruiterName: event.target.value })} />
              <input className={control} type="date" value={person.joiningDate} onChange={(event) => edit(index, { joiningDate: event.target.value })} />
              <select className={control} value={person.jobProfileId ?? ''} onChange={(event) => edit(index, { jobProfileId: event.target.value || undefined })}><option value="">No reusable job profile</option>{profiles.data?.filter((profile) => profile.enabled).map((profile) => <option key={profile.profileId} value={profile.profileId}>{profile.name} · v{profile.version}</option>)}</select>
              <input className={control} placeholder="Work country (e.g. US) *" value={person.workforceContext?.workCountry ?? ''} onChange={(event) => editContext(index, 'workCountry', event.target.value)} />
              <select className={control} value={person.workforceContext?.workEnvironment ?? ''} onChange={(event) => editContext(index, 'workEnvironment', event.target.value || undefined)}><option value="">Work environment unknown</option><option value="office">Office</option><option value="remote">Remote</option><option value="site">Site</option><option value="field">Field</option><option value="mixed">Mixed</option></select>
              <input className={control} placeholder="Site (if applicable)" value={person.workforceContext?.site ?? ''} onChange={(event) => editContext(index, 'site', event.target.value)} />
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 text-xs text-[var(--text-secondary)] md:grid-cols-3">
              {(['siteExposure', 'safetyCritical', 'assistedIntake'] as const).map((field) => <label key={field}>{field.replace(/([A-Z])/g, ' $1')}<select className="ml-2 h-7 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={person.workforceContext?.[field] === undefined ? '' : String(person.workforceContext?.[field])} onChange={(event) => editContext(index, field, event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></label>)}
            </div>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4"><Button variant="outline" onClick={() => setPeople((current) => [...current, blankPerson()])}><Plus className="mr-1 h-4 w-4" /> Add person</Button><Button onClick={create} disabled={submit.isPending}><Upload className="mr-1 h-4 w-4" /> {submit.isPending ? 'Creating held cases…' : 'Create batch cases'}</Button></div>
        {error && <p role="alert" className="text-xs text-[var(--status-red)]">{error}</p>}
        {result && <div className="rounded border border-[var(--status-green)]/30 bg-[var(--status-green-bg)] p-3 text-xs text-[var(--status-green-fg)]"><p className="font-semibold"><Check className="mr-1 inline h-4 w-4" />{result.retry ? 'Retry reconciled safely; no duplicate cases were created.' : `Batch ${result.name} created without starting providers.`}</p><div className="mt-2 space-y-1">{result.results.map((row) => {
          const person = people.find((candidate) => candidate.personKey === row.personKey);
          const gateARequired = person?.hireType === 'external-fte' || person?.hireType === 'contractor' || person?.hireType === 'rehire';
          return <div key={row.personKey} className="flex flex-wrap items-center gap-2"><span className="uppercase">{row.status}</span><Link className="underline" href={`/cases/${row.caseId}`}>Case #{row.caseId}</Link><span>policy {row.profileId} v{row.profileVersion}</span>{!gateARequired && <Button size="sm" variant="outline" disabled={release.isPending} onClick={() => release.mutate({ batchId: result.batchId, caseId: row.caseId }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() }), onError: (error: Error) => setError(error.message) })}>Release to orchestration</Button>}{gateARequired && <span className="text-[var(--status-amber-fg)]">Gate A confirmation required</span>}</div>;
        })}</div></div>}
      </div>
    </div>
  );
}