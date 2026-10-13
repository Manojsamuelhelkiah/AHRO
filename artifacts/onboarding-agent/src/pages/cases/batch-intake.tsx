import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'wouter';
import { useUser } from '@clerk/react';
import { AlertTriangle, Check, Download, Upload, X } from 'lucide-react';
import { getListOnboardingCasesQueryKey } from '@workspace/api-client-react';
import type { HroBatchResult, HroBatchTemplate, HroBatchValidation } from '@workspace/api-client-react';
import { Button, Input, Label } from '@/components/ui-shared';
import { useOrganizationRole } from '@/hooks/use-organization-role';
import { useClientOperationsSettings } from '../settings-client-operations';
import { ManualBatchIntakeForm } from './manual-batch-intake';
import {
  MAX_ROWS, MAX_UPLOAD_BYTES, createHroBatch, downloadHroBatchTemplate, hroBatchHistoryKey, hroBatchTemplatesKey,
  issuesToCsv, listHroBatchHistory, listHroBatchTemplates, saveBlob, validateHroBatchFile, hroBatchErrorMessage,
} from '@/lib/hro-batch-intake-api';

const select = 'h-9 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 text-sm outline-none focus:border-[var(--primary)]';

export function BatchIntakeForm({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();
  const { user } = useUser();
  const org = useOrganizationRole();
  const scope = user?.id && org.organizationId ? `${user.id}:${org.organizationId}` : '';
  const [mode, setMode] = useState<'upload' | 'manual'>('upload');
  const [family, setFamily] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [consent, setConsent] = useState(false);
  const [validation, setValidation] = useState<HroBatchValidation | null>(null);
  const [result, setResult] = useState<HroBatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'validate' | 'commit' | null>(null);
  const epoch = useRef(0);
  const lock = useRef(false);
  const abort = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [settledScope, setSettledScope] = useState(scope);

  const templates = useQuery({ queryKey: hroBatchTemplatesKey(scope), queryFn: ({ signal }) => listHroBatchTemplates({ signal }), enabled: !!scope });
  const ops = useClientOperationsSettings(org.organizationId ?? null);
  const familySetting = ops.data?.configuration.families.find((f) => f.family === family);
  const opsReady = ops.isSuccess && !!ops.data;
  const paused = !!family && opsReady && familySetting?.batchEnabled === false;
  const intakeBlocked = !opsReady || paused;
  const chooseFamily = (f: string) => {
    resetWork(); setFamily(f);
    const def = ops.data?.configuration.families.find((x) => x.family === f)?.defaultTemplateId ?? '';
    setTemplateId((templates.data ?? []).some((t) => t.family === f && t.id === def) ? def : '');
  };
  const history = useQuery({ queryKey: hroBatchHistoryKey(scope), queryFn: ({ signal }) => listHroBatchHistory({ signal }), enabled: !!scope && org.isHR });

  const resetWork = (clearInput = true) => {
    epoch.current += 1; abort.current?.abort(); lock.current = false;
    setFile(null); setValidation(null); setResult(null); setConsent(false); setError(null); setBusy(null);
    if (clearInput && fileInput.current) fileInput.current.value = '';
  };
  useEffect(() => { resetWork(); setFamily(''); setTemplateId(''); setName(''); setSettledScope(scope); return () => abort.current?.abort(); }, [scope]);

  const families = useMemo(() => Array.from(new Set((templates.data ?? []).map((t) => t.family))), [templates.data]);
  const options = (templates.data ?? []).filter((t) => t.family === family);
  const template: HroBatchTemplate | undefined = options.find((t) => t.id === templateId);

  const download = async (format: 'csv' | 'xlsx') => {
    if (!template) return;
    try { saveBlob(await downloadHroBatchTemplate(template.id, format), `${template.id}-v${template.version}.${format}`); }
    catch (e) { setError(hroBatchErrorMessage(e, 'The template could not be downloaded.')); }
  };
  const pick = (f: File | null) => {
    resetWork(false);
    if (f && f.size > MAX_UPLOAD_BYTES) { setError('File exceeds the 2 MB limit.'); setFile(null); return; }
    setFile(f);
  };
  const validate = async () => {
    if (!org.isHR || intakeBlocked || !file || !template || lock.current) return;
    lock.current = true; const mine = ++epoch.current; abort.current?.abort(); abort.current = new AbortController();
    setBusy('validate'); setError(null); setValidation(null); setConsent(false);
    try {
      const v = await validateHroBatchFile(file, template, abort.current.signal);
      if (mine !== epoch.current) return;
      if (v.rows.length > MAX_ROWS) setError(`Limit is ${MAX_ROWS} rows.`);
      setValidation(v);
    } catch (e) { if (mine === epoch.current) setError(hroBatchErrorMessage(e, 'The file could not be validated.')); }
    finally { if (mine === epoch.current) { lock.current = false; setBusy(null); } }
  };
  const commit = async () => {
    if (!org.isHR || intakeBlocked || !validation?.valid || !template || !consent || !name.trim() || lock.current) return;
    lock.current = true; const mine = ++epoch.current; abort.current?.abort(); abort.current = new AbortController();
    setBusy('commit'); setError(null);
    try {
      const r = await createHroBatch({ templateId: template.id, templateVersion: template.version, name: name.trim(), rows: validation.rows }, abort.current.signal);
      if (mine !== epoch.current) return;
      setResult(r); setValidation(null); setFile(null); setConsent(false);
      if (fileInput.current) fileInput.current.value = '';
      queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
      queryClient.invalidateQueries({ queryKey: hroBatchHistoryKey(scope) });
    } catch (e) { if (mine === epoch.current) setError(hroBatchErrorMessage(e, 'The cases could not be created.')); }
    finally { if (mine === epoch.current) { lock.current = false; setBusy(null); } }
  };
  const errorCsv = () => validation && saveBlob(new Blob([issuesToCsv(validation.issues)], { type: 'text/csv' }), 'validation-errors.csv');

  const cols = template?.columns ?? [];
  const specialist = template && template.family !== 'onboarding' && !template.hireType;

  if (settledScope !== scope) return <div role="status" className="p-4 text-sm text-[var(--text-muted)]">Loading the current organization’s batch intake…</div>;
  return (
    <div className="mb-6 max-w-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-md">
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] bg-[var(--surface-alt)] p-[var(--space-lg)]">
        <div className="min-w-0"><h3 className="text-sm font-semibold text-[var(--text-primary)]">Batch intake</h3>
          <p className="mt-1 text-xs text-[var(--text-muted)]">Upload a template file to create held review cases. Nothing starts automatically; uploaded files are parsed and not retained.</p></div>
        <Button variant="ghost" size="sm" onClick={onClose} data-testid="button-close-batch"><X className="h-4 w-4" /></Button>
      </div>
      <div className="flex gap-2 border-b border-[var(--border)] p-3">
        <Button size="sm" variant={mode === 'upload' ? 'default' : 'outline'} onClick={() => { resetWork(); setMode('upload'); }} data-testid="button-mode-upload">Template upload</Button>
        <Button size="sm" disabled={!org.isHR} variant={mode === 'manual' ? 'default' : 'outline'} onClick={() => { resetWork(); setMode('manual'); }} data-testid="button-mode-manual">Manual entry</Button>
      </div>
      {mode === 'manual' ? <div className="p-3"><ManualBatchIntakeForm key={scope} onClose={onClose} /></div> : (
      <div className="space-y-4 p-[var(--space-lg)]">
        {!scope && <p role="status" className="text-xs text-[var(--text-muted)]">{org.loading ? 'Loading your session and organization...' : 'Select an active organization to browse templates. If membership could not be loaded, refresh this page.'}</p>}
        {scope && !org.isHR && <p role="status" className="rounded border border-[var(--border)] p-3 text-xs text-[var(--text-secondary)]">You can browse and download blank templates. Uploading and creating cases requires an organization owner/admin with approved case-flow, profile and notes edit permissions and applicable collection policies.</p>}
        {scope && ops.isLoading && <p role="status" className="text-xs text-[var(--text-muted)]">Checking client batch settings...</p>}
        {scope && ops.isError && <p role="alert" className="text-xs text-[var(--status-red)]">Client operations settings are unavailable, so validation and creation are disabled. Template downloads still work. <button className="underline" onClick={() => ops.refetch()}>Retry</button></p>}
        {paused && <p role="status" data-testid="text-family-paused" className="rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]">Batch intake is paused for the {family} family in client settings. New batch imports are disabled; templates remain downloadable. Individual and email case creation are unaffected.</p>}
        {templates.isError && <p role="alert" className="text-xs text-[var(--status-red)]">{hroBatchErrorMessage(templates.error, 'Could not load templates.')} <button className="underline" onClick={() => templates.refetch()}>Retry</button></p>}
        {templates.isLoading && <div className="h-9 animate-pulse rounded bg-[var(--surface-alt)]" />}
        {scope && templates.isSuccess && families.length === 0 && <p role="status" className="text-xs text-[var(--text-muted)]">No batch templates are available. <button className="underline" onClick={() => templates.refetch()}>Reload templates</button></p>}
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div><Label>Case family</Label>
             <select className={select} data-testid="select-family" value={family} disabled={!scope || templates.isPending || templates.isError || families.length === 0} onChange={(e) => chooseFamily(e.target.value)}>
               <option value="">{!scope || templates.isPending ? 'Loading families…' : templates.isError ? 'Templates unavailable — retry above' : families.length === 0 ? 'No families available' : 'Choose a family'}</option>{families.map((f) => <option key={f} value={f}>{f}{ops.data?.configuration.families.find((x) => x.family === f)?.batchEnabled === false ? ' (batch paused)' : ''}</option>)}</select></div>
          <div><Label>Template</Label>
             <select className={select} data-testid="select-template" value={templateId} disabled={!family || templates.isPending || templates.isError} onChange={(e) => { resetWork(); setTemplateId(e.target.value); }}>
              <option value="">Choose a template</option>{options.map((t) => <option key={t.id} value={t.id}>{t.name} (v{t.version})</option>)}</select></div>
        </div>
        {template && <>
          <p className="text-xs text-[var(--text-secondary)]" data-testid="text-template-description">{template.description}</p>
          {specialist && <p className="rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Creates specialist-review requests only. Nothing is executed or authorized automatically.</p>}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => download('xlsx')} data-testid="button-download-xlsx"><Download className="mr-1 h-4 w-4" />Excel</Button>
            <Button size="sm" variant="outline" onClick={() => download('csv')} data-testid="button-download-csv"><Download className="mr-1 h-4 w-4" />CSV</Button>
          </div>
          <div className="max-h-56 overflow-auto rounded border border-[var(--border)]">
            <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-[var(--surface-alt)]"><tr><th className="p-2">Field</th><th className="p-2">Required</th><th className="p-2">Instructions</th></tr></thead>
              <tbody>{cols.map((c) => <tr key={c.key} className="border-t border-[var(--border)] align-top"><td className="p-2 font-medium">{c.label}</td><td className="p-2">{c.required ? 'Yes' : 'No'}</td><td className="p-2">{c.description}{c.values?.length ? ` Allowed: ${c.values.join(', ')}.` : ''}</td></tr>)}</tbody></table>
          </div>
          <div><Label>Filled file (CSV or Excel, up to 2 MB and {MAX_ROWS} rows)</Label>
             <input ref={fileInput} type="file" disabled={!org.isHR} accept=".csv,.xlsx" data-testid="input-file" className="mt-1 block w-full text-xs" onChange={(e) => pick(e.target.files?.[0] ?? null)} /></div>
           <Button onClick={validate} disabled={!org.isHR || intakeBlocked || !file || busy !== null} data-testid="button-validate"><Upload className="mr-1 h-4 w-4" />{busy === 'validate' ? 'Validating...' : 'Validate file'}</Button>
        </>}
        {error && <p role="alert" data-testid="text-error" className="text-xs text-[var(--status-red)]">{error}</p>}
        {validation && template && (
          <div className="space-y-3" data-testid="section-preview">
            {validation.issues.length > 0 ? (
              <div className="rounded border border-[var(--status-red)]/30 p-3 text-xs">
                <p className="font-semibold text-[var(--status-red)]">{validation.issues.length} issue(s) found. Fix the file and validate again.</p>
                <ul className="mt-2 max-h-40 space-y-1 overflow-auto">{validation.issues.slice(0, 100).map((i, n) => <li key={n}>Row {i.row}, {i.column}: {i.message}</li>)}</ul>
                <Button size="sm" variant="outline" className="mt-2" onClick={errorCsv} data-testid="button-download-errors"><Download className="mr-1 h-4 w-4" />Download error CSV</Button>
              </div>) : <p className="text-xs text-[var(--status-green-fg)]"><Check className="mr-1 inline h-4 w-4" />{validation.rows.length} valid row(s).</p>}
            <div className="max-h-64 overflow-auto rounded border border-[var(--border)]">
              <table className="w-full text-left text-xs"><thead className="sticky top-0 bg-[var(--surface-alt)]"><tr><th className="p-2">#</th>{cols.map((c) => <th key={c.key} className="whitespace-nowrap p-2">{c.label}</th>)}</tr></thead>
                <tbody>{validation.rows.slice(0, 50).map((r, n) => <tr key={n} className="border-t border-[var(--border)]"><td className="p-2">{n + 1}</td>{cols.map((c) => <td key={c.key} className="whitespace-nowrap p-2">{r[c.key]}</td>)}</tr>)}</tbody></table>
            </div>
            {validation.rows.length > 50 && <p className="text-xs text-[var(--text-muted)]">Showing the first 50 rows.</p>}
            {validation.valid && validation.rows.length <= MAX_ROWS && (
              <div className="space-y-3 border-t border-[var(--border)] pt-3">
                <div className="max-w-md"><Label>Batch name</Label><Input className="mt-1" value={name} onChange={(e) => setName(e.target.value)} data-testid="input-batch-name" /></div>
                <label className="flex items-start gap-2 text-xs"><input type="checkbox" className="mt-0.5" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="checkbox-consent" />
                  <span>I confirm I am authorized to submit this personal data and that it should create {validation.rows.length} held review case(s). Duplicates are reconciled, not recreated.</span></label>
                 <Button onClick={commit} disabled={!org.isHR || intakeBlocked || !consent || !name.trim() || busy !== null} data-testid="button-confirm-create">{busy === 'commit' ? 'Creating held cases...' : 'Create held cases'}</Button>
              </div>)}
          </div>)}
        {result && (
          <div className="rounded border border-[var(--status-green)]/30 bg-[var(--status-green-bg)] p-3 text-xs text-[var(--status-green-fg)]" data-testid="section-result">
            <p className="font-semibold"><Check className="mr-1 inline h-4 w-4" />{result.retry ? 'Retry reconciled; no duplicates created.' : `Batch ${result.name} created.`}</p>
            <ul className="mt-2 space-y-1">{result.results.map((r) => <li key={r.personKey} className="flex flex-wrap gap-2"><span className="uppercase">{r.status}</span><Link className="underline" href={`/cases/${r.caseId}`}>Case #{r.caseId}</Link></li>)}</ul>
          </div>)}
        <div className="border-t border-[var(--border)] pt-3" data-testid="section-history">
          <h4 className="text-xs font-semibold text-[var(--text-primary)]">Import history</h4>
          {history.isLoading && <div className="mt-2 h-8 animate-pulse rounded bg-[var(--surface-alt)]" />}
          {!org.isHR && <p className="mt-2 text-xs text-[var(--text-muted)]">Import history requires authorized owner/admin case access.</p>}
          {history.isError && <p className="mt-2 text-xs text-[var(--status-red)]">{hroBatchErrorMessage(history.error, 'Could not load history.')} <button className="underline" onClick={() => history.refetch()}>Retry</button></p>}
          {history.data?.length === 0 && <p className="mt-2 text-xs text-[var(--text-muted)]">No imports yet.</p>}
          <ul className="mt-2 space-y-2">{history.data?.map((h) => (
            <li key={h.batchId} className="rounded border border-[var(--border)] p-2 text-xs" data-testid={`row-history-${h.batchId}`}>
              <div className="flex flex-wrap justify-between gap-2"><strong className="break-words">{h.name}</strong><span className="text-[var(--text-muted)]">{new Date(h.createdAt).toLocaleString()}</span></div>
              <div className="text-[var(--text-muted)]">{h.family} / {h.templateId} / {h.count} case(s)</div>
              <div className="mt-1 flex flex-wrap gap-2">{h.caseIds.slice(0, 20).map((id) => <Link key={id} className="underline" href={`/cases/${id}`}>#{id}</Link>)}{h.caseIds.length > 20 && <span>+{h.caseIds.length - 20} more</span>}</div>
            </li>))}</ul>
        </div>
      </div>)}
    </div>
  );
}
