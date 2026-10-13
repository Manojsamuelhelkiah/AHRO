import { useMemo, useState } from 'react';
import {
  useGetIntentCatalog,
  getGetIntentCatalogQueryKey,
  exportIntentCatalog,
} from '@workspace/api-client-react';
import type {
  OperationalIntentCatalog,
  OperationalIntentDefinition,
  CatalogMapping,
} from '@workspace/api-client-react';
import { Download, RefreshCw, Search, Info } from 'lucide-react';

const SOURCES = ['master', 'registry', 'case-family', 'sample', 'custom'] as const;
type Src = (typeof SOURCES)[number];

const card: React.CSSProperties = {
  backgroundColor: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  padding: 'var(--space-lg)',
};
const chip: React.CSSProperties = {
  fontSize: 'var(--text-xs)',
  padding: '2px 8px',
  borderRadius: 999,
  backgroundColor: 'var(--primary-light)',
  color: 'var(--text-secondary)',
  fontWeight: 600,
  display: 'inline-block',
};
const field: React.CSSProperties = {
  minHeight: 36,
  border: '1px solid var(--border)',
  borderRadius: 'var(--radius-md)',
  backgroundColor: 'var(--surface)',
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
  padding: '0 8px',
};
const h2: React.CSSProperties = { fontSize: 'var(--text-lg)', fontWeight: 700, marginBottom: 8 };

function defSources(d: OperationalIntentDefinition, mappings: CatalogMapping[]): Set<Src> {
  const s = new Set<Src>();
  if (d.definitionClass === 'custom') s.add('custom');
  for (const m of mappings) {
    if (m.definitionKeys.includes(d.key) && m.source !== 'candidate') s.add(m.source as Src);
  }
  return s;
}

function List({ items, label }: { items: string[]; label: string }) {
  return (
    <div>
      <h4 style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-muted)' }}>{label}</h4>
      {items.length === 0 ? (
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>None recorded</p>
      ) : (
        <ul style={{ fontSize: 'var(--text-sm)', paddingLeft: 18, listStyle: 'disc' }}>
          {items.map((i, n) => <li key={n}>{i}</li>)}
        </ul>
      )}
    </div>
  );
}

