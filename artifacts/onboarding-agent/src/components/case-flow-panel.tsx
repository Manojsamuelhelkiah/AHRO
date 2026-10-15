import { useGetCaseExecutableFlow, getGetCaseExecutableFlowQueryKey, getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { useUser } from '@clerk/react';
import type { CaseExecutableFlow } from '@workspace/api-client-react';
import { GetCaseExecutableFlowResponse } from '@workspace/api-zod';

const label = (s: string) => s.replace(/[-_]/g, ' ');

function Chip({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'amber' | 'green' | 'red' | 'info' }) {
  return <span className="inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide"
    style={{ background: `var(--status-${tone}-bg)`, color: `var(--status-${tone}-fg)` }}>{children}</span>;
}

function tone(status: string): 'gray' | 'amber' | 'green' | 'red' | 'info' {
  const s = status.toLowerCase();
  if (/(complete|done|verified|satisfied)/.test(s)) return 'green';
  if (/(block|fail|reject)/.test(s)) return 'red';
  if (/(wait|pending|review|hold)/.test(s)) return 'amber';
  if (/(progress|active|ready|running)/.test(s)) return 'info';
  return 'gray';
}

const MODE_TEXT: Record<string, string> = {
  executable: 'Executable flow. This view is read-only; it starts no work.',
  'compatibility-review': 'Compatibility review. This historical record is held and gains no authority by being viewed.',
  'review-only': 'Review only. No executable domain runtime is bound; viewing this case grants no execution authority.',
};

function Section({ title, children, id }: { title: string; children: React.ReactNode; id: string }) {
  return <section aria-labelledby={id} className="mt-5">
    <h3 id={id} className="mb-2 text-sm font-semibold text-[var(--text-primary)]">{title}</h3>{children}</section>;
}

function List({ items, empty }: { items: string[]; empty: string }) {
  return items.length ? <ul className="list-disc pl-5">{items.map((b) => <li key={b}>{b}</li>)}</ul> : <span className="text-[var(--text-muted)]">{empty}</span>;
}
function Blockers({ items }: { items: string[] }) {
  return items.length ? <details><summary className="cursor-pointer font-medium">Blockers ({items.length})</summary>
    <div className="mt-1"><List items={items} empty="" /></div></details> : <span>None recorded</span>;
}

function FlowBody({ f }: { f: CaseExecutableFlow }) {
  const redacted = f.progressRedacted;
  const def = f.definition;
  return (
    <div className="text-sm text-[var(--text-secondary)]" data-testid="flow-body">
      <div role="status" className="rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={f.mode === 'executable' ? 'info' : 'amber'}>{label(f.mode)}</Chip>
          {f.definitionId
            ? <span data-testid="text-flow-version">Pinned executable version: <b>{f.definitionId}</b> v{f.definitionVersion}</span>
            : <span>No executable version is pinned to this case.</span>}
        </div>
        <p className="mt-2">{MODE_TEXT[f.mode] ?? 'Read-only view.'}</p>
        {f.compatibilityReason && <p className="mt-1">Reason: {f.compatibilityReason}</p>}
        {f.informationalNotice && <p className="mt-1">{f.informationalNotice}</p>}
        <p className="mt-2 text-xs text-[var(--text-muted)]">The pinned version is the immutable executable definition used for this case. It is separate from the commercial planning basis in Client Setup, which is not execution authority.</p>
        {f.family === 'separation' && <p className="mt-1 text-xs text-[var(--text-muted)]">Final separation closure remains unavailable.</p>}
      </div>
      {redacted && <div role="status" data-testid="flow-redacted" className="mt-3 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-[var(--status-amber-fg)]">
        Progress is redacted for your current permissions. Statuses and blockers shown below may be incomplete and are not inferred.</div>}

      <Section id="flow-stages" title={`Stages (${f.stages.length})`}>
        {f.stages.length === 0 ? <p className="text-[var(--text-muted)]">No stages are recorded.</p> :
          <ol className="space-y-2">{f.stages.map((s, i) => (
            <li key={s.id} className="rounded-md border border-[var(--border)] p-3" data-testid={`flow-stage-${s.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-[var(--text-primary)]">{i + 1}. {s.label}</span>
                <Chip tone={redacted ? 'gray' : tone(s.status)}>{redacted ? 'redacted' : label(s.status)}</Chip>
              </div>
              <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[9rem_1fr]">
                <dt className="text-[var(--text-muted)]">Responsible role</dt><dd>{s.role}</dd>
                <dt className="text-[var(--text-muted)]">Depends on</dt><dd><List items={s.prerequisites.map((p) => f.stages.find((x) => x.id === p)?.label ?? p)} empty="No prerequisites (can start in parallel)" /></dd>
                <dt className="text-[var(--text-muted)]">Blockers</dt><dd>{redacted ? <span className="text-[var(--text-muted)]">Redacted</span> : <Blockers items={s.blockers} />}</dd>
              </dl>
            </li>))}</ol>}
      </Section>

      <Section id="flow-tasks" title={`Parallel tasks (${f.tasks.length})`}>
        {f.tasks.length === 0 ? <p className="text-[var(--text-muted)]">No tasks are recorded.</p> :
          <div className="grid gap-2 md:grid-cols-2">{f.tasks.map((t) => (
            <div key={t.id} className="rounded-md border border-[var(--border)] p-3" data-testid={`flow-task-${t.id}`}>
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="font-semibold text-[var(--text-primary)]">{t.label}</span>
                <Chip tone={redacted ? 'gray' : tone(t.status)}>{redacted ? 'redacted' : label(t.status)}</Chip></div>
              <p className="mt-1 text-xs">Role: {t.role}</p>
              <p className="text-xs">Depends on: {t.prerequisites.length ? t.prerequisites.join(', ') : 'none'}</p>
              {!redacted && t.blockers.length > 0 && <div className="mt-1 text-xs text-[var(--status-amber-fg)]"><Blockers items={t.blockers} /></div>}
            </div>))}</div>}
      </Section>

      <Section id="flow-actions" title={`Possible actions, informational (${f.actions.length})`}>
        <p className="mb-2 text-xs text-[var(--text-muted)]">Listed for inspection only. Eligibility here does not authorize you to act; the server checks authority and evidence when work is recorded.</p>
        {f.actions.length === 0 ? <p className="text-[var(--text-muted)]">No actions are listed.</p> :
          <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-left text-xs">
            <caption className="sr-only">Possible actions for this case</caption>
            <thead><tr className="border-b border-[var(--border)] text-[var(--text-muted)]"><th scope="col" className="py-1 pr-2">Action</th><th scope="col" className="pr-2">Stage</th><th scope="col" className="pr-2">Eligibility</th><th scope="col" className="pr-2">Needs authority</th><th scope="col">Needs evidence</th></tr></thead>
            <tbody>{f.actions.map((a) => (
              <tr key={a.id} className="border-b border-[var(--border)] align-top" data-testid={`flow-action-${a.id}`}>
                <th scope="row" className="py-1 pr-2 font-medium">{label(a.id)}<div className="font-normal text-[var(--text-muted)]">{a.handler}</div></th>
                <td className="pr-2">{f.stages.find((s) => s.id === a.stage)?.label ?? a.stage}</td>
                <td className="pr-2">{redacted ? 'Redacted' : a.eligible ? 'Currently eligible (informational)' : 'Not currently eligible'}{!redacted && a.blockers.length > 0 && <List items={a.blockers} empty="" />}</td>
                <td className="pr-2">{a.requiredAuthority.join(', ') || 'None listed'}</td>
                <td>{a.requiredEvidence.join(', ') || 'None listed'}</td>
              </tr>))}</tbody></table></div>}
      </Section>

      {def && <Section id="flow-definition" title="Definition structure and branches">
        <p className="mb-2 text-xs text-[var(--text-muted)]">{def.id} v{def.version} · family {def.family}. Condition text is shown as recorded.</p>
        <ul className="space-y-1 text-xs">{def.stages.map((s) => (
          <li key={s.id} className="rounded border border-[var(--border)] p-2"><b>{s.label}</b> · {s.role}
            <div>Applies when: {s.applies || 'always'} · Complete when: {s.completed || 'not specified'}</div>
            <div>Prerequisites: {s.prerequisites.join(', ') || 'none'}</div>
            {def.actions.filter((a) => a.stage === s.id).map((a) => <div key={a.id} className="text-[var(--text-muted)]">Action {a.id}: requires {a.requires.join(', ') || 'nothing'}{a.reworkTo ? `; rework returns to ${a.reworkTo}` : ''}</div>)}
          </li>))}</ul>
      </Section>}

      <Section id="flow-history" title={`Recorded history (${f.history.length})`}>
        <p className="mb-2 text-xs text-[var(--text-muted)]">Up to 100 recent transitions are shown. Older records are retained.</p>
        {f.history.length === 0 ? <p className="text-[var(--text-muted)]">{redacted ? 'History is redacted or not recorded.' : 'No flow actions have been recorded.'}</p> :
          <ol className="space-y-2">{f.history.map((h, i) => (
            <li key={`${h.actionId}-${h.occurredAt}-${i}`} className="rounded-md border border-[var(--border)] p-2 text-xs">
              <b>{label(h.actionId)}</b> · {h.outcome} · {new Date(h.occurredAt).toLocaleString()}
              <div>{h.reason}</div><div className="text-[var(--text-muted)]">Version {h.definitionId} v{h.definitionVersion}</div>
            </li>))}</ol>}
      </Section>
    </div>
  );
}

export function CaseFlowPanel({ caseId }: { caseId: number }) {
  const { user } = useUser();
  const q = useGetCaseExecutableFlow(caseId, { query: {
    enabled: !!caseId && !!user,
    queryKey: [...getGetCaseExecutableFlowQueryKey(caseId), getPinnedOrganizationIdForPage() ?? 'no-tenant', user?.id ?? 'signed-out'],
    retry: false, refetchInterval: 15_000, refetchOnWindowFocus: true,
  } });
  if (q.isLoading) return <div aria-busy="true" aria-label="Loading flow" className="space-y-2">{[0, 1, 2].map((i) => <div key={i} className="h-12 animate-pulse rounded-md bg-[var(--surface-soft)]" />)}</div>;
  const validResponse = q.data !== undefined && GetCaseExecutableFlowResponse.safeParse(q.data).success;
  if (q.isError || !validResponse) return <div role="alert" className="rounded-md border border-[var(--status-red-fg)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)]">
    The flow could not be loaded. Case operations are unaffected.
    {!q.isError && q.data !== undefined && <p>The Flow response did not match the expected contract.</p>}
    <button type="button" data-testid="button-retry-flow" onClick={() => q.refetch()} className="ml-3 min-h-9 rounded-md border border-current px-3 font-semibold">Retry</button></div>;
  return <FlowBody f={q.data!} />;
}
