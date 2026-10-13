import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { useUser } from '@clerk/react';
import { format as formatDate } from 'date-fns';
import {
  getGetClientOperationsSettingsQueryKey,
  getPinnedOrganizationIdForPage,
  useGetClientOperationsSettings,
  useUpdateClientOperationsSettings,
} from '@workspace/api-client-react';
import type { ClientOperationsConfiguration, ClientOperationsSettings, HroBatchTemplate } from '@workspace/api-client-react';
import { AlertTriangle, Check, Download, Plus, RefreshCw, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { Badge, Button, IconTile, LoadingBlock, cn } from '@/components/ui-shared';
import { useOrganizationRole } from '@/hooks/use-organization-role';
import {
  downloadHroBatchTemplate, hroBatchErrorMessage, hroBatchTemplatesKey, listHroBatchTemplates, saveBlob,
} from '@/lib/hro-batch-intake-api';

const inputCls = 'block w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)] bg-background shadow-sm disabled:opacity-60';
const OWNERS: { value: string; label: string }[] = [
  { value: 'hr', label: 'HR' }, { value: 'recruiter', label: 'Recruiter' }, { value: 'hiring-manager', label: 'Hiring manager' },
  { value: 'bgv-team', label: 'BGV team' }, { value: 'documentation', label: 'Documentation' },
  { value: 'operations', label: 'Operations' }, { value: 'compliance', label: 'Compliance' },
];
const DATE_FORMATS = ['MMM d, yyyy', 'dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd'] as const;
const WEEKDAYS = [
  { n: 1, label: 'Mon' }, { n: 2, label: 'Tue' }, { n: 3, label: 'Wed' }, { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' }, { n: 6, label: 'Sat' }, { n: 0, label: 'Sun' },
];
const ownerLabel = (v: string) => OWNERS.find((o) => o.value === v)?.label ?? v;

/** Organization-scoped, always-fresh read of client operations settings. Shared with batch intake. */
export function useClientOperationsSettings(organizationId: string | null) {
  const headers = organizationId ? { 'x-organization-id': organizationId } : undefined;
  return useGetClientOperationsSettings({
    query: {
      queryKey: [...getGetClientOperationsSettingsQueryKey(), organizationId ?? 'none'],
      enabled: !!organizationId,
      staleTime: 0,
      refetchOnMount: 'always',
      refetchInterval: 60_000,
    },
    request: { headers },
  });
}

const errStatus = (e: unknown): number | undefined => (e as { status?: number } | null)?.status;
const errMsg = (e: unknown, fb: string) => {
  const x = e as { message?: string; error?: string; data?: { message?: string; error?: string } } | null;
  return x?.data?.message ?? x?.data?.error ?? x?.error ?? x?.message ?? fb;
};

function validTimezone(tz: string) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz.trim().length > 0; } catch { return false; }
}
const isIsoDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const todayIso = () => formatDate(new Date(), 'yyyy-MM-dd');
const parseLocal = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

function isBusiness(d: Date, days: number[], holidays: Set<string>) {
  const wd = d.getDay();
  return days.includes(wd) && !holidays.has(formatDate(d, 'yyyy-MM-dd'));
}
function nextBusinessDate(startIso: string, days: number[], holidays: string[]): Date | null {
  if (!isIsoDate(startIso) || days.length === 0) return null;
  const set = new Set(holidays);
  const d = parseLocal(startIso);
  for (let i = 0; i < 800; i++) {
    d.setDate(d.getDate() + 1);
    if (isBusiness(d, days, set)) return new Date(d);
  }
  return null;
}

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--border)] p-4">
      <h4 className="text-[var(--text-sm)] font-semibold text-[var(--text-primary)]">{title}</h4>
      {hint && <p className="mt-1 mb-3 text-[var(--text-xs)] text-[var(--text-muted)] max-w-3xl">{hint}</p>}
      {children}
    </section>
  );
}
function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return <div><label htmlFor={id} className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">{label}</label><div className="mt-1">{children}</div></div>;
}

