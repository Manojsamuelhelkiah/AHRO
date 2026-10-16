import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import { getAgentCatalogue, getPinnedOrganizationIdForPage, type AgentCatalogue } from '@workspace/api-client-react';
import { ShieldCheck, Lock, RotateCcw, Layers, Search as SearchIcon, History } from 'lucide-react';
import { AgentInspector } from './agent-inspector';
import { RoleIcon, roleAccent } from './role-visual';
import { Button } from '@/components/ui-shared';
import { RegistrationForm, type Pending } from './registration-form';

export function CatalogueSection({ searchTerm }: { searchTerm: string }) {
  const { userId, sessionId } = useAuth();
  const orgId = getPinnedOrganizationIdForPage() ?? '';
  const queryKey = useMemo(() => ['agent-catalogue', userId ?? '', sessionId ?? '', orgId] as const, [userId, sessionId, orgId]);
  return <ScopedCatalogueSection key={JSON.stringify(queryKey)} queryKey={queryKey} searchTerm={searchTerm} />;
}

function ScopedCatalogueSection({ queryKey, searchTerm }: {
  queryKey: readonly [string, string, string, string]; searchTerm: string;
}) {
  const client = useQueryClient();
  // Keep only the frozen request outside the private subtree. Failed reads
  // unmount all private display/draft state; scope changes unmount this too.
  const [pending, setPending] = useState<Pending | null>(null);
  const orgId = queryKey[3];
  const q = useQuery<AgentCatalogue>({
    queryKey, enabled: !!queryKey[1] && !!orgId, retry: 1, gcTime: 0, staleTime: 0, refetchInterval: 30_000,
    queryFn: async ({ signal }) => {
      const res = await getAgentCatalogue({ signal });
      if (res.organizationId !== orgId) throw new Error('Catalogue belongs to a different workspace.');
      return res;
    },
  });
  const status = (q.error as { status?: number } | null)?.status;
  const authorizationDenied = q.isError && (status === 401 || status === 403);
  const managementEnded = authorizationDenied || (q.isSuccess && !q.data.canManage);
  useEffect(() => {
    if (!managementEnded) return;
    setPending(null);
    if (!authorizationDenied) return;
    // Retain the error/retry state, but remove the old administrative snapshot
    // from the active query as well as the DOM. Clearing data must not trigger
    // an automatic new fetch or restore an earlier authorized response.
    client.getQueryCache().find({ queryKey, exact: true })?.setState({ data: undefined, dataUpdatedAt: 0 });
  }, [managementEnded, authorizationDenied, client, queryKey]);
  const cat = q.isError || q.isPending ? undefined : q.data;
  const [formSelection, setFormSelection] = useState<{ key: string; revision: number }>();

  const term = searchTerm.trim().toLowerCase();
  const [family, setFamily] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [legacyHit, setLegacyHit] = useState<string | null>(null);
  const families = useMemo(() => Array.from(new Set((cat?.entries ?? []).flatMap(e => e.productFamilies))).sort(), [cat]);
  const legacy = cat?.legacyIdentities ?? [];
  const legacyMatches = legacy.filter(l => !!term && [l.id, l.name, l.description, l.owner, ...l.capabilities].some(s => s.toLowerCase().includes(term)));
  // Private selection never survives a failed read or lost management/session.
  useEffect(() => { if (!cat) { setSelected(null); setLegacyHit(null); } }, [cat]);
  useEffect(() => {
    if (!cat) return;
    const apply = () => {
      const h = window.location.hash.slice(1);
      if (!h) { setSelected(null); return; }
      if (h.startsWith('role:')) { const k = h.slice(5); setSelected(cat.entries.some(e => e.key === k) ? k : null); return; }
      const lid = h.startsWith('legacy:') ? h.slice(7) : h;
      if (legacy.some(l => l.id === lid)) {
        setSelected(null); setLegacyHit(lid);
        window.requestAnimationFrame(() => {
          const target = document.getElementById(`legacy-${lid}`);
          target?.scrollIntoView({ block: 'center' }); target?.focus({ preventScroll: true });
        });
      }
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [cat, legacy]);
  const open = (k: string) => { setSelected(k); history.replaceState(null, '', `#role:${k}`); };
  const close = () => { setSelected(null); history.replaceState(null, '', window.location.pathname + window.location.search); };
  const entries = useMemo(() => (cat?.entries ?? []).filter(e => (!family || e.productFamilies.includes(family)) && (!term ||
    [e.name, e.key, e.responsibility, ...e.productFamilies, ...e.prerequisites,
      ...e.mappings.flatMap(m => [m.intentKey, m.intentName])].some(s => s.toLowerCase().includes(term)))), [cat, term, family]);

  const regOf = (key: string) => cat?.registrations.find(r => r.catalogueKey === key);
  const selEntry = cat?.entries.find(e => e.key === selected);

  return (
    <section aria-labelledby="catalogue-h" className="space-y-4 min-w-0" data-testid="section-catalogue">
      <div>
        <h2 id="catalogue-h" className="text-lg font-bold text-[var(--text-primary)] scroll-mt-24">Agent catalogue</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">Versioned agent roles and who is registered to each. Inspect reads saved definitions only; it never runs a model.</p>
      </div>
      {q.isPending && q.fetchStatus !== 'idle' && (
        <div className="space-y-3" role="status" aria-label="Loading catalogue" data-testid="loading-catalogue">
          {[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-[var(--radius-lg)] bg-[var(--surface-soft)] border border-[var(--border)]" />)}
        </div>
      )}
      {q.isPending && q.fetchStatus === 'idle' && <p role="status" className="text-sm text-[var(--text-secondary)]">Sign in and select a client to browse its agent catalogue.</p>}
      {q.isError && (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-[var(--radius-lg)] border border-[var(--status-red)] bg-[var(--status-red-bg)] p-5 text-[var(--status-red-fg)]" data-testid="error-catalogue">
          <p className="font-bold text-sm">The catalogue could not be loaded</p>
          <p className="text-xs">{(q.error as any)?.data?.message || (q.error as Error)?.message || 'An unexpected error occurred.'} Registration details are hidden until it loads.</p>
          <Button variant="outline" size="sm" onClick={() => q.refetch()} className="h-9" data-testid="button-retry-catalogue"><RotateCcw className="h-4 w-4 mr-2" />Retry</Button>
        </div>
      )}

      {cat && (
        <div className="space-y-4">
          <p className="text-xs text-[var(--text-secondary)]">
            Product families are browsing labels, not a replacement for the broader intent taxonomy.
            Reviewed mappings associate coordination responsibilities only; they do not approve execution or raise coverage maturity.
          </p>
          <div className="flex items-center gap-2">
            <label htmlFor="family-filter" className="text-xs font-semibold">Family</label>
            <select id="family-filter" data-testid="select-family-filter" value={family} onChange={e => setFamily(e.target.value)} className="h-9 min-w-0 max-w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 text-sm">
              <option value="">All families</option>
              {families.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>

          {!cat.canManage && (
            <div className="flex gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-alt)] p-4 text-sm text-[var(--text-secondary)]" data-testid="notice-no-manage">
              <Lock className="h-5 w-5 shrink-0 text-[var(--text-muted)]" />
              <p>You can browse the catalogue. Registration details, principals and owners are private to administrators and are not shown here, so a role is not necessarily unregistered.</p>
            </div>
          )}

          {cat.canManage && (
            <RegistrationForm catalogue={cat} queryScope={queryKey} selection={formSelection} retryState={{ pending, setPending }} />
          )}

          {cat.customMappings.length > 0 && (
            <div className="rounded-[var(--radius-lg)] border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-4 text-xs text-[var(--status-amber-fg)]" data-testid="panel-custom-mappings">
              <h3 className="font-bold uppercase tracking-wider">Custom mappings requiring review</h3>
              <ul className="mt-2 space-y-1">
                {cat.customMappings.map(m => <li key={m.intentKey}>{m.name} <code>{m.intentKey}</code> - {m.status}, {m.reviewStatus}</li>)}
              </ul>
            </div>
          )}

          <p role="status" aria-live="polite" data-testid="catalogue-search-results" className="text-sm font-semibold text-[var(--text-primary)]">
            {entries.length} of {cat.entries.length} catalogue roles{term ? ` match “${searchTerm.trim()}”` : ''}
          </p>
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 p-10 text-[var(--text-muted)] bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)]" data-testid="empty-catalogue">
              <Layers className="h-8 w-8 opacity-30" />
              <p className="text-sm font-medium">No catalogue roles match your search.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {entries.map(e => {
                const reg = regOf(e.key);
                const idx = cat.entries.findIndex(x => x.key === e.key);
                const ac = roleAccent(e.key, idx);
                return (
                  <article key={e.key} id={`role-${e.key}`} className="flex min-w-0 flex-col rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm" style={{ borderTop: `3px solid ${ac.solid}` }} data-testid={`card-role-${e.key}`}>
                    <header className="flex items-start gap-3 p-3">
                      <RoleIcon roleKey={e.key} index={idx} />
                      <div className="min-w-0 flex-1">
                        <h3 className="text-sm font-bold text-[var(--text-primary)]">{e.name}</h3>
                        <div className="font-mono text-[11px] text-[var(--text-muted)] break-all">{e.key} - v{e.version}</div>
                      </div>
                      <span className="shrink-0 rounded px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ background: ac.bg, color: ac.fg }}>{e.kind}</span>
                    </header>
                    <div className="flex flex-1 flex-col gap-2 px-3 pb-3 text-sm">
                      <p className="text-xs text-[var(--text-secondary)] leading-relaxed line-clamp-3">{e.responsibility}</p>
                      <div className="flex flex-wrap gap-1">
                        {e.productFamilies.map(f => <span key={f} className="rounded px-1.5 py-0.5 text-[11px]" style={{ background: ac.bg, color: ac.fg }}>{f}</span>)}
                      </div>
                      <div className="text-[11px] text-[var(--text-muted)]">{e.mappings.length} intent mappings{e.prerequisites.length > 0 ? ` - ${e.prerequisites.length} prerequisites` : ''}</div>
                      <p className="text-[11px] text-[var(--text-secondary)]"><b>Skills / coordination scope:</b> {e.key === 'intake-conversion' ? 'Explicit template validation · Held-case conversion' : e.mappings.slice(0, 2).map(m => m.intentName).join(' · ') || 'System health observation · Escalation coordination'}</p>
                      <p className="text-[11px] text-[var(--text-secondary)]">{e.key === 'intake-conversion' ? 'Rule-driven capability · No model' : 'Coordination definition · No role model executor'}</p>
                      {cat.canManage ? (
                        <div className="text-xs" data-testid={`registration-${e.key}`}>
                          {reg ? <><ShieldCheck className="inline h-4 w-4 mr-1 text-[var(--text-muted)]" />Binding recorded: <code className="break-all">{reg.agentId}</code> (v{reg.version}, {reg.state ?? 'registered'})</> : <span className="text-[var(--text-muted)]">Catalogue-only role - Not registered</span>}
                          {e.key === 'intake-conversion' && reg && <p className="mt-1 font-semibold">{reg.state === 'registered' ? 'Standing conversion enabled' : `Standing conversion paused · ${reg.state ?? 'review required'}`}</p>}
                        </div>
                      ) : (
                        <div className="text-xs text-[var(--text-muted)] flex items-center gap-1"><Lock className="h-3.5 w-3.5" />Registration status private</div>
                      )}
                      <div className="mt-auto flex flex-wrap gap-2 pt-2">
                        <Button type="button" size="sm" variant="outline" className="h-9" data-testid={`button-inspect-${e.key}`} aria-label={`Inspect ${e.name}`} onClick={() => open(e.key)}>Inspect</Button>
                        {cat.canManage && (
                          <Button type="button" size="sm" variant="outline" className="h-9" data-testid={`button-select-${e.key}`}
                            onClick={() => { setFormSelection(previous => ({ key: e.key, revision: (previous?.revision ?? 0) + 1 })); document.getElementById('catalogue-h')?.scrollIntoView({ block: 'start' }); document.getElementById('reg-role')?.focus({ preventScroll: true }); }}>
                            {reg ? 'Replace' : 'Register'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}

          {legacy.length > 0 && (!term || legacyMatches.length > 0 || legacyHit) && (
            <details open={!!legacyHit || !!term} className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-alt)] p-3" data-testid="legacy-references">
              <summary className="min-h-9 cursor-pointer text-xs font-bold text-[var(--text-primary)]"><History className="mr-2 inline h-4 w-4" />Historical identity references · {legacy.length} preserved IDs</summary>
              <p className="mt-1 text-[11px] text-[var(--text-secondary)]">Older identities kept so old links resolve. The owner shown is a historic label, not an accountable human, and nothing here maps to a role, principal or executor.</p>
              <ul className="mt-2 space-y-1.5">
                {(term ? legacy.filter(l => legacyMatches.includes(l) || legacyHit === l.id) : legacy).map(l => (
                  <li key={l.id} id={`legacy-${l.id}`} tabIndex={-1} data-testid={`legacy-${l.id}`} className={`min-w-0 border-t p-2 text-xs ${legacyHit === l.id ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]' : 'border-[var(--border)]'}`}>
                    <div className="flex flex-wrap items-center gap-2"><SearchIcon className="h-3 w-3 shrink-0" /><b className="break-words">{l.name}</b><a href={`#legacy:${l.id}`} className="font-mono text-[11px] underline break-all">legacy:{l.id}</a></div>
                    <p className="mt-1 break-words text-[var(--text-secondary)]">{l.description}</p>
                    <p className="text-[var(--text-muted)] break-words">Historic owner label: {l.owner}{l.capabilities.length ? ` - ${l.capabilities.join(', ')}` : ''}</p>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {selEntry && <AgentInspector key={`${selEntry.key}:${cat.canManage}`} cat={cat} entry={selEntry} index={cat.entries.findIndex(x => x.key === selEntry.key)} onClose={close} />}
        </div>
      )}
    </section>
  );
}
