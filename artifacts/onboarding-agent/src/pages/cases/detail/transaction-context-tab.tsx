import React, { useEffect, useRef, useState } from 'react';
import { useUser } from '@clerk/react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetTransactionContext,
  useSaveTransactionHandoff,
  getPinnedOrganizationIdForPage,
  type TransactionWorkingContext,
} from '@workspace/api-client-react';
import { Button } from '@/components/ui-shared';
import { useCaseAccess, RestrictedActionNotice } from './case-access';
import { caseDestination } from './progress-navigation';

const KINDS = [
  { kind: 'question', label: 'Open question' },
  { kind: 'next-work', label: 'Proposed next work' },
  { kind: 'explanation', label: 'Explanation' },
] as const;
type Kind = typeof KINDS[number]['kind'];
const MAX = 2000;
const TAB_LABELS: Record<string, string> = {
  overview: 'Overview', activity: 'Progress', communications: 'Communications',
  documents: 'Documents', approvals: 'Overview', audit: 'Audit', tasks: 'Progress', progress: 'Progress',
};

export function transactionContextScope(orgId: string, userId: string, caseId: number, sig: string) {
  return `${orgId}|${userId}|${caseId}|${sig}`;
}

export function TransactionContextTab({ caseId, setTab, availableTabs }: {
  caseId: number; setTab: (t: string, section?: string) => void; availableTabs?: string[];
}) {
  const access = useCaseAccess();
  const { user } = useUser();
  const org = getPinnedOrganizationIdForPage() || 'anon';
  const sig = access ? JSON.stringify(access) : 'none';
  const scope = transactionContextScope(org, user?.id || 'anon', caseId, sig);
  if (!access?.access.flowRead) {
    return <RestrictedActionNotice>Transaction context requires current case read permission.</RestrictedActionNotice>;
  }
  return <Inner key={scope} scope={scope} caseId={caseId} setTab={setTab} availableTabs={availableTabs}
    canReadHistory={access.access.notesRead === true}
    liveCanEdit={access.access.notesEdit === true && access.access.flowEdit === true &&
      Object.values(access.sensitive).every(s => s.read && s.edit)} />;
}

