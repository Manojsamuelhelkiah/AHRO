import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetHroEmailRotation, useStageHroEmailRotation, useReadmitHroEmailRequests, useConfigureHroEmailIntake,
  getGetHroEmailRotationQueryKey, getGetHroEmailIntakeQueryKey, getListHroEmailRequestsQueryKey,
} from '@workspace/api-client-react';
import { Button, Input, Label } from '@/components/ui-shared';
import { ErrorNote, fmtDate, Pill, Skeleton, emailAccessRefresh } from './common';

/** A metadata-only surface: never load the queue's private request or source endpoints. */
export function MarkerRotation({ routeId, headers, scope }: { routeId: string; headers: Record<string, string>; scope: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reference, setReference] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [before, setBefore] = useState<string>();
  const [notice, setNotice] = useState('');
  const q = useGetHroEmailRotation(routeId, before ? { before } : undefined, {
    request: { headers }, query: {
      queryKey: [...getGetHroEmailRotationQueryKey(routeId), scope, before],
      enabled: open, retry: false, refetchInterval: q => emailAccessRefresh(q) ? 15_000 : false,
      refetchOnWindowFocus: emailAccessRefresh, refetchOnMount: emailAccessRefresh, staleTime: 0,
    },
  });
  const stage = useStageHroEmailRotation({ request: { headers } });
  const review = useConfigureHroEmailIntake({ request: { headers } });
  const readmit = useReadmitHroEmailRequests({ request: { headers } });
  const d = q.data, replacement = d?.replacement;
  const busy = stage.isPending || review.isPending || readmit.isPending;
  const refOk = reference.trim().length > 0 && reference.length <= 240;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: getGetHroEmailRotationQueryKey(routeId) });
    qc.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() });
    qc.invalidateQueries({ queryKey: getListHroEmailRequestsQueryKey() });
  };
  const completed = (message: string) => {
    setNotice(message); setReference(''); setSelected({}); setAcknowledged(false); setBefore(undefined);
    refresh();
  };
  return (
    <div className="space-y-3">
      <Button size="sm" variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? 'Hide marker replacement' : 'Preview marker replacement / held requests'}
      </Button>
      {open && <section className="space-y-3 rounded-md border border-[var(--border)] p-3" aria-label="Staged marker replacement">
        <h3 className="text-sm font-semibold">Staged marker replacement</h3>
        <p className="text-xs text-[var(--text-muted)]">Staging permanently retires the old marker. It cannot be reopened. A different named client owner or administrator with current route-configuration permissions must approve the replacement on the same connected Gmail primary mailbox. No historical inbox replay occurs. Selected held requests still need fresh field review; blocks, private sources and retention holds remain unchanged. Sender identity and permission to execute work are never established here.</p>
        {q.isLoading ? <Skeleton n={2} /> : q.isError || !d ? <ErrorNote error={q.error} onRetry={() => q.refetch()} /> : <>
          <p className="text-xs">Old route version {d.route.version} · {d.route.retiredAt ? `Permanently retired ${fmtDate(d.route.retiredAt)}` : 'Not retired'}</p>
          {replacement && <p className="text-xs break-all">Replacement: <span className="font-mono">{replacement.subjectMarker}</span> · v{replacement.version} · <Pill tone={replacement.enabled ? 'green' : 'amber'}>{replacement.reviewRequired ? 'Independent review required' : replacement.enabled ? 'Reviewed and enabled' : 'Paused or retired'}</Pill></p>}
          <h4 className="text-sm font-semibold">Affected held requests — metadata only</h4>
          <p className="text-xs text-[var(--text-muted)]">Converted, rejected, unbound, other-client and post-retirement requests are excluded. Blocked requests stay blocked after re-admission. No request is selected automatically.</p>
          {!d.requests.length ? <p className="text-sm">No held requests on this preview page.</p> : <ul className="space-y-2">
            {d.requests.map(row => <li key={row.id} className="flex items-start gap-2 text-xs">
              <input type="checkbox" id={`readmit-${row.id}`} disabled={busy || !replacement?.enabled || !!replacement.retiredAt} checked={selected[row.id] !== undefined}
                onChange={e => setSelected(previous => { const next = { ...previous }; if (e.target.checked) next[row.id] = row.version; else delete next[row.id]; return next; })} />
              <label htmlFor={`readmit-${row.id}`}><span className="font-mono">{row.id}</span> · {row.status} · v{row.version} · received {fmtDate(row.receivedAt)}</label>
            </li>)}
          </ul>}
          <div className="flex gap-2">
            {before && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setBefore(undefined); setSelected({}); }}>First page</Button>}
            {d.nextBefore && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setBefore(d.nextBefore!); setSelected({}); }}>Next page</Button>}
          </div>
          <Label htmlFor={`rotation-reference-${routeId}`}>Required review reference</Label>
          <Input id={`rotation-reference-${routeId}`} maxLength={240} value={reference} onChange={e => setReference(e.target.value)} />
          {!d.route.retiredAt && <>
            <label className="flex gap-2 text-xs"><input type="checkbox" checked={acknowledged} onChange={e => setAcknowledged(e.target.checked)} />I understand the old marker will be permanently retired and cannot be reopened.</label>
            <Button size="sm" variant="destructive" disabled={!refOk || !acknowledged || busy || !d.route.activatedAt || !d.route.mailboxAddress} onClick={() => stage.mutate({
              routeId, data: { expectedVersion: d.route.version, reference: reference.trim(), retirementAcknowledged: true },
            }, { onSuccess: () => completed('Old marker permanently retired. Replacement staged for a different verified reviewer.'), onError: refresh })}>Retire old marker and stage replacement</Button>
            {(!d.route.activatedAt || !d.route.mailboxAddress) && <p className="text-xs">This route needs verified primary-mailbox review before marker replacement can be staged.</p>}
          </>}
          {replacement?.reviewRequired && <Button size="sm" disabled={!refOk || busy} onClick={() => review.mutate({
            data: { routeId: replacement.id, expectedVersion: replacement.version, reference: reference.trim(), backfillHours: 0 },
          }, { onSuccess: () => completed('Replacement independently reviewed. Select held requests for explicit re-admission.'), onError: refresh })}>Independently review replacement binding</Button>}
          {d.route.retiredAt && replacement?.enabled && !replacement.retiredAt && <Button size="sm" disabled={!refOk || busy || !Object.keys(selected).length} onClick={() => readmit.mutate({
            routeId, data: { expectedVersion: d.route.version, expectedReplacementVersion: replacement.version,
              reference: reference.trim(), requests: Object.entries(selected).map(([id, expectedVersion]) => ({ id, expectedVersion })) },
          }, { onSuccess: () => completed('Selected requests re-admitted for fresh field review. Blocks and holds preserved; no cases or external effects created.'), onError: refresh })}>
            Re-admit selected requests ({Object.keys(selected).length})
          </Button>}
        </>}
        {busy && <p role="status" className="text-xs">Saving reviewed change…</p>}
        {notice && <p role="status" className="text-xs">{notice}</p>}
        {(stage.isError || review.isError || readmit.isError) && <ErrorNote error={stage.error || review.error || readmit.error} />}
      </section>}
    </div>
  );
}
