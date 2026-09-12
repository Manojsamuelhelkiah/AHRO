import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, CheckCircle2, LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@/components/ui-shared';
import { getPinnedOrganizationIdForPage } from '@workspace/api-client-react';
import { useOrganizationRole } from '../../../hooks/use-organization-role';

type ExceptionType = 'no-response' | 'payroll-cutoff' | 'delayed-bgv';
type ManualFulfillment = {
  area: 'bgv' | 'payroll' | 'benefits';
  status: string;
  evidenceStatus: string;
  consentStatus: string;
  cutoffStatus: string;
  reconciliationStatus: string;
  failureStatus: string;
};
type View = {
  version: number;
  startDate: string;
  preparation: { allowed: true; message: string };
  startDateImpacts: Array<{ stream: string; owner: string; status: string }>;
  startDateReconciliation: { state: 'not-required' | 'pending-review' | 'complete'; message: string };
  rehireReuse: { eligible: boolean; message: string };
  conditionalJoin: { enabled: boolean; message: string };
  release: { access: { eligible: boolean; blockers: string[] }; assets: { eligible: boolean; blockers: string[] } };
  exceptions: Array<{ type: ExceptionType; owner: string; state: 'held' | 'clear'; message: string }>;
  manualFulfillment: ManualFulfillment[];
};

function title(type: ExceptionType) {
  return type.replace(/-/g, ' ');
}

/**
 * This intentionally uses a narrow status endpoint rather than operational
 * request progress. Operational-request completion is a simulation/human task
 * record and is never rendered as evidence for a real release.
 */
