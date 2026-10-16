import { useEffect, useRef, useState } from 'react';
import type { AgentCatalogue, AgentCatalogueEntry } from '@workspace/api-client-react';
import { X, Copy, Check, AlertTriangle } from 'lucide-react';
import { PrincipalSummary } from './principal-summary';
import { RoleIcon, roleAccent } from './role-visual';

const TABS = ['Overview', 'Instructions', 'Model & Tools', 'Protocols & Collaboration', 'Activity'] as const;

function CopyBlock({ label, text, id }: { label: string; text: string; id: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'err'>('idle');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setState('ok'); } catch { setState('err'); }
  }
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{label}</span>
        <button type="button" onClick={copy} data-testid={`button-copy-${id}`} className="inline-flex min-h-8 items-center gap-1 rounded border border-[var(--border)] px-2 text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--surface-soft)]">
          {state === 'ok' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}Copy
        </button>
      </div>
      <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border)] bg-[var(--surface-soft)] p-2 text-[11px]">{text || '(empty)'}</pre>
      <p role="status" className="text-[11px]">{state === 'ok' ? 'Copied.' : state === 'err' ? 'Copy failed. Select the text and copy it manually.' : ''}</p>
    </div>
  );
}

export function AgentInspector({ cat, entry, index, onClose }: {
  cat: AgentCatalogue; entry: AgentCatalogueEntry; index: number; onClose: () => void;
}) {
  const [tab, setTab] = useState(0);
  const headRef = useRef<HTMLHeadingElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    headRef.current?.focus();
    return () => { document.body.style.overflow = overflow; prev?.focus?.(); };
  }, []);
  const a = roleAccent(entry.key, index);
  const ins = entry.inspection;
  const reg = cat.registrations.find(r => r.catalogueKey === entry.key);
  // Exact current binding only: same agent AND recorded principal version.
  const acts = (cat.activity ?? []).filter(x => reg && x.agentId === reg.agentId && x.agentVersion === reg.principalVersion);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { e.stopPropagation(); closeRef.current(); return; }
    if (e.key === 'Tab') {
      const nodes = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
      if (!nodes.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === headRef.current)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function tabKey(e: React.KeyboardEvent) {
    let n = tab;
    if (e.key === 'ArrowRight') n = (tab + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') n = (tab + TABS.length - 1) % TABS.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = TABS.length - 1;
    else return;
    e.preventDefault(); setTab(n);
    window.requestAnimationFrame(() => document.getElementById(`insp-tab-${n}`)?.focus());
  }
  const dl = 'grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 text-xs [&>div]:min-w-0 [&_dd]:[overflow-wrap:anywhere]';
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }} data-testid="inspector-backdrop">
      <div role="dialog" aria-modal="true" aria-labelledby="insp-title" onKeyDown={onKey} data-testid={`inspector-${entry.key}`}
        className="flex h-full w-full max-w-2xl min-w-0 flex-col overflow-hidden bg-[var(--surface)] shadow-xl" style={{ borderTop: `4px solid ${a.solid}` }}>
        <header className="flex items-start gap-3 border-b border-[var(--border)] p-4">
          <RoleIcon roleKey={entry.key} index={index} />
          <div className="min-w-0 flex-1">
            <h2 id="insp-title" ref={headRef} tabIndex={-1} className="text-base font-bold text-[var(--text-primary)] outline-none">{entry.name}</h2>
            <p className="font-mono text-[11px] text-[var(--text-muted)] break-all">role:{entry.key} - v{entry.version} - {entry.kind}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close inspector" data-testid="button-close-inspector" className="flex h-10 w-10 items-center justify-center rounded-md border border-[var(--border)]"><X className="h-4 w-4" /></button>
        </header>
        <div role="tablist" aria-label="Inspector sections" onKeyDown={tabKey} className="flex gap-1 overflow-x-auto border-b border-[var(--border)] px-2">
          {TABS.map((t, i) => (
            <button key={t} id={`insp-tab-${i}`} role="tab" type="button" aria-selected={tab === i} aria-controls="insp-panel" tabIndex={tab === i ? 0 : -1}
              onClick={() => setTab(i)} data-testid={`tab-inspector-${i}`}
              className="min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-xs font-semibold"
              style={{ borderColor: tab === i ? a.solid : 'transparent', color: tab === i ? a.fg : 'var(--text-secondary)' }}>{t}</button>
          ))}
        </div>
        <div id="insp-panel" role="tabpanel" aria-labelledby={`insp-tab-${tab}`} tabIndex={0} className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm text-[var(--text-secondary)] [overflow-wrap:anywhere]">
          {tab === 0 && <>
            <p>{entry.responsibility}</p>
            <dl className={dl}>
              <div><dt className="font-semibold">Role / version</dt><dd className="break-all">{entry.key} v{entry.version}</dd></div>
              <div><dt className="font-semibold">Operational capability</dt><dd>{entry.operationalCapability}</dd></div>
              <div className="sm:col-span-2"><dt className="font-semibold">Prerequisites</dt><dd>{entry.prerequisites.length ? entry.prerequisites.join('; ') : 'None recorded'}</dd></div>
            </dl>
            <div>
              <h3 className="text-xs font-bold text-[var(--text-primary)]">{entry.mappings.length} canonical intent mappings</h3>
              <ul className="mt-1 space-y-1.5">{entry.mappings.map(m => (
                <li key={m.intentKey} className="rounded border border-[var(--border)] p-2 text-xs">
                  <div className="font-medium break-words">{m.intentName} <span className="font-mono text-[var(--text-muted)]">{m.intentKey} v{m.intentVersion}</span></div>
                  <div className="text-[var(--text-muted)]">Review: {m.reviewStatus}; source: {m.sourceVersion}; provenance: {m.provenance.join(', ') || 'none'}</div>
                  <p>{m.rationale}</p>
                </li>))}</ul>
            </div>
            {cat.canManage ? (
              <div data-testid="inspector-binding">
                <h3 className="mb-1 text-xs font-bold text-[var(--text-primary)]">Binding</h3>
                {reg ? <>
                  <PrincipalSummary catalogue={cat} id={reg.agentId} title="Current role binding" testId="inspector-principal" />
                  <p className="mt-1 text-xs break-words">Binding version {reg.version} - recorded principal version {reg.principalVersion} - {reg.state ?? 'registered'}</p>
                  {entry.key === 'intake-conversion' && <p className="mt-2 text-xs">{reg.state === 'registered' ? 'Standing conversion enabled for new valid requests only.' : 'Standing conversion is not currently eligible.'} No downstream execution, contact or closure is authorized.
                    {reg.intakeAuthorization && <> Capability {reg.intakeAuthorization.capability}; registration boundary {new Date(reg.intakeAuthorization.activatedAt).toLocaleString()}.</>}
                  </p>}
                </> : <p className="text-xs">Catalogue-only role. Not registered.</p>}
              </div>
            ) : <p className="text-xs">Binding details are private to administrators.</p>}
          </>}
          {tab === 1 && (ins ? <>
            <p className="whitespace-pre-wrap break-words">{ins.instructions}</p>
            <p className="text-xs"><b>Execution:</b> {ins.execution}</p>
            <p className="text-xs">Static source templates only. Context placeholders remain unresolved; no case messages, private evidence, credentials or hidden reasoning are loaded.</p>
            {ins.workflows.map((w, i) => <section key={w.name} className="min-w-0 space-y-2 rounded border border-[var(--border)] p-3">
              <h3 className="text-sm font-bold">{w.name}</h3>
              <p className="text-xs">{w.association}</p>
              <p className="text-xs">{w.status}</p>
              <p className="break-all text-xs">Source: {w.source}<br />SHA-256: {w.hash}</p>
              <CopyBlock label="System instructions" text={w.system} id={`system-${entry.key}-${i}`} />
              <CopyBlock label="Prompt template" text={w.template} id={`template-${entry.key}-${i}`} />
            </section>)}
            {ins.workflows.length === 0 && <p className="text-xs">No executing model or prompt is attached to this role.</p>}
            {ins.contextSources.length > 0 && <div><h3 className="text-xs font-bold text-[var(--text-primary)]">Context sources</h3><ul className="list-disc pl-5 text-xs">{ins.contextSources.map(s => <li key={s}>{s}</li>)}</ul></div>}
          </> : <p>No inspection detail was provided for this role.</p>)}
          {tab === 2 && (ins ? <>
            {ins.workflows.length === 0 && <p className="flex gap-2 rounded border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="h-4 w-4 shrink-0" />No model executor is configured for this role. {ins.execution}</p>}
            {ins.workflows.map((w, i) => (
              <section key={w.name + i} className="min-w-0 space-y-2 rounded border border-[var(--border)] p-3" aria-label={`Workflow ${w.name}`}>
                <h3 className="text-xs font-bold text-[var(--text-primary)]">{w.name}</h3>
                <dl className={dl}>
                  <div><dt className="font-semibold">Status</dt><dd>{w.status}</dd></div>
                  <div><dt className="font-semibold">Association</dt><dd>{w.association}</dd></div>
                  <div className="min-w-0"><dt className="font-semibold">Source</dt><dd className="break-all">{w.source}</dd></div>
                  <div className="min-w-0"><dt className="font-semibold">Hash</dt><dd className="break-all font-mono">{w.hash}</dd></div>
                  <div><dt className="font-semibold">Provider / model</dt><dd className="break-words">{w.provider} / {w.model}</dd></div>
                  <div><dt className="font-semibold">Settings</dt><dd className="break-words">{w.settings}</dd></div>
                </dl>
              </section>
            ))}
            <div>
              <h3 className="text-xs font-bold text-[var(--text-primary)]">Tools</h3>
              {ins.tools.length === 0 ? <p className="text-xs">No tools listed.</p> : <ul className="mt-1 space-y-1.5">{ins.tools.map(t => (
                <li key={t.name} className="rounded border border-[var(--border)] p-2 text-xs break-words"><b>{t.name}</b> - {t.access}; {t.association}<div>Input: {t.input}</div><div>Output: {t.output}</div></li>))}</ul>}
            </div>
            {ins.unavailable.length > 0 && <div><h3 className="text-xs font-bold text-[var(--text-primary)]">Not available</h3><ul className="list-disc pl-5 text-xs">{ins.unavailable.map(u => <li key={u}>{u}</li>)}</ul></div>}
          </> : <p>No inspection detail was provided for this role.</p>)}
          {tab === 3 && (ins ? <>
            {['implemented', 'proposed'].map(st => {
              const list = ins.protocols.filter(p => p.status.toLowerCase() === st);
              return <div key={st}><h3 className="text-xs font-bold capitalize text-[var(--text-primary)]">{st}</h3>
                {list.length === 0 ? <p className="text-xs">None {st}.</p> : <ul className="mt-1 space-y-1.5">{list.map(p => <li key={p.name} className="rounded border border-[var(--border)] p-2 text-xs"><b>{p.name}</b> ({p.status}) - {p.description}</li>)}</ul>}</div>;
            })}
            {ins.protocols.filter(p => !['implemented', 'proposed'].includes(p.status.toLowerCase())).map(p => <p key={p.name} className="text-xs"><b>{p.name}</b> ({p.status}) - {p.description}</p>)}
            <div><h3 className="text-xs font-bold text-[var(--text-primary)]">Collaboration</h3>{ins.collaborations.length === 0 ? <p className="text-xs">None recorded.</p> : <ul className="list-disc pl-5 text-xs">{ins.collaborations.map(c => <li key={c}>{c}</li>)}</ul>}</div>
          </> : <p>No inspection detail was provided for this role.</p>)}
          {tab === 4 && (!cat.canManage ? <p>Activity is private to administrators.</p> : <>
            <p className="text-xs">From at most 100 latest tenant invocation records, showing only the current binding's principal and recorded principal version. Case payloads are never shown. These are tool/capability audit records, not inference telemetry.</p>
            <p className="text-xs">Attribution is to the recorded principal, not proof of a catalogue-role executor or a particular binding generation.</p>
            {!reg ? <p className="text-xs">Not registered, so no attributable binding activity is shown.</p> : acts.length === 0 ? <p className="text-xs" data-testid="empty-activity">No matching activity in this bounded window for this exact binding. This does not prove there was no earlier activity.</p> :
              <ul className="space-y-1.5">{acts.map(x => <li key={x.id} className="rounded border border-[var(--border)] p-2 text-xs break-all"><b>{x.toolKey}</b> - {x.action} - {x.outcome}<div className="text-[var(--text-muted)]"><time dateTime={x.createdAt}>{new Date(x.createdAt).toLocaleString()}</time> - audit {x.id} - principal version {x.agentVersion}<br />Run: {x.runId}<br />Correlation: {x.correlationId}</div></li>)}</ul>}
          </>)}
        </div>
      </div>
    </div>
  );
}
