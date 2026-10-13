import { useSeparationQueryScope } from './shared';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useListSeparationPolicies, useProposeSeparationPolicy, useDecideSeparationPolicy, getListSeparationPoliciesQueryKey } from '@workspace/api-client-react';
import type { SeparationPolicy, SeparationPolicyRecord } from '@workspace/api-client-react';
import { Card, Input, PageHeader, Button } from '@/components/ui-shared';
import { Plus, Trash2 } from 'lucide-react';
import { ErrorBox, Field, Pill, SkeletonRows, SubNav, LwdNote, areaCls, statusTone } from './shared';

type Ob = { id: string; label: string; stream: string; scope: string; prerequisites: string; dueOffsetDays: string };
const blank = { country: '', role: '', workerCategory: '', timeZone: '', endOfLwd: '18:00', rulesReference: '', retentionReference: '', assets: '' };

function Decide({ p }: { p: SeparationPolicyRecord }) {
  const qc = useQueryClient();
  const [ref, setRef] = useState('');
  const d = useDecideSeparationPolicy();
  const go = (decision: 'approve' | 'withdraw') => d.mutate({ policyId: p.id, version: p.version, data: { decision, reference: ref.trim() } }, { onSuccess: () => { setRef(''); qc.invalidateQueries({ queryKey: getListSeparationPoliciesQueryKey() }); } });
  const canApprove = p.status === 'proposed', canWithdraw = p.status === 'proposed' || p.status === 'approved';
  if (!canApprove && !canWithdraw) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
      <Field label="Decision reference" hint={canApprove ? 'Approval needs an independent legal authority; the proposer cannot approve their own proposal. The server enforces this.' : 'Withdrawal stops future adoption.'}><Input data-testid={`input-decision-ref-${p.id}-${p.version}`} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      {d.isError && <ErrorBox error={d.error} />}
      <div className="flex gap-2">
        {canApprove && <Button size="sm" data-testid={`button-approve-${p.id}-${p.version}`} disabled={!ref.trim() || d.isPending} onClick={() => go('approve')}>Approve (legal)</Button>}
        {canWithdraw && <Button size="sm" variant="destructive" data-testid={`button-withdraw-${p.id}-${p.version}`} disabled={!ref.trim() || d.isPending} onClick={() => go('withdraw')}>Withdraw</Button>}
      </div>
    </div>
  );
}

