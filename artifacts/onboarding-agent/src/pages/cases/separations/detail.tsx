import { useSeparationQueryScope } from './shared';
import { OriginalIntent } from '../detail/components';
import { useUser } from '@clerk/react';
import { useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import { useGetSeparationCase, useApplySeparationAction, useListSeparationPolicies, getGetSeparationCaseQueryKey, getListSeparationCasesQueryKey } from '@workspace/api-client-react';
import type { SeparationAction, SeparationDetail, SeparationTask, SeparationReceipt } from '@workspace/api-client-react';
import { Card, Input, Button } from '@/components/ui-shared';
import { ArrowLeft } from 'lucide-react';
import { CaseFlowPanel } from '../../../components/case-flow-panel';
import { Disclosure } from '../detail/disclosure';
import { ExchangePanel } from './exchange-panel';
import { caseListReference } from '../case-presentation';
import { OFFBOARDING_CASES_PATH } from '../list-navigation';
import { ClosureWarning, ErrorBox, FACT_FIELDS, FactsForm, Field, Pill, SkeletonRows, areaCls, selectCls, statusTone, validateFacts } from './shared';

const TRIGGERS = ['posh', 'whistleblower', 'litigation-hold', 'fraud-investigation', 'abscondment', 'death-in-service', 'statutory-position', 'unknown', 'conflicting'];
const FLAGS = ['privileged', 'highRisk', 'clientFacing', 'peopleManager', 'statutory'] as const;
const ITEM_KEYS = ['basePay', 'assetRecovery', 'relocationRecovery', 'noticeAdjustment', 'statutory', 'equity', 'other'];

type Spec = { key: string; label: string; kind: 'bool' | 'text' | 'datetime' | 'select'; options?: string[] };
const TASK_SPECS: Record<string, Spec[]> = {
  'ethics-review': [{ key: 'antiRetaliationReviewed', label: 'Anti-retaliation controls reviewed', kind: 'bool' }, { key: 'noSurpriseReviewed', label: 'No-surprise human handling reviewed', kind: 'bool' }],
  'legal-review': [
    { key: 'humanLedDispositionReviewed', label: 'Restricted human-led Legal disposition reviewed', kind: 'bool' },
    { key: 'nomineeBenefitsReviewed', label: 'If death in service: dignified nominee / benefits review recorded (no automatic entitlement)', kind: 'bool' },
    { key: 'exitInterviewExcluded', label: 'If death in service: exit interview excluded', kind: 'bool' },
    { key: 'noticeReviewReference', label: 'If abscondment: Legal notice review reference', kind: 'text' },
    { key: 'settlementHoldDispositionReference', label: 'If abscondment: F&F hold disposition reference', kind: 'text' },
  ],
  'asset-inventory': [{ key: 'confirmed', label: 'Default asset expectations confirmed', kind: 'bool' }],
  'knowledge-risk': [{ key: 'riskPresent', label: 'Single-point-of-knowledge risk present', kind: 'bool' }, { key: 'mitigationApproved', label: 'Mitigation plan approved', kind: 'bool' }, { key: 'mitigationReference', label: 'Mitigation reference', kind: 'text' }],
  'kt-signoff': [{ key: 'receivingManagerOrSuccessor', label: 'Receiving manager or successor', kind: 'text' }],
  'kt-access-exception': [{ key: 'exceptionRequired', label: 'Temporary KT access required', kind: 'bool' }, { key: 'approved', label: 'Exception approved', kind: 'bool' }, { key: 'approvedScope', label: 'Approved access scope', kind: 'text' }, { key: 'expiresAt', label: 'Access expiry (future, ISO e.g. 2030-01-31T18:00:00Z)', kind: 'datetime' }],
  'asset-recovery': [{ key: 'disposition', label: 'Finance disposition', kind: 'select', options: ['recovery-approved', 'write-off-approved', 'no-recovery-source-attested'] }],
  'payroll-reconciliation': [{ key: 'hrisMatchesPayroll', label: 'HRIS matches payroll', kind: 'bool' }, { key: 'hrisReference', label: 'HRIS reference', kind: 'text' }, { key: 'payrollReference', label: 'Payroll reference', kind: 'text' }],
  'payroll-ready': [{ key: 'ready', label: 'Payroll readiness confirmed', kind: 'bool' }],
  'client-communication': [{ key: 'humanAuthored', label: 'Human-authored content', kind: 'bool' }, { key: 'approved', label: 'Delivery Head approved', kind: 'bool' }, { key: 'contentReference', label: 'Approved content reference', kind: 'text' }],
  'privacy-retention': [{ key: 'action', label: 'Action taken (use preserve-under-hold when a hold exists)', kind: 'text' }],
  'access-closure': [{ key: 'sourceConfirmedClosed', label: 'Source confirms access closed', kind: 'bool' }, { key: 'dependenciesResolved', label: 'Dependencies resolved', kind: 'bool' }, { key: 'exceptionClosedReference', label: 'KT exception closure reference (required when a temporary KT exception was required)', kind: 'text' }],
  'emergency-closure': [{ key: 'sourceConfirmedClosed', label: 'Source confirms access closed', kind: 'bool' }, { key: 'dependenciesResolved', label: 'Dependencies resolved', kind: 'bool' }, { key: 'accessInventoryReference', label: 'Attested access inventory reference', kind: 'text' }],
  'emergency-review': [{ key: 'reviewCompleted', label: 'Independent review completed', kind: 'bool' }, { key: 'breakGlassReference', label: 'Break-glass disposition reference', kind: 'text' }],
  'client-access': [{ key: 'sourceConfirmedClosed', label: 'Source confirms access closed', kind: 'bool' }, { key: 'dependenciesResolved', label: 'Dependencies resolved', kind: 'bool' }],
};
const GENERIC: Spec[] = [{ key: 'note', label: 'Evidence note (optional)', kind: 'text' }];

function Receipt({ r }: { r: SeparationReceipt }) {
  return <div className="text-xs text-[var(--text-muted)]">{r.scope} · {r.actor} · {new Date(r.recordedAt).toLocaleString()} · gen {r.generation}<br />Ref: {r.reference}</div>;
}

function TaskCard({ t, caseId, version, run, busy, ktRequired }: { ktRequired: boolean; t: SeparationTask; caseId: number; version: number; run: (a: Omit<SeparationAction, 'expectedVersion'>) => void; busy: boolean }) {
  const { user } = useUser();
  const [mode, setMode] = useState<null | 'assign' | 'evidence' | 'blocked'>(null);
  const [ref, setRef] = useState('');
  const [owner, setOwner] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const [vals, setVals] = useState<Record<string, string | boolean>>({});
  const specs = TASK_SPECS[t.id] ?? GENERIC;
  const [tErr, setTErr] = useState<string | null>(null);
  const submit = () => {
    setTErr(null);
    if (mode === 'evidence' && t.id === 'access-closure' && ktRequired && !String(vals.exceptionClosedReference ?? '').trim()) return setTErr('A temporary KT exception was required: record its source-backed closure reference.');
    const base = { reference: ref.trim(), taskId: t.id };
    if (mode === 'assign') run({ ...base, action: 'assign', owner: owner.trim() });
    else if (mode === 'blocked') run({ ...base, action: 'task-blocked', uncertain });
    else if (mode === 'evidence') {
      const details: Record<string, string | boolean> = {};
      for (const s of specs) { const v = vals[s.key]; if (s.kind === 'bool') details[s.key] = v === true; else if (typeof v === 'string' && v.trim()) details[s.key] = v.trim(); }
      run({ ...base, action: 'task-evidence', provenance: 'human-source-attested', details });
    }
    setMode(null); setRef('');
  };
  const disabledSubmit = busy || !ref.trim() || (mode === 'assign' && !owner.trim());
  return (
    <div data-testid={`card-task-${t.id}`} className="rounded-md border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0"><div className="text-sm font-semibold">{t.label}</div><div className="text-xs text-[var(--text-muted)]">Activity {t.activity} · scope {t.scope} · owner {t.owner ?? 'unassigned'}{t.dueAt ? ` · due ${new Date(t.dueAt).toLocaleString()}` : ''}</div></div>
        <Pill tone={statusTone(t.status)}>{t.status}</Pill>
      </div>
      {t.blockers.length > 0 && <ul className="mt-1 list-disc pl-5 text-xs text-[var(--status-amber-fg)]">{t.blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
      {t.evidence && <div className="mt-2 rounded bg-[var(--surface-alt)] p-2"><Receipt r={t.evidence} />{Object.keys(t.details).length > 0 && <div className="mt-1 text-xs">{Object.entries(t.details).map(([k, v]) => `${k}: ${String(v)}`).join(' · ')}</div>}</div>}
      <div className="mt-2 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" data-testid={`button-assign-${t.id}`} onClick={() => setMode('assign')}>Assign owner</Button>
        <Button size="sm" variant="outline" data-testid={`button-evidence-${t.id}`} onClick={() => setMode('evidence')}>Record evidence</Button>
        <Button size="sm" variant="outline" data-testid={`button-blocked-${t.id}`} onClick={() => setMode('blocked')}>Mark blocked</Button>
      </div>
      {mode && (
        <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
          {mode === 'assign' && <Field label="Owner (named member principal id)" hint="Must have current case-edit and approval permissions. Checked by the server; assigning an owner grants no access."><Input data-testid={`input-owner-${t.id}`} value={owner} onChange={(e) => setOwner(e.target.value)} /><Button size="sm" variant="outline" disabled={!user?.id || busy} onClick={() => setOwner(user?.id ?? '')}>Use my account</Button></Field>}
          {mode === 'blocked' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={uncertain} onChange={(e) => setUncertain(e.target.checked)} /> Status is uncertain (not confirmed blocked)</label>}
          {mode === 'evidence' && (
            <div className="space-y-2">
              <p className="text-xs text-[var(--text-muted)]">Provenance: human-source-attested. Only the current assigned owner can record it, after prerequisites are verified. Unconfirmed results are not accepted.</p>
              {specs.map((s) => (
                <div key={s.key}>
                  {s.kind === 'bool' ? <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`check-${t.id}-${s.key}`} checked={vals[s.key] === true} onChange={(e) => setVals({ ...vals, [s.key]: e.target.checked })} /> {s.label}</label>
                    : s.kind === 'select' ? <Field label={s.label}><select className={selectCls} data-testid={`select-${t.id}-${s.key}`} value={String(vals[s.key] ?? '')} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })}><option value="">Choose</option>{s.options!.map((o) => <option key={o}>{o}</option>)}</select></Field>
                      : <Field label={s.label}><Input maxLength={512} data-testid={`input-${t.id}-${s.key}`} value={String(vals[s.key] ?? '')} onChange={(e) => setVals({ ...vals, [s.key]: e.target.value })} /></Field>}
                </div>
              ))}
            </div>
          )}
          {mode === 'evidence' && t.id.startsWith('emergency-') && <p className="text-xs text-[var(--text-muted)]">{t.id === 'emergency-review' ? 'Independent Legal review. The owner must differ from the emergency closure owner.' : 'Human-led IT Security closure. Nothing is executed remotely by this system.'}</p>}
          {tErr && <p role="alert" className="text-xs text-[var(--status-red-fg)]">{tErr}</p>}
          <Field label="Source-backed reference"><Input data-testid={`input-ref-${t.id}`} value={ref} maxLength={512} onChange={(e) => setRef(e.target.value)} /></Field>
          <div className="flex gap-2"><Button size="sm" data-testid={`button-submit-task-${t.id}`} disabled={disabledSubmit} onClick={submit}>Submit</Button><Button size="sm" variant="ghost" onClick={() => setMode(null)}>Cancel</Button></div>
        </div>
      )}
      <span className="hidden">{caseId}-{version}</span>
    </div>
  );
}

