import { useSeparationQueryScope } from './shared';
import { useState } from 'react';
import { useUser } from '@clerk/react';
import { Link } from 'wouter';
import { getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { useHumanPermissions } from '@/hooks/use-human-permissions';
import { useQueryClient } from '@tanstack/react-query';
import { useListSeparationPolicies, useProposeSeparationPolicy, useDecideSeparationPolicy, getListSeparationPoliciesQueryKey } from '@workspace/api-client-react';
import type { SeparationPolicy, SeparationPolicyRecord } from '@workspace/api-client-react';
import { Card, Input, PageHeader, Button } from '@/components/ui-shared';
import { Plus, Trash2 } from 'lucide-react';
import { ErrorBox, Field, Pill, SkeletonRows, SubNav, LwdNote, areaCls, statusTone } from './shared';
import { OFFBOARDING_CASES_PATH } from '../list-navigation';

type Ob = { id: string; label: string; stream: string; scope: string; prerequisites: string; dueOffsetDays: string };
const blank = { country: '', role: '', workerCategory: '', timeZone: '', endOfLwd: '18:00', rulesReference: '', retentionReference: '', assets: '' };

function Decide({ p }: { p: SeparationPolicyRecord }) {
  const qc = useQueryClient();
  const { user } = useUser();
  const organizationId = getPinnedOrganizationIdForPage();
  const [ref, setRef] = useState('');
  const d = useDecideSeparationPolicy({ request: { headers: { 'X-Organization-Id': organizationId ?? '' } } });
  const go = (decision: 'approve' | 'withdraw') => d.mutate({ policyId: p.id, version: p.version, data: { decision, reference: ref.trim() } }, { onSuccess: () => { setRef(''); qc.invalidateQueries({ queryKey: getListSeparationPoliciesQueryKey() }); } });
  const canApprove = p.status === 'proposal' && p.createdBy !== user?.id, canWithdraw = p.status === 'proposal' || p.status === 'approved';
  if (!canApprove && !canWithdraw) return null;
  return (
    <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
      <Field label="Decision reference" hint="Independent human review and current policy-management, case-flow and profile edit permissions are required. A proposer cannot approve their own proposal. Withdrawal stops future adoption; existing case safeguards still apply."><Input data-testid={`input-decision-ref-${p.id}-${p.version}`} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      {d.isError && <ErrorBox error={d.error} />}
      {p.status === 'proposal' && p.createdBy === user?.id && <p className="text-xs text-[var(--text-muted)]">Another permitted member must independently approve your proposal.</p>}
      <div className="flex flex-wrap gap-2">
        {canApprove && <Button size="sm" data-testid={`button-approve-${p.id}-${p.version}`} disabled={!ref.trim() || d.isPending} onClick={() => go('approve')}>Approve policy</Button>}
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
  const organizationId = getPinnedOrganizationIdForPage();
  const m = useProposeSeparationPolicy({ request: { headers: { 'X-Organization-Id': organizationId ?? '' } } });
  const set = (k: keyof typeof blank, v: string) => setF({ ...f, [k]: v });
  const submit = () => {
    const e: string[] = [];
    if (!/^[A-Z]{2}$/.test(f.country.trim())) e.push('Country must be two uppercase letters.');
    for (const k of ['role', 'workerCategory', 'rulesReference', 'retentionReference'] as const) if (!f[k].trim()) e.push(`${k} is required.`);
    if (!f.timeZone.trim()) e.push('Time zone is required.');
    else try { new Intl.DateTimeFormat('en', { timeZone: f.timeZone.trim() }); } catch { e.push('Time zone must be a valid IANA zone.'); }
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.endOfLwd)) e.push('End of LWD must be HH:mm.');
    const ids = new Set<string>();
    obs.forEach((o, i) => { if (!o.id.trim() || !o.label.trim() || !o.stream.trim() || !o.scope.trim()) e.push(`Obligation ${i + 1}: id, label, stream and routing label are required.`); if (ids.has(o.id.trim())) e.push(`Obligation ${i + 1}: duplicate id.`); ids.add(o.id.trim()); if (!Number.isInteger(Number(o.dueOffsetDays)) || o.dueOffsetDays.trim() === '' || Number(o.dueOffsetDays) < -90 || Number(o.dueOffsetDays) > 180) e.push(`Obligation ${i + 1}: due offset must be an integer from -90 to 180.`); });
    setErrs(e); if (e.length) return;
    const policy: SeparationPolicy = { country: f.country.trim(), role: f.role.trim(), workerCategory: f.workerCategory.trim(), timeZone: f.timeZone.trim(), endOfLwd: f.endOfLwd, rulesReference: f.rulesReference.trim(), retentionReference: f.retentionReference.trim(), defaultAssets: f.assets.split('\n').map((s) => s.trim()).filter(Boolean),
      obligations: obs.map((o) => ({ id: o.id.trim(), label: o.label.trim(), stream: o.stream.trim(), scope: o.scope.trim(), prerequisites: o.prerequisites.split(/[,\s]+/).filter(Boolean), dueOffsetDays: Number(o.dueOffsetDays) })) };
    m.mutate({ data: { ...(base ? { id: base.id } : {}), expectedVersion: base ? base.version : 0, policy } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListSeparationPoliciesQueryKey() }); onClose(); } });
  };
  const txt = (k: keyof typeof blank, label: string, hint?: string) => <Field label={label} hint={hint}><Input data-testid={`input-policy-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} /></Field>;
  return (
    <Card className="space-y-4 p-5">
      <h2 className="break-words text-lg font-semibold">{base ? `Propose version ${base.version + 1} of ${base.id}` : 'Propose a new policy'}</h2>
      <p className="text-sm text-[var(--text-muted)]">A proposal is not active. It matches a case only on exact country, role, worker category and time zone, and requires independent human approval before explicit case adoption. Saving or approving never revises running cases or authorizes external effects.</p>
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
              {(['id', 'label', 'stream', 'scope', 'prerequisites', 'dueOffsetDays'] as const).map((k) => <Field key={k} label={k === 'dueOffsetDays' ? 'Due offset (days from LWD)' : k === 'scope' ? 'Reviewer routing label (no access grant)' : k === 'prerequisites' ? 'Prerequisite ids (comma separated)' : k} hint={k === 'dueOffsetDays' ? 'Whole days: -90 to 180. Negative = before LWD; positive = after.' : k === 'scope' ? 'Use an existing routing label, e.g. legal-approve. This is not a specialist grant.' : undefined}><Input data-testid={`input-obligation-${i}-${k}`} value={o[k]} onChange={(e) => up(k, e.target.value)} /></Field>)}
              <div className="flex items-end"><Button size="sm" variant="ghost" aria-label="Remove obligation" onClick={() => setObs(obs.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button></div>
            </div>
          );
        })}
      </div>
      {errs.length > 0 && <ul role="alert" className="list-disc rounded-md bg-[var(--status-red-bg)] p-3 pl-6 text-xs text-[var(--status-red-fg)]">{errs.map((e) => <li key={e}>{e}</li>)}</ul>}
      {m.isError && <><ErrorBox error={m.error} /><p role="status" className="text-sm">Your inputs are retained. If the policy changed, refresh the list and compare revisions before opening a new revision. This draft still submits against its original version.</p><Button variant="outline" onClick={() => qc.invalidateQueries({ queryKey: getListSeparationPoliciesQueryKey() })}>Refresh saved revisions</Button></>}
      <div className="flex flex-wrap gap-2"><Button data-testid="button-submit-policy" disabled={m.isPending} onClick={submit}>{m.isPending ? 'Submitting...' : 'Submit proposal'}</Button><Button variant="outline" disabled={m.isPending} onClick={onClose}>Cancel</Button></div>
    </Card>
  );
}

export function SeparationPoliciesPage() {
  return <SeparationPolicyManagement context="cases" />;
}

/** Both entry points share the editor, queries and mutations. Scope remounts
 * discard drafts and decision references before another client's UI can render. */
export function SeparationPolicyManagement({ context }: { context: 'cases' | 'settings' }) {
  const scope = useSeparationQueryScope();
  return <ScopedPolicyManagement key={scope} context={context} scope={scope} />;
}

function ScopedPolicyManagement({ context, scope }: { context: 'cases' | 'settings'; scope: string }) {
  const permissions = useHumanPermissions();
  const organizationId = getPinnedOrganizationIdForPage();
  const canManage = !permissions.isError && ['tool.policy.manage', 'flow.case.edit', 'data.case.profile.edit']
    .every(key => permissions.data?.allows.includes(key));
  const q = useListSeparationPolicies({ request: { headers: { 'X-Organization-Id': organizationId ?? '' } },
    query: { queryKey: [...getListSeparationPoliciesQueryKey(), scope], staleTime: 0, refetchInterval: 30_000, retry: false } });
  const [form, setForm] = useState<{ base?: SeparationPolicyRecord } | null>(null);
  return (
    <div className="mx-auto max-w-5xl space-y-5 [&>div:first-child]:flex-wrap [&>div:first-child]:gap-3">
      <PageHeader title={context === 'settings' ? 'Offboarding configuration' : 'Offboarding policies'} subtitle="Client-scoped, versioned separation policies. Proposals require independent human approval and explicit case adoption.">
        <Button className="gap-2" data-testid="button-new-policy" disabled={!canManage || q.isLoading || q.isError || form !== null} onClick={() => setForm({})}><Plus className="h-4 w-4" /> Propose policy</Button>
      </PageHeader>
      {context === 'cases' ? <SubNav active="policies" /> : <nav aria-label="Offboarding settings navigation" className="flex flex-wrap gap-4 text-sm text-[var(--primary)]"><Link href="/settings">Back to Settings</Link><Link href={OFFBOARDING_CASES_PATH}>View Offboarding cases</Link></nav>}
      <p className="text-sm text-[var(--text-muted)]">Configure exact country, role, worker category and time-zone applicability, last-working-day end time, rules and retention references, default assets, and obligations with prerequisites and relative deadlines. Both entry points manage the same saved revisions and decisions.</p>
      <LwdNote />
      {permissions.isLoading ? <p role="status">Checking policy permissions…</p> : permissions.isError ? <ErrorBox error={permissions.error} onRetry={() => permissions.refetch()} /> : !canManage && <p role="status" className="rounded-md border p-3 text-sm">Permission-limited view. Current policy-management, case-flow and profile edit permissions are required to propose, revise or decide policies. Only policies the server permits you to view are shown.</p>}
      {form && <fieldset disabled={!canManage || q.isError || q.isLoading} className="min-w-0"><Propose key={form.base ? `${form.base.id}:${form.base.version}` : 'new'} base={form.base} onClose={() => setForm(null)} /></fieldset>}
      {q.isLoading ? <SkeletonRows /> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? <div role="status" className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">No policies are visible to you in this client workspace. This response may be permission-filtered and does not establish that the client has no policies.</div> : q.data.map((p) => (
        <Card key={`${p.id}-${p.version}`} className="break-words p-4" data-testid={`card-policy-${p.id}-${p.version}`}>
          <div className="flex flex-wrap items-center justify-between gap-2"><div className="font-semibold">{p.policy.country} · {p.policy.role} · {p.policy.workerCategory} <span className="font-normal text-[var(--text-muted)]">v{p.version}</span></div><Pill tone={statusTone(p.status)}>{p.status}</Pill></div>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
            <div>Time zone: {p.policy.timeZone}</div><div>End of LWD: {p.policy.endOfLwd}</div><div>Rules: {p.policy.rulesReference}</div><div>Retention: {p.policy.retentionReference}</div>
            <div className="sm:col-span-2">Default assets: {p.policy.defaultAssets.join(', ') || 'none'}</div>
            <div className="sm:col-span-2">Obligations: {p.policy.obligations.map((o) => `${o.label} [${o.id}] · ${o.stream} · ${o.scope} · ${o.dueOffsetDays} days from LWD · prerequisites: ${o.prerequisites.join(', ') || 'none'}`).join('; ') || 'none beyond baseline'}</div>
            <div className="text-[var(--text-muted)]">Proposed by {p.createdBy}{p.approval ? ` · approved by ${p.approval.actor}` : ''}</div>
          </dl>
          <div className="mt-2"><Button size="sm" variant="outline" disabled={!canManage || form !== null} data-testid={`button-revise-${p.id}-${p.version}`} onClick={() => { setForm({ base: p }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>Propose new version</Button></div>
          {canManage && <Decide p={p} />}
        </Card>
      ))}
    </div>
  );
}
