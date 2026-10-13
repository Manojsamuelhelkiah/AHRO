import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetOfflineCasePreparation,
  useSaveOfflineCasePreparation,
  useActivateOfflineCase,
  useReconfirmOfflineCaseActivation,
  useStartOfflineCaseWorkflow,
  getGetOfflineCasePreparationQueryKey,
  getGetOnboardingCaseQueryKey,
  getListOnboardingCasesQueryKey,
  getPinnedOrganizationIdForPage,
} from '@workspace/api-client-react';
import { useUser } from '@clerk/react';

function errorInfo(err: unknown): { status?: number; blockers: string[]; message: string } {
  const e = err as any;
  const status = e?.status ?? e?.response?.status;
  const body = e?.data ?? e?.body ?? e?.response?.data;
  const blockers: string[] = Array.isArray(body?.blockers) ? body.blockers.filter((b: unknown) => typeof b === 'string') : [];
  const message = body?.message ?? body?.error ?? e?.message ?? 'Save failed.';
  return { status, blockers, message: String(message) };
}

export function OperationalPreparationPanel({ caseId, canRead }: { caseId: number; canRead: boolean }) {
  const { user } = useUser();
  const org = getPinnedOrganizationIdForPage() || 'anon';
  const userId = user?.id || 'anon';
  return <OperationalPreparationPanelContent key={`${org}:${userId}:${caseId}:${canRead}`}
    caseId={caseId} canRead={canRead} org={org} userId={userId} />;
}

