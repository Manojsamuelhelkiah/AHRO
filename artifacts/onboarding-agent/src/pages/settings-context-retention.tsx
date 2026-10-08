import { useState, type FormEvent } from 'react';
import {
  useGetHroContextRetention, useSaveHroContextRetention, getGetHroContextRetentionQueryKey,
  getListHroContextTransactionsQueryKey, type HroContextRetentionPolicy,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Input } from '@/components/ui-shared';

export function ContextRetentionSettings() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useGetHroContextRetention({
    query: { queryKey: getGetHroContextRetentionQueryKey(), staleTime: 10_000, refetchInterval: 30_000, retry: false },
  });
  const [editing, setEditing] = useState(false);
  if (isLoading) return <p className="text-xs" role="status">Loading retention status…</p>;
  if (error) {
    const forbidden = 'status' in error && error.status === 403;
    return <div className="text-xs text-muted-foreground">
      {forbidden ? 'Retention rules and pruning status are available only to verified privacy or legal reviewers. The latest-30 display is not a storage retention rule.' :
        <p role="alert">Retention status could not be loaded. <button className="underline" onClick={() => void refetch()}>Retry</button></p>}
    </div>;
  }
  if (!data) return null;
  return <section className="rounded-lg border p-4 space-y-3" aria-label="Context metadata retention">
    <h3 className="text-sm font-semibold">Governed metadata retention</h3>
    <p className="text-sm">Status: <strong>{data.status.replaceAll('-', ' ')}</strong>.
      {data.policy ? ` Reviewed revision ${data.policy.revision}: ${data.policy.retentionDays} days after the newest activity in the complete correlation chain.` :
        ' No approved rule exists. Automatic pruning is disabled; no retention period has been assumed.'}</p>
    <p className="text-xs text-muted-foreground">{data.safeguards}</p>
    <p className="text-xs text-muted-foreground">
      Each heartbeat checks at most {data.limits.organizations} organizations and prunes at most {data.limits.transactions} attempts,
      {' '}{data.limits.steps} steps and {data.limits.anchors} unused anchors per organization. Oversized chains need separate review.
    </p>
    {data.lastSweep ? <p className="text-xs">
      Last sweep: {new Date(data.lastSweep.lastSweepAt).toLocaleString()} · {data.lastSweep.outcome} · policy revision {data.lastSweep.policyRevision}.
      {' '}Removed {data.lastSweep.transactionsPruned} attempts, {data.lastSweep.stepsPruned} steps, {data.lastSweep.anchorsPruned} anchors.
    </p> : <p className="text-xs">No sweep has been recorded.</p>}
    {data.holdActive && <p className="text-sm font-medium">An active privacy/legal hold blocks pruning. Manage holds through Sensitive lifecycle or Audit lifecycle controls.</p>}
    <Button variant="outline" onClick={() => setEditing(!editing)}>{editing ? 'Close review' : 'Review retention rule'}</Button>
    {editing && <RetentionReview key={data.policy?.revision ?? 0} policy={data.policy} onSaved={() => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: getGetHroContextRetentionQueryKey() });
      void queryClient.invalidateQueries({ queryKey: getListHroContextTransactionsQueryKey() });
    }} />}
  </section>;
}

function RetentionReview({ policy, onSaved }: { policy: HroContextRetentionPolicy | null; onSaved: () => void }) {
  const mutation = useSaveHroContextRetention();
  const [days, setDays] = useState(policy ? String(policy.retentionDays) : '');
  const [enabled, setEnabled] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [fields, setFields] = useState({
    purpose: policy?.purpose ?? '', lawfulBasis: policy?.lawfulBasis ?? '',
    policyReference: policy?.policyReference ?? '', approvalReference: '',
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (days.trim() === '' || !Number.isSafeInteger(Number(days)) || Number(days) < 0 || Number(days) > 3650) return;
    mutation.mutate({ data: {
      expectedRevision: policy?.revision ?? 0, enabled, retentionDays: Number(days),
      confirmPruning: confirm, ...fields,
    } }, { onSuccess: onSaved });
  };
  return <form onSubmit={submit} className="space-y-3">
    <p className="text-xs">Record only an already-reviewed rule covering this organization’s HRO execution metadata and authenticated principal identifiers.
      This does not approve sensitive business records or alter protected audit retention. Enabling or shortening retention may permanently remove eligible metadata on the next heartbeat.</p>
    <label className="block text-sm">Reviewed retention days (0–3650)
      <Input required type="number" min={0} max={3650} step={1} value={days} onChange={event => setDays(event.target.value)} />
    </label>
    {([
      ['purpose', 'Reviewed purpose'], ['lawfulBasis', 'Lawful basis'],
      ['policyReference', 'Policy reference'], ['approvalReference', 'New review / approval reference'],
    ] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}
      <Input required maxLength={500} value={fields[key]} onChange={event => setFields({ ...fields, [key]: event.target.value })} />
    </label>)}
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setConfirm(false); }} />
      Enable pruning under this reviewed rule (unchecked records a paused revision).
    </label>
    {enabled && <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" required checked={confirm} onChange={event => setConfirm(event.target.checked)} />
      I confirm irreversible pruning of eligible execution metadata under the recorded approval. Active attempts, holds and required links remain protected.
    </label>}
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error.message}</p>}
    <Button type="submit" disabled={mutation.isPending || (enabled && !confirm)}>{mutation.isPending ? 'Recording…' : 'Record reviewed revision'}</Button>
  </form>;
}
