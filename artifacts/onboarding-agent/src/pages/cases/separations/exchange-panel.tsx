import { useState } from 'react';
import { Link } from 'wouter';
import { EmailIndicators } from './email-indicators';
import { useUser } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import { useGetOffboardingExchanges, useActOffboardingExchange, getGetOffboardingExchangesQueryKey } from '@workspace/api-client-react';
import type { OffboardingExchangeView, ActOffboardingExchangeBody } from '@workspace/api-client-react';
import { Card, Input, Button } from '@/components/ui-shared';
import { ErrorBox, Field, Pill, SkeletonRows, errMsg, selectCls, areaCls, useSeparationQueryScope } from './shared';

const when = (s?: string | null) => (s ? new Date(s).toLocaleString() : 'not set');

export function ExchangePanel({ caseId }: { caseId: number }) {
  const scope = useSeparationQueryScope();
  return <ScopedPanel key={`${scope}:${caseId}`} caseId={caseId} scope={scope} />;
}

function ScopedPanel({ caseId, scope }: { caseId: number; scope: string }) {
  const { user } = useUser();
  const qc = useQueryClient();
  const key = [...getGetOffboardingExchangesQueryKey(caseId), scope];
  const q = useGetOffboardingExchanges(caseId, { query: { queryKey: key, staleTime: 10_000, refetchInterval: 20_000, retry: false } as never });
  const act = useActOffboardingExchange();
  const v: OffboardingExchangeView | undefined = q.data;
  const [clock, setClock] = useState('');
  const [reqTask, setReqTask] = useState('');
  const [excRef, setExcRef] = useState<Record<string, boolean>>({});
  const [sourceRefs, setSourceRefs] = useState<Record<string, string>>({});
  const [handlingStatements, setHandlingStatements] = useState<Record<string, string>>({});
  const [checkedPortions, setCheckedPortions] = useState<Record<string, string[]>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const store = (n: OffboardingExchangeView | null | undefined) => { if (n) qc.setQueryData(key, n); else qc.invalidateQueries({ queryKey: getGetOffboardingExchangesQueryKey(caseId) }); };
  const done = (m: string, n: OffboardingExchangeView | null | undefined) => { setErr(null); setMsg(m); store(n); };
  const fail = (e: unknown) => { setMsg(null); setErr(errMsg(e)); };
  const busy = act.isPending;
  const doAct = (data: Omit<ActOffboardingExchangeBody, 'expectedVersion'>, m: string, after?: () => void) => {
    if (!v) return;
    setErr(null); setMsg(null);
    act.mutate({ caseId, data: { ...data, expectedVersion: v.version } }, { onSuccess: (n) => { done(m, n); after?.(); }, onError: fail });
  };

  if (q.isLoading) return <SkeletonRows n={3} />;
  if (q.isError) return <Card className="p-4"><h2 className="font-semibold">Access and equipment conversations</h2><div className="mt-2"><ErrorBox error={q.error} onRetry={() => q.refetch()} /></div></Card>;
  if (!v) return <Card className="p-4 text-sm text-[var(--text-muted)]" data-testid="panel-exchange-empty"><h2 className="font-semibold text-[var(--text-primary)]">Access and equipment conversations</h2><p className="mt-1">No conversations are available for this case.</p></Card>;
  const en = v.enrollment;
  return (
    <Card className="space-y-4 p-4" data-testid="panel-exchange">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div><h2 className="font-semibold">Access and equipment conversations</h2><p className="text-xs text-[var(--text-muted)]">Operational clock {when(v.clock)} · v{v.version} gen {v.generation}. Requests require explicit initiation; enrolled outstanding work may receive follow-ups.</p></div>
        <Pill tone={en.enabled ? 'green' : 'amber'}>{en.enabled ? 'enrolled' : 'paused'}</Pill>
      </div>
      {v.blockers.length > 0 && <ul className="list-disc pl-5 text-xs text-[var(--status-amber-fg)]">{v.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {msg && <p role="status" className="rounded-md bg-[var(--status-green-bg)] p-2 text-sm text-[var(--status-green-fg)]">{msg}</p>}
      {err && <p role="alert" className="rounded-md bg-[var(--status-red-bg)] p-2 text-sm text-[var(--status-red-fg)]">{err}</p>}

      <section aria-label="Conversation tasks" className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Tasks</h3>
        {v.tasks.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No conversation tasks yet.</p> : v.tasks.map((t) => (
          <div key={t.id} data-testid={`exchange-task-${t.id}`} className="space-y-2 rounded-md border border-[var(--border)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0"><div className="text-sm font-semibold">{t.label}</div><div className="text-xs text-[var(--text-muted)]">Due {when(t.dueAt)}{t.notBeforeAt ? ` · not before ${when(t.notBeforeAt)}` : ''} · owner {t.owner ?? 'unassigned'} · rev {t.revision}</div></div>
              <Pill tone={t.status === 'verified' ? 'green' : t.status === 'blocked' ? 'red' : 'muted'}>{t.status}</Pill>
            </div>
            <div className="text-xs">Portions: {t.confirmed.length} of {t.expected.length} confirmed{t.outstanding.length > 0 && <> · outstanding: {t.outstanding.join(', ')}</>}</div>
            {t.handling && <p className="break-words text-xs">{t.handling.sharedAccountOwner ? `Account owner: ${t.handling.sharedAccountOwner}` : t.handling.ktRequired === false ? 'Temporary KT access not required.' : `KT owner: ${t.handling.ktOwner} · expires ${when(t.handling.ktExpiresAt)} · authorization ${t.handling.ktAuthorizationReference}`}</p>}
            {t.prerequisites.length > 0 && <div className="text-xs text-[var(--text-muted)]">Prerequisites: {t.prerequisites.join('; ')}</div>}
            {t.owner === user?.id && t.status !== 'resolved' && <div className="space-y-2">
              <Field label="Source record reference"><Input value={sourceRefs[t.id] ?? ''} maxLength={256} onChange={e => setSourceRefs(p => ({ ...p, [t.id]: e.target.value }))} /></Field>
              {['shared-accounts', 'kt-access-exception'].includes(t.id) && <Field label="Ownership / temporary access details" hint={t.id === 'shared-accounts' ? 'Shared account owner: <current member id>' : 'KT required: no, or KT required: yes with KT owner:, KT expiry: (ISO timestamp) and KT authorization: on separate lines.'}><textarea className={areaCls} maxLength={1000} value={handlingStatements[t.id] ?? ''} onChange={e => setHandlingStatements(p => ({ ...p, [t.id]: e.target.value }))} /></Field>}
              <div className="flex flex-wrap gap-3 text-xs">{t.outstanding.map(portion => <label className="flex items-center gap-1" key={portion}><input type="checkbox" checked={checkedPortions[t.id]?.includes(portion) ?? false} onChange={e => setCheckedPortions(p => ({ ...p, [t.id]: e.target.checked ? [...(p[t.id] ?? []), portion] : (p[t.id] ?? []).filter(v => v !== portion) }))} />I checked {portion}</label>)}</div>
              <Button size="sm" variant="outline" disabled={busy || !sourceRefs[t.id]?.trim() || !checkedPortions[t.id]?.length} onClick={() => doAct({ action: 'source-confirm', taskId: t.id, taskRevision: t.revision, confirmed: true, sourceReference: sourceRefs[t.id].trim(), portions: checkedPortions[t.id], handlingStatement: handlingStatements[t.id] }, 'Source attestation recorded.', () => { setSourceRefs(p => ({...p, [t.id]: ''})); setCheckedPortions(p => ({...p, [t.id]: []})); setHandlingStatements(p => ({ ...p, [t.id]: '' })); })}>Confirm checked portions</Button>
            </div>}
            {t.exception && (
              <div className="space-y-2 rounded bg-[var(--surface-alt)] p-2 text-xs">
                <div><b>Exception</b> rev {t.exception.revision} · {t.exception.sourceId}: {t.exception.explanation}{t.exception.disposition ? ` · ${t.exception.disposition} by ${t.exception.reviewedBy ?? 'unknown'}` : ''}</div>
                {!t.exception.disposition && (
                  <>
                    <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={excRef[t.id] === true} onChange={(e) => setExcRef({ ...excRef, [t.id]: e.target.checked })} /> I reviewed this exact exception (task rev {t.revision}, exception rev {t.exception.revision}) and its source evidence.</label>
                    <Button size="sm" variant="outline" disabled={busy || excRef[t.id] !== true} onClick={() => doAct({ action: 'exception-review', taskId: t.id, confirmed: true, disposition: 'resolved-with-reviewed-exception', evidenceReference: t.exception!.sourceId, taskRevision: t.revision, exceptionRevision: t.exception!.revision }, 'Exception review recorded.', () => setExcRef({ ...excRef, [t.id]: false }))}>Record exception review</Button>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
      </section>

      <section aria-label="Private exchanges" className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Private exchanges</h3>
        {v.exchanges.length === 0 ? <p className="rounded-md border border-dashed border-[var(--border)] p-4 text-center text-sm text-[var(--text-muted)]">No exchanges recorded.</p> : v.exchanges.map((m) => (
          <article key={m.id} className="space-y-1 rounded-md border border-[var(--border)] p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><b className="min-w-0 break-words">{m.subject}</b><span className="flex gap-1"><Pill>{m.direction}</Pill><Pill tone={m.status === 'accepted' ? 'blue' : 'muted'}>{m.status}</Pill></span></div>
            <p className="whitespace-pre-wrap break-words text-xs">{m.body}</p>
            <dl className="grid gap-x-3 text-xs text-[var(--text-muted)] sm:grid-cols-2">
              <div>Operator: {m.operator}</div><div>Agent: {m.agentId}</div><div>Persona: {m.persona}</div><div className="break-all">Mailbox: {m.mailbox}</div>
               <div className="break-all">{m.direction === 'inbound' ? 'From' : 'To'}: {m.recipient} ({m.memberId || 'unverified member'})</div><div>Task: {m.taskId} · {when(m.createdAt)}</div>
              <div className="break-all sm:col-span-2">Source: {m.reference} · transport {m.sourceTransportVerified ? 'verified' : 'not verified'}{m.applied ? ' · applied' : ''}</div>
            </dl>
            {m.direction === 'outbound' && <p className="text-xs text-[var(--text-muted)]">Provider acceptance only. This is not delivery or read acknowledgment.</p>}
          </article>
        ))}
      </section>

      <section aria-label="Actions" className="space-y-3 border-t border-[var(--border)] pt-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">Actions</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Request task"><div className="flex gap-2"><select className={selectCls} value={reqTask} onChange={(e) => setReqTask(e.target.value)}><option value="">Choose task</option>{v.tasks.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}</select><Button size="sm" variant="outline" disabled={busy || !reqTask || !en.enabled || v.communicationChecks.reviewRequired || !v.communicationChecks.emailConsent || !v.communicationChecks.emailVerified} onClick={() => doAct({ action: 'request', taskId: reqTask }, 'Request recorded.', () => setReqTask(''))}>Request</Button></div></Field>
          <Field label="Advance operational clock" hint="Moves the case clock only; it is not mail time."><div className="flex gap-2"><Input type="datetime-local" value={clock} onChange={(e) => setClock(e.target.value)} /><Button size="sm" variant="outline" disabled={busy || !clock} onClick={() => doAct({ action: 'advance-clock', clock: new Date(clock).toISOString() }, 'Operational clock advanced.', () => setClock(''))}>Advance</Button></div></Field>
        </div>
        <Button size="sm" variant="ghost" disabled={busy || !reqTask} onClick={() => doAct({ action: 'inspect-interface', taskId: reqTask }, 'Interface response recorded.')}>Inspect selected interface</Button>
      </section>

      <section aria-label="Communication settings" className="space-y-2 border-t border-[var(--border)] pt-3">
        <EmailIndicators key={`${scope}:${caseId}`} view={v} scope={scope} />
        <p className="text-sm">{en.enabled && v.communicationChecks.emailConsent && v.communicationChecks.emailVerified && !v.communicationChecks.reviewRequired ? 'Gmail communication is enabled.' : 'Gmail communication is paused.'}</p>
        <Link href={`/client-setup?offboardingCaseId=${caseId}#gmail-communication`} className="inline-flex min-h-11 items-center text-sm text-[var(--primary)]">Manage Gmail contacts in Client Setup</Link>
      </section>
    </Card>
  );
}