function OperationalPreparationPanelContent({ caseId, canRead, org, userId }: {
  caseId: number; canRead: boolean; org: string; userId: string;
}) {
  const qc = useQueryClient();
  const key = getGetOfflineCasePreparationQueryKey(caseId);
  const { data, isLoading, error, refetch } = useGetOfflineCasePreparation(caseId, {
    query: {
      queryKey: [...key, org, userId],
      enabled: canRead && caseId > 0,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnWindowFocus: true,
      refetchInterval: 20_000,
      retry: false,
    },
  });
  const save = useSaveOfflineCasePreparation();
  const activate = useActivateOfflineCase();
  const reconfirm = useReconfirmOfflineCaseActivation();
  const start = useStartOfflineCaseWorkflow();
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [excludeHistory, setExcludeHistory] = useState(false);
  useEffect(() => {
    setConfirmIdentity(false); setExcludeHistory(false);
  }, [data?.requirementsFingerprint, caseId, org, userId, canRead]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [base, setBase] = useState<{ revision: number; data: Record<string, string> } | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [saveErr, setSaveErr] = useState<{ blockers: string[]; message: string } | null>(null);
  const [conflict, setConflict] = useState(false);
  const baseRef = useRef(base);
  baseRef.current = base;
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const dirtyOf = (b: typeof base, d: Record<string, string>) =>
    !!b && Object.keys({ ...b.data, ...d }).some((k) => (b.data[k] ?? '') !== (d[k] ?? ''));

  useEffect(() => {
    baseRef.current = null;
    draftRef.current = {};
    setBase(null);
    setDraft({});
    setSaved(null);
    setSaveErr(null);
    setConflict(false);
  }, [caseId, org, userId, canRead]);

  useEffect(() => {
    if (error || !canRead || data?.canReadData === false) {
      baseRef.current = null;
      draftRef.current = {};
      setBase(null);
      setDraft({});
      setSaved(null);
      return;
    }
    if (!data) return;
    const b = baseRef.current;
    if (!b) {
      setBase({ revision: data.revision, data: data.data });
      setDraft({ ...data.data });
    } else if (data.revision !== b.revision) {
      if (dirtyOf(b, draftRef.current)) setConflict(true);
      else {
        setBase({ revision: data.revision, data: data.data });
        setDraft({ ...data.data });
      }
    }
  }, [data, error, canRead, caseId, org, userId]);

  if (!canRead) return null;
  const reload = () => {
    if (!data) return;
    setBase({ revision: data.revision, data: data.data });
    setDraft({ ...data.data });
    setConflict(false);
    setSaveErr(null);
  };
  const dirty = dirtyOf(base, draft);
  const readOnly = Boolean(error) || !data?.canReadData || !data?.canEdit || !data?.eligible;
  const field = 'min-h-10 w-full rounded-md border bg-[var(--surface)] px-2 py-1.5 text-sm disabled:opacity-70';

  const submit = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!data || !base || readOnly || conflict) return;
    const payload: Record<string, string> = {};
    data.fields.forEach((f) => { payload[f.key] = draft[f.key] ?? ''; });
    setSaveErr(null);
    setSaved(null);
    save.mutate({ caseId, data: { expectedRevision: base.revision, data: payload } }, {
      onSuccess: (view) => {
        setSaved(view.revision);
        setBase({ revision: view.revision, data: view.data });
        setDraft({ ...view.data });
        qc.setQueryData([...key, org, userId], view);
        qc.invalidateQueries({ queryKey: key });
        qc.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(caseId) });
        qc.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
      },
      onError: (err) => {
        const info = errorInfo(err);
        if (info.status === 409 && info.blockers.length === 0 && /revision|changed|stale/i.test(info.message)) setConflict(true);
        else setSaveErr({ blockers: info.blockers, message: info.message });
        qc.invalidateQueries({ queryKey: key });
      },
    });
  };
  const confirm = () => {
    if (!data?.requirementsFingerprint || dirty || conflict || !confirmIdentity || !excludeHistory) return;
    const mutation = data.activationGeneration ? reconfirm : activate;
    mutation.mutate({ caseId, data: {
      expectedRevision: data.revision, requirementsFingerprint: data.requirementsFingerprint,
      confirmIdentity: true, excludeHistoricalEvidence: true,
    } }, {
      onSuccess: view => {
        qc.setQueryData([...key, org, userId], view);
        qc.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(caseId) });
        qc.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
        setConfirmIdentity(false); setExcludeHistory(false); setSaveErr(null);
      },
      onError: err => { setSaveErr(errorInfo(err)); refetch(); },
    });
  };

  return (
    <section aria-label="Operational preparation" data-testid="panel-operational-preparation"
      className="mb-6 rounded-lg border bg-[var(--surface)] p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-[var(--text-primary)]">Operational preparation</h3>
        {data && <span className="text-xs text-[var(--text-muted)]">Revision {data.revision} · Evidence {data.evidenceStatus}</span>}
      </div>
      <p className="mt-1 text-xs text-[var(--text-secondary)]">
        The original fictional source{data?.sourceLabel ? ` (${data.sourceLabel})` : ''} is preserved unchanged. Entries here are unverified.
        Saving and confirming send no messages or links and never approve or close a case.
        After activation, start supported work separately using the normal case controls. Live operations require a named account, current permissions and configured supported providers.
      </p>
      {isLoading && <div className="mt-3 h-24 animate-pulse rounded-md bg-[var(--surface-soft)]" />}
      {error && (
        <div role="alert" className="mt-3 rounded-md border border-[var(--status-red-fg)] bg-[var(--status-red-bg)] p-2 text-xs text-[var(--status-red-fg)]">
          Preparation could not be loaded. <button type="button" className="underline" onClick={() => refetch()}>Retry</button>
        </div>
      )}
      {data && !error && (
        <form onSubmit={submit} className="mt-3 space-y-3" noValidate>
          {data.blockers.length > 0 && (
            <div role="status" data-testid="list-preparation-blockers" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]">
              <p className="font-semibold">Prerequisites outstanding</p>
              <ul className="mt-1 list-disc pl-4">{data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
            </div>
          )}
          {!data.eligible && <p className="text-xs text-[var(--text-muted)]">This case is not eligible for preparation.</p>}
          {!data.canEdit && <p className="text-xs text-[var(--text-muted)]">Read-only: your access does not allow saving preparation.</p>}
          {conflict && (
            <div role="alert" data-testid="alert-preparation-conflict" className="rounded-md border border-[var(--status-red-fg)] bg-[var(--status-red-bg)] p-2 text-xs text-[var(--status-red-fg)]">
              This preparation changed elsewhere. Your unsaved entries are kept but cannot be saved.{' '}
              <button type="button" className="font-semibold underline" onClick={reload}>Reload latest (discards your edits)</button>
            </div>
          )}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.fields.map((f) => {
              const id = `prep-${f.key}`;
              const val = !error && data.canReadData ? draft[f.key] ?? '' : '';
              const common = {
                id, name: f.key, value: val, disabled: readOnly, className: field,
                'aria-describedby': `${id}-d`, 'data-testid': `input-prep-${f.key}`,
              };
              const on = (e: React.ChangeEvent<any>) => setDraft((d) => ({ ...d, [f.key]: e.target.value }));
              return (
                <div key={f.key}>
                  <label htmlFor={id} className="mb-1 block text-xs font-medium text-[var(--text-secondary)]">
                    {f.label}{f.required && <span className="ml-1 text-[var(--status-amber-fg)]">(required to complete)</span>}
                  </label>
                  {f.kind === 'choice' ? (
                    <select {...common} onChange={on}>
                      <option value="">Not set</option>
                      {val && !f.values?.includes(val) && <option value={val}>{val}</option>}
                      {(f.values ?? []).map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  ) : (
                    <input {...common} onChange={on} type={f.kind === 'email' ? 'email' : 'text'}
                      placeholder={f.kind === 'date' ? 'YYYY-MM-DD' : undefined}
                      inputMode={f.kind === 'date' ? 'numeric' : undefined} autoComplete="off" />
                  )}
                  <p id={`${id}-d`} className="mt-0.5 text-[11px] text-[var(--text-muted)]">{f.description}</p>
                </div>
              );
            })}
          </div>
          {saveErr && (
            <div role="alert" data-testid="alert-preparation-save-error" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]">
              {saveErr.blockers.length > 0 ? (
                <><p className="font-semibold">Saving is blocked by missing prerequisites</p>
                  <ul className="mt-1 list-disc pl-4">{saveErr.blockers.map((b) => <li key={b}>{b}</li>)}</ul></>
              ) : saveErr.message}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" data-testid="button-save-preparation"
              disabled={readOnly || save.isPending || conflict || !dirty}
              className="min-h-10 rounded-md bg-[var(--primary)] px-4 text-sm font-semibold text-white disabled:opacity-50">
              {save.isPending ? 'Saving…' : 'Save preparation'}
            </button>
            {dirty && !save.isPending && <span className="text-xs text-[var(--text-muted)]">Unsaved changes</span>}
            {saved !== null && !dirty && <span role="status" data-testid="text-preparation-saved" className="text-xs font-medium text-[var(--status-green-fg)]">Saved as revision {saved}</span>}
          </div>
          {(data.canActivate || data.canReconfirm) && !readOnly && <div className="rounded-md border p-3 space-y-2">
            <p className="font-semibold">{data.activationGeneration ? 'Review current operational bindings' : 'Confirm operational activation'}</p>
            {data.activationGeneration && <p className="text-xs">Material corrections create fresh requirements; prior operational records remain history and must not approve the new work.</p>}
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={confirmIdentity} onChange={e => setConfirmIdentity(e.target.checked)} />
              <span>I confirm the actual worker, contact address and source request, and have reviewed the current requirements.</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={excludeHistory} onChange={e => setExcludeHistory(e.target.checked)} />
              <span>Original fictional history, sample approvals and simulated results are not evidence or authority for this work.</span>
            </label>
            <button type="button" onClick={confirm} data-testid="button-confirm-operational-activation"
              disabled={!confirmIdentity || !excludeHistory || dirty || conflict || save.isPending || activate.isPending || reconfirm.isPending}
              className="min-h-10 rounded-md bg-[var(--primary)] px-4 font-semibold text-white disabled:opacity-50">
              {activate.isPending || reconfirm.isPending ? 'Confirming…' : data.activationGeneration ? 'Reconfirm current requirements' : 'Activate without starting work'}
            </button>
          </div>}
          {data.activationGeneration && <div className="rounded-md border p-3 space-y-2">
            <p className="font-semibold">Operational workflow</p>
            <p className="text-xs text-[var(--text-muted)]">
              {data.workflowStarted
                ? 'This generation was explicitly started. Resolve its current requirements and use the normal approval and resume controls.'
                : 'Activation did not start work. A separate named-user confirmation is required before emails or external transactions can run.'}
            </p>
            {data.sourceName && <p className="text-xs">
              Original fictional identity: {data.sourceName}{data.sourceEmail ? ` (${data.sourceEmail})` : ''}.
              It remains source history, not the current worker or evidence.
            </p>}
            {data.workflowBlocker && <p className="text-xs">{data.workflowBlocker}</p>}
            {data.canStart && !readOnly && <button type="button"
              data-testid="button-start-operational-workflow"
              className="min-h-10 rounded-md bg-[var(--primary)] px-4 font-semibold text-white disabled:opacity-50"
              disabled={dirty || conflict || save.isPending || activate.isPending || reconfirm.isPending || start.isPending}
              onClick={() => {
                if (!data.requirementsFingerprint || dirty || conflict) return;
                start.mutate({ caseId, data: { expectedRevision: data.revision,
                  requirementsFingerprint: data.requirementsFingerprint, confirmStart: true } }, {
                  onSuccess: view => {
                    qc.setQueryData([...key, org, userId], view);
                    qc.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(caseId) });
                    qc.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
                    setSaveErr(null);
                  },
                  onError: err => { setSaveErr(errorInfo(err)); refetch(); },
                });
              }}>
              {start.isPending ? 'Starting…' : 'Start supported operational workflow'}
            </button>}
          </div>}
        </form>
      )}
    </section>
  );
}
