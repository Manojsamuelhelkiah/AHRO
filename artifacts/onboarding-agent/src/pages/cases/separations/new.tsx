import { useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useCreateSeparationCase, useAdmitSeparationSourceEvent, getListSeparationCasesQueryKey } from '@workspace/api-client-react';
import type { SeparationFacts } from '@workspace/api-client-react';
import { Card, Input, PageHeader, Button } from '@/components/ui-shared';
import { ErrorBox, Field, FactsForm, SubNav, LwdNote, emptyFacts, selectCls, validateFacts } from './shared';

const CHANNELS = [
  { v: 'manual', l: 'Manual entry (HR compliance authority)' },
  { v: 'manager-request', l: 'Manager request (authenticated human)' },
  { v: 'security-request', l: 'Security request (authenticated human)' },
  { v: 'compliance-request', l: 'Compliance request (authenticated human)' },
  { v: 'hris', l: 'HRIS feed - not supported' },
] as const;

export function SeparationNewPage() {
  const [, nav] = useLocation();
  const qc = useQueryClient();
  const [channel, setChannel] = useState<string>('manual');
  const [ref, setRef] = useState('');
  const [facts, setFacts] = useState<Record<string, string>>(emptyFacts() as unknown as Record<string, string>);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const manual = useCreateSeparationCase();
  const admit = useAdmitSeparationSourceEvent();
  const pending = manual.isPending || admit.isPending;
  const err = manual.error ?? admit.error;
  const done = (r: { caseId: number; conflict: boolean; status: string }[]) => {
    qc.invalidateQueries({ queryKey: getListSeparationCasesQueryKey() });
    const first = r[0];
    if (first.conflict) { setMsg(`Conflicting source recorded on case ${first.caseId}. The case is held for HRBP reconciliation.`); return; }
    nav(`/cases/separations/${first.caseId}`);
  };
  const submit = () => {
    const e = validateFacts(facts);
    if (!ref.trim()) e.sourceReference = 'Required';
    setErrors(e);
    if (Object.keys(e).length || channel === 'hris') return;
    const data = { sourceReference: ref.trim(), facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.trim()])) as unknown as SeparationFacts };
    if (channel === 'manual') manual.mutate({ data }, { onSuccess: done });
    else admit.mutate({ channel: channel as 'manager-request', data }, { onSuccess: done });
  };
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <PageHeader title="New separation" subtitle="All thirteen facts are required. No employee contact details are collected." />
      <SubNav active="new" />
      <LwdNote />
      <Card className="space-y-5 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Source channel" hint={channel === 'hris' ? 'HRIS ingestion is honestly unsupported here; submissions are authenticated human requests, not an HRIS feed.' : 'Your authority for the chosen channel and country is checked by the server.'}>
            <select data-testid="select-channel" className={selectCls} value={channel} onChange={(e) => setChannel(e.target.value)}>
              {CHANNELS.map((c) => <option key={c.v} value={c.v} disabled={c.v === 'hris'}>{c.l}</option>)}
            </select>
          </Field>
          <Field label="Source reference" hint="Ticket, email or request id. Reusing it with different values is rejected." error={errors.sourceReference}>
            <Input data-testid="input-source-reference" value={ref} maxLength={160} onChange={(e) => setRef(e.target.value)} />
          </Field>
        </div>
        <FactsForm value={facts} onChange={setFacts} errors={errors} disabled={pending} />
        {err ? <ErrorBox error={err} /> : null}
        {msg && <div role="status" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-sm text-[var(--status-amber-fg)]">{msg}</div>}
        <div className="flex gap-2">
          <Button data-testid="button-submit-separation" disabled={pending || channel === 'hris'} onClick={submit}>{pending ? 'Recording...' : 'Record separation'}</Button>
          <Link href="/cases/separations"><Button variant="outline">Cancel</Button></Link>
        </div>
      </Card>
    </div>
  );
}
