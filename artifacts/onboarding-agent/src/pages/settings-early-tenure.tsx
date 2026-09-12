import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, RefreshCw, Settings2, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, cn, IconTile } from '@/components/ui-shared';
import { listEarlyTenurePolicies, putEarlyTenure } from '../lib/early-tenure-api';
import { buildEarlyTenurePolicy, cadenceOffsets, defaultObligations, hasValidCadence, missingMandatoryObligations, policyDraft, removedCheckIns } from '../lib/early-tenure-policy-draft';

const policyQueryKey = ['early-tenure-policy-versions'] as const;

export function EarlyTenureSettingsCard() {
  const client = useQueryClient();
  const { data: policies = [], isLoading, isError, error, refetch } = useQuery({
    queryKey: policyQueryKey,
    queryFn: listEarlyTenurePolicies,
    retry: false,
  });
  const active = policies.find((policy) => policy.status?.toLowerCase() === 'active') ?? policies[0];
  const [draft, setDraft] = useState(() => policyDraft());
  const [touched, setTouched] = useState(false);
  const [confirmCheckInRemoval, setConfirmCheckInRemoval] = useState(false);
  const [confirmMandatoryTaskMigration, setConfirmMandatoryTaskMigration] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    if (active && !touched) {
      setDraft(policyDraft(active));
      setConfirmCheckInRemoval(false);
      setConfirmMandatoryTaskMigration(false);
    }
  }, [active, touched]);

  const publish = useMutation({
    mutationFn: () => {
      return putEarlyTenure<unknown>('/policy', {
        expectedVersion: active?.version ?? 0,
        policy: buildEarlyTenurePolicy(active, draft, { addMissingMandatoryObligations: confirmMandatoryTaskMigration }),
      });
    },
    onSuccess: () => {
      setTouched(false);
      setNotice({ ok: true, message: 'Early-tenure policy version submitted. Existing case snapshots remain unchanged.' });
      void client.invalidateQueries({ queryKey: policyQueryKey });
    },
    onError: (caught: any) => setNotice({ ok: false, message: caught?.message || 'Policy could not be published. Current governance and policy authority are required.' }),
  });

  const checkInOffsets = cadenceOffsets(draft.checkInDays);
  const removedCadence = removedCheckIns(active, checkInOffsets);
  const missingMandatoryTasks = missingMandatoryObligations(active);
  const needsMandatoryTaskMigration = Boolean(active && missingMandatoryTasks.length > 0);
  const sourceConfirmationPreserved = active?.obligations?.some((obligation) => obligation.sourceConfirmationRequired === true) ?? false;
  const invalid = !Number.isInteger(Number(draft.probationLengthDays)) || Number(draft.probationLengthDays) < 1 || !hasValidCadence(draft.checkInDays) || !draft.decisionAuthorityScope.trim();

  return (
    <Card className="mt-8">
      <div className="flex flex-col gap-3 border-b border-[var(--border)] bg-[var(--surface-alt)] p-4 md:flex-row md:items-start md:justify-between">
        <div className="flex gap-3">
          <IconTile icon={Settings2} className="border-transparent bg-[var(--primary-light)] text-[var(--primary)]" />
          <div>
            <h3 className="m-0 text-xs font-semibold uppercase tracking-[0.05em] text-[var(--text-primary)]">Early-tenure policy</h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">Govern onboarding obligations, policy check-ins, and who may record a probation disposition.</p>
          </div>
        </div>
        {active && <span className="self-start rounded-full bg-[var(--surface)] px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-[var(--text-secondary)]">Version {active.version ?? '—'} · {active.status ?? 'published'}</span>}
      </div>
      <CardContent className="p-4 md:p-5">
        {isLoading ? <p className="animate-pulse text-sm text-[var(--text-muted)]">Loading early-tenure policy…</p> : isError ? (
          <div className="flex flex-col gap-3 rounded-[var(--radius-md)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)] sm:flex-row sm:items-center sm:justify-between">
            <span>Unable to load early-tenure policy: {(error as any)?.message || 'Unknown error'}</span><Button variant="outline" size="sm" onClick={() => void refetch()}><RefreshCw className="mr-1 h-3.5 w-3.5" />Retry</Button>
          </div>
        ) : (
          <>
            {!active && <div className="mb-4 flex gap-2 rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="h-4 w-4 shrink-0" /><span>No active early-tenure policy is available. Complete the governed fields below before enrollment can occur. This new policy will include separate evidence-backed induction, compliance completion, learning enrollment, calendar delivery, buddy, and manager-connect tasks.</span></div>}
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-xs font-semibold text-[var(--text-secondary)]">Configured probation length (days)<input type="number" min="1" value={draft.probationLengthDays} onChange={(event) => { setDraft({ ...draft, probationLengthDays: event.target.value }); setTouched(true); setNotice(null); }} className="mt-1.5 h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]" /></label>
              <label className="text-xs font-semibold text-[var(--text-secondary)]">Policy check-in days<input value={draft.checkInDays} onChange={(event) => { setDraft({ ...draft, checkInDays: event.target.value }); setConfirmCheckInRemoval(false); setTouched(true); setNotice(null); }} placeholder="30, 60, 90" className="mt-1.5 h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]" /></label>
              <label className="text-xs font-semibold text-[var(--text-secondary)]">Probation decision authority scope<select value={draft.decisionAuthorityScope} onChange={(event) => { setDraft({ ...draft, decisionAuthorityScope: event.target.value }); setTouched(true); setNotice(null); }} className="mt-1.5 h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]"><option value="hr-compliance-approve">HR compliance approve</option><option value="legal-approve">Legal approve</option><option value="manager-approve">Manager approve</option><option value="occupational-health-approve">Occupational health approve</option></select></label>
              <label className="text-xs font-semibold text-[var(--text-secondary)]">Eligible hire types (optional)<input value={draft.hireTypes} onChange={(event) => { setDraft({ ...draft, hireTypes: event.target.value }); setTouched(true); setNotice(null); }} placeholder="Leave blank for all eligible hires" className="mt-1.5 h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]" /></label>
              <label className="text-xs font-semibold text-[var(--text-secondary)]">Eligible worker categories (optional)<input value={draft.workerCategories} onChange={(event) => { setDraft({ ...draft, workerCategories: event.target.value }); setTouched(true); setNotice(null); }} placeholder="Leave blank for all eligible categories" className="mt-1.5 h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]" /></label>
              <label className="text-xs font-semibold text-[var(--text-secondary)]">Eligible legal entities (optional)<input value={draft.legalEntities} onChange={(event) => { setDraft({ ...draft, legalEntities: event.target.value }); setTouched(true); setNotice(null); }} placeholder="Leave blank for all eligible entities" className="mt-1.5 h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 text-sm text-[var(--text-primary)]" /></label>
            </div>
            {removedCadence.length > 0 && <label className="mt-4 flex gap-2 rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]"><input type="checkbox" checked={confirmCheckInRemoval} onChange={(event) => setConfirmCheckInRemoval(event.target.checked)} /><span>I confirm removal of {removedCadence.map((checkIn) => `"${checkIn.label}"`).join(', ')} from the next policy version. Existing case snapshots are unchanged.</span></label>}
            {needsMandatoryTaskMigration && <label className="mt-4 flex gap-2 rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]"><input type="checkbox" checked={confirmMandatoryTaskMigration} onChange={(event) => setConfirmMandatoryTaskMigration(event.target.checked)} /><span>I confirm addition of {missingMandatoryTasks.map((task) => `"${task.label}"`).join(', ')} to the next policy version. These are separate required human-evidence workflow tasks; existing custom obligations and all existing case snapshots remain unchanged.</span></label>}
            <div className="mt-4 rounded-[var(--radius-md)] border border-[var(--primary)]/20 bg-[var(--primary-light)]/20 p-3 text-xs text-[var(--text-secondary)]"><div className="flex gap-2"><ShieldCheck className="h-4 w-4 shrink-0 text-[var(--primary)]" /><span>Publishing clones all existing obligations and their fields, then changes only the governed values edited above. {!active ? 'A new policy uses the required workflow tasks below.' : needsMandatoryTaskMigration ? 'The separately confirmed migration above appends only the missing required workflow tasks.' : 'The current policy includes all required workflow task types.'} Check-in cadence is tenant-configured and does not define a legal probation term.</span></div><div className="mt-3 rounded-[var(--radius-sm)] bg-[var(--surface)]/70 p-2"><p className="font-semibold text-[var(--text-primary)]">Required workflow tasks in a new policy</p><ul className="mt-1 list-disc space-y-0.5 pl-4">{defaultObligations().map((task) => <li key={task.key}>{task.label} · Day {task.offsetDays} · explicit evidence required</li>)}</ul></div><label className="mt-3 flex items-start gap-2 font-semibold text-[var(--text-primary)]"><input type="checkbox" checked={sourceConfirmationPreserved} disabled aria-label="Trusted source confirmation required" className="mt-0.5" /><span>Trusted source confirmation required <span className="font-normal text-[var(--text-muted)]">{sourceConfirmationPreserved ? '— existing source-confirmed obligations are preserved unchanged in the next policy version. Their completion remains restricted to the configured trusted source.' : '— disabled for new human-evidence obligations while LMS and calendar adapters are activation-pending and lack server-verified source confirmation.'}</span></span></label></div>
            <div className="mt-5 flex flex-col gap-3 border-t border-[var(--border)] pt-4 sm:flex-row sm:items-center">
              <Button disabled={!touched || invalid || (removedCadence.length > 0 && !confirmCheckInRemoval) || (needsMandatoryTaskMigration && !confirmMandatoryTaskMigration) || publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? 'Publishing…' : 'Publish governed version'}</Button>
              {touched && <Button variant="outline" onClick={() => { setDraft(policyDraft(active)); setConfirmCheckInRemoval(false); setConfirmMandatoryTaskMigration(false); setTouched(false); setNotice(null); }}>Discard changes</Button>}
              {notice && <p role={notice.ok ? 'status' : 'alert'} className={cn('text-xs sm:ml-auto', notice.ok ? 'text-[var(--status-green-fg)]' : 'text-[var(--status-red-fg)]')}>{notice.ok && <Check className="mr-1 inline h-3.5 w-3.5" />}{notice.message}</p>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}