export function ClientOperationsSettingsPanel() {
  const role = useOrganizationRole();
  const orgId = getPinnedOrganizationIdForPage() || role.organizationId || null;
  // Keyed by organization so drafts are discarded on tenant switch.
  return <ClientOperationsInner key={orgId ?? 'none'} orgId={orgId} roleLoading={role.loading} />;
}

function ClientOperationsInner({ orgId, roleLoading }: { orgId: string | null; roleLoading: boolean }) {
  const queryClient = useQueryClient();
  const { user } = useUser();
  const query = useClientOperationsSettings(orgId);
  const headers = orgId ? { 'x-organization-id': orgId } : undefined;
  const update = useUpdateClientOperationsSettings({ request: { headers } });
  // Do not display retained administrative routing data after a failed access
  // refresh. A successful member-only response must not retain an owner's draft.
  const server = query.isError ? undefined : query.data as ClientOperationsSettings | undefined;

  const [draft, setDraft] = useState<ClientOperationsConfiguration | null>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);
  const [previewStart, setPreviewStart] = useState(todayIso());
  const [holidayInput, setHolidayInput] = useState('');
  const [dlError, setDlError] = useState<string | null>(null);

  const scope = user?.id && orgId ? `${user.id}:${orgId}` : '';
  const catalog = useQuery({
    queryKey: hroBatchTemplatesKey(scope),
    queryFn: ({ signal }) => listHroBatchTemplates({ signal }),
    enabled: !!scope,
  });
  const templates: HroBatchTemplate[] = catalog.data ?? [];

  useEffect(() => {
    if (query.data && !query.data.canEdit) {
      setDraft(null); setBaseVersion(null); setNotice(null);
    }
  }, [query.data?.canEdit]);
  const cfg = server?.canEdit ? draft ?? server.configuration : server?.configuration;
  const dirty = !!draft && !!server && JSON.stringify(draft) !== JSON.stringify(server.configuration);
  const stale = !!draft && !!server && baseVersion !== null && baseVersion !== server.version;
  const canEdit = !!server?.canEdit;

  const edit = (fn: (c: ClientOperationsConfiguration) => void) => {
    if (!server || !cfg || !canEdit) return;
    const next = JSON.parse(JSON.stringify(cfg)) as ClientOperationsConfiguration;
    fn(next);
    if (!draft) setBaseVersion(server.version);
    setDraft(next);
    setNotice(null);
  };

  const problems = useMemo(() => {
    const p: string[] = [];
    if (!cfg) return p;
    if (!validTimezone(cfg.defaults.timezone)) p.push('Time zone must be a valid IANA zone such as Asia/Kolkata.');
    if (cfg.defaults.businessDays.length === 0) p.push('Select at least one business day.');
    cfg.defaults.holidays.forEach((h) => { if (!isIsoDate(h)) p.push(`Holiday ${h} is not a valid date.`); });
    const seen = new Set<string>();
    cfg.routingRules.forEach((r, i) => {
      if (r.country && !/^[A-Z]{2}$/.test(r.country)) p.push(`Routing rule ${i + 1}: country must be a 2-letter ISO code.`);
      const k = `${r.family ?? '*'}|${r.country ?? '*'}`;
      if (seen.has(k)) p.push(`Routing rule ${i + 1} duplicates another rule with the same family and country.`);
      seen.add(k);
    });
    if (catalog.isSuccess) {
      cfg.families.forEach((f) => {
        const opts = templates.filter((t) => t.family === f.family);
        if (opts.length && !opts.some((t) => t.id === f.defaultTemplateId)) p.push(`${f.family}: default template is not in the built-in catalog.`);
      });
    }
    return p;
  }, [cfg, catalog.isSuccess, templates]);

  const refreshFresh = () => queryClient.invalidateQueries({ queryKey: [...getGetClientOperationsSettingsQueryKey(), orgId ?? 'none'] });

  const save = () => {
    if (!server || !cfg || !draft || baseVersion === null || stale || problems.length) return;
    setNotice(null);
    update.mutate({ data: { expectedVersion: baseVersion, configuration: draft } }, {
      onSuccess: (saved) => {
        queryClient.setQueryData([...getGetClientOperationsSettingsQueryKey(), orgId ?? 'none'], saved);
        setDraft(null); setBaseVersion(null);
        setNotice({ ok: true, message: `Saved as version ${saved.version}. New batch imports use these settings immediately.` });
      },
      onError: (e) => {
        const s = errStatus(e);
        if (s === 409) {
          void refreshFresh();
          setBaseVersion(-1); // force stale until explicitly resolved
          setNotice({ ok: false, message: 'Someone else saved newer settings. Your draft is kept. Reload the server version or rebase your draft onto it.' });
        } else if (s === 403) {
          void refreshFresh();
          setNotice({ ok: false, message: 'Save denied. Your role cannot edit client operations settings. Your draft is kept.' });
        } else setNotice({ ok: false, message: errMsg(e, 'Saving failed. Your draft is kept; try again.') });
      },
    });
  };

  const download = async (t: HroBatchTemplate, fmt: 'csv' | 'xlsx') => {
    setDlError(null);
    try { saveBlob(await downloadHroBatchTemplate(t.id, fmt), `${t.id}-v${t.version}.${fmt}`); }
    catch (e) { setDlError(hroBatchErrorMessage(e, 'The template could not be downloaded.')); }
  };

  const preview = cfg ? nextBusinessDate(previewStart, cfg.defaults.businessDays, cfg.defaults.holidays) : null;
  const startIsBusiness = cfg && isIsoDate(previewStart)
    ? isBusiness(parseLocal(previewStart), cfg.defaults.businessDays, new Set(cfg.defaults.holidays)) : false;
  const fmtDate = (d: Date) => cfg ? formatDate(d, cfg.defaults.dateFormat) : '';

  const familyNames = cfg?.families.map((f) => f.family) ?? [];

  return (
    <div className="mb-8 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm" data-testid="panel-client-operations">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border)] bg-[var(--surface-alt)] p-[var(--space-lg)]">
        <div className="flex items-start gap-3">
          <IconTile icon={SlidersHorizontal} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
          <div>
            <h3 className="text-[var(--text-xs)] font-semibold uppercase tracking-[0.05em] text-[var(--text-primary)]">Client operations</h3>
            <p className="mt-0.5 text-[var(--text-xs)] text-[var(--text-muted)] max-w-2xl">
              Reusable defaults, batch intake controls and responsibility routing for this client organization.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {server && <Badge className="bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] font-mono shadow-none">v{server.version}</Badge>}
          {server && <Badge className="bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] shadow-none">{server.source === 'client-override' ? 'Client settings' : 'Product defaults'}</Badge>}
          <Button variant="outline" size="sm" className="gap-1.5" disabled={query.isFetching || !orgId} onClick={() => void query.refetch()} data-testid="button-ops-refresh">
            <RefreshCw className={cn('h-3.5 w-3.5', query.isFetching && 'animate-pulse')} /> Refresh
          </Button>
        </div>
      </div>

      <div className="space-y-5 p-[var(--space-lg)]">
        {(roleLoading || query.isLoading) && <LoadingBlock>Loading client operations settings...</LoadingBlock>}
        {!roleLoading && !orgId && <p role="status" className="text-[var(--text-sm)] text-[var(--text-muted)]">Select an active organization to manage client operations settings.</p>}
        {query.isError && !server && (
          <div role="alert" className="rounded-[var(--radius-md)] bg-[var(--status-red-bg)] p-3 text-[var(--text-sm)] text-[var(--status-red-fg)]">
            {errStatus(query.error) === 403 ? 'You do not have access to client operations settings.' : errMsg(query.error, 'Client operations settings could not be loaded.')}
            <Button variant="outline" size="sm" className="ml-3" onClick={() => void query.refetch()} data-testid="button-ops-retry">Retry</Button>
          </div>
        )}
        {query.isError && server && (
          <div role="alert" className="rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] p-3 text-[var(--text-xs)] text-[var(--status-amber-fg)]">
            The latest refresh failed; showing the last loaded version. <button className="underline" onClick={() => void query.refetch()}>Retry</button>
          </div>
        )}

        {server && cfg && (
          <>
            {!canEdit && (
              <div role="status" className="flex items-start gap-2 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] p-3 text-[var(--text-xs)] text-[var(--text-secondary)]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> Read-only. Only an active organization owner or Super Admin can change client operations settings. Administrative routing rules are not shown.
              </div>
            )}
            {stale && (
              <div role="alert" className="rounded-[var(--radius-md)] border border-[var(--status-amber)]/40 bg-[var(--status-amber-bg)] p-3 text-[var(--text-sm)] text-[var(--status-amber-fg)]" data-testid="banner-ops-stale">
                <p className="font-medium">The server version changed to v{server.version} while you were editing.</p>
                <p className="mt-1 text-[var(--text-xs)]">Saving is paused. Your draft is preserved until you choose how to resolve it.</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" onClick={() => { setDraft(null); setBaseVersion(null); setNotice(null); }} data-testid="button-ops-reload">Load server version (discard draft)</Button>
                  <Button size="sm" variant="outline" onClick={() => { setBaseVersion(server.version); setNotice(null); }} data-testid="button-ops-rebase">Keep my draft on v{server.version}</Button>
                </div>
              </div>
            )}

            <fieldset disabled={!canEdit} className="space-y-5 min-w-0 border-0 p-0 m-0">
              <Section title="Client defaults" hint="Business days and holidays are a proposed reusable client calendar with a preview. They do not override existing approved per-case SLA calendars and are not yet applied to all service-level deadlines.">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <Field id="ops-timezone" label="Time zone">
                    <input id="ops-timezone" list="ops-tz-list" className={inputCls} value={cfg.defaults.timezone} data-testid="input-ops-timezone"
                      onChange={(e) => edit((c) => { c.defaults.timezone = e.target.value; })} />
                    <datalist id="ops-tz-list">
                      {((Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? []).map((z) => <option key={z} value={z} />)}
                    </datalist>
                    <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Inherited by new Day-1 logistics only when no separate logistics default time zone is saved.</p>
                  </Field>
                  <Field id="ops-dateformat" label="Case list date format">
                    <select id="ops-dateformat" className={inputCls} value={cfg.defaults.dateFormat} data-testid="select-ops-dateformat"
                      onChange={(e) => edit((c) => { c.defaults.dateFormat = e.target.value as typeof c.defaults.dateFormat; })}>
                      {DATE_FORMATS.map((f) => <option key={f} value={f}>{f}</option>)}
                    </select>
                    <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Used for dates in the case list.</p>
                  </Field>
                </div>
                <div className="mt-4">
                  <p className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]" id="ops-bd-label">Business days</p>
                  <div role="group" aria-labelledby="ops-bd-label" className="mt-1 flex flex-wrap gap-2">
                    {WEEKDAYS.map((d) => {
                      const on = cfg.defaults.businessDays.includes(d.n);
                      return (
                        <button key={d.n} type="button" aria-pressed={on} data-testid={`toggle-ops-day-${d.n}`}
                          onClick={() => edit((c) => {
                            const cur = c.defaults.businessDays.filter((x) => x !== d.n);
                            c.defaults.businessDays = on ? cur : [...cur, d.n].sort((a, b) => a - b);
                          })}
                          className={cn('h-8 min-w-12 rounded-[var(--radius-md)] border px-3 text-[var(--text-xs)] font-medium disabled:opacity-60',
                            on ? 'border-[var(--primary)] bg-[var(--primary-light)] text-[var(--primary)]' : 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]')}>
                          {d.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div className="mt-4">
                  <label htmlFor="ops-holiday" className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">Holiday calendar</label>
                  <div className="mt-1 flex flex-wrap gap-2">
                    <input id="ops-holiday" type="date" className={cn(inputCls, 'max-w-48')} value={holidayInput} onChange={(e) => setHolidayInput(e.target.value)} data-testid="input-ops-holiday" />
                    <Button size="sm" variant="outline" className="gap-1" data-testid="button-ops-add-holiday"
                      disabled={!isIsoDate(holidayInput) || cfg.defaults.holidays.includes(holidayInput)}
                      onClick={() => { edit((c) => { c.defaults.holidays = [...c.defaults.holidays, holidayInput].sort(); }); setHolidayInput(''); }}>
                      <Plus className="h-3.5 w-3.5" /> Add holiday
                    </Button>
                  </div>
                  <ul className="mt-2 flex flex-wrap gap-2">
                    {cfg.defaults.holidays.length === 0 && <li className="text-[var(--text-xs)] text-[var(--text-muted)]">No holidays configured.</li>}
                    {cfg.defaults.holidays.map((h) => (
                      <li key={h} className="flex items-center gap-1 rounded-full bg-[var(--surface-soft)] py-0.5 pl-3 pr-1 text-[var(--text-xs)]">
                        {isIsoDate(h) ? formatDate(parseLocal(h), cfg.defaults.dateFormat) : h}
                        <button type="button" aria-label={`Remove holiday ${h}`} className="rounded-full p-1 hover:bg-[var(--surface-alt)] disabled:opacity-50" data-testid={`button-ops-remove-holiday-${h}`}
                          onClick={() => edit((c) => { c.defaults.holidays = c.defaults.holidays.filter((x) => x !== h); })}><X className="h-3 w-3" /></button>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="mt-4 rounded-[var(--radius-md)] bg-[var(--surface-alt)] p-3" data-testid="section-ops-calendar-preview">
                  <p className="text-[var(--text-xs)] font-semibold text-[var(--text-primary)]">Calendar preview</p>
                  <div className="mt-2 flex flex-wrap items-end gap-3">
                    <div>
                      <label htmlFor="ops-preview-start" className="text-[var(--text-xs)] text-[var(--text-muted)]">Starting from</label>
                      <input id="ops-preview-start" type="date" className={cn(inputCls, 'mt-1 w-44')} value={previewStart} onChange={(e) => setPreviewStart(e.target.value)} disabled={false} />
                    </div>
                    <p className="text-[var(--text-sm)] text-[var(--text-secondary)]" aria-live="polite" data-testid="text-ops-next-business-date">
                      {!isIsoDate(previewStart) ? 'Choose a valid start date.'
                        : !preview ? 'No business date can be computed. Select at least one business day.'
                        : <>That day {startIsBusiness ? 'is' : 'is not'} a business day. Next business date: <strong>{fmtDate(preview)}</strong> ({formatDate(preview, 'EEEE')}).</>}
                    </p>
                  </div>
                  <p className="mt-2 text-[var(--text-xs)] text-[var(--text-muted)]">Preview uses your browser's calendar day and the selections above, including unsaved changes.</p>
                </div>
              </Section>

              <Section title="Batch intake by case family" hint="Enabling or pausing a family affects NEW batch imports only. Historical cases, and individual or email-based case creation, keep their existing controls. Template files and column requirements below are built in and always available to download.">
                {catalog.isError && (
                  <p role="alert" className="mb-2 text-[var(--text-xs)] text-[var(--status-red)]">{hroBatchErrorMessage(catalog.error, 'Could not load templates.')} <button className="underline" onClick={() => void catalog.refetch()}>Retry</button></p>
                )}
                {catalog.isLoading && <div className="mb-2 h-8 animate-pulse rounded bg-[var(--surface-alt)]" />}
                {dlError && <p role="alert" className="mb-2 text-[var(--text-xs)] text-[var(--status-red)]">{dlError}</p>}
                <ul className="space-y-2">
                  {cfg.families.map((f, i) => {
                    const opts = templates.filter((t) => t.family === f.family);
                    const tpl = opts.find((t) => t.id === f.defaultTemplateId);
                    return (
                      <li key={f.family} className="rounded-[var(--radius-md)] border border-[var(--border)] p-3" data-testid={`row-ops-family-${f.family}`}>
                        <div className="grid grid-cols-1 items-center gap-3 md:grid-cols-12">
                          <div className="md:col-span-3">
                            <p className="text-[var(--text-sm)] font-medium break-words">{f.family}</p>
                            <label className="mt-1 flex items-center gap-2 text-[var(--text-xs)]">
                              <input type="checkbox" checked={f.batchEnabled} data-testid={`checkbox-ops-batch-${f.family}`} onChange={(e) => edit((c) => { c.families[i].batchEnabled = e.target.checked; })} />
                              {f.batchEnabled ? 'Batch enabled' : 'Batch paused'}
                            </label>
                          </div>
                          <div className="md:col-span-5">
                            <label htmlFor={`ops-tpl-${i}`} className="text-[var(--text-xs)] text-[var(--text-muted)]">Default template</label>
                            <select id={`ops-tpl-${i}`} className={inputCls} value={f.defaultTemplateId} data-testid={`select-ops-template-${f.family}`}
                              onChange={(e) => edit((c) => { c.families[i].defaultTemplateId = e.target.value; })}>
                              {!tpl && <option value={f.defaultTemplateId}>{catalog.isSuccess ? `${f.defaultTemplateId} (not in catalog)` : f.defaultTemplateId}</option>}
                              {opts.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}
                            </select>
                          </div>
                          <div className="flex gap-2 md:col-span-4 md:justify-end">
                            <Button size="sm" variant="outline" disabled={!tpl} className="gap-1" onClick={() => tpl && void download(tpl, 'csv')} data-testid={`button-ops-csv-${f.family}`}><Download className="h-3.5 w-3.5" />CSV</Button>
                            <Button size="sm" variant="outline" disabled={!tpl} className="gap-1" onClick={() => tpl && void download(tpl, 'xlsx')} data-testid={`button-ops-xlsx-${f.family}`}><Download className="h-3.5 w-3.5" />Excel</Button>
                          </div>
                        </div>
                        {tpl && (
                          <details className="mt-2 text-[var(--text-xs)]">
                            <summary className="cursor-pointer text-[var(--text-secondary)]">
                              Template v{tpl.version}: {tpl.columns.filter((c) => c.required).length} required of {tpl.columns.length} columns
                            </summary>
                            <ul className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
                              {tpl.columns.map((c) => (
                                <li key={c.key}><span className="font-medium">{c.label}</span> <span className="text-[var(--text-muted)]">{c.required ? 'required' : 'optional'}{c.values?.length ? `, one of: ${c.values.join(', ')}` : ''}</span></li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </Section>

              <Section title="Action routing" hint="Routing rules name who is responsible for an action. They are responsibility metadata only: they do not add group members, grant access, confer professional authorization, or establish an email identity. A rule with a country is more specific than a family-only rule, which is more specific than a catch-all.">
                <ul className="space-y-2">
                  {cfg.routingRules.length === 0 && <li className="rounded border border-dashed border-[var(--border-strong)] p-4 text-center text-[var(--text-xs)] text-[var(--text-muted)]">No routing rules. Every action goes to the fallback owner.</li>}
                  {cfg.routingRules.map((r, i) => (
                    <li key={i} className="grid grid-cols-1 items-end gap-2 rounded-[var(--radius-md)] border border-[var(--border)] p-3 md:grid-cols-12" data-testid={`row-ops-rule-${i}`}>
                      <div className="md:col-span-3">
                        <label htmlFor={`ops-rule-family-${i}`} className="text-[var(--text-xs)] text-[var(--text-muted)]">Family</label>
                        <select id={`ops-rule-family-${i}`} className={inputCls} value={r.family ?? ''} onChange={(e) => edit((c) => { c.routingRules[i].family = e.target.value || null; })}>
                          <option value="">Any family</option>
                          {familyNames.map((f) => <option key={f} value={f}>{f}</option>)}
                        </select>
                      </div>
                      <div className="md:col-span-2">
                        <label htmlFor={`ops-rule-country-${i}`} className="text-[var(--text-xs)] text-[var(--text-muted)]">Country (ISO2)</label>
                        <input id={`ops-rule-country-${i}`} className={inputCls} maxLength={2} placeholder="Any" value={r.country ?? ''}
                          onChange={(e) => edit((c) => { c.routingRules[i].country = e.target.value.toUpperCase().trim() || null; })} />
                      </div>
                      <div className="md:col-span-3">
                        <label htmlFor={`ops-rule-owner-${i}`} className="text-[var(--text-xs)] text-[var(--text-muted)]">Owner queue</label>
                        <select id={`ops-rule-owner-${i}`} className={inputCls} value={r.owner} onChange={(e) => edit((c) => { c.routingRules[i].owner = e.target.value as typeof r.owner; })}>
                          {OWNERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                        </select>
                      </div>
                      <div className="md:col-span-3">
                        <label htmlFor={`ops-rule-group-${i}`} className="text-[var(--text-xs)] text-[var(--text-muted)]">Group label (optional)</label>
                        <select id={`ops-rule-group-${i}`} className={inputCls} value={r.groupId ?? ''} onChange={(e) => edit((c) => { c.routingRules[i].groupId = e.target.value || null; })}>
                          <option value="">None</option>
                          {server.groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                          {r.groupId && !server.groups.some((g) => g.id === r.groupId) && <option value={r.groupId}>Unavailable group</option>}
                        </select>
                      </div>
                      <div className="md:col-span-1 md:text-right">
                        <Button size="sm" variant="ghost" aria-label={`Remove routing rule ${i + 1}`} data-testid={`button-ops-remove-rule-${i}`}
                          className="text-[var(--status-red)]" onClick={() => edit((c) => { c.routingRules.splice(i, 1); })}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  <Button size="sm" variant="secondary" className="gap-1" data-testid="button-ops-add-rule"
                    onClick={() => edit((c) => { c.routingRules.push({ family: null, country: null, owner: c.fallbackOwner, groupId: null }); })}>
                    <Plus className="h-3.5 w-3.5" /> Add rule
                  </Button>
                  <div className="w-full sm:w-56">
                    <label htmlFor="ops-fallback" className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)]">Fallback owner</label>
                    <select id="ops-fallback" className={inputCls} value={cfg.fallbackOwner} data-testid="select-ops-fallback" onChange={(e) => edit((c) => { c.fallbackOwner = e.target.value as typeof c.fallbackOwner; })}>
                      {OWNERS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </div>
                  <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Currently falls back to {ownerLabel(cfg.fallbackOwner)} when no rule matches.</p>
                </div>
              </Section>
            </fieldset>

            <p className="text-[var(--text-xs)] text-[var(--text-muted)]">
              Need a different flow for this client? Flow customization lives in <Link href="/client-setup" className="underline">Client Setup</Link>. Nothing on this panel creates a custom workflow or bypasses existing execution controls.
            </p>

            {problems.length > 0 && dirty && (
              <ul role="alert" className="list-disc rounded-[var(--radius-md)] bg-[var(--status-red-bg)] p-3 pl-7 text-[var(--text-xs)] text-[var(--status-red-fg)]" data-testid="list-ops-problems">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}

            {canEdit && (
              <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-4">
                <Button onClick={save} disabled={!dirty || update.isPending || stale || problems.length > 0} className="gap-2" data-testid="button-ops-save">
                  <Check className="h-4 w-4" /> {update.isPending ? 'Saving...' : 'Save settings'}
                </Button>
                <Button variant="ghost" disabled={!draft || update.isPending} onClick={() => { setDraft(null); setBaseVersion(null); setNotice(null); }} data-testid="button-ops-discard">Discard draft</Button>
                {dirty && !stale && <span className="text-[var(--text-xs)] text-[var(--text-muted)]">Unsaved changes based on v{baseVersion}.</span>}
              </div>
            )}
            {notice && (
              <div role="status" data-testid="status-ops-save" className={cn('flex items-start gap-3 rounded-[var(--radius-md)] p-3 text-[var(--text-sm)]', notice.ok ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]')}>
                {notice.ok ? <Check className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
                <p>{notice.message}</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