const ACTIONS = [
  ['screen', 'Separation Screening'], ['classify', 'Confirm classification'], ['adopt-policy', 'Adopt approved policy'], ['pause', 'Pause'],
  ['hrbp-disposition', 'HRBP disposition of pause'], ['hrbp-reconcile', 'HRBP reconcile conflict'], ['context-change', 'Context change'],
  ['emergency-security-plan', 'Emergency security plan (restricted only)'], ['sensitive-flag', 'Raise sensitive flag'], ['legal-hold', 'Legal hold'], ['settlement-version', 'Settlement version'],
] as const;

function CasePanel({ d, run, busy }: { d: SeparationDetail; run: (a: Omit<SeparationAction, 'expectedVersion'>) => Promise<boolean>; busy: boolean }) {
  const pol = useListSeparationPolicies({ query: { queryKey: ['/api/offboarding/policies', useSeparationQueryScope()], staleTime: 15_000, retry: false } as never });
  const [action, setAction] = useState<string>('screen');
  const [ref, setRef] = useState('');
  const [trig, setTrig] = useState<string[]>([]);
  const [cls, setCls] = useState('');
  const [urg, setUrg] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [flags, setFlags] = useState<Record<string, boolean | undefined>>({});
  const [policyKey, setPolicyKey] = useState('');
  const [disp, setDisp] = useState('');
  const [facts, setFacts] = useState<Record<string, string>>(() => Object.fromEntries(FACT_FIELDS.map((f) => [f.key, (d.privateFacts as unknown as Record<string, string> | undefined)?.[f.key] ?? (d.facts as unknown as Record<string, string>)[f.key] ?? ''])));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [items, setItems] = useState<Record<string, string>>({});
  const [cur, setCur] = useState('');
  const [rules, setRules] = useState('');
  const [hrbpDone, setHrbpDone] = useState(false);
  const restricted = d.status === 'restricted' || d.state.gatewayA === 'restricted';
  const [polRef, setPolRef] = useState('');
  const [bgRef, setBgRef] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const approved = (pol.data ?? []).filter((p) => p.status === 'approved');
  const needsFacts = action === 'hrbp-reconcile' || action === 'context-change';
  const submit = async () => {
    setLocal(null);
    const base = { action: action as SeparationAction['action'], reference: ref.trim() };
    let body: Omit<SeparationAction, 'expectedVersion'> = base;
    if (action === 'screen' || action === 'sensitive-flag') body = { ...base, sensitiveTriggers: trig };
    if (action === 'sensitive-flag' && !trig.length) return setLocal('Select at least one trigger.');
    if (action === 'classify') {
      if (restricted && !hrbpDone) return setLocal('On a restricted case, classification needs a fresh HRBP reconciliation reference first. Confirm it was recorded.');
      if (!cls.trim()) return setLocal('Classification text is required.');
      if (!urg) return setLocal('Choose urgency.');
      if (FLAGS.some((k) => flags[k] === undefined)) return setLocal('Answer every flag explicitly (yes or no).');
      body = { ...base, confirmed, classification: cls.trim(), urgency: urg as 'Standard', flags: flags as never };
    }
    if (action === 'emergency-security-plan') {
      if (!confirmed) return setLocal('Independent human authorization must be explicitly confirmed.');
      if (!polRef.trim() || !bgRef.trim()) return setLocal('Both references are required.');
      body = { ...base, confirmed: true, details: { policyReference: polRef.trim(), breakGlassReference: bgRef.trim() } } as never;
    }
    if (action === 'adopt-policy') { const [id, v] = policyKey.split('@'); if (!id) return setLocal('Choose an approved policy.'); body = { ...base, policyId: id, policyVersion: Number(v), ...(restricted ? { confirmed } : {}) } as never; if (restricted && !confirmed) return setLocal('Confirm human-led adoption.'); }
    if (action === 'hrbp-disposition') { if (!disp) return setLocal('Choose a disposition.'); body = { ...base, disposition: disp as 'cancel' }; }
    if (needsFacts) { const e = validateFacts(facts); setErrors(e); if (Object.keys(e).length) return; body = { ...base, facts: facts as never }; }
    if (action === 'settlement-version') {
      const nums: Record<string, number> = {};
      for (const [k, v] of Object.entries(items)) if (v.trim()) { const n = Number(v); if (!Number.isFinite(n)) return setLocal(`${k} must be a number.`); nums[k] = n; }
      if (!Object.keys(nums).length) return setLocal('Enter at least one settlement line.');
      if (!/^[A-Z]{3}$/.test(cur.trim())) return setLocal('Currency must be an uppercase ISO code.');
      if (!rules.trim()) return setLocal('Rules reference is required.');
      body = { ...base, items: nums, currency: cur.trim(), rulesReference: rules.trim() };
    }
    if (await run(body)) setRef('');
  };
  return (
    <Card className="space-y-3 p-4" data-testid="panel-case-actions">
      <h3 className="font-semibold">Case actions</h3>
      <Field label="Action"><select data-testid="select-action" className={selectCls} value={action} onChange={(e) => { setAction(e.target.value); setLocal(null); }}>{ACTIONS.filter(([v]) => v !== 'emergency-security-plan' || d.status === 'restricted').map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
      {(action === 'screen' || action === 'sensitive-flag') && (
        <fieldset className="space-y-1"><legend className="text-sm font-medium">Sensitive triggers</legend><p className="text-xs text-[var(--text-muted)]">Confirm selection; recorded findings and legal holds remain restricted. Re-screening never removes an existing trigger.</p><legend className="hidden"></legend>
          {TRIGGERS.map((t) => <label key={t} className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid={`check-trigger-${t}`} checked={trig.includes(t)} onChange={(e) => setTrig(e.target.checked ? [...trig, t] : trig.filter((x) => x !== t))} /> {t}</label>)}</fieldset>
      )}
      {action === 'classify' && (
        <div className="space-y-2">
          <Field label="Classification (human text)"><Input data-testid="input-classification" value={cls} maxLength={160} onChange={(e) => setCls(e.target.value)} /></Field>
          <Field label="Urgency"><select data-testid="select-urgency" className={selectCls} value={urg} onChange={(e) => setUrg(e.target.value)}><option value="">Choose</option>{['Standard', 'Elevated', 'High'].map((u) => <option key={u}>{u}</option>)}</select></Field>
          {FLAGS.map((k) => <Field key={k} label={k}><select data-testid={`select-flag-${k}`} className={selectCls} value={flags[k] === undefined ? '' : String(flags[k])} onChange={(e) => setFlags({ ...flags, [k]: e.target.value === '' ? undefined : e.target.value === 'true' })}><option value="">Choose</option><option value="true">Yes</option><option value="false">No</option></select></Field>)}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="check-confirmed" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm this classification is certain. Uncertain cases need HRBP disposition.</label>
        </div>
      )}
      {action === 'emergency-security-plan' && (
        <div className="space-y-2">
          <p className="text-xs text-[var(--text-muted)]">Records the human emergency basis only. No remote action is performed. Requires a named, verified IT Security authority independent of ordinary HR approvers. Creates human-led closure and independent Legal review tasks.</p>
          <Field label="Approved Security operation / break-glass policy reference"><Input data-testid="input-policy-reference" maxLength={512} value={polRef} onChange={(e) => setPolRef(e.target.value)} /></Field>
          <Field label="Independent human emergency authorization reference"><Input data-testid="input-breakglass-reference" maxLength={512} value={bgRef} onChange={(e) => setBgRef(e.target.value)} /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="check-emergency-confirmed" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Independent human authorization confirms immediate execution</label>
        </div>
      )}
      {restricted && action === 'classify' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" data-testid="check-hrbp-done" className="mt-1" checked={hrbpDone} onChange={(e) => setHrbpDone(e.target.checked)} /> A fresh HRBP reconciliation reference has been recorded for this case. The server verifies it.</label>}
      {restricted && action === 'adopt-policy' && <div className="space-y-1"><p className="text-xs font-semibold">Human-led adoption (restricted)</p><p className="text-xs text-[var(--text-muted)]">Retains Ethics and Legal reviews and generates a manual-only plan. Separation Screening stays restricted and sensitive triggers stay in place. Standard automation is never authorized.</p><label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="check-adopt-confirmed" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm human-led adoption</label></div>}
      {action === 'adopt-policy' && <Field label="Approved policy" hint={pol.isError ? 'Policies could not be loaded.' : approved.length ? 'Exact country, role, category and time zone must match; the server checks.' : 'No approved policy exists.'}><select data-testid="select-policy" className={selectCls} value={policyKey} onChange={(e) => setPolicyKey(e.target.value)}><option value="">Choose</option>{approved.map((p) => <option key={`${p.id}@${p.version}`} value={`${p.id}@${p.version}`}>{p.policy.country} / {p.policy.role} / {p.policy.workerCategory} / {p.policy.timeZone} v{p.version}</option>)}</select></Field>}
      {action === 'hrbp-disposition' && <Field label="Disposition" hint="Requires a paused case. Resume restarts review only; no access is restored."><select data-testid="select-disposition" className={selectCls} value={disp} onChange={(e) => setDisp(e.target.value)}><option value="">Choose</option><option value="cancel">Cancel separation</option><option value="convert-to-transfer">Convert to transfer review</option><option value="resume">Resume review</option></select></Field>}
      {restricted && action === 'hrbp-reconcile' && <p className="text-xs text-[var(--text-muted)]">Allowed for known restricted cases with full facts and a reference. Re-screening afterwards retains sensitive triggers. Next: re-screen, classify, assign and evidence Ethics and Legal tasks, then adopt policy.</p>}
      {needsFacts && <><p className="text-xs text-[var(--text-muted)]">Full corrected facts are required. Employee ID cannot change.{!d.privateVisible && ' Restricted fields are not shown to you; they must be supplied from the source.'}</p><FactsForm value={facts} onChange={setFacts} errors={errors} /></>}
      {action === 'settlement-version' && (
        <div className="space-y-2"><p className="text-xs text-[var(--text-muted)]">Finite source-attested values only. No formula is computed here.</p>
          <div className="grid grid-cols-2 gap-2">{ITEM_KEYS.map((k) => <Field key={k} label={k}><Input inputMode="decimal" data-testid={`input-item-${k}`} value={items[k] ?? ''} onChange={(e) => setItems({ ...items, [k]: e.target.value })} /></Field>)}</div>
          <div className="grid grid-cols-2 gap-2"><Field label="Currency (ISO)"><Input data-testid="input-currency" maxLength={3} value={cur} onChange={(e) => setCur(e.target.value.toUpperCase())} /></Field><Field label="Rules reference"><Input data-testid="input-rules-reference" value={rules} onChange={(e) => setRules(e.target.value)} /></Field></div></div>
      )}
      <Field label={action === 'pause' ? 'Pause reason / reference' : action === 'legal-hold' ? 'Hold reference' : 'Source-backed reference'}><textarea data-testid="input-action-reference" rows={2} maxLength={512} className={areaCls} value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      {local && <p role="alert" className="text-sm text-[var(--status-red-fg)]">{local}</p>}
      <Button data-testid="button-apply-action" disabled={busy || !ref.trim()} onClick={submit}>{busy ? 'Applying...' : 'Apply action'}</Button>
    </Card>
  );
}

export function SeparationDetailPage() {
  const params = useParams<{ caseId: string }>();
  const caseId = Number(params.caseId);
  const valid = Number.isSafeInteger(caseId) && caseId > 0;
  const qc = useQueryClient();
  const scope = useSeparationQueryScope();
  const q = useGetSeparationCase(caseId, { query: { enabled: valid, queryKey: [...getGetSeparationCaseQueryKey(caseId), scope], staleTime: 10_000, refetchInterval: 20_000, retry: false } as never });
  const act = useApplySeparationAction();
  const [stale, setStale] = useState(false);
  const d = q.data;
  const streams = useMemo(() => { const m = new Map<string, SeparationTask[]>(); (d?.state.tasks ?? []).forEach((t) => m.set(t.stream, [...(m.get(t.stream) ?? []), t])); return [...m.entries()]; }, [d]);
  const run = (a: Omit<SeparationAction, 'expectedVersion'>) => new Promise<boolean>((resolve) => {
    if (!d) return resolve(false);
    setStale(false);
    act.mutate({ caseId, data: { ...a, expectedVersion: d.version } }, {
      onSuccess: () => { qc.invalidateQueries({ queryKey: getGetSeparationCaseQueryKey(caseId) }); qc.invalidateQueries({ queryKey: getListSeparationCasesQueryKey() }); resolve(true); },
      onError: (e) => { setStale(/changed/i.test(String((e as Error).message))); resolve(false); },
    });
  });
  const renderStreams = (pred: (t: SeparationTask) => boolean) => !d ? null : (
              <section aria-label="Workstreams" className="space-y-3">
                {streams.length === 0 ? <div className="rounded-md border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--text-muted)]">No checklist yet. Complete Separation Screening, classification, then adopt an approved policy.</div> : streams.map(([s, all]) => { const ts = all.filter(pred); return ts.length === 0 ? null : (
                  <div key={s} className="space-y-2"><h3 className="text-sm font-semibold uppercase tracking-wide text-[var(--text-muted)]">{s} <span className="font-normal">({all.filter((t) => t.status === 'verified').length}/{all.length} verified)</span></h3>
                    {ts.map((t) => <TaskCard ktRequired={d.state.tasks.some((x) => x.id === 'kt-access-exception' && x.details.exceptionRequired === true)} key={`${t.id}-${d.generation}-${d.version}`} t={t} caseId={caseId} version={d.version} busy={act.isPending} run={(a) => { void run(a); }} />)}</div>
                ); })}
              </section>
  );
  if (!valid) return <ErrorBox error={new Error('Invalid case id.')} />;
  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <Link href={OFFBOARDING_CASES_PATH} className="inline-flex min-h-10 items-center gap-1 text-sm text-[var(--primary)]"><ArrowLeft className="h-4 w-4" /> Back to Cases</Link>
      {q.isLoading ? <SkeletonRows n={5} /> : q.isError ? <ErrorBox error={q.error} onRetry={() => q.refetch()} /> : d && (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-sm font-semibold">Case {caseListReference(d)}</p>
              <h1 className="break-words text-2xl font-semibold" data-testid="text-worker-name">{d.facts.workerName}</h1>
              <p className="text-sm text-[var(--text-muted)]">Offboarding · {!d.fictionalOfflineIdentity && <>{d.facts.employeeId} · </>}{d.facts.role} · {d.facts.country} · LWD {d.facts.lastWorkingDay} ({d.facts.timeZone}) · v{d.version} gen {d.generation}</p></div>
            <div className="flex flex-wrap gap-2"><Pill tone={statusTone(d.status)}>{d.status}</Pill><Pill tone={statusTone(d.state.gatewayA)}>Separation Screening {d.state.gatewayA}</Pill>{d.state.conflict && <Pill tone="red">source conflict</Pill>}</div>
          </header>
          <ClosureWarning />
          <div className="flex flex-wrap gap-2 text-xs"><Pill>Final Closure {d.gatewayC}</Pill><Pill>Activity 12 {d.activity12}</Pill>{!d.fictionalOfflineIdentity && <Pill tone="blue">manual, source-backed, no remote actions</Pill>}</div>
          {d.state.pauseReason && <div role="status" data-testid="banner-pause" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-sm text-[var(--status-amber-fg)]">Paused for HRBP review: {d.state.pauseReason}. Use the HRBP disposition action to cancel, convert to transfer, or resume.</div>}
          {d.state.holds.length > 0 && <div role="status" className="rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-sm text-[var(--status-red-fg)]">Holds: {d.state.holds.join('; ')}. Deletion and archival are prohibited.</div>}
          {stale && <div role="alert" className="flex items-center justify-between gap-2 rounded-md bg-[var(--status-amber-bg)] p-3 text-sm text-[var(--status-amber-fg)]">The case changed since you loaded it. <Button size="sm" variant="outline" onClick={() => q.refetch()}>Reload</Button></div>}
          {act.isError && !stale && <ErrorBox error={act.error} />}
          <section aria-label="Action required" data-testid="block-action-required" className="rounded-[var(--radius-lg)] border-2 border-[var(--primary)] bg-[var(--surface)] p-4 shadow-[var(--shadow-md)]">
            <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--primary)]">Action required</p>
            <h2 className="mb-1 text-lg font-bold">{d.state.pauseReason ? 'Paused: record the HRBP disposition' : d.status === 'restricted' ? 'Restricted case: human-led handling only' : 'Record the next case action'}</h2>
            <p className="mb-3 text-sm text-[var(--text-muted)]">{streams.length === 0 ? 'No checklist yet. Complete Separation Screening, classification, then adopt an approved policy.' : `${d.state.tasks.filter((t) => t.status !== 'verified').length} of ${d.state.tasks.length} tasks still need evidence. Task actions are under Activities and workstreams.`}</p>
            {!d.privateVisible && <p className="mb-3 text-xs text-[var(--text-muted)]" data-testid="text-privacy-explainer">Restricted sources, receipts, decisions and history are hidden. Viewing them requires current verified HR, Legal, Payroll and Occupational Health authorities (all four) and all-sensitive field grants (not one or the other). Nothing here weakens that check.</p>}
            <CasePanel key={`${scope}-${d.privateVisible}-${d.version}-${d.generation}`} d={d} run={run} busy={act.isPending} />
            {d.state.tasks.some((t) => t.status !== 'verified') && <div className="mt-4 space-y-2"><h3 className="font-semibold">Tasks needing action</h3>{renderStreams((t) => t.status !== 'verified')}</div>}
            {d.privateVisible && d.fictionalOfflineIdentity === true && <div className="mt-4"><ExchangePanel caseId={caseId} /></div>}
          </section>
          <Disclosure title="Original intake request" summary="The request that originated this case">
            {d.originalIntent ? <OriginalIntent c={d} /> : <p className="text-sm text-[var(--text-muted)]">No original intake request is recorded for this case.</p>}
          </Disclosure>
          <Disclosure title="Verified activities and workstreams" summary="Completed tasks and their evidence receipts">
            {d.state.tasks.some((t) => t.status === 'verified') ? renderStreams((t) => t.status === 'verified') : <p className="text-sm text-[var(--text-muted)]">No tasks are verified yet.</p>}
          </Disclosure>
          <Disclosure title="Facts, decisions, settlement and history" summary="Case facts, receipts, revisions, evidence sources">
          <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
            <div className="space-y-5">
              <Card className="space-y-2 p-4"><h2 className="font-semibold">Facts and classification</h2>
                <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                  {Object.entries(d.facts).filter(([k]) => !d.fictionalOfflineIdentity || k !== 'employeeId').map(([k, v]) => <div key={k} className="flex min-w-0 gap-2"><dt className="text-[var(--text-muted)]">{k}</dt><dd className="min-w-0 break-words">{String(v)}</dd></div>)}
                  {d.privateVisible && d.privateFacts ? <><div className="flex gap-2"><dt className="text-[var(--text-muted)]">exitType</dt><dd>{d.privateFacts.exitType}</dd></div><div className="flex gap-2 sm:col-span-2"><dt className="text-[var(--text-muted)]">exitReason</dt><dd>{d.privateFacts.exitReason}</dd></div></> : <div className="text-xs text-[var(--text-muted)] sm:col-span-2">Exit type and reason are restricted to verified HR and Legal readers.</div>}
                </dl>
                <div className="flex flex-wrap gap-2 pt-2 text-xs">
                  <Pill>Urgency {d.state.urgency ?? 'unset'}</Pill><Pill>Class {d.state.classification ?? 'unset'}</Pill>
                  {d.state.flags && Object.entries(d.state.flags).filter(([, v]) => v).map(([k]) => <Pill key={k} tone="amber">{k}</Pill>)}
                  {d.state.sensitiveTriggers.map((t) => <Pill key={t} tone="red">{t}</Pill>)}
                  <Pill tone={d.state.policyId ? (d.state.policyCurrent ? 'green' : 'red') : 'muted'}>{d.state.policyId ? `Policy ${d.state.policyId} v${d.state.policyVersion}${d.state.policyCurrent ? '' : ' (not current)'}` : 'No policy adopted'}</Pill>
                </div>
              </Card>
              <Card className="space-y-2 p-4"><h2 className="font-semibold">Decisions</h2>
                {d.state.decisions.length === 0 ? <p className="text-sm text-[var(--text-muted)]">{d.privateVisible ? 'No decisions recorded.' : 'Decision history is restricted.'}</p> : d.state.decisions.map((r, i) => <div key={i} className="border-b border-[var(--border)] pb-2 last:border-0"><Receipt r={r} /></div>)}</Card>
              <Card className="space-y-2 p-4"><h2 className="font-semibold">Settlement versions</h2>
                {d.state.settlementVersions.length === 0 ? <p className="text-sm text-[var(--text-muted)]">None recorded.</p> : d.state.settlementVersions.map((s, i) => <pre key={i} className="overflow-x-auto rounded bg-[var(--surface-alt)] p-2 text-xs">{JSON.stringify({ revision: s.revision, currency: s.currency, items: s.items, rulesReference: s.rulesReference }, null, 1)}</pre>)}</Card>
              {d.state.restrictedManual && <div role="status" data-testid="banner-restricted-manual" className="rounded-md border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-3 text-sm text-[var(--status-amber-fg)]">Restricted manual plan: human-led tasks only. Separation Screening remains restricted; no standard automation is authorized.</div>}
              <Card className="space-y-2 p-4" data-testid="panel-settlement-review"><h2 className="font-semibold">Settlement review (numeric)</h2>
                {d.settlementReview.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No numeric settlement versions visible. Requires current Payroll authority.</p> : d.settlementReview.map((r) => <div key={r.revision} className="rounded bg-[var(--surface-alt)] p-2 text-xs"><div className="mb-1 flex flex-wrap gap-2"><b>Revision {r.revision}</b><span>{r.currency}</span><span>{new Date(r.recordedAt).toLocaleString()}</span><Pill tone={r.authorityCurrent ? 'green' : 'red'}>{r.authorityCurrent ? 'authority current' : 'authority not current'}</Pill></div>{Object.entries(r.items).map(([k, v]) => <span key={k} className="mr-3">{k}: {String(v)}</span>)}</div>)}</Card>
              <Card className="space-y-2 p-4" data-testid="panel-history"><h2 className="font-semibold">Revision history (private)</h2>
                {!d.privateVisible ? <p className="text-sm text-[var(--text-muted)]">History is private and not available to you.</p> : d.history.length === 0 ? <p className="text-sm text-[var(--text-muted)]">No revisions recorded.</p> : d.history.map((h) => <details key={`${h.version}-${h.action}`} className="rounded border border-[var(--border)] p-2 text-xs"><summary className="cursor-pointer">v{h.version} gen {h.generation} · {h.status} · {h.action} · {h.actor} · {new Date(h.recordedAt).toLocaleString()}</summary><div className="mt-2 grid gap-2 md:grid-cols-2"><div><b>Source facts</b><pre className="overflow-x-auto rounded bg-[var(--surface-alt)] p-2">{JSON.stringify(h.facts, null, 1)}</pre></div><div><b>State</b><pre className="max-h-64 overflow-auto rounded bg-[var(--surface-alt)] p-2">{JSON.stringify(h.state, null, 1)}</pre></div></div></details>)}</Card>
              <Card className="space-y-2 p-4"><h2 className="font-semibold">Evidence sources</h2>
                {!d.privateVisible ? <p className="text-sm text-[var(--text-muted)]">Source narratives are visible only to verified HR and Legal readers.</p> : d.sources.map((s, i) => <div key={i} className="text-xs"><b>{s.channel}</b> · {s.sourceReference} · {s.actor} · <span className="text-[var(--text-muted)]">{s.provenance}</span></div>)}</Card>
            </div>
            <aside className="space-y-4"><Card className="p-4 text-xs text-[var(--text-muted)]">Final Closure and Activity 12 are unavailable. No override exists.</Card></aside>
          </div>
          </Disclosure>
          <Disclosure title="Flow" summary="Read-only stages, tasks, blockers and recorded history" testId="disclosure-flow">
            <CaseFlowPanel caseId={caseId} />
          </Disclosure>
        </>
      )}
    </div>
  );
}
