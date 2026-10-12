import { useSeparationQueryScope } from './shared';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useCreateSeparationBatch, useGetSeparationMailbox, useConfigureSeparationMailbox, useListSeparationMailboxRequests,
  useConvertSeparationMailboxRequest, getGetSeparationMailboxQueryKey, getListSeparationMailboxRequestsQueryKey, getListSeparationCasesQueryKey,
} from '@workspace/api-client-react';
import type { SeparationIntake, SeparationMailboxRequest } from '@workspace/api-client-react';
import { Card, Input, PageHeader, Button } from '@/components/ui-shared';
import { Link } from 'wouter';
import { Download } from 'lucide-react';
import { ClosureWarning, ErrorBox, FACT_FIELDS, FactsForm, Field, Pill, SkeletonRows, SubNav, areaCls, emptyFacts, statusTone, validateFacts } from './shared';

const TEMPLATE = { entries: [{ sourceReference: 'TICKET-1001', facts: Object.fromEntries(FACT_FIELDS.map((f) => [f.key, f.type === 'date' ? '2025-01-31' : f.key === 'country' ? 'IN' : f.key === 'timeZone' ? 'Asia/Kolkata' : `<${f.label}>`])) }] };

function validateBatch(text: string): { entries?: SeparationIntake[]; issues: string[] } {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return { issues: ['The file is not valid JSON.'] }; }
  const list = (j as { entries?: unknown })?.entries;
  if (!Array.isArray(list)) return { issues: ['Expected an object with an "entries" array. Download the template.'] };
  if (list.length < 1 || list.length > 500) return { issues: ['Provide 1 to 500 entries.'] };
  const issues: string[] = [];
  const ids = new Set<string>(), refs = new Set<string>();
  list.forEach((e: { sourceReference?: unknown; facts?: Record<string, unknown> }, i) => {
    const n = i + 1;
    if (typeof e?.sourceReference !== 'string' || !e.sourceReference.trim()) issues.push(`Entry ${n}: sourceReference is required.`);
    else if (refs.has(e.sourceReference)) issues.push(`Entry ${n}: duplicate sourceReference.`); else refs.add(e.sourceReference);
    const f = (e?.facts ?? {}) as Record<string, unknown>;
    const extra = Object.keys(f).filter((k) => !FACT_FIELDS.some((x) => x.key === k));
    if (extra.length) issues.push(`Entry ${n}: unexpected field ${extra.join(', ')}.`);
    const strs = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === 'string' ? v : '']));
    for (const [k, m] of Object.entries(validateFacts(strs))) issues.push(`Entry ${n}: ${k} - ${m}.`);
    const id = String(f.employeeId ?? '').normalize('NFKC').toUpperCase();
    if (id && ids.has(id)) issues.push(`Entry ${n}: employee ${id} repeated in this file.`); else ids.add(id);
  });
  return issues.length ? { issues: issues.slice(0, 40) } : { entries: list as SeparationIntake[], issues: [] };
}

function BatchPanel() {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [v, setV] = useState<ReturnType<typeof validateBatch> | null>(null);
  const batch = useCreateSeparationBatch();
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(TEMPLATE, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'separation-batch-template.json'; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-lg font-semibold">Batch upload (JSON)</h2>
      <p className="text-sm text-[var(--text-muted)]">Up to 500 entries, each with a unique sourceReference and all 13 facts. Entries are validated here and again by the server. Your authority applies per entry; a failure rolls back the batch.</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="gap-2" data-testid="button-download-template" onClick={download}><Download className="h-4 w-4" /> Download template</Button>
        <label className="inline-flex min-h-9 cursor-pointer items-center rounded-md border border-[var(--border)] px-3 text-sm font-medium">
          Choose file
          <input data-testid="input-batch-file" type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; const t = await f.text(); setText(t); setV(validateBatch(t)); batch.reset(); }} />
        </label>
      </div>
      <textarea aria-label="Batch JSON" data-testid="input-batch-json" rows={8} className={`${areaCls} font-mono text-xs`} value={text} onChange={(e) => { setText(e.target.value); setV(null); }} placeholder='{"entries": [...]}' />
      <div className="flex gap-2">
        <Button variant="outline" data-testid="button-validate-batch" disabled={!text.trim()} onClick={() => setV(validateBatch(text))}>Validate</Button>
        <Button data-testid="button-submit-batch" disabled={!v?.entries || batch.isPending} onClick={() => v?.entries && batch.mutate({ data: { entries: v.entries } }, { onSuccess: () => qc.invalidateQueries({ queryKey: getListSeparationCasesQueryKey() }) })}>{batch.isPending ? 'Submitting...' : 'Submit batch'}</Button>
      </div>
      {v?.issues.length ? <ul role="alert" className="list-disc space-y-0.5 rounded-md bg-[var(--status-red-bg)] p-3 pl-6 text-xs text-[var(--status-red-fg)]">{v.issues.map((i) => <li key={i}>{i}</li>)}</ul> : v?.entries ? <p className="text-sm text-[var(--status-green-fg)]">{v.entries.length} entries valid.</p> : null}
      {batch.isError && <ErrorBox error={batch.error} />}
      {batch.data && (
        <div data-testid="text-batch-result" className="space-y-1 text-sm">
          {batch.data.map((r, i) => <div key={i} className="flex items-center gap-2"><Link className="text-[var(--primary)] underline" href={`/cases/separations/${r.caseId}`}>Case {r.caseId}</Link><Pill tone={r.conflict ? 'amber' : 'green'}>{r.conflict ? 'conflict held' : r.status}</Pill></div>)}
        </div>
      )}
    </Card>
  );
}

