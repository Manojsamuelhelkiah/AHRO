import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { registerCatalogueAgent, type AgentCatalogue, type CatalogueAgentRegistrationInput } from '@workspace/api-client-react';
import { AlertTriangle, RotateCcw, Link2, PlusCircle } from 'lucide-react';
import { Button, Input, Label } from '@/components/ui-shared';
import { identityLabel } from '@/components/member-identity';
import { PrincipalSummary, principalBlocker } from './principal-summary';

export type Pending = { payload: CatalogueAgentRegistrationInput; requestId: string };
type Notice = { kind: 'ok' | 'conflict' | 'error' | 'unknown'; text: string };
const selectCls = 'h-10 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm focus:border-[var(--primary)] focus:outline-none';

export function RegistrationForm({ catalogue, queryScope, selection, retryState }: {
  catalogue: AgentCatalogue; queryScope: readonly unknown[]; selection?: { key: string; revision: number };
  retryState?: { pending: Pending | null; setPending: (value: Pending | null) => void };
}) {
  const client = useQueryClient();
  const alive = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; abortRef.current?.abort(); }; }, []);

  const [localPending, setLocalPending] = useState<Pending | null>(null);
  const pending = retryState ? retryState.pending : localPending;
  const setPending = retryState?.setPending ?? setLocalPending;
  const [catKey, setCatKey] = useState(pending?.payload.catalogueKey ?? selection?.key ?? catalogue.entries[0]?.key ?? '');
  const [mode, setMode] = useState<'new' | 'bind'>(pending?.payload.agentId ? 'bind' : 'new');
  const [name, setName] = useState(pending?.payload.name ?? '');
  // No explicit choice means follow this role's current binding, never the
  // first principal in the list. Explicit choices survive snapshot refreshes.
  const [choice, setChoice] = useState<{ role: string; id: string } | null>(() =>
    pending?.payload.agentId ? { role: pending.payload.catalogueKey, id: pending.payload.agentId } : null);
  const [ownerUserId, setOwnerUserId] = useState(pending?.payload.ownerUserId ?? '');
  const [ackEvidence, setAckEvidence] = useState<string | null>(null);
  const [reviewRequired, setReviewRequired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(() => pending ? {
    kind: 'unknown', text: `The outcome for ${pending.payload.catalogueKey} is unknown. Retry sends the identical request and request ID, so it cannot register twice.`,
  } : null);

  // Card selection is navigation, never an alteration of an in-flight retry.
  // A revision lets a later click on the same card select it again.
  useEffect(() => {
    if (selection && !pending && !busy) {
      setCatKey(selection.key); setChoice(null); setAckEvidence(null); setReviewRequired(false);
    }
  }, [selection]);

  const entry = catalogue.entries.find(e => e.key === catKey);
  const existing = catalogue.registrations.find(r => r.catalogueKey === catKey);
  const agentId = choice?.role === catKey ? choice.id : existing?.agentId ?? '';
  const principal = catalogue.principals.find(p => p.id === agentId);
  const noOwners = catalogue.owners.length === 0;
  const effectiveOwner = mode === 'bind' ? principal?.ownerUserId ?? '' : ownerUserId;
  const blocker = mode === 'bind' ? principalBlocker(catalogue, catKey, agentId) : null;
  const currentPrincipal = catalogue.principals.find(p => p.id === existing?.agentId);
  const evidence = JSON.stringify([
    entry, existing, currentPrincipal, mode,
    mode === 'bind' ? [agentId, principal, blocker] : [name, ownerUserId],
    catalogue.owners.filter(o => [effectiveOwner, currentPrincipal?.ownerUserId].includes(o.clerkUserId)),
  ]);
  const target = JSON.stringify([catKey, mode, mode === 'bind' ? choice?.id ?? null : [name, ownerUserId]]);
  const previousEvidence = useRef({ target, evidence });
  const changedEvidence = previousEvidence.current.target === target && previousEvidence.current.evidence !== evidence;
  const replaceAck = ackEvidence === evidence;
  useEffect(() => {
    if (pending || busy) return;
    if (previousEvidence.current.target === target && previousEvidence.current.evidence !== evidence) {
      setAckEvidence(null); setReviewRequired(true);
    }
    previousEvidence.current = { target, evidence };
  }, [target, evidence, pending, busy]);

  function navigateRole(key: string) {
    if (pending || busy) return;
    setCatKey(key); setChoice(null); setAckEvidence(null); setReviewRequired(false);
  }

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

  const blocked = mode === 'new' ? !catalogue.owners.some(o => o.clerkUserId === ownerUserId) : !!blocker;
  const ready = !!payload && !blocked && !changedEvidence && !reviewRequired && (!existing || replaceAck) && !busy;

  async function send(p: Pending) {
    setBusy(true); setNotice(null);
    const ctl = new AbortController(); abortRef.current = ctl;
    try {
      const res = await registerCatalogueAgent({ ...p.payload, requestId: p.requestId }, { signal: ctl.signal });
      if (!alive.current) return;
      setPending(null); setAckEvidence(null); setName('');
      setNotice({ kind: 'ok', text: `${res.createdPrincipal ? 'Created and registered' : 'Bound'} principal ${res.binding.agentId} for ${p.payload.catalogueKey} (binding version ${res.binding.version}).` });
      void client.invalidateQueries({ queryKey: queryScope });
    } catch (e) {
      if (!alive.current || ctl.signal.aborted) return;
      const status = (e as { status?: number })?.status;
      const msg = (e as { data?: { message?: string } })?.data?.message || (e as Error)?.message || '';
      if (status === 409) {
        setPending(null);
        setAckEvidence(null); setReviewRequired(true);
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
    if (busy) return;
    if (pending) return void send(pending);
    if (!ready || !payload) return;
    const p = { payload, requestId: crypto.randomUUID() };
    if (mode === 'bind') setChoice({ role: catKey, id: agentId });
    setPending(p); void send(p);
  }
  function reload() {
    // Unknown outcomes remain locked to the identical payload and request ID.
    if (!pending) { setNotice(null); setAckEvidence(null); }
    void client.invalidateQueries({ queryKey: queryScope, exact: true });
  }

  const locked = !!pending;
  return (
    <form onSubmit={submit} className="space-y-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5" data-testid="form-register-agent">
      <div>
        <h3 className="text-sm font-bold text-[var(--text-primary)]">Register catalogue role</h3>
        <p className="mt-1 text-xs text-[var(--text-secondary)]" data-testid="registration-capability-notice">{catKey === 'intake-conversion'
          ? 'Registering is your standing instruction: new complete, explicit email templates in this client will automatically become held cases without Save Review or Convert clicks. Existing backlog is excluded. Owner eligibility and registration are checked on every conversion. Attachments stay quarantined; no evidence approval, contact, workstream release or closure is authorized.'
          : 'Setup only. Registering records a binding to a principal; it does not run, grant permissions, change membership or send anything.'}</p>
      </div>
      <fieldset disabled={locked || busy} className="grid gap-4 md:grid-cols-2 min-w-0">
        <div className="md:col-span-2">
          <Label htmlFor="reg-role">Catalogue role</Label>
          <select id="reg-role" data-testid="select-catalogue-role" className={selectCls} value={catKey} onChange={e => navigateRole(e.target.value)}>
            {!entry && <option value={catKey}>Role unavailable ({catKey})</option>}
            {catalogue.entries.map(e => <option key={e.key} value={e.key}>{e.name} (v{e.version})</option>)}
          </select>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">Current binding version: {existing ? existing.version : '0 (unregistered)'}</p>
        </div>
        <div className="md:col-span-2 flex flex-col sm:flex-row gap-2" role="radiogroup" aria-label="Registration mode">
          {(['new', 'bind'] as const).map(m => (
            <label key={m}
              className={`flex-1 min-w-0 min-h-11 px-2 py-2 cursor-pointer inline-flex items-center justify-center gap-2 rounded-md border text-sm font-semibold focus-within:ring-2 focus-within:ring-[var(--primary)] ${mode === m ? 'border-[var(--primary)] bg-[var(--violet-light-bg)] text-[var(--violet-fg)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}>
              <input type="radio" name="catalogue-registration-mode" checked={mode === m} data-testid={`radio-mode-${m}`}
                onChange={() => { setMode(m); setChoice(null); setAckEvidence(null); setReviewRequired(false); }} className="sr-only" />
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
            {existing && <div className="md:col-span-2 min-w-0">
              <PrincipalSummary catalogue={catalogue} id={existing.agentId} title="Current role binding" testId="current-principal-detail" />
              <p className="mt-1 text-xs break-words">Binding version {existing.version} · recorded principal version {existing.principalVersion} · {existing.state ?? 'registered'}</p>
            </div>}
            <div className="md:col-span-2 min-w-0">
              <Label htmlFor="reg-principal">Existing principal</Label>
              <select id="reg-principal" data-testid="select-principal" className={selectCls} value={agentId}
                onChange={e => { setChoice({ role: catKey, id: e.target.value }); setAckEvidence(null); setReviewRequired(false); }}>
                <option value="">Select a principal</option>
                {agentId && !principal && <option value={agentId}>Unavailable principal · {agentId}</option>}
                {catalogue.principals.map(p => <option key={p.id} value={p.id}>{p.name} - {p.id}{principalBlocker(catalogue, catKey, p.id) ? ' (not eligible)' : ''}</option>)}
              </select>
            </div>
            {agentId && <div className="md:col-span-2 min-w-0">
              <PrincipalSummary catalogue={catalogue} id={agentId}
                title={existing ? 'Candidate replacement — saved details' : 'Selected principal — saved details'} testId="text-principal-detail" />
              {existing?.agentId === agentId && <p className="mt-1 text-xs">The selected principal is the current binding; submitting re-registers it at the reviewed version.</p>}
            </div>}
          </>
        )}
      </fieldset>

      {mode === 'new' && noOwners && (
        <p role="alert" data-testid="alert-no-owners" className="flex gap-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          <AlertTriangle className="h-4 w-4 shrink-0" /> No eligible owners are available for this organization, so a new principal cannot be created. Ask an administrator to add a member first.
        </p>
      )}
      {mode === 'bind' && blocker && (
        <p role="alert" data-testid="alert-principal-blocked" className="flex gap-2 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          <AlertTriangle className="h-4 w-4 shrink-0" /> <span className="min-w-0 break-words">{blocker}</span>
        </p>
      )}
      {!pending && (reviewRequired || changedEvidence) && (
        <div role="alert" className="text-xs" data-testid="alert-review-required">
          <p>Relevant saved information changed. Review the current details{existing ? ' and acknowledge replacement again' : ' before continuing'}.</p>
          {!existing && <Button type="button" variant="outline" size="sm" data-testid="button-review-details"
            onClick={() => { setReviewRequired(false); previousEvidence.current = { target, evidence }; }}>I reviewed the current details</Button>}
        </div>
      )}
      {existing && (
        <label className="flex items-start gap-3 rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          <input type="checkbox" data-testid="check-replace" className="mt-0.5 h-4 w-4 shrink-0" checked={replaceAck} disabled={locked || busy} onChange={e => { setAckEvidence(e.target.checked ? evidence : null); setReviewRequired(false); }} />
          <span className="min-w-0">I reviewed the saved details and understand this replaces the existing registration for this role: principal <code className="break-all">{existing.agentId}</code> (recorded principal version {existing.principalVersion}, state {existing.state ?? 'registered'}), expected binding version {existing.version}.</span>
        </label>
      )}

      {notice && (
        <div role={notice.kind === 'ok' ? 'status' : 'alert'} data-testid={`notice-${notice.kind}`}
          className={`rounded-md border p-3 text-xs ${notice.kind === 'ok' ? 'border-[var(--status-green)] bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'border-[var(--status-red)] bg-[var(--status-red-bg)] text-[var(--status-red-fg)]'}`}>
          <p>{notice.text}</p>
          {(notice.kind === 'conflict' || notice.kind === 'unknown') && (
            <Button type="button" variant="outline" size="sm" className="mt-2 min-h-9 h-auto whitespace-normal" disabled={busy} onClick={reload} data-testid="button-reload-catalogue">
              <RotateCcw className="h-4 w-4 mr-2" /> Reload and review current state
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending ? busy : !ready} className="min-h-11" data-testid="button-submit-registration">
          {busy ? 'Submitting...' : pending ? 'Retry same request' : existing ? 'Replace registration' : mode === 'new' ? 'Create and register' : 'Bind and register'}
        </Button>
        {pending && <div className="min-w-0 text-[11px] text-[var(--text-muted)] break-all">
          <p>Pending role {pending.payload.catalogueKey} · Request ID {pending.requestId}</p>
          {pending.payload.agentId && <p>Identical retry: principal {pending.payload.agentId} · reviewed principal version {pending.payload.expectedPrincipalVersion} · owner {pending.payload.ownerUserId} · expected binding version {pending.payload.expectedBindingVersion}. Refreshed saved details do not change this request.</p>}
        </div>}
      </div>
    </form>
  );
}