function Propose({ base, onClose }: { base?: SeparationPolicyRecord; onClose: () => void }) {
  const qc = useQueryClient();
  const b = base?.policy;
  const [f, setF] = useState(b ? { country: b.country, role: b.role, workerCategory: b.workerCategory, timeZone: b.timeZone, endOfLwd: b.endOfLwd, rulesReference: b.rulesReference, retentionReference: b.retentionReference, assets: b.defaultAssets.join('\n') } : blank);
  const [obs, setObs] = useState<Ob[]>((b?.obligations ?? []).map((o) => ({ ...o, prerequisites: o.prerequisites.join(', '), dueOffsetDays: String(o.dueOffsetDays) })));
  const [errs, setErrs] = useState<string[]>([]);
  const m = useProposeSeparationPolicy();
  const set = (k: keyof typeof blank, v: string) => setF({ ...f, [k]: v });
  const submit = () => {
    const e: string[] = [];
    if (!/^[A-Z]{2}$/.test(f.country.trim())) e.push('Country must be two uppercase letters.');
    for (const k of ['role', 'workerCategory', 'rulesReference', 'retentionReference'] as const) if (!f[k].trim()) e.push(`${k} is required.`);
    try { new Intl.DateTimeFormat('en', { timeZone: f.timeZone.trim() }); } catch { e.push('Time zone must be a valid IANA zone.'); }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.endOfLwd)) e.push('End of LWD must be HH:mm.');
    const ids = new Set<string>();
    obs.forEach((o, i) => { if (!o.id.trim() || !o.label.trim() || !o.stream.trim() || !o.scope.trim()) e.push(`Obligation ${i + 1}: id, label, stream and scope are required.`); if (ids.has(o.id.trim())) e.push(`Obligation ${i + 1}: duplicate id.`); ids.add(o.id.trim()); if (!Number.isFinite(Number(o.dueOffsetDays)) || o.dueOffsetDays.trim() === '') e.push(`Obligation ${i + 1}: due offset must be a number.`); });
    setErrs(e); if (e.length) return;
    const policy: SeparationPolicy = { country: f.country.trim(), role: f.role.trim(), workerCategory: f.workerCategory.trim(), timeZone: f.timeZone.trim(), endOfLwd: f.endOfLwd, rulesReference: f.rulesReference.trim(), retentionReference: f.retentionReference.trim(), defaultAssets: f.assets.split('\n').map((s) => s.trim()).filter(Boolean),
      obligations: obs.map((o) => ({ id: o.id.trim(), label: o.label.trim(), stream: o.stream.trim(), scope: o.scope.trim(), prerequisites: o.prerequisites.split(/[,\s]+/).filter(Boolean), dueOffsetDays: Number(o.dueOffsetDays) })) };
    m.mutate({ data: { ...(base ? { id: base.id } : {}), expectedVersion: base ? base.version : 0, policy } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListSeparationPoliciesQueryKey() }); onClose(); } });
  };
  const txt = (k: keyof typeof blank, label: string, hint?: string) => <Field label={label} hint={hint}><Input data-testid={`input-policy-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>;
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-lg font-semibold">{base ? `Propose version ${base.version + 1} of ${base.id}` : 'Propose a new policy'}</h2>
      <p className="text-sm text-[var(--text-muted)]">A proposal is not live. It matches a case only on exact country, role, worker category and time zone, and cannot be adopted until legally approved.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {txt('country', 'Country', 'Two uppercase letters')}{txt('role', 'Role (exact)')}{txt('workerCategory', 'Worker category (exact)')}{txt('timeZone', 'IANA time zone')}
        {txt('endOfLwd', 'End of last working day (HH:mm)')}{txt('rulesReference', 'Rules reference')}{txt('retentionReference', 'Retention reference')}
      </div>
      <Field label="Default assets" hint="One per line"><textarea data-testid="input-policy-assets" rows={3} className={areaCls} value={f.assets} onChange={(e) => set('assets', e.target.value)} /></Field>
      <div className="space-y-2">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold">Obligations</h3><Button size="sm" variant="outline" className="gap-1" data-testid="button-add-obligation" onClick={() => setObs([...obs, { id: '', label: '', stream: '', scope: '', prerequisites: '', dueOffsetDays: '0' }])}><Plus className="h-3 w-3" /> Add</Button></div>
        {obs.map((o, i) => {
          const up = (k: keyof Ob, v: string) => setObs(obs.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
          return (
            <div key={i} className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-3">
              {(['id', 'label', 'stream', 'scope', 'prerequisites', 'dueOffsetDays'] as const).map((k) => <Field key={k} label={k === 'dueOffsetDays' ? 'Due offset (days from LWD)' : k === 'scope' ? 'Reviewer routing label (no access grant)' : k === 'prerequisites' ? 'Prerequisite ids (comma separated)' : k}><Input data-testid={`input-obligation-${i}-${k}`} value={o[k]} onChange={(e) => up(k, e.target.value)} /></Field>)}
              <div className="flex items-end"><Button size="sm" variant="ghost" aria-label="Remove obligation" onClick={() => setObs(obs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button></div>
            </div>
          );
        })}
      </div>
      {errs.length > 0 && <ul role="alert" className="list-disc rounded-md bg-[var(--status-red-bg)] p-3 pl-6 text-xs text-[var(--status-red-fg)]">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
      {m.isError && <ErrorBox error={m.error} />}
      <div className="flex gap-2"><Button data-testid="button-submit-policy" disabled={m.isPending} onClick={submit}>{m.isPending ? 'Submitting...' : 'Submit proposal'}</Button><Button variant="outline" onClick={onClose}>Cancel</Button></div>
    </Card>
  );
}

export function SeparationPoliciesPage() {
  const q = useListSeparationPolicies({ query: { queryKey: [...getListSeparationPoliciesQueryKey(), useSeparationQueryScope()], staleTime: 15_000, retry: false } as never });
  const [form, setForm] = useState<{ base?: SeparationPolicyRecord } | null>(null);
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Offboarding policies" subtitle="Versioned, legally approved obligations. Proposals never take effect until independently approved.">
        <Button className="gap-2" data-testid="button-new-policy" onClick={() => setForm({})}><Plus className="h-4 w-4" /> Propose policy</Button>
      </PageHeader>
      <SubNav active="policies" />
      <LwdNote />
      {form && <Propose base={form.base} onClose={() => setForm(null)} />}
      {q.isLoading ? <SkeletonRows /> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <div className="rounded-md border border-dashed border-[var(--border)] p-10 text-center text-sm text-[var(--text-muted)]">No policies yet. Propose one so cases can generate a checklist.</div> : q.data.map((p) => (
        <Card key={`${p.id}-${p.version}`} className="p-4" data-testid={`card-policy-${p.id}-${p.version}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">{p.policy.country} · {p.policy.role} · {p.policy.workerCategory} <span className="font-normal text-[var(--text-muted)]">v{p.version}</span></div><Pill tone={statusTone(p.status)}>{p.status}</Pill></div>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div>Time zone: {p.policy.timeZone}</div><div>End of LWD: {p.policy.endOfLwd}</div><div>Rules: {p.policy.rulesReference}</div><div>Retention: {p.policy.retentionReference}</div>
            <div className="sm:col-span-2">Default assets: {p.policy.defaultAssets.join(', ') || 'none'}</div>
            <div className="sm:col-span-2">Obligations: {p.policy.obligations.map((o) => `${o.label} (${o.dueOffsetDays}d)`).join('; ') || 'none beyond baseline'}</div>
            <div className="text-[var(--text-muted)]">Proposed by {p.createdBy}{p.approval ? ` · approved by ${p.approval.actor}` : ''}</div>
          </dl>
          <div className="mt-2"><Button size="sm" variant="outline" data-testid={`button-revise-${p.id}-${p.version}`} onClick={() => { setForm({ base: p }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Propose new version</Button></div>
          <Decide p={p} />
        </Card>
      ))}
    </div>
  );
}