function Convert({ r, onDone }: { r: SeparationMailboxRequest; onDone: () => void }) {
  const qc = useQueryClient();
  const [facts, setFacts] = useState<Record<string, string>>({ ...(emptyFacts() as unknown as Record<string, string>), ...r.fields });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const conv = useConvertSeparationMailboxRequest();
  const [ackFiles, setAckFiles] = useState(false);
  const hasFiles = r.attachments.length > 0;
  return (
    <div className="space-y-3 rounded-md border border-[var(--border)] p-3">
      <p className="text-xs text-[var(--text-muted)]">Mailbox content is unverified and is not an HRIS feed. Review every value, then confirm as an authenticated human.</p>
      <FactsForm value={facts} onChange={setFacts} errors={errors} />
      {hasFiles && <label className="flex items-start gap-2 rounded-md bg-[var(--status-amber-bg)] p-2 text-sm text-[var(--status-amber-fg)]"><input type="checkbox" data-testid={`check-attachments-${r.id}`} className="mt-1" checked={ackFiles} onChange={(e) => setAckFiles(e.target.checked)} /> I reviewed the attachment metadata ({r.attachments.length}). Files stay quarantined at the provider and are not imported.</label>}
      {conv.isError && <ErrorBox error={conv.error} />}
      <div className="flex gap-2">
        <Button size="sm" data-testid={`button-convert-${r.id}`} disabled={conv.isPending || (hasFiles && !ackFiles)} onClick={() => {
          const e = validateFacts(facts); setErrors(e); if (Object.keys(e).length) return;
          conv.mutate({ requestId: r.id, data: { ...(hasFiles ? { attachmentsReviewed: true } : {}), facts: Object.fromEntries(Object.entries(facts).map(([k, v]) => [k, v.trim()])) as never } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getListSeparationMailboxRequestsQueryKey() }); qc.invalidateQueries({ queryKey: getListSeparationCasesQueryKey() }); onDone(); } });
        }}>{conv.isPending ? 'Converting...' : 'Convert to separation'}</Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Close</Button>
      </div>
    </div>
  );
}