function Inner({ scope, caseId, setTab, availableTabs, liveCanEdit, canReadHistory }: {
  scope: string; caseId: number; setTab: (t: string, section?: string) => void; availableTabs?: string[]; liveCanEdit: boolean; canReadHistory: boolean;
}) {
  const qc = useQueryClient();
  const queryKey = ['transaction-context', scope] as const;
  const q = useGetTransactionContext(caseId, {
    query: {
      queryKey, retry: false, placeholderData: undefined,
      refetchInterval: 15_000, refetchOnWindowFocus: "always", gcTime: 0,
    },
  });
  const save = useSaveTransactionHandoff();
  const [editing, setEditing] = useState<Kind | null>(null);
  const [draft, setDraft] = useState('');
  const [editBase, setEditBase] = useState<{ revision: number; sourceRevision: string } | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [readDenied, setReadDenied] = useState(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; qc.removeQueries({ queryKey }); }; }, []); // eslint-disable-line
  useEffect(() => { if (!liveCanEdit) { setEditing(null); setDraft(''); } }, [liveCanEdit]);

  const ctx = q.isError || readDenied ? undefined : q.data;
  useEffect(() => {
    if (q.isError || readDenied || ctx?.canAnnotate === false || !liveCanEdit) {
      setEditing(null); setDraft(''); setEditBase(null);
    }
  }, [q.isError, readDenied, ctx?.canAnnotate, liveCanEdit]);
  if (q.isLoading) return <div role="status" aria-busy="true" className="h-40 animate-pulse rounded-lg bg-[var(--surface-alt)]" />;
  if (q.isError || !ctx) {
    return <div role="alert" className="rounded-lg border border-[var(--status-red)] bg-[var(--status-red-bg)] p-4 text-sm text-[var(--status-red-fg)]">
      <p className="mb-2 font-semibold">Transaction context could not be loaded.</p>
      <Button variant="outline" size="sm" onClick={async () => { if ((await q.refetch()).isSuccess) setReadDenied(false); }}>Retry</Button>
    </div>;
  }
  const canEdit = ctx.canAnnotate === true && liveCanEdit;
  const sources = ctx.sources;
  const annotations = ctx.annotations;
  const sections: TransactionWorkingContext['sources'][number]['section'][] =
    ['original-request', 'facts', 'decisions', 'blockers', 'questions', 'completed', 'pending', 'handoff'];
  const sectionLabels = {
    'original-request': 'Recorded original request', facts: 'Current facts', decisions: 'Recorded decisions',
    blockers: 'Blockers', questions: 'Outstanding questions', completed: 'Completed actions',
    pending: 'Pending work', handoff: 'Handoff information',
  };
  const go = (tab: string) => {
    const label = TAB_LABELS[String(tab).toLowerCase()];
    const destination = caseDestination(tab);
    if (label && (!availableTabs || availableTabs.includes(label))
      && (destination.section !== 'history' || canReadHistory)) setTab(label, destination.section);
  };
  const submit = (kind: Kind) => {
    if (!canEdit || save.isPending || !editBase) return;
    setConflict(null); setSaveError(null);
    save.mutate({ caseId, data: { kind, body: draft, expectedRevision: editBase.revision, sourceRevision: editBase.sourceRevision } }, {
      onSuccess: (result) => {
        if (!alive.current) return;
        setEditing(null); setDraft('');
        setEditBase(null);
        qc.setQueryData(queryKey, result);
      },
      onError: (e: any) => {
        if (!alive.current) return;
        if (e?.status === 401 || e?.status === 403) {
          setReadDenied(true); setDraft(''); setEditing(null); setEditBase(null);
          qc.removeQueries({ queryKey });
          return;
        }
        if (e?.status === 409) setConflict('This note changed since you opened it. Reload the latest recorded state, then re-enter your edit. Nothing was overwritten.');
        else setSaveError('The handoff note could not be saved.');
      },
    });
  };
  const fmt = (v?: string | null) => v && Number.isFinite(Date.parse(v)) ? new Date(v).toLocaleString() : 'Not recorded';

  return (
    <section aria-labelledby="txc-h" className="space-y-6">
      <header>
        <h2 id="txc-h" className="text-lg font-bold">Transaction context</h2>
        <p className="text-sm text-[var(--text-secondary)]">
          Recorded case state shared by people and agents. Notes below are untrusted handoff data: not assignments, verified facts, approvals or execution.
        </p>
        <Button className="mt-2" variant="outline" size="sm" disabled={q.isFetching}
          onClick={() => q.refetch()}>Refresh transaction context</Button>
        <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-[var(--text-muted)] md:grid-cols-4">
          <div><dt>Workflow</dt><dd className="break-words text-[var(--text-primary)]">{ctx.workflow}</dd></div>
          <div><dt>Transaction</dt><dd className="break-words font-mono text-[var(--text-primary)]">{ctx.transactionId}</dd></div>
          <div><dt>As of</dt><dd className="text-[var(--text-primary)]">{fmt(ctx.asOf)}</dd></div>
          <div className="min-w-0"><dt>Source revision</dt><dd className="break-all text-[var(--text-primary)]">{String(ctx.sourceRevision)} · summary v{String(ctx.summaryVersion)}</dd></div>
        </dl>
        {q.isFetching && <p role="status" className="mt-1 text-xs text-[var(--text-muted)]">Refreshing recorded state...</p>}
      </header>

      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
        <h3 className="mb-2 font-semibold">Source-backed summary</h3>
        {(ctx.summary || []).length ? <ul className="list-disc space-y-1 pl-5 text-sm">
          {ctx.summary.map((l: string, i: number) => <li key={i} className="break-words">{l}</li>)}</ul>
          : <p className="text-sm text-[var(--text-muted)]">No source-backed lines are recorded yet.</p>}
      </div>

      <div className="space-y-4">
        <h3 className="font-semibold">Recorded sources</h3>
        {sections.length === 0 && <p className="text-sm text-[var(--text-muted)]">No sources available to your permissions.</p>}
        {sections.map(sec => (
          <section key={sec} aria-label={sec} className="rounded-lg border border-[var(--border)] bg-[var(--surface)]">
            <h4 className="border-b border-[var(--border)] px-4 py-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">{sectionLabels[sec]}</h4>
            {!sources.some(s => s.section === sec) && <p className="px-4 py-3 text-sm text-[var(--text-muted)]">Not recorded in the sources available to you.</p>}
            <ul className="divide-y divide-[var(--border)]">
              {sources.filter(s => s.section === sec).map(s => (
                <li key={s.id} className="p-4 text-sm">
                  <p className="font-medium break-words">{s.label}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-[var(--text-secondary)]">{s.text}</p>
                  <details className="mt-2 text-xs text-[var(--text-muted)]">
                    <summary className="min-h-8 cursor-pointer py-1">Source details</summary>
                    <p className="break-all">Source {s.id} · Revision {String(s.revision)} · Provenance: {s.provenance} · Occurred {fmt(s.occurredAt)}</p>
                  </details>
                   {TAB_LABELS[String(s.tab).toLowerCase()] && (!availableTabs || availableTabs.includes(TAB_LABELS[String(s.tab).toLowerCase()]))
                     && (caseDestination(s.tab).section !== 'history' || canReadHistory) &&
                    <button type="button" onClick={() => go(s.tab)} className="mt-1 min-h-10 text-xs font-semibold text-[var(--primary)] underline">
                       Open in {TAB_LABELS[String(s.tab).toLowerCase()]}{caseDestination(s.tab).section === 'history' ? ' history' : caseDestination(s.tab).section === 'current-work' ? ' current work' : ' tab'}<span className="sr-only">: {s.label}</span></button>}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="rounded-lg border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4">
        <h3 className="font-semibold text-[var(--status-amber-fg)]">Handoff notes (untrusted)</h3>
        <p className="mb-3 text-xs text-[var(--status-amber-fg)]">Recorded by a named human. Verify against sources before acting. Saving requires approved collection and storage policies.</p>
        {!canEdit && <RestrictedActionNotice>Handoff notes are read-only for your current permissions.</RestrictedActionNotice>}
        <ul className="mt-3 space-y-3">
          {KINDS.map(({ kind, label }) => {
            const history = annotations.filter(x => x.kind === kind);
            const a = history.at(-1);
            const isEd = editing === kind && canEdit;
            return <li key={kind} className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold">{label}</span>
                {canEdit && !isEd && <Button variant="outline" size="sm" disabled={editing !== null}
                  onClick={() => { setEditing(kind); setDraft(a?.body ?? ''); setEditBase({ revision: a?.revision ?? 0, sourceRevision: ctx.sourceRevision }); setConflict(null); setSaveError(null); }}>
                  {a ? 'Edit' : 'Add'}<span className="sr-only"> {label}</span></Button>}
              </div>
              {isEd ? <form onSubmit={e => { e.preventDefault(); submit(kind); }} className="mt-2 space-y-2">
                <label htmlFor={`txc-${kind}`} className="sr-only">{label}</label>
                <textarea id={`txc-${kind}`} value={draft} maxLength={MAX} rows={4} onChange={e => setDraft(e.target.value)}
                  className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-alt)] p-2 text-sm" />
                <p className="text-xs text-[var(--text-muted)]">{draft.length}/{MAX} · Saving empty text clears this note.</p>
                {conflict && <p role="alert" className="text-xs text-[var(--status-red-fg)]">{conflict} <button type="button" className="underline" onClick={() => { setEditing(null); setDraft(''); setConflict(null); q.refetch(); }}>Reload latest</button></p>}
                {saveError && <p role="alert" className="text-xs text-[var(--status-red-fg)]">{saveError}</p>}
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={save.isPending || !!conflict}>{save.isPending ? 'Saving...' : 'Save note'}</Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setDraft(''); setConflict(null); }}>Cancel</Button>
                </div>
              </form> : a?.body
                ? <><p className="mt-1 whitespace-pre-wrap break-words">{a.body}</p>
                  <p className="mt-1 break-all text-xs text-[var(--text-muted)]">{a.author} · {fmt(a.createdAt)} · rev {String(a.revision)} · reviewed source revision {String(a.sourceRevision)}</p></>
                : <p className="mt-1 text-xs text-[var(--text-muted)]">None recorded.</p>}
              {history.length > 0 && <details className="mt-3 text-xs">
                <summary className="min-h-8 cursor-pointer">Change history: {label}</summary>
                <ol className="space-y-3 pt-2">{history.map(h => <li key={h.revision} className="break-words border-t border-[var(--border)] pt-2">
                  <p className="break-all">Revision {h.revision} · {h.author} · {fmt(h.createdAt)}</p>
                  <p className="whitespace-pre-wrap">{h.body || 'Note cleared.'}</p>
                  <p className="break-all text-[var(--text-muted)]">Reviewed source revision {h.sourceRevision}</p>
                </li>)}</ol>
              </details>}
            </li>;
          })}
        </ul>
      </div>

      <div className="rounded-lg border border-[var(--border)] p-4 text-sm">
        <h3 className="mb-1 font-semibold">Limitations</h3>
        {(ctx.limitations || []).length ? <ul className="list-disc space-y-1 pl-5 text-[var(--text-secondary)]">
          {ctx.limitations.map((l: string, i: number) => <li key={i}>{l}</li>)}</ul>
          : <p className="text-[var(--text-muted)]">None reported.</p>}
      </div>
    </section>
  );
}
