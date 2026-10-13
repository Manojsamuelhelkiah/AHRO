import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerCatalogueAgent, type AgentCatalogue, type CatalogueAgentRegistrationInput } from '@workspace/api-client-react';
import { AlertTriangle, RotateCcw, Link2, PlusCircle } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui-shared';
import { identityLabel } from '@/components/member-identity';

type Pending = { payload: CatalogueAgentRegistrationInput; requestId: string };
type Notice = { kind: 'ok' | 'conflict' | 'error' | 'unknown'; text: string };
const selectCls = 'h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm focus:border-[var(--primary)] focus:outline-none';

export function RegistrationForm({ catalogue, queryScope, selection }: { catalogue: AgentCatalogue; queryScope: readonly unknown[]; selection?: { key: string; revision: number } }) {
  const client = useQueryClient();
  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abortRef.current?.abort(); }; }, []);

  const [catKey, setCatKey] = useState(selection?.key ?? catalogue.entries[0]?.key ?? '');
  const [mode, setMode] = useState<'new' | 'bind'>('new');
  const [name, setName] = useState('');
  const [agentId, setAgentId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [replaceAck, setReplaceAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Card selection is navigation, never an alteration of an in-flight retry.
  // A revision lets a later click on the same card select it again.
  useEffect(() => {
    if (selection && !pending && !busy) { setCatKey(selection.key); setReplaceAck(false); }
  }, [selection]);

  const entry = catalogue.entries.find(e => e.key === catKey);
  const existing = catalogue.registrations.find(r => r.catalogueKey === catKey);
  const principal = catalogue.principals.find(p => p.id === agentId);
  const ownerFor = (id: string) => {
    const m = catalogue.owners.find(o => o.clerkUserId === id);
    return m ? identityLabel(m, catalogue.owners) : `Owner not in member list (${id})`;
  };
  const bindOwnerKnown = !!principal && catalogue.owners.some(o => o.clerkUserId === principal.ownerUserId);
  const noOwners = catalogue.owners.length === 0;
  const effectiveOwner = mode === 'bind' ? principal?.ownerUserId ?? '' : ownerUserId;

  const payload = useMemo<CatalogueAgentRegistrationInput | null>(() => {
    if (!entry || !effectiveOwner) return null;
    const base: CatalogueAgentRegistrationInput = {
      organizationId: catalogue.organizationId, catalogueKey: entry.key, catalogueVersion: entry.version,
      ownerUserId: effectiveOwner, requestId: '', expectedBindingVersion: existing?.version ?? 0,
      ...(existing ? { replaceExisting: true } : {}),
    };
    if (mode === 'new') return name.trim() ? { ...base, name: name.trim() } : null;
    return principal ? { ...base, agentId: principal.id, expectedPrincipalVersion: principal.version } : null;
  }, [entry, effectiveOwner, catalogue.organizationId, existing, mode, name, principal]);

  const blocked = mode === 'new' ? noOwners : !!principal && !bindOwnerKnown;
  const ready = !!payload && !blocked && (!existing || replaceAck) && !busy;

  async function send(p: Pending) {
    setBusy(true); setNotice(null);
    const ctl = new AbortController(); abortRef.current = ctl;
    try {
      const res = await registerCatalogueAgent({ ...p.payload, requestId: p.requestId }, { signal: ctl.signal });
      if (!alive.current) return;
      setPending(null); setReplaceAck(false); setName('');
      setNotice({ kind: 'ok', text: `${res.createdPrincipal ? 'Created and registered' : 'Bound'} principal ${res.binding.agentId} for ${p.payload.catalogueKey} (binding version ${res.binding.version}).` });
      void client.invalidateQueries({ queryKey: queryScope });
    } catch (e) {
      if (!alive.current || ctl.signal.aborted) return;
      const status = (e as { status?: number })?.status;
      const msg = (e as { data?: { message?: string } })?.data?.message || (e as Error)?.message || '';
      if (status === 409) {
        setPending(null);
        setNotice({ kind: 'conflict', text: msg || 'Registration or principal changed since you loaded this page. Reload and review the current state before trying again.' });
      } else if (status && status >= 400 && status < 500) {
        setPending(null);
        setNotice({ kind: 'error', text: msg || `Request rejected (${status}).` });
        if (status === 401 || status === 403) void client.resetQueries({ queryKey: queryScope, exact: true });
      } else {
        setNotice({ kind: 'unknown', text: `The outcome for ${p.payload.catalogueKey} is unknown. Retry sends the identical request and request ID, so it cannot register twice.` });
      }
    } finally { if (alive.current) setBusy(false); }
  }

  function submit(ev: React.FormEvent) {
    ev.preventDefault();
    if (pending) return void send(pending);
    if (!ready || !payload) return;
    const p = { payload, requestId: crypto.randomUUID() };
    setPending(p); void send(p);
  }
  function reload() {
    setPending(null); setNotice(null); setReplaceAck(false);
    void client.resetQueries({ queryKey: queryScope, exact: true });
  }

  const locked = !!pending;
  return (
    <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5" data-testid="form-register-agent">
      <div>
        <h3 className="text-sm font-bold text-[var(--text-primary)]">Register catalogue role</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]">Setup only. Registering records a binding to a principal; it does not run, grant permissions, change membership or send anything.</p>
      </div>
      <fieldset disabled={locked || busy} className="grid gap-4 md:grid-cols-2 min-w-0">
        <div className="md:col-span-2">
          <Label htmlFor="reg-role">Catalogue role</Label>
          <select id="reg-role" data-testid="select-catalogue-role" className={selectCls} value={catKey} onChange={e => { setCatKey(e.target.value); setReplaceAck(false); }}>
            {catalogue.entries.map(e => <option key={e.key} value={e.key}>{e.name} (v{e.version})</option>)}
          </select>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">Current binding version: {existing ? existing.version : '0 (unregistered)'}</p>
        </div>
        <div className="md:col-span-2 flex gap-2" role="radiogroup" aria-label="Registration mode">
          {(['new', 'bind'] as const).map(m => (
            <label key={m}
              className={`flex-1 min-h-11 cursor-pointer inline-flex items-center justify-center gap-2 rounded-md border text-sm font-semibold focus-within:ring-2 focus-within:ring-[var(--primary)] ${mode === m ? 'border-[var(--primary)] bg-[var(--violet-light-bg)] text-[var(--violet-fg)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}>
              <input type="radio" name="catalogue-registration-mode" checked={mode === m} data-testid={`radio-mode-${m}`}
                onChange={() => { setMode(m); setReplaceAck(false); }} className="sr-only" />
              {m === 'new' ? <PlusCircle className="h-4 w-4" /> : <Link2 className="h-4 w-4" />}
              {m === 'new' ? 'Create new principal' : 'Bind existing principal'}
            </label>
          ))}
        </div>
        {mode === 'new' ? (
          <>
            <div>
              <Label htmlFor="reg-name">Principal name</Label>
              <Input id="reg-name" data-testid="input-principal-name" maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Payroll changes agent" />
            </div>
            <div>
              <Label htmlFor="reg-owner">Owner</Label>
              <select id="reg-owner" data-testid="select-owner" className={selectCls} value={ownerUserId} onChange={e => setOwnerUserId(e.target.value)} disabled={noOwners}>
                <option value="">Select an owner</option>
                {catalogue.owners.map(o => <option key={o.clerkUserId} value={o.clerkUserId}>{identityLabel(o, catalogue.owners)}</option>)}
              </select>
            </div>
          </>
        ) : (
          <>
            <div>
              <Label htmlFor="reg-principal">Existing principal</Label>
              <select id="reg-principal" data-testid="select-principal" className={selectCls} value={agentId} onChange={e => setAgentId(e.target.value)}>
                <option value="">Select a principal</option>
                {catalogue.principals.map(p => <option key={p.id} value={p.id}>{p.name} - {p.id}</option>)}
              </select>
            </div>
            <div className="text-sm">
              <Label>Owner (kept as is)</Label>
              <div className="min-h-10 rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-xs break-words" data-testid="text-bound-owner">
                {principal ? ownerFor(principal.ownerUserId) : 'Choose a principal'}
              </div>
            </div>
            {principal && (
              <div className="md:col-span-2 text-xs text-[var(--text-secondary)] space-y-0.5" data-testid="text-principal-detail">
                <div>Principal ID: <code className="select-all break-all font-mono">{principal.id}</code></div>
                <div>Status: {principal.status} - principal version {principal.version}</div>
              </div>
            )}
          </>
        )}
      </fieldset>

      {mode === 'new' && noOwners && (
        <p role="alert" data-testid="alert-no-owners" className="flex gap-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          <AlertTriangle className="h-4 w-4 shrink-0" /> No eligible owners are available for this organization, so a new principal cannot be created. Ask an administrator to add a member first.
        </p>
      )}
      {mode === 'bind' && principal && !bindOwnerKnown && (
        <p role="alert" className="flex gap-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          <AlertTriangle className="h-4 w-4 shrink-0" /> This principal's owner ({principal.ownerUserId}) is not in the current member list. Binding is blocked until ownership is resolved elsewhere.
        </p>
      )}
      {existing && (
        <label className="flex items-start gap-3 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          <input type="checkbox" data-testid="check-replace" className="mt-0.5 h-4 w-4" checked={replaceAck} disabled={locked || busy} onChange={e => setReplaceAck(e.target.checked)} />
          <span>I understand this replaces the existing registration for this role: principal <code className="break-all">{existing.agentId}</code> (principal version {existing.principalVersion}, state {existing.state ?? 'registered'}), expected binding version {existing.version}.</span>
        </label>
      )}

      {notice && (
        <div role={notice.kind === 'ok' ? 'status' : 'alert'} data-testid={`notice-${notice.kind}`}
          className={`rounded-md border p-3 text-xs ${notice.kind === 'ok' ? 'border-[var(--status-green)] bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'border-[var(--status-red)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)]'}`}>
          <p>{notice.text}</p>
          {(notice.kind === 'conflict' || notice.kind === 'unknown') && (
            <Button type="button" variant="outline" size="sm" className="mt-2 h-9" onClick={reload} data-testid="button-reload-catalogue">
              <RotateCcw className="h-4 w-4 mr-2" /> Reload and review current state
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending ? busy : !ready} className="min-h-11" data-testid="button-submit-registration">
          {busy ? 'Submitting...' : pending ? 'Retry same request' : existing ? 'Replace registration' : mode === 'new' ? 'Create and register' : 'Bind and register'}
        </Button>
        {pending && !busy && <span className="text-[11px] text-[var(--text-muted)] break-all">Pending role {pending.payload.catalogueKey} · Request ID {pending.requestId}</span>}
      </div>
    </form>
  );
}