function download(data: OperationalIntentCatalog) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `intent-catalog-${data.version.replace(/[^A-Za-z0-9._-]+/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function IntentCatalogPage() {
  const q = useGetIntentCatalog({
    query: { queryKey: getGetIntentCatalogQueryKey(), staleTime: 5 * 60_000, gcTime: 10 * 60_000, refetchOnWindowFocus: false },
  });
  const [search, setSearch] = useState('');
  const [journey, setJourney] = useState('');
  const [service, setService] = useState('');
  const [source, setSource] = useState('');
  const [cls, setCls] = useState('');
  const [coverage, setCoverage] = useState('');
  const [init, setInit] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');

  const cat = q.data;

  const filtered = useMemo(() => {
    if (!cat) return [];
    const t = search.trim().toLowerCase();
    return cat.definitions.filter((d) => {
      if (journey && !d.journeyKeys.includes(journey)) return false;
      if (service && !d.serviceKeys.includes(service)) return false;
      if (cls && d.definitionClass !== cls) return false;
      if (coverage && d.coverage !== coverage) return false;
      if (init === 'human' && !d.initiation.human) return false;
      if (init === 'ai' && !d.initiation.ai) return false;
      if (source && !defSources(d, cat.mappings).has(source as Src)) return false;
      if (t) {
        const labels = cat.mappings.filter((m) => m.definitionKeys.includes(d.key)).map((m) => m.label);
        const hay = [d.name, d.key, d.outcome, ...d.aliases, ...labels].join('\n').toLowerCase();
        if (!hay.includes(t)) return false;
      }
      return true;
    });
  }, [cat, search, journey, service, cls, coverage, init, source]);

  const byKey = useMemo(() => new Map((cat?.definitions ?? []).map((d) => [d.key, d])), [cat]);
  const selDef = selected ? byKey.get(selected) : undefined;

  if (q.isLoading) {
    return (
      <div style={{ paddingTop: 24 }} aria-busy="true" aria-label="Loading intent catalog">
        {[0, 1, 2].map((i) => (
          <div key={i} className="animate-pulse" style={{ ...card, height: 90, marginBottom: 12, backgroundColor: 'var(--surface-soft)' }} />
        ))}
      </div>
    );
  }
  if (q.isError || !cat) {
    return (
      <div role="alert" style={{ ...card, marginTop: 24 }}>
        <p style={{ fontWeight: 600 }}>The intent catalog could not be loaded.</p>
        <button type="button" onClick={() => q.refetch()} style={{ ...field, marginTop: 12, fontWeight: 600, padding: '0 16px', minHeight: 44 }}>
          Retry
        </button>
      </div>
    );
  }

  const unresolved = cat.mappings.filter((m) => m.relation === 'unresolved' || m.relation === 'ambiguous' || m.definitionKeys.length === 0);
  const compFor = selDef
    ? {
        children: cat.compositions.filter((c) => c.callerKey === selDef.key),
        callers: cat.compositions.filter((c) => c.calleeKey === selDef.key),
      }
    : null;
  const mapsFor = selDef ? cat.mappings.filter((m) => m.definitionKeys.includes(selDef.key)) : [];
  const gapsFor = selDef ? cat.gaps.filter((g) => g.definitionKeys.includes(selDef.key)) : [];

  const nameOf = (k: string) => byKey.get(k)?.name ?? k;
  const KeyLink = ({ k }: { k: string }) => (
    <button
      type="button"
      onClick={() => {
        setSelected(k);
        document.getElementById('definition-detail')?.scrollIntoView({ block: 'nearest' });
      }}
      style={{ color: 'var(--primary)', textDecoration: 'underline', fontWeight: 600, textAlign: 'left', minHeight: 24 }}
    >
      {nameOf(k)}
    </button>
  );

  const counts: [string, number][] = [
    ['Journeys', cat.counts.journeys],
    ['Services', cat.counts.services],
    ['Master atomic outcomes', cat.counts.masterAtomicOutcomes],
    ['Canonical atomic', cat.counts.canonicalAtomicDefinitions],
    ['Composites', cat.counts.compositeDefinitions],
    ['Custom', cat.counts.customDefinitions],
    ['Proposed gaps', cat.counts.proposedGaps],
    ['Sample variations', cat.counts.sampleVariations],
    ['Registry entries', cat.counts.registryEntries],
  ];

  const Sel = ({ label, value, set, options }: { label: string; value: string; set: (v: string) => void; options: [string, string][] }) => (
    <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {label}
      <select value={value} onChange={(e) => set(e.target.value)} style={field}>
        <option value="">All</option>
        {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </label>
  );

  return (
    <div style={{ paddingTop: 'var(--space-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>Intent Catalog</h1>
          <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginTop: 4 }}>
            Read-only inventory of operational intents. Version <strong data-testid="text-catalog-version">{cat.version}</strong>
            {cat.sourceVersions.length > 0 && <> built from {cat.sourceVersions.join(', ')}</>}.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" data-testid="button-refresh-catalog" onClick={() => q.refetch()} disabled={q.isFetching}
            style={{ ...field, display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', fontWeight: 600, minHeight: 44 }}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> {q.isFetching ? 'Refreshing' : 'Refresh'}
          </button>
          <button type="button" data-testid="button-export-catalog" disabled={exporting}
            onClick={async () => {
              setExporting(true);
              setExportError('');
              try {
                download(await exportIntentCatalog());
              } catch {
                setExportError('Export failed. Try again.');
              } finally {
                setExporting(false);
              }
            }}
            style={{ minHeight: 44, padding: '0 14px', borderRadius: 'var(--radius-md)', backgroundColor: 'var(--primary)', color: '#fff', fontWeight: 600, fontSize: 'var(--text-sm)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Download className="h-4 w-4" aria-hidden="true" /> {exporting ? 'Exporting' : 'Export JSON'}
          </button>
        </div>
      </header>
      {exportError && <p role="alert" style={{ color: 'var(--status-red)', fontSize: 'var(--text-sm)' }}>{exportError}</p>}

      <section aria-labelledby="ic-notices" style={{ ...card, borderLeft: '4px solid var(--primary)' }}>
        <h2 id="ic-notices" style={{ ...h2, display: 'flex', gap: 6, alignItems: 'center' }}><Info className="h-4 w-4" aria-hidden="true" /> How to read this catalog</h2>
        <ul style={{ fontSize: 'var(--text-sm)', paddingLeft: 18, listStyle: 'disc', display: 'grid', gap: 4 }}>
          <li>This is descriptive metadata. It does not grant permission and cannot authorize or run any action.</li>
          <li>Sample variations are illustrations, not evidence of operational support.</li>
          <li>The scope covers reviewed material only, not every possible HRO intent.</li>
          <li>The values below come from the live response and are authoritative over older maturity claims.</li>
          {cat.notices.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
        <p style={{ fontSize: 'var(--text-sm)', marginTop: 8 }}><strong>Scope:</strong> {cat.scope}</p>
      </section>

      <section aria-labelledby="ic-counts">
        <h2 id="ic-counts" className="sr-only">Counts</h2>
        <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(140px,1fr))', gap: 8 }}>
          {counts.map(([l, v]) => (
            <div key={l} style={{ ...card, padding: 12 }}>
              <dt style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontWeight: 600 }}>{l}</dt>
              <dd style={{ fontSize: 'var(--text-2xl)', fontWeight: 700 }}>{v}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="ic-defs" style={card}>
        <h2 id="ic-defs" style={h2}>Definitions ({filtered.length} of {cat.definitions.length})</h2>
        <div role="search" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 8, marginBottom: 12 }}>
          <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, gridColumn: '1 / -1', position: 'relative' }}>
            Search names, keys, outcomes, aliases, mapping labels
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, ...field, marginTop: 2 }}>
              <Search className="h-4 w-4" aria-hidden="true" />
              <input data-testid="input-catalog-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                style={{ flex: 1, minWidth: 0, background: 'transparent', outline: 'none', minHeight: 34 }} />
            </span>
          </label>
          <Sel label="Journey" value={journey} set={setJourney} options={cat.journeys.map((j) => [j.key, j.name])} />
          <Sel label="Service" value={service} set={setService} options={cat.services.map((j) => [j.key, j.name])} />
          <Sel label="Source" value={source} set={setSource} options={SOURCES.map((s) => [s, s])} />
          <Sel label="Class" value={cls} set={setCls} options={['atomic', 'composite', 'custom'].map((s) => [s, s])} />
          <Sel label="Coverage" value={coverage} set={setCoverage} options={['catalogued', 'illustrative', 'simulated', 'integrated', 'verified'].map((s) => [s, s])} />
          <Sel label="Initiation" value={init} set={setInit} options={[['human', 'Human can start'], ['ai', 'AI can start']]} />
        </div>
        <p aria-live="polite" className="sr-only">{filtered.length} definitions match</p>

        <div style={{ display: 'grid', gap: 16 }} className="lg:grid-cols-2">
          <ul style={{ maxHeight: 520, overflowY: 'auto', display: 'grid', gap: 6, alignContent: 'start' }} aria-label="Definitions">
            {filtered.length === 0 && <li style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', padding: 12 }}>No definitions match these filters.</li>}
            {filtered.map((d) => (
              <li key={d.key}>
                <button type="button" data-testid={`button-definition-${d.key}`} aria-pressed={selected === d.key} onClick={() => setSelected(d.key)}
                  style={{ width: '100%', textAlign: 'left', minHeight: 44, padding: 10, borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)', backgroundColor: selected === d.key ? 'var(--surface-selected)' : 'var(--surface)' }}>
                  <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', display: 'block' }}>{d.name}</span>
                  <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{d.key}</span>
                  <span style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                    <span style={chip}>{d.definitionClass}</span>
                    <span style={chip}>{d.coverage}</span>
                    <span style={chip}>{d.reviewStatus}</span>
                    {d.status === 'retired' && <span style={chip}>retired</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <article id="definition-detail" aria-live="polite" tabIndex={-1} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 16, minWidth: 0 }}>
            {!selDef || !compFor ? (
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Select a definition to see its outcome, context, relations and mappings.</p>
            ) : (
              <div style={{ display: 'grid', gap: 12, fontSize: 'var(--text-sm)' }}>
                <div>
                  <h3 style={{ fontSize: 'var(--text-xl)', fontWeight: 700 }}>{selDef.name}</h3>
                  <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>{selDef.key} v{selDef.version}</p>
                  <p style={{ marginTop: 6 }}>{selDef.outcome}</p>
                  <p style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>
                    <span style={chip}>{selDef.definitionClass}</span><span style={chip}>coverage: {selDef.coverage}</span>
                    <span style={chip}>{selDef.reviewStatus}</span><span style={chip}>{selDef.status}</span>
                  </p>
                </div>
                <div>
                  <h4 style={{ fontWeight: 700 }}>Initiation ({selDef.initiation.reviewStatus})</h4>
                  <p>
                    Human: {selDef.initiation.human ? 'yes' : 'no'}; AI: {selDef.initiation.ai ? 'yes' : 'no'};
                    standalone: {selDef.initiation.standalone ? 'yes' : 'no'}; composed: {selDef.initiation.composed ? 'yes' : 'no'}.
                  </p>
                  <p style={{ color: 'var(--text-secondary)' }}>{selDef.initiation.note}</p>
                </div>
                <List label="Required context" items={selDef.requiredContext} />
                <List label="Invocation constraints" items={selDef.invocationConstraints} />
                <List label="Evidence" items={selDef.evidence} />
                <List label="Coverage evidence" items={selDef.coverageEvidence} />
                <List label="Aliases" items={selDef.aliases} />
                <List label="Provenance" items={selDef.provenance} />
                <p><strong>Journeys:</strong> {selDef.journeyKeys.map((k) => cat.journeys.find((j) => j.key === k)?.name ?? k).join(', ') || 'None'}</p>
                <p><strong>Services:</strong> {selDef.serviceKeys.map((k) => cat.services.find((j) => j.key === k)?.name ?? k).join(', ') || 'None'}</p>

                <div>
                  <h4 style={{ fontWeight: 700 }}>Calls these child intents ({compFor.children.length})</h4>
                  {compFor.children.length === 0 && <p style={{ color: 'var(--text-muted)' }}>None</p>}
                  {compFor.children.map((c) => (
                    <div key={c.key} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                      <KeyLink k={c.calleeKey} /> <span style={chip}>{c.completionDependency}</span> <span style={chip}>{c.reviewStatus}</span>
                      <p>Proposed condition: {c.condition}</p>
                      <List label="Input mappings" items={c.inputMappings} />
                    </div>
                  ))}
                </div>
                <div>
                  <h4 style={{ fontWeight: 700 }}>Called by ({compFor.callers.length})</h4>
                  {compFor.callers.length === 0 && <p style={{ color: 'var(--text-muted)' }}>None</p>}
                  {compFor.callers.map((c) => (
                    <div key={c.key} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                      <KeyLink k={c.callerKey} /> <span style={chip}>{c.completionDependency}</span> <span style={chip}>{c.reviewStatus}</span>
                      <p>Proposed condition: {c.condition}</p>
                      <List label="Input mappings" items={c.inputMappings} />
                    </div>
                  ))}
                </div>
                <div>
                  <h4 style={{ fontWeight: 700 }}>Mappings to this definition ({mapsFor.length})</h4>
                  {mapsFor.map((m) => <MappingRow key={`${m.source}:${m.sourceKey}`} m={m} />)}
                </div>
                {gapsFor.length > 0 && (
                  <div>
                    <h4 style={{ fontWeight: 700 }}>Related gaps</h4>
                    {gapsFor.map((g) => <p key={g.key}><strong>{g.title}</strong> ({g.reviewStatus})</p>)}
                  </div>
                )}
              </div>
            )}
          </article>
        </div>
      </section>

      <section aria-labelledby="ic-gaps" style={card}>
        <h2 id="ic-gaps" style={h2}>Gaps ({cat.gaps.length})</h2>
        {cat.gaps.length === 0 && <p style={{ fontSize: 'var(--text-sm)' }}>No gaps recorded.</p>}
        <ul style={{ display: 'grid', gap: 8, gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))' }}>
          {cat.gaps.map((g) => (
            <li key={g.key} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: 12, fontSize: 'var(--text-sm)' }}>
              <strong>{g.title}</strong> <span style={chip}>{g.reviewStatus}</span>
              <p style={{ marginTop: 4 }}>{g.description}</p>
              <p style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {g.definitionKeys.map((k) => <KeyLink key={k} k={k} />)}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="ic-maps" style={card}>
        <h2 id="ic-maps" style={h2}>Mappings ({cat.mappings.length}; {unresolved.length} unresolved or ambiguous)</h2>
        {unresolved.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <h3 style={{ fontWeight: 700, fontSize: 'var(--text-sm)' }}>Unresolved and ambiguous</h3>
            {unresolved.map((m) => <MappingRow key={`u:${m.source}:${m.sourceKey}`} m={m} KeyLink={KeyLink} />)}
          </div>
        )}
        <details>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 'var(--text-sm)', minHeight: 32 }}>All mappings</summary>
          <div style={{ maxHeight: 420, overflowY: 'auto' }}>
            {cat.mappings.map((m) => <MappingRow key={`a:${m.source}:${m.sourceKey}`} m={m} KeyLink={KeyLink} />)}
          </div>
        </details>
      </section>

      <section aria-labelledby="ic-contract" style={card}>
        <h2 id="ic-contract" style={h2}>Future intent instance contract (v{cat.instanceContract.version})</h2>
        <p style={{ fontSize: 'var(--text-sm)', marginBottom: 8 }}>
          Implemented: <strong>{cat.instanceContract.implemented ? 'yes' : 'no'}</strong>. This describes a future shape only; no instances can be created from this page.
          Limits: depth {cat.instanceContract.maximumDepth}, children {cat.instanceContract.maximumChildren}, tree size {cat.instanceContract.maximumTreeSize}.
        </p>
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))' }}>
          <List label="Fields" items={cat.instanceContract.fields} />
          <List label="Lifecycle" items={cat.instanceContract.lifecycle} />
          <List label="Safeguards" items={cat.instanceContract.safeguards} />
        </div>
      </section>
    </div>
  );
}

function MappingRow({ m, KeyLink }: { m: CatalogMapping; KeyLink?: (p: { k: string }) => React.ReactElement }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '8px 0', fontSize: 'var(--text-sm)' }}>
      <strong>{m.label}</strong>{' '}
      <span style={chip}>{m.source} {m.sourceVersion}</span>{' '}
      <span style={chip}>{m.relation}</span>{' '}
      <span style={chip}>{m.reviewStatus}</span>
      <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', wordBreak: 'break-all' }}>{m.sourceKey}</p>
      <p style={{ color: 'var(--text-secondary)' }}>{m.rationale}</p>
      {KeyLink && m.definitionKeys.length > 0 && (
        <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {m.definitionKeys.map((k) => <KeyLink key={k} k={k} />)}
        </p>
      )}
    </div>
  );
}

export default IntentCatalogPage;
