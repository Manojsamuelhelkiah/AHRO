import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@clerk/react';
import { getAgentCatalogue, getPinnedOrganizationIdForPage, type AgentCatalogue } from '@workspace/api-client-react';
import { ShieldCheck, Lock, RotateCcw, Layers } from 'lucide-react';
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
  const entries = useMemo(() => (cat?.entries ?? []).filter(e => !term ||
    [e.name, e.key, e.responsibility, ...e.productFamilies, ...e.prerequisites,
      ...e.mappings.flatMap(m => [m.intentKey, m.intentName])].some(s => s.toLowerCase().includes(term))), [cat, term]);

  const regOf = (key: string) => cat?.registrations.find(r => r.catalogueKey === key);

  return (
    <section aria-labelledby="catalogue-h" className="space-y-4" data-testid="section-catalogue">
      <div>
        <h2 id="catalogue-h" className="text-lg font-bold text-[var(--text-primary)]">Catalogue roles and registrations</h2>
        <p className="text-sm text-[var(--text-secondary)] mt-1 max-w-2xl">Versioned agent roles and who is registered to each. Registration is setup metadata only.</p>
      </div>

      {q.isPending && q.fetchStatus !== 'idle' && (
        <div className="space-y-3" role="status" aria-label="Loading catalogue" data-testid="loading-catalogue">
          {[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-[var(--radius-lg)] bg-[var(--surface-soft)] border border-[var(--border)]" />)}
        </div>
      )}
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
            The twelve product families are browsing labels, not a replacement for the broader intent taxonomy.
            Reviewed mappings associate coordination responsibilities only; they do not approve execution or raise coverage maturity.
          </p>

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
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {entries.map(e => {
                const reg = regOf(e.key);
                return (
                  <article key={e.key} className="min-w-0 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-sm" data-testid={`card-role-${e.key}`}>
                    <header className="flex items-start justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-alt)] p-4">
                      <div className="min-w-0">
                        <h3 className="text-sm font-bold text-[var(--text-primary)]">{e.name}</h3>
                        <div className="font-mono text-[11px] text-[var(--text-muted)] break-all">{e.key} - v{e.version}</div>
                      </div>
                      <span className="shrink-0 rounded border border-[var(--border-strong)] px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)]">{e.kind}</span>
                    </header>
                    <div className="space-y-3 p-4 text-sm">
                      <p className="text-[var(--text-secondary)] leading-relaxed">{e.responsibility}</p>
                      <div className="flex flex-wrap gap-1.5">
                        {e.productFamilies.map(f => <span key={f} className="rounded border border-[var(--border)] bg-[var(--surface-soft)] px-2 py-1 text-[11px]">{f}</span>)}
                      </div>
                      {e.prerequisites.length > 0 && <div className="text-xs text-[var(--text-secondary)]"><b>Prerequisites:</b> {e.prerequisites.join('; ')}</div>}
                      <div className="text-xs text-[var(--text-muted)]"><b>Operational capability (unavailable):</b> {e.operationalCapability}</div>
                      <details className="text-xs">
                        <summary className="cursor-pointer font-semibold text-[var(--text-primary)] min-h-8">{e.mappings.length} canonical intent mappings</summary>
                        <ul className="mt-2 space-y-2">
                          {e.mappings.map(m => (
                            <li key={m.intentKey} className="rounded border border-[var(--border)] p-2">
                              <div className="font-medium">{m.intentName} <span className="font-mono text-[var(--text-muted)]">{m.intentKey} v{m.intentVersion}</span></div>
                              <div className="text-[var(--text-muted)]">Review: {m.reviewStatus}; provenance: {m.provenance.join(', ') || 'none'}</div>
                            </li>
                          ))}
                        </ul>
                      </details>
                      {cat.canManage ? (
                        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border)] pt-3" data-testid={`registration-${e.key}`}>
                          <div className="min-w-0 text-xs">
                            {reg ? <><ShieldCheck className="inline h-4 w-4 mr-1 text-[var(--text-muted)]" />Binding recorded: <code className="break-all">{reg.agentId}</code> (v{reg.version}, {reg.state ?? 'registered'})</> : <span className="text-[var(--text-muted)]">Catalogue-only role · Not registered</span>}
                          </div>
                          <Button type="button" size="sm" variant="outline" className="h-9" data-testid={`button-select-${e.key}`}
                            onClick={() => { setFormSelection(previous => ({ key: e.key, revision: (previous?.revision ?? 0) + 1 })); document.getElementById('catalogue-h')?.scrollIntoView({ block: 'start' }); }}>
                            {reg ? 'Replace' : 'Register'}
                          </Button>
                        </div>
                      ) : (
                        <div className="border-t border-[var(--border)] pt-3 text-xs text-[var(--text-muted)] flex items-center gap-1"><Lock className="h-3.5 w-3.5" />Registration status private</div>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