export function StandardOperationsPanel({ caseId }: { caseId: number }) {
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [newStartDate, setNewStartDate] = useState('');
  const [manualDrafts, setManualDrafts] = useState<Record<string, ManualFulfillment>>({});
  const { isHR, loading } = useOrganizationRole();

  const request = useCallback(async (path = '', init?: RequestInit) => {
    const organizationId = getPinnedOrganizationIdForPage();
    const response = await fetch(`/api/onboarding/cases/${caseId}/standard-operations${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        ...(organizationId ? { 'x-organization-id': organizationId } : {}),
        ...(init?.headers ?? {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.message || 'Could not load standard operations safeguards.');
    return body as View;
  }, [caseId]);

  const load = useCallback(() => {
    setError(null);
    request().then(setView).catch((caught) =>
      setError(caught instanceof Error ? caught.message : 'Could not load standard operations safeguards.'),
    );
  }, [request]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (view) setNewStartDate(view.startDate);
  }, [view?.startDate]);

  const updateException = async (type: ExceptionType, resolve: boolean) => {
    if (!view) return;
    setBusy(type);
    setError(null);
    try {
      // The server validates a non-empty rationale but deliberately does not
      // retain it, because free text can contain restricted BGV/payroll data.
      await request(resolve ? `/exceptions/${type}/resolve` : '/exceptions', {
        method: 'POST',
        body: JSON.stringify(resolve
          ? { expectedVersion: view.version, rationale: 'HR Operations reviewed this exception.' }
          : { type, expectedVersion: view.version, rationale: 'HR Operations placed a safe exception hold.' }),
      });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update the exception hold.');
      load();
    } finally {
      setBusy(null);
    }
  };

  const updateStartDate = async () => {
    if (!view) return;
    setBusy('date-change');
    setError(null);
    try {
      await request('/start-date', {
        method: 'PUT',
        body: JSON.stringify({ startDate: newStartDate, expectedVersion: view.version, rationale: 'HR Operations opened start-date reconciliation.' }),
      });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update start-date reconciliation.');
      load();
    } finally {
      setBusy(null);
    }
  };

  const reconcileImpact = async (stream: string, resolution: 'source-proof' | 'manual-resolution') => {
    if (!view) return;
    setBusy(`impact:${stream}`);
    setError(null);
    try {
      await request(`/start-date/impacts/${stream}/reconcile`, {
        method: 'POST',
        body: JSON.stringify({
          expectedVersion: view.version,
          resolution,
          rationale: resolution === 'source-proof'
            ? 'HR Operations reconciled this stream against the current trusted source.'
            : 'The accountable stream owner recorded a manual reconciliation resolution.',
        }),
      });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not reconcile the start-date impact.');
      load();
    } finally {
      setBusy(null);
    }
  };

  const saveManualFulfillment = async (item: ManualFulfillment) => {
    if (!view) return;
    const draft = manualDrafts[item.area] ?? item;
    setBusy(`manual:${item.area}`);
    setError(null);
    try {
      await request('/manual-fulfillment', {
        method: 'POST',
        body: JSON.stringify({
          ...draft,
          expectedVersion: view.version,
          rationale: 'An accountable owner updated the restricted manual fulfillment status.',
        }),
      });
      setManualDrafts((current) => {
        const next = { ...current };
        delete next[item.area];
        return next;
      });
      load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not save manual fulfillment status.');
      load();
    } finally {
      setBusy(null);
    }
  };

  if (!view && !error) {
    return <Card><CardContent className="p-5 text-sm text-[var(--text-muted)]">Loading standard operations safeguards…</CardContent></Card>;
  }
  if (!view) {
    return <Card><CardContent className="p-5 text-sm text-[var(--status-red)]" role="alert">
      {error} <Button variant="outline" className="ml-3" onClick={load}>Try again</Button>
    </CardContent></Card>;
  }

  const blockers = [...new Set([...view.release.access.blockers, ...view.release.assets.blockers])];
  return (
    <Card className="border-[var(--border)] shadow-[var(--shadow-sm)]">
      <CardHeader className="border-b bg-[var(--surface-alt)] pb-4">
        <CardTitle className="flex items-center gap-2 text-[var(--text-base)]">
          <CalendarClock className="h-5 w-5 text-[var(--violet)]" /> Standard operations & start-date reconciliation
        </CardTitle>
        <p className="mt-2 text-xs leading-relaxed text-[var(--text-muted)]">
          This is a preparation and reconciliation plan. It does not invoke a provider, create access, release an asset, enroll payroll/benefits, or publish a schedule.
        </p>
      </CardHeader>
      <CardContent className="space-y-5 p-5">
        <div className="rounded-md border border-[var(--status-blue)]/30 bg-[var(--surface-alt)] p-3 text-xs text-[var(--text-secondary)]">
          <ShieldCheck className="mr-1 inline h-4 w-4 text-[var(--status-blue)]" /> {view.preparation.message}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Start-date impact owners</h4>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {view.startDateImpacts.map((item) => <div key={item.stream} className="rounded border border-[var(--border)] p-2 text-xs">
              <div className="font-semibold capitalize text-[var(--text-primary)]">{item.stream}</div>
              <div className="mt-1 text-[var(--text-muted)]">{item.owner}</div>
              <div className="mt-1 font-medium text-[var(--status-amber-fg)]">
                {item.status === 'source-confirmed' ? 'Trusted source proof recorded' : item.status === 'manual-resolution' ? 'Accountable manual resolution recorded' : 'Review required'}
              </div>
              {isHR && !loading && view.startDateReconciliation.state === 'pending-review' && item.status === 'review-required' && (
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => reconcileImpact(item.stream, 'source-proof')}>
                    {busy === `impact:${item.stream}` ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Verify source'}
                  </Button>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => reconcileImpact(item.stream, 'manual-resolution')}>
                    Manual resolution
                  </Button>
                </div>
              )}
            </div>)}
          </div>
          <div className={`mt-3 rounded border p-3 text-xs ${view.startDateReconciliation.state === 'pending-review' ? 'border-[var(--status-amber)] bg-[var(--status-amber-bg)]' : 'border-[var(--border)]'}`}>
            <strong>Start date: {view.startDate}</strong>
            <p className="mt-1 text-[var(--text-muted)]">{view.startDateReconciliation.message}</p>
            {isHR && !loading && <div className="mt-3 flex flex-wrap items-center gap-2">
              <input aria-label="New start date" type="date" value={newStartDate}
                onChange={(event) => setNewStartDate(event.target.value)}
                className="rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs" />
              <Button size="sm" variant="outline" disabled={!newStartDate || newStartDate === view.startDate || busy !== null}
                onClick={updateStartDate}>
                {busy === 'date-change' ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Change date & open review'}
              </Button>
            </div>}
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <div className={`rounded-md border p-3 text-xs ${view.rehireReuse.eligible ? 'border-[var(--status-green)] bg-[var(--status-green-bg)]' : 'border-[var(--status-amber)] bg-[var(--status-amber-bg)]'}`}>
            <strong>Rehire reuse: {view.rehireReuse.eligible ? 'eligible to consider' : 'held'}</strong>
            <p className="mt-1">{view.rehireReuse.message}</p>
          </div>
          <div className={`rounded-md border p-3 text-xs ${view.conditionalJoin.enabled ? 'border-[var(--status-green)] bg-[var(--status-green-bg)]' : 'border-[var(--status-amber)] bg-[var(--status-amber-bg)]'}`}>
            <strong>Conditional join: {view.conditionalJoin.enabled ? 'policy-enabled' : 'disabled'}</strong>
            <p className="mt-1">{view.conditionalJoin.message}</p>
          </div>
        </div>

        <div className={`rounded-md border p-3 ${blockers.length ? 'border-[var(--status-red)] bg-[var(--status-red-bg)]' : 'border-[var(--status-green)] bg-[var(--status-green-bg)]'}`}>
          <div className="flex items-center gap-2 text-sm font-bold">
            {blockers.length ? <LockKeyhole className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            Access and asset release {blockers.length ? 'held' : 'eligible for a separately fenced provider action'}
          </div>
          {blockers.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
            {blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}
          </ul>}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Restricted manual fulfillment tracking</h4>
          <p className="mb-2 text-xs text-[var(--text-muted)]">These accountable status records never claim live enrollment, provider proof, readiness, or release.</p>
          <div className="space-y-2">
            {view.manualFulfillment.map((item) => {
              const draft = manualDrafts[item.area] ?? item;
              const updateDraft = (key: keyof ManualFulfillment, value: string) => setManualDrafts((current) => ({
                ...current,
                [item.area]: { ...draft, [key]: value },
              }));
              return <div key={item.area} className="rounded border border-[var(--border)] p-3 text-xs">
                <div className="mb-2 font-semibold capitalize text-[var(--text-primary)]">{item.area}</div>
                <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <label>Status<select value={draft.status} onChange={(e) => updateDraft('status', e.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] p-1"><option>not-started</option><option>in-progress</option><option>failed</option><option>resolved</option></select></label>
                  <label>Evidence<select value={draft.evidenceStatus} onChange={(e) => updateDraft('evidenceStatus', e.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] p-1"><option>not-recorded</option><option>recorded</option></select></label>
                  <label>Consent<select value={draft.consentStatus} onChange={(e) => updateDraft('consentStatus', e.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] p-1"><option>not-applicable</option><option>pending</option><option>recorded</option></select></label>
                  <label>Cutoff<select value={draft.cutoffStatus} onChange={(e) => updateDraft('cutoffStatus', e.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] p-1"><option>not-applicable</option><option>unknown</option><option>reviewed</option></select></label>
                  <label>Reconciliation<select value={draft.reconciliationStatus} onChange={(e) => updateDraft('reconciliationStatus', e.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] p-1"><option>not-started</option><option>pending</option><option>resolved</option></select></label>
                  <label>Failure<select value={draft.failureStatus} onChange={(e) => updateDraft('failureStatus', e.target.value)} className="mt-1 block w-full rounded border border-[var(--border)] bg-[var(--surface)] p-1"><option>none</option><option>active</option></select></label>
                </div>
                {isHR && !loading && <Button size="sm" variant="outline" className="mt-2" disabled={busy !== null} onClick={() => saveManualFulfillment(item)}>
                  {busy === `manual:${item.area}` ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : 'Save accountable status'}
                </Button>}
              </div>;
            })}
          </div>
        </div>

        <div>
          <h4 className="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">HR Operations exception holds</h4>
          <div className="space-y-2">
            {view.exceptions.map((exception) => <div key={exception.type} className="flex flex-col gap-2 rounded border border-[var(--border)] p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs">
                <div className="font-semibold capitalize text-[var(--text-primary)]">
                  {exception.state === 'held' && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 text-[var(--status-red)]" />}
                  {title(exception.type)} · {exception.owner}
                </div>
                <p className="mt-1 text-[var(--text-muted)]">{exception.message}</p>
              </div>
              {isHR && !loading && (
                <Button size="sm" variant="outline" disabled={busy === exception.type}
                  onClick={() => updateException(exception.type, exception.state === 'held')}>
                  {busy === exception.type ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : exception.state === 'held' ? 'Mark reviewed' : 'Place hold'}
                </Button>
              )}
            </div>)}
          </div>
        </div>
        {error && <p role="alert" className="text-xs text-[var(--status-red)]">{error}</p>}
      </CardContent>
    </Card>
  );
}