import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetHroEmailIntake, useConfigureHroEmailIntake, useUpdateHroEmailRoute, useListHroEmailRequests,
  useListHroEmailTriage, useResolveHroEmailTriage,
  getGetHroEmailIntakeQueryKey, getListHroEmailRequestsQueryKey, getListHroEmailTriageQueryKey,
} from '@workspace/api-client-react';
import type { HroEmailReadiness, HroEmailRoute, HroEmailTriage } from '@workspace/api-client-react';
import { Card, Button, Input, Label, PageHeader } from '@/components/ui-shared';
import { Mail, ShieldAlert, Lock } from 'lucide-react';
import { CopyButton, ErrorNote, Pill, Skeleton, fmtDate, inputCls, statusTone, useEmailScope } from './common';

function Templates({ data }: { data: HroEmailReadiness }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!data.templates.length) return <p className="text-sm text-[var(--text-muted)]">No template formats are published for this workspace.</p>;
  return (
    <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
      {data.templates.map(({ template: t, example }) => {
        const key = `${t.id}@${t.version}`;
        const isOpen = open === key;
        return (
          <li key={key} className="p-3">
            <button type="button" aria-expanded={isOpen} aria-controls={`tpl-${key}`} data-testid={`button-template-${t.id}`} onClick={() => setOpen(isOpen ? null : key)} className="flex w-full flex-wrap items-center justify-between gap-2 text-left">
              <span><span className="text-sm font-semibold">{t.name}</span> <span className="text-xs text-[var(--text-muted)]">{t.family} · v{t.version}{t.hireType ? ` · ${t.hireType}` : ''}</span></span>
              <span className="text-xs font-medium text-[var(--primary)]">{isOpen ? 'Hide format' : 'Show format'}</span>
            </button>
            {isOpen && (
              <div id={`tpl-${key}`} className="mt-3 grid gap-3 lg:grid-cols-2">
                <div>
                  <p className="mb-2 text-xs text-[var(--text-muted)]">{t.description}</p>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs"><caption className="sr-only">Fields for {t.name}</caption>
                      <thead><tr className="text-left text-[var(--text-muted)]"><th className="py-1 pr-2">Field</th><th className="pr-2">Key</th><th className="pr-2">Type</th><th>Required</th></tr></thead>
                      <tbody>{t.columns.map((c) => (
                        <tr key={c.key} className="border-t border-[var(--border)] align-top">
                          <td className="py-1 pr-2 font-medium">{c.label}<div className="font-normal text-[var(--text-muted)]">{c.description}{c.values?.length ? ` Allowed: ${c.values.join(', ')}.` : ''}</div></td>
                          <td className="pr-2 font-mono">{c.key}</td><td className="pr-2">{c.kind}</td><td>{c.required ? 'Required' : 'Optional'}</td>
                        </tr>))}</tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold">Example body</span><CopyButton value={example} label={`${t.name} example`} /></div>
                  <pre tabIndex={0} className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-[var(--surface-alt)] p-3 font-mono text-xs">{example}</pre>
                </div>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function RouteRow({ route, canConfigure, headers }: { route: HroEmailRoute; canConfigure: boolean; headers: Record<string, string> }) {
  const qc = useQueryClient();
  const upd = useUpdateHroEmailRoute({ request: { headers } });
  const toggle = () => upd.mutate({ routeId: route.id, data: { expectedVersion: route.version, enabled: !route.enabled } }, { onSettled: () => qc.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }) });
  return (
    <li className="space-y-2 p-3" data-testid={`row-route-${route.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2"><Pill tone={route.enabled ? 'green' : 'muted'}>{route.enabled ? 'Enabled' : 'Disabled'}</Pill><span className="text-xs text-[var(--text-muted)]">Route version {route.version}</span></div>
        <Button size="sm" variant="outline" disabled={!canConfigure || upd.isPending} data-testid={`button-toggle-route-${route.id}`} onClick={toggle} title={canConfigure ? undefined : 'Requires configure permission'}>
          {upd.isPending ? 'Saving...' : route.enabled ? 'Disable route' : 'Enable route'}
        </Button>
      </div>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-[var(--text-muted)]">Send mail to</dt><dd className="flex flex-wrap items-center gap-2 break-all font-mono text-xs">{route.mailboxAddress ?? 'Not available'}{route.mailboxAddress && <CopyButton value={route.mailboxAddress} label="mailbox address" />}</dd></div>
        <div><dt className="text-xs text-[var(--text-muted)]">Subject must include this marker</dt><dd className="flex flex-wrap items-center gap-2 break-all font-mono text-xs">{route.subjectMarker}<CopyButton value={route.subjectMarker} label="subject marker" /></dd></div>
        <div><dt className="text-xs text-[var(--text-muted)]">Activated</dt><dd className="text-xs">{route.activatedAt ? fmtDate(route.activatedAt) : 'Not yet'}</dd></div>
        <div><dt className="text-xs text-[var(--text-muted)]">Backfill from</dt><dd className="text-xs">{route.backfillFrom ? fmtDate(route.backfillFrom) : 'None'}</dd></div>
      </dl>
      {upd.isError && <ErrorNote error={upd.error} />}
    </li>
  );
}

function ConfigForm({ headers, scope, routes }: { headers: Record<string, string>; scope: string; routes: HroEmailRoute[] }) {
  const qc = useQueryClient();
  const [reference, setReference] = useState('');
  const [hours, setHours] = useState('0');
  const [routeId, setRouteId] = useState('');
  useEffect(() => { setReference(''); setHours('0'); setRouteId(''); }, [scope]);
  const cfg = useConfigureHroEmailIntake({ request: { headers } });
  const h = Number(hours);
  const hoursOk = hours.trim() !== '' && Number.isInteger(h) && h >= 0 && h <= 48;
  const refOk = reference.trim().length >= 1 && reference.length <= 240;
  return (
    <form className="space-y-3 rounded-md border border-[var(--border)] p-3" onSubmit={(e) => { e.preventDefault(); if (!refOk || !hoursOk) return;
      cfg.mutate({ data: { reference: reference.trim(), backfillHours: h, ...(routeId ? { routeId, expectedVersion: routes.find(r => r.id === routeId)?.version } : {}) } }, { onSuccess: () => { setReference(''); qc.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }); } }); }}>
      <h3 className="text-sm font-semibold">Create or refresh a client route</h3>
      <Label htmlFor="email-existing-route">Route to review</Label>
      <select id="email-existing-route" value={routeId} className={inputCls} onChange={e => setRouteId(e.target.value)}>
        <option value="">Create a new reviewed route</option>
        {routes.map(r => <option key={r.id} value={r.id}>{r.mailboxAddress ? 'Reverify' : 'Upgrade legacy separation route'}: {r.id.slice(0, 12)}</option>)}
      </select>
      <p className="text-xs text-[var(--text-muted)]">Legacy separation markers need explicit review before universal intake is enabled. Re-enabling a paused route receives future mail only; saved requests need fresh review.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <div className="space-y-1"><Label htmlFor="email-ref">Review reference</Label><Input id="email-ref" data-testid="input-email-reference" maxLength={240} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Authorisation or review ticket reference" /></div>
        <div className="space-y-1"><Label htmlFor="email-backfill">Backfill hours (0-48)</Label><Input id="email-backfill" data-testid="input-email-backfill" type="number" inputMode="numeric" min={0} max={48} step={1} value={hours} onChange={(e) => setHours(e.target.value)} aria-invalid={!hoursOk} /></div>
      </div>
      {!hoursOk && <p role="alert" className="text-xs text-[var(--status-red-fg)]">Backfill hours must be a whole number from 0 to 48.</p>}
      <p className="text-xs text-[var(--text-muted)]">The reference is recorded for audit. Backfill reads earlier mail in the mailbox that carries this route's marker.</p>
      <Button type="submit" data-testid="button-save-email-config" disabled={!refOk || !hoursOk || cfg.isPending}>{cfg.isPending ? 'Saving...' : 'Save configuration'}</Button>
      {cfg.isSuccess && <p role="status" className="text-xs text-[var(--status-green-fg)]">Route saved. Marker: <span className="font-mono">{cfg.data.subjectMarker}</span></p>}
      {cfg.isError && <ErrorNote error={cfg.error} />}
    </form>
  );
}

function Triage({ data, headers, scope }: { data: HroEmailReadiness; headers: Record<string, string>; scope: string }) {
  const qc = useQueryClient();
  const q = useListHroEmailTriage({ request: { headers }, query: { queryKey: [...getListHroEmailTriageQueryKey(), scope] } });
  const [target, setTarget] = useState<{ id: string; action: 'assign' | 'reject' } | null>(null);
  const [routeId, setRouteId] = useState('');
  const [reference, setReference] = useState('');
  useEffect(() => { setTarget(null); setRouteId(''); setReference(''); }, [scope]);
  const resolve = useResolveHroEmailTriage({ request: { headers } });
  const enabledRoutes = data.routes.filter((r) => r.enabled);
  const submit = (row: HroEmailTriage) => {
    if (!target) return;
    if (target.action === 'assign' && !routeId) return;
    resolve.mutate({ requestId: row.id, data: { expectedVersion: row.version, action: target.action, ...(target.action === 'assign' ? { routeId } : {}), ...(reference.trim() ? { reference: reference.trim() } : {}) } }, {
      onSuccess: () => { setTarget(null); setRouteId(''); setReference(''); },
      onSettled: () => { qc.invalidateQueries({ queryKey: getListHroEmailTriageQueryKey() }); qc.invalidateQueries({ queryKey: getListHroEmailRequestsQueryKey() }); qc.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() }); },
    });
  };
  return (
    <Card className="space-y-3 p-4" data-testid="section-triage">
      <div className="flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-[var(--status-amber-fg)]" /><h2 className="text-base font-semibold">Platform triage</h2></div>
      <p className="text-xs text-[var(--text-muted)]">Metadata only. Message content is never shown here. Assign an item to a reviewed route or reject it; nothing is assigned automatically.</p>
      {q.isLoading ? <Skeleton n={2} /> : q.isError ? <ErrorNote error={q.error} onRetry={() => q.refetch()} /> : !q.data?.length ? (
        <p className="rounded-md bg-[var(--surface-alt)] p-4 text-sm text-[var(--text-muted)]" data-testid="text-triage-empty">No unmatched mail is waiting for triage.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">
          {q.data.map((row) => {
            const active = target?.id === row.id;
            return (
              <li key={row.id} className="space-y-2 p-3" data-testid={`row-triage-${row.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm"><span className="font-mono text-xs">{row.id}</span> <Pill tone="amber">{row.status}</Pill><div className="text-xs text-[var(--text-muted)]">Received {fmtDate(row.receivedAt)}{row.reason ? ` · ${row.reason}` : ''}</div></div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" data-testid={`button-triage-assign-${row.id}`} onClick={() => setTarget({ id: row.id, action: 'assign' })}>Assign</Button>
                    <Button size="sm" variant="outline" data-testid={`button-triage-reject-${row.id}`} onClick={() => setTarget({ id: row.id, action: 'reject' })}>Reject</Button>
                  </div>
                </div>
                {active && (
                  <div className="space-y-2 rounded-md bg-[var(--surface-alt)] p-3">
                    {target.action === 'assign' && (
                      <div className="space-y-1"><Label htmlFor={`tr-route-${row.id}`}>Reviewed route</Label>
                        <select id={`tr-route-${row.id}`} className={inputCls} value={routeId} onChange={(e) => setRouteId(e.target.value)}>
                          <option value="">Select an enabled route</option>
                          {enabledRoutes.map((r) => <option key={r.id} value={r.id}>{r.subjectMarker}</option>)}
                        </select>
                        {!enabledRoutes.length && <p className="text-xs text-[var(--status-amber-fg)]">No enabled routes are available.</p>}</div>)}
                    <div className="space-y-1"><Label htmlFor={`tr-ref-${row.id}`}>Required review reference</Label><Input id={`tr-ref-${row.id}`} required maxLength={240} value={reference} onChange={(e) => setReference(e.target.value)} /></div>
                    <div className="flex gap-2">
                      <Button size="sm" variant={target.action === 'reject' ? 'destructive' : 'default'} disabled={resolve.isPending || (target.action === 'assign' && !routeId)} onClick={() => submit(row)} data-testid={`button-triage-confirm-${row.id}`}>{resolve.isPending ? 'Saving...' : target.action === 'assign' ? 'Confirm assignment' : 'Confirm rejection'}</Button>
                      <Button size="sm" variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
                    </div>
                    {resolve.isError && <ErrorNote error={resolve.error} />}
                  </div>)}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export function EmailIntakePage() {
  const { scope, headers, org } = useEmailScope();
  const intake = useGetHroEmailIntake({ request: { headers }, query: { queryKey: [...getGetHroEmailIntakeQueryKey(), scope], enabled: Boolean(org), retry: false } });
  const [before, setBefore] = useState<string | undefined>();
  const [previous, setPrevious] = useState<Array<string | undefined>>([]);
  useEffect(() => { setBefore(undefined); setPrevious([]); }, [scope]);
  const reqs = useListHroEmailRequests(before ? { before } : undefined, { request: { headers }, query: { queryKey: [...getListHroEmailRequestsQueryKey(), scope, before], enabled: Boolean(org) && intake.data?.canReview === true, retry: false } });
  const d = intake.data;
  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-12">
      <PageHeader title="Email intake" subtitle="Client requests received by email, reviewed by people before any case is created." />
      {intake.isLoading ? <Skeleton n={4} /> : intake.isError || !d ? <ErrorNote error={intake.error} onRetry={() => intake.refetch()} /> : (
        <>
          <Card className="space-y-3 p-4" data-testid="section-readiness">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2"><Mail className="h-4 w-4 text-[var(--primary)]" /><h2 className="text-base font-semibold">Mailbox and readiness</h2></div>
              <Pill tone={d.ready ? 'green' : 'amber'}>{d.ready ? 'Ready' : 'Not ready'}</Pill>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
              <div className="sm:col-span-2"><dt className="text-xs text-[var(--text-muted)]">Connected Gmail address</dt><dd className="flex flex-wrap items-center gap-2 break-all font-mono text-xs" data-testid="text-mailbox-address">{d.mailboxAddress ?? 'No mailbox connected'}{d.mailboxAddress && <CopyButton value={d.mailboxAddress} label="mailbox address" testId="button-copy-mailbox" />}</dd></div>
              <div><dt className="text-xs text-[var(--text-muted)]">Monitor</dt><dd><Pill tone={d.monitor.healthy ? 'green' : 'red'}>{d.monitor.state}</Pill></dd></div>
              <div><dt className="text-xs text-[var(--text-muted)]">Last success</dt><dd className="text-xs">{d.lastSuccessAt ? fmtDate(d.lastSuccessAt) : 'Never'}</dd></div>
              <div><dt className="text-xs text-[var(--text-muted)]">Backlog</dt><dd className="font-semibold">{d.backlog}</dd></div>
              <div><dt className="text-xs text-[var(--text-muted)]">Blocked</dt><dd className="font-semibold">{d.blocked}</dd></div>
              <div><dt className="text-xs text-[var(--text-muted)]">Pagination</dt><dd className="text-xs">{d.paginationPending ? 'More mail pending' : 'Complete'}</dd></div>
            </dl>
            {d.lastError && <p role="alert" className="rounded-md bg-[var(--status-red-bg)] p-2 text-xs text-[var(--status-red-fg)]">Last error: {d.lastError.slice(0, 200)}</p>}
            <p className="rounded-md bg-[var(--surface-alt)] p-2 text-xs"><Lock className="mr-1 inline h-3 w-3" />Attachments policy: {d.attachmentPolicy}</p>
            <p className="text-xs text-[var(--text-muted)]" data-testid="text-permissions">Your permissions: {[d.canConfigure && 'configure routes', d.canReview && 'review requests', d.canTriage && 'platform triage'].filter(Boolean).join(', ') || 'view only'}.</p>
          </Card>

          <Card className="space-y-3 p-4" data-testid="section-routes">
            <h2 className="text-base font-semibold">Client routes</h2>
            <p className="text-xs text-[var(--text-muted)]">Mail is tied to this client by the marker in the subject line sent to the connected address. The marker is the only link; keep it with the request.</p>
            {d.routes.length ? <ul className="divide-y divide-[var(--border)] rounded-md border border-[var(--border)]">{d.routes.map((r) => <RouteRow key={r.id} route={r} canConfigure={d.canConfigure} headers={headers} />)}</ul>
              : <p className="rounded-md bg-[var(--surface-alt)] p-4 text-sm text-[var(--text-muted)]">No route exists yet. {d.canConfigure ? 'Create one below.' : 'Ask an administrator with configure permission to create one.'}</p>}
            {d.canConfigure ? <ConfigForm headers={headers} scope={scope} routes={d.routes} /> : <p className="text-xs text-[var(--text-muted)]">Configuration requires the configure permission, which you do not have.</p>}
          </Card>

          <Card className="space-y-3 p-4" data-testid="section-templates">
            <h2 className="text-base font-semibold">Template families and examples</h2>
            <Templates data={d} />
          </Card>

          <Card className="space-y-3 p-4" data-testid="section-requests">
            <h2 className="text-base font-semibold">Client request queue</h2>
            <p className="text-xs text-[var(--text-muted)]">Confidential. The queue lists status and counts only; open a request to review its extracted fields.</p>
            {!d.canReview ? <p className="rounded-md bg-[var(--surface-alt)] p-4 text-sm" data-testid="text-no-review">You do not have permission to review client email requests.</p>
              : reqs.isLoading ? <Skeleton /> : reqs.isError ? <ErrorNote error={reqs.error} onRetry={() => reqs.refetch()} />
              : !reqs.data?.length ? <p className="rounded-md bg-[var(--surface-alt)] p-6 text-center text-sm text-[var(--text-muted)]" data-testid="text-requests-empty">No client requests yet. Mail sent to the address above with a route marker will appear here.</p>
              : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm"><caption className="sr-only">Client email requests</caption>
                    <thead><tr className="text-left text-xs text-[var(--text-muted)]"><th className="py-2 pr-3">Request</th><th className="pr-3">Status</th><th className="pr-3">Family</th><th className="pr-3">Missing</th><th className="pr-3">Attachments</th><th className="pr-3">Received</th><th><span className="sr-only">Open</span></th></tr></thead>
                    <tbody>{reqs.data.map((r) => (
                      <tr key={r.id} className="border-t border-[var(--border)]" data-testid={`row-request-${r.id}`}>
                        <td className="py-2 pr-3 font-mono text-xs">{r.id.slice(0, 12)}</td>
                        <td className="pr-3"><Pill tone={statusTone(r.status)}>{r.status}</Pill>{r.potentialDuplicates > 0 && <span className="ml-1"><Pill tone="amber">{r.potentialDuplicates} possible duplicate</Pill></span>}</td>
                        <td className="pr-3">{r.family ?? 'Unclassified'}</td>
                        <td className="pr-3">{r.missingFields.length}</td>
                        <td className="pr-3">{r.attachments.length}</td>
                        <td className="pr-3 text-xs">{fmtDate(r.receivedAt)}</td>
                        <td><Link href={`/email-intake/${r.id}`} className="font-medium text-[var(--primary)] underline" data-testid={`link-request-${r.id}`}>Review</Link></td>
                      </tr>))}</tbody>
                  </table>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button size="sm" variant="outline" disabled={!previous.length} onClick={() => { setBefore(previous.at(-1)); setPrevious(p => p.slice(0, -1)); }}>Newer requests</Button>
                    <Button size="sm" variant="outline" disabled={reqs.data.length < 100} onClick={() => { const last = reqs.data?.at(-1); if (last) { setPrevious(p => [...p, before]); setBefore(`${last.receivedAt}|${last.id}`); } }}>Older requests</Button>
                  </div>
                </div>)}
          </Card>

          {d.canTriage && <Triage data={d} headers={headers} scope={scope} />}
        </>
      )}
    </div>
  );
}