function MailboxPanel() {
  const qc = useQueryClient();
  const scope = useSeparationQueryScope();
  const box = useGetSeparationMailbox({ query: { queryKey: [...getGetSeparationMailboxQueryKey(), scope], staleTime: 30_000, retry: false } as never });
  const reqs = useListSeparationMailboxRequests({ query: { queryKey: [...getListSeparationMailboxRequestsQueryKey(), scope], staleTime: 15_000, refetchInterval: 30_000, retry: false } as never });
  const cfg = useConfigureSeparationMailbox();
  const [senders, setSenders] = useState('');
  const [ref, setRef] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const list = senders.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = list.filter((s) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s));
  const save = () => cfg.mutate({ data: { allowedSenders: list, reference: ref.trim() } }, { onSuccess: () => { qc.invalidateQueries({ queryKey: getGetSeparationMailboxQueryKey() }); setRef(''); } });
  const rd = box.data;
  return (
    <Card className="space-y-4 p-5">
      <h2 className="text-lg font-semibold">Mailbox intake</h2>
      <p className="text-sm text-[var(--text-muted)]">Uses the existing Gmail consumer. Messages need the subject token <code className="font-mono">[HRO-INTAKE:&lt;48 hex&gt;]</code>, an allowed sender, and <code className="font-mono">field:value</code> lines in the body. Attachments are quarantined at the provider and never imported.</p>
      <section aria-label="Readiness" className="space-y-2">
        <h3 className="text-sm font-semibold">Readiness</h3>
        {box.isLoading ? <SkeletonRows n={2} /> : box.isError ? <ErrorBox error={box.error} onRetry={() => box.refetch()} /> : rd && (
          <div className="space-y-2 text-sm" data-testid="panel-mailbox-readiness">
            <div className="flex flex-wrap gap-2"><Pill tone="amber">{rd.provenance}</Pill><Pill>{rd.attachmentPolicy}</Pill></div>
            <div className="grid gap-2 sm:grid-cols-2">
              {([['Channel', rd.channel], ['Monitor', rd.monitor]] as const).map(([t, o]) => (
                <div key={t} className="rounded-md bg-[var(--surface-alt)] p-2 text-xs"><div className="mb-1 font-semibold">{t}</div>
                  {Object.entries(o).map(([k, val]) => <div key={k} className="flex justify-between gap-2"><span className="text-[var(--text-muted)]">{k}</span><span className="break-all text-right">{typeof val === 'object' ? JSON.stringify(val) : String(val)}</span></div>)}
                </div>))}
            </div>
            {rd.configurations.length === 0 ? <p className="text-[var(--text-muted)]">No intake configuration yet. Save allowed senders to issue a token.</p> : rd.configurations.map((c) => (
              <div key={c.id} className="rounded-md border border-[var(--border)] p-2 text-xs"><div className="flex items-center gap-2"><Pill tone={c.enabled ? 'green' : 'red'}>{c.enabled ? 'enabled' : 'disabled'}</Pill><code className="break-all font-mono" data-testid="text-intake-token">[HRO-INTAKE:{c.token}]</code></div><div className="mt-1 text-[var(--text-muted)]">Allowed: {c.allowedSenders.join(', ') || 'none'}</div></div>
            ))}
          </div>
        )}
      </section>
      <section aria-label="Configure" className="space-y-2 border-t border-[var(--border)] pt-3">
        <h3 className="text-sm font-semibold">Configure allowed senders</h3>
        <Field label="Allowed senders" hint="Email addresses separated by comma or space." error={bad.length ? `Invalid: ${bad.join(', ')}` : undefined}><textarea data-testid="input-allowed-senders" rows={2} className={areaCls} value={senders} onChange={(e) => setSenders(e.target.value)} /></Field>
        <Field label="Authority reference" hint="Source-backed approval for this change."><Input data-testid="input-mailbox-reference" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        {cfg.isError && <ErrorBox error={cfg.error} />}
        <Button data-testid="button-save-mailbox" disabled={cfg.isPending || !list.length || bad.length > 0 || !ref.trim()} onClick={save}>{cfg.isPending ? 'Saving...' : 'Save configuration'}</Button>
      </section>
      <section aria-label="Requests" className="space-y-2 border-t border-[var(--border)] pt-3">
        <h3 className="text-sm font-semibold">Review queue</h3>
        {reqs.isLoading ? <SkeletonRows n={3} /> : reqs.isError ? <ErrorBox error={reqs.error} onRetry={() => reqs.refetch()} /> : !reqs.data?.length ? <p className="rounded-md border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-muted)]">No mailbox requests.</p> : reqs.data.map((r) => (
          <div key={r.id} data-testid={`row-mailbox-request-${r.id}`} className="space-y-2 rounded-md border border-[var(--border)] p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-medium">{r.sender}</span><div className="flex gap-2"><Pill tone={statusTone(r.status)}>{r.status}</Pill>{r.attachments.length > 0 && <Pill tone="amber">{r.attachments.length} quarantined</Pill>}</div></div>
            {r.missingFields.length > 0 && <p className="text-xs text-[var(--status-amber-fg)]">Missing: {r.missingFields.join(', ')}</p>}
            {r.status === 'collection-review-required' && <p className="text-xs text-[var(--text-muted)]">Employee content was not imported because jurisdiction collection approval is missing. Review the private provider mailbox and enter complete facts only after approval.</p>}
            {r.caseId ? <Link className="text-[var(--primary)] underline" href={`/cases/separations/${r.caseId}`}>Case {r.caseId}</Link> : open === r.id ? <Convert r={r} onDone={() => setOpen(null)} /> : <Button size="sm" variant="outline" data-testid={`button-review-${r.id}`} onClick={() => setOpen(r.id)}>Review and convert</Button>}
          </div>
        ))}
      </section>
    </Card>
  );
}

export function SeparationIntakePage() {
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader title="Separation intake" subtitle="Batch upload, mailbox review and readiness." />
      <SubNav active="intake" />
      <ClosureWarning />
      <div className="grid gap-5 lg:grid-cols-2"><BatchPanel /><MailboxPanel /></div>
    </div>
  );
}
