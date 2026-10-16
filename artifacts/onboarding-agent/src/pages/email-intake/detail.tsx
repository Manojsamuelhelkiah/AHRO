import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetHroEmailIntake, useGetHroEmailRequest, useReviewHroEmailRequest, useConvertHroEmailRequest,
  useGetHroEmailPrivateSource, useRetryHroEmailExtraction,
  getGetHroEmailIntakeQueryKey, getGetHroEmailRequestQueryKey, getListHroEmailRequestsQueryKey,
} from '@workspace/api-client-react';
import type { HroEmailRequest, HroEmailTemplate, HroEmailExtractionResult } from '@workspace/api-client-react';
import { Card, Button, PageHeader } from '@/components/ui-shared';
import { ArrowLeft, Lock } from 'lucide-react';
import { ErrorNote, Pill, Skeleton, fmtDate, inputCls, statusTone, useEmailScope, emailAccessRefresh, useClearDeniedEmailData } from './common';

const CONTROL = ['template_id', 'template_version', 'request_id'];

function Editor({ request, templates, canReview, headers, scope, reload }: { request: HroEmailRequest; templates: HroEmailTemplate[]; canReview: boolean; headers: Record<string, string>; scope: string; reload: () => Promise<HroEmailRequest | undefined> }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState(request);
  const [templateId, setTemplateId] = useState(request.templateId ?? '');
  const [fields, setFields] = useState<Record<string, string>>({ ...request.fields });
  const [dirty, setDirty] = useState(false);
  const [savedHere, setSavedHere] = useState(false);
  const [ackFiles, setAckFiles] = useState(false);
  const [ackDup, setAckDup] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const [preview, setPreview] = useState<HroEmailExtractionResult | null>(null);
  const [reloading, setReloading] = useState(false);
  const extraction = useRetryHroEmailExtraction({ request: { headers } });
  const review = useReviewHroEmailRequest({ request: { headers } });
  const convert = useConvertHroEmailRequest({ request: { headers } });
  const source = useGetHroEmailPrivateSource(current.id, { query: { queryKey: ['hro-email-private-source', scope, current.id], enabled: canReview,
    retry: false, refetchOnWindowFocus: emailAccessRefresh, refetchOnMount: emailAccessRefresh }, request: { headers } });

  const tpl = templates.find((t) => t.template.id === templateId)?.template;
  const allowed = useMemo(() => [...new Set([...CONTROL, ...(tpl?.columns.map((c) => c.key) ?? [])])], [tpl]);
  const closed = current.status === 'converted' || current.status === 'rejected';
  const busy = extraction.isPending || review.isPending || convert.isPending || reloading;
  const readOnly = !canReview || closed || busy;

  // A refreshed query must replace a clean local snapshot, but must never
  // silently rebase unsaved edits onto somebody else's revision.
  useEffect(() => {
    if (dirty || busy || request.version < current.version || request === current) return;
    setCurrent(request);
    setFields({ ...request.fields });
    setTemplateId(request.templateId ?? '');
    if (request.version !== current.version) {
      setSavedHere(false); setPreview(null); setAckFiles(false); setAckDup(false);
    } else {
      if (request.potentialDuplicates !== current.potentialDuplicates) setAckDup(false);
      if (JSON.stringify(request.attachments) !== JSON.stringify(current.attachments)) setAckFiles(false);
    }
  }, [request, current, dirty, busy]);
  const newerSavedVersion = request.version > current.version;
  const reloadLatest = async () => {
    if (busy) return;
    if (dirty && !window.confirm('Reloading will discard your unsaved field changes. Load the latest saved request?')) return;
    setReloading(true);
    try {
      const latest = await reload();
      if (!latest) return;
      setCurrent(latest); setFields({ ...latest.fields }); setTemplateId(latest.templateId ?? '');
      setDirty(false); setSavedHere(false); setPreview(null); setAckFiles(false); setAckDup(false);
      extraction.reset(); review.reset(); convert.reset();
    } finally { setReloading(false); }
  };
  const missing = useMemo(() => tpl ? tpl.columns.filter((c) => c.required && !(fields[c.key] ?? '').trim()).map((c) => c.key) : current.missingFields, [tpl, fields, current.missingFields]);
  const ctlMissing = tpl ? CONTROL.filter((k) => !(fields[k] ?? '').trim()) : [];

  const pickTemplate = (id: string) => {
    setTemplateId(id);
    const t = templates.find((x) => x.template.id === id)?.template;
    setFields((f) => ({ ...Object.fromEntries(Object.entries(f).filter(([key]) => t?.columns.some(c => c.key === key))), template_id: id, template_version: t ? String(t.version) : '', request_id: f.request_id || current.id }));
    setDirty(true);
  };
  const setField = (k: string, v: string) => { setFields((f) => ({ ...f, [k]: v })); setDirty(true); };
  const touchSaved = (r: HroEmailRequest) => {
    setPreview(null);
    setCurrent(r); setFields({ ...r.fields }); setTemplateId(r.templateId ?? templateId); setDirty(false);
    qc.setQueryData([...getGetHroEmailRequestQueryKey(r.id), scope], r);
    qc.invalidateQueries({ queryKey: getListHroEmailRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() });
  };
  const save = () => {
    const out: Record<string, string> = {};
    for (const k of allowed) if ((fields[k] ?? '') !== '') out[k] = fields[k];
    review.mutate({ requestId: current.id, data: { expectedVersion: current.version, action: 'save', ...(templateId ? { templateId } : {}), fields: out } }, { onSuccess: (r) => { setSavedHere(true); touchSaved(r); } });
  };
  const reject = () => review.mutate({ requestId: current.id, data: { expectedVersion: current.version, action: 'reject' } }, { onSuccess: (r) => { setConfirmReject(false); touchSaved(r); } });
  const retryExtraction = () => {
    setPreview(null);
    extraction.mutate({ requestId: current.id, data: { expectedVersion: current.version, action: 'preview' } }, { onSuccess: setPreview });
  };
  const adoptExtraction = () => {
    if (!preview) return;
    // Unsaved changes, including explicit clears, stay in the draft after adoption.
    const edits = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== (current.fields[k] ?? '')));
    extraction.mutate({ requestId: current.id, data: { expectedVersion: current.version, action: 'apply', previewDigest: preview.previewDigest } }, {
      onSuccess: result => {
        if (!result.request) return;
        touchSaved(result.request); setSavedHere(false);
        if (Object.keys(edits).length) { setFields(f => ({ ...f, ...edits })); setDirty(true); }
      },
    });
  };

  const hasAttach = current.attachments.length > 0;
  const dup = current.potentialDuplicates > 0;
  const reviewerSaved = savedHere || current.reviewed === true;
  const canConvert = canReview && !readOnly && !dirty && !newerSavedVersion && current.missingFields.length === 0 && reviewerSaved && (!hasAttach || ackFiles) && (!dup || ackDup);
  const doConvert = () => convert.mutate({ requestId: current.id, data: { expectedVersion: current.version, attachmentsAcknowledged: ackFiles, duplicateAcknowledged: ackDup } }, {
    onSuccess: (r) => touchSaved(r),
    // Refresh evidence and duplicate counts after a rejected attempt, but never
    // repeat conversion or silently acknowledge newly discovered requirements.
    onError: () => { void reload(); },
  });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Card className="space-y-3 p-4" data-testid="section-classification">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">Classification</h2><Pill tone={statusTone(current.status)}>{current.status}</Pill><span className="text-xs text-[var(--text-muted)]">Version {current.version}</span>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void reloadLatest()} data-testid="button-reload-email-request">Reload latest</Button>
          </div>
          {newerSavedVersion && <p role="status" className="text-sm text-[var(--status-amber-fg)]">A newer saved version is available. Your unsaved fields have been kept. Reload latest before saving or converting.</p>}
          {current.reason && <p className="rounded-md bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]">{current.reason}</p>}
          <div className="space-y-1"><label htmlFor="tpl-select" className="text-xs font-medium">Template (family: {current.family ?? 'unclassified'})</label>
            <select id="tpl-select" data-testid="select-template" disabled={readOnly} className={inputCls} value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Select a template</option>
              {templates.map(({ template: t }) => <option key={`${t.id}`} value={t.id}>{t.name} - {t.family} v{t.version}</option>)}
            </select></div>
          <p className="text-xs text-[var(--text-muted)]">Source: {current.sourceUrl ? 'linked mailbox message (content is not shown here)' : 'mailbox'}. Received {fmtDate(current.receivedAt)}.</p>
        </Card>

        {canReview && !closed && <Card className="space-y-3 p-4" data-testid="section-extraction">
          <h2 className="text-base font-semibold">Retry source extraction</h2>
          <p className="text-xs text-[var(--text-muted)]">Read the exact original mailbox message again. Preview does not change saved fields. Adoption preserves reviewer-authored fields and unsaved edits, clears prior review, and never creates a case.</p>
          <Button variant="secondary" data-testid="button-preview-extraction" disabled={busy} onClick={retryExtraction}>{extraction.isPending ? 'Checking source...' : 'Preview extraction'}</Button>
          {extraction.isError && <ErrorNote error={extraction.error} />}
          {preview && <div className="space-y-2" data-testid="extraction-preview">
            <p className="break-words text-sm">Proposed template: {preview.templateId ?? 'unclassified'}</p>
            <p className="text-xs">Protected reviewer fields: {preview.preservedFields.join(', ') || 'none'}. Unsaved draft edits also remain.</p>
            <dl className="grid gap-2 sm:grid-cols-2">{Object.entries(preview.fields).map(([k, v]) => <div key={k} className="min-w-0 rounded border border-[var(--border)] p-2 text-xs"><dt className="break-words font-medium">{k}</dt><dd className="break-words">{v}</dd><dd className="text-[var(--text-muted)]">{preview.metadata.provenance?.[k]?.join(', ')}</dd></div>)}</dl>
            {preview.metadata.issues?.map((issue, i) => <p key={i} className="break-words text-xs text-[var(--status-amber-fg)]">{issue.field}: {issue.message}</p>)}
            {dirty && templateId !== (current.templateId ?? '') && <p role="status" className="text-xs">Save your changed classification before adopting source suggestions.</p>}
            <div className="flex flex-wrap gap-2"><Button data-testid="button-adopt-extraction" disabled={busy || (dirty && templateId !== (current.templateId ?? ''))} onClick={adoptExtraction}>Adopt suggestions, not review</Button><Button variant="ghost" disabled={busy} onClick={() => setPreview(null)}>Dismiss preview</Button></div>
          </div>}
        </Card>}

        <Card className="space-y-3 p-4" data-testid="section-fields">
          <h2 className="text-base font-semibold">Allowed fields</h2>
          {!tpl ? <p className="rounded-md bg-[var(--surface-alt)] p-4 text-sm text-[var(--text-muted)]">Select a template to see the fields that can be recorded.</p> : (
            <div className="grid gap-3 sm:grid-cols-2">
              {tpl.columns.map((c) => {
                const id = `f-${c.key}`; const val = fields[c.key] ?? '';
                const src = current.fieldSources[c.key];
                const isMissing = c.required && !val.trim();
                const problems = current.extraction?.issues?.filter(i => i.field === c.key) ?? [];
                return (
                  <div key={c.key} className="space-y-1">
                    <label htmlFor={id} className="flex flex-wrap items-center gap-1.5 text-xs font-medium">{c.label}{c.required && <span className="text-[var(--status-red-fg)]" aria-label="required">*</span>}{src && <Pill tone={src === 'email' ? 'blue' : 'green'}>{src}</Pill>}</label>
                    {c.kind === 'choice' && c.values?.length ? (
                      <select id={id} disabled={readOnly} className={inputCls} value={val} aria-invalid={isMissing || problems.length > 0} aria-describedby={`${id}-d`} onChange={(e) => setField(c.key, e.target.value)}><option value="">Not set</option>{c.values.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                    ) : (
                      <input id={id} data-testid={`input-field-${c.key}`} disabled={readOnly} className={inputCls} type={c.kind === 'date' ? 'date' : c.kind === 'email' ? 'email' : 'text'} value={val} onChange={(e) => setField(c.key, e.target.value)} aria-invalid={isMissing} aria-describedby={`${id}-d`} />
                    )}
                    <p id={`${id}-d`} className={`text-[11px] ${isMissing || problems.length ? 'text-[var(--status-amber-fg)]' : 'text-[var(--text-muted)]'}`}>{problems.length ? `Source extraction needs review: ${problems.map(p => p.message).join(' ')} ` : isMissing ? 'Not supplied in the source or draft. ' : ''}{c.description}{c.values?.length ? ` Allowed: ${c.values.join(', ')}.` : ''}</p>
                  </div>);
              })}
            </div>)}
          <p className="text-xs text-[var(--text-muted)]">Only template fields and the binding fields template_id, template_version and request_id are accepted. Incomplete drafts can be saved.</p>
          {canReview && !closed && (
            <div className="flex flex-wrap gap-2">
              <Button data-testid="button-save-review" disabled={readOnly || review.isPending || !tpl} onClick={save}>{review.isPending ? 'Saving...' : 'Save review'}</Button>
              <Button variant="destructive" data-testid="button-reject-request" disabled={busy} onClick={() => setConfirmReject(true)}>Reject request</Button>
            </div>)}
          {confirmReject && (
            <div role="alertdialog" aria-label="Confirm rejection" className="space-y-2 rounded-md border border-[var(--status-red)] bg-[var(--status-red-bg)] p-3 text-sm">
              <p>Reject this request? No case will be created.</p>
              <div className="flex gap-2"><Button size="sm" variant="destructive" data-testid="button-confirm-reject" disabled={review.isPending} onClick={reject}>Confirm rejection</Button><Button size="sm" variant="ghost" onClick={() => setConfirmReject(false)}>Keep request</Button></div>
            </div>)}
          {review.isError && <ErrorNote error={review.error} />}
          {!canReview && <p role="status" className="text-xs">View only: you lack the review permission.</p>}
        </Card>
      </div>

      <div className="space-y-5">
        <Card className="space-y-2 p-4">
          <h2 className="text-base font-semibold">Confidential source history</h2>
          <p className="text-xs text-[var(--text-muted)]">Untrusted mail is not approved evidence. Private source content is available only under current client access, collection policy and a clean malware scan.</p>
          {!source.isError && source.data?.state === 'clean' ? <div className="space-y-2 text-sm"><p className="break-words">{source.data.subject}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border)] p-2 text-xs">{source.data.body}</pre></div> :
            <p role="status" className="text-sm">Private source unavailable or quarantined ({source.data?.state ?? 'checking'}). Use approved secure collection for sensitive facts.</p>}
          {source.isError && <ErrorNote error={source.error} />}
        </Card>
        <Card className="space-y-2 p-4" data-testid="section-missing">
          <h2 className="text-base font-semibold">Missing fields and source problems</h2>
          {missing.length === 0 && ctlMissing.length === 0 ? <p className="text-sm text-[var(--status-green-fg)]">No required fields are missing{dirty ? ' in this draft' : ''}.</p>
            : <ul className="list-disc space-y-0.5 pl-5 text-sm">{[...new Set([...ctlMissing, ...missing])].map((m) => <li key={m} className="break-words text-xs">{m}: {current.extraction?.issues?.some(i => i.field === m) ? 'source value needs correction; see field guidance' : 'no usable value supplied'}</li>)}</ul>}
          {current.extraction?.issues?.filter(i => i.field === 'table' || i.field === 'template_id').map((issue, i) => <p key={i} role="status" className="text-xs text-[var(--status-amber-fg)]">{issue.message}</p>)}
          <p className="text-xs text-[var(--text-muted)]">Extraction suggests source values only. It does not verify identity, employment, evidence or authority.</p>
        </Card>

        <Card className="space-y-2 p-4" data-testid="section-attachments">
          <div className="flex items-center gap-2"><Lock className="h-4 w-4" /><h2 className="text-base font-semibold">Attachments (quarantined)</h2></div>
          <p className="text-xs text-[var(--text-muted)]">Attachments are held in quarantine and are not imported. Acknowledging them is not evidence approval.</p>
          {hasAttach ? <ul className="divide-y divide-[var(--border)] text-sm">{current.attachments.map((a, i) => <li key={i} className="flex items-center justify-between gap-2 py-1.5"><span className="truncate">{a.name}</span><Pill tone="amber">{a.status}</Pill></li>)}</ul> : <p className="text-sm text-[var(--text-muted)]">No attachments.</p>}
        </Card>

        <Card className="space-y-3 p-4" data-testid="section-convert">
          <h2 className="text-base font-semibold">Convert to case</h2>
          {current.status === 'converted' ? (
            <div data-testid="text-case-result" className="space-y-1 text-sm"><Pill tone="green">converted</Pill>
              {current.caseId != null && <p>Case {current.caseId}{current.caseKind ? ` (${current.caseKind})` : ''}: <Link className="font-medium text-[var(--primary)] underline" href={current.caseKind === 'separation' ? `/cases/separations/${current.caseId}` : `/cases/${current.caseId}`}>Open case</Link></p>}</div>
          ) : current.status === 'rejected' ? <p className="text-sm">This request was rejected.</p> : (
            <>
              <p className="text-xs text-[var(--text-muted)]">Complete mail still needs a reviewer save first. Conversion is checked against version {current.version}.</p>
              {hasAttach && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" data-testid="checkbox-ack-attachments" checked={ackFiles} onChange={(e) => setAckFiles(e.target.checked)} disabled={readOnly} />I acknowledge the attachments stay quarantined and are not imported.</label>}
              {dup && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" data-testid="checkbox-ack-duplicate" checked={ackDup} onChange={(e) => setAckDup(e.target.checked)} disabled={readOnly} />I reviewed {current.potentialDuplicates} possible duplicate request(s) and still want to convert.</label>}
              <Button data-testid="button-convert" disabled={!canConvert || convert.isPending} onClick={doConvert}>{convert.isPending ? 'Converting...' : 'Convert to case'}</Button>
              {!canConvert && canReview && <p className="text-xs text-[var(--text-muted)]">{dirty ? 'Save your changes first.' : current.missingFields.length ? 'Required fields are still missing.' : !reviewerSaved ? 'Save the review before converting.' : 'Complete the acknowledgements above.'}</p>}
              {convert.isError && <ErrorNote error={convert.error} />}
            </>)}
        </Card>
      </div>
    </div>
  );
}

export function EmailRequestDetailPage() {
  const { requestId = '' } = useParams<{ requestId: string }>();
  const { scope, headers, org } = useEmailScope();
  const intake = useGetHroEmailIntake({ request: { headers }, query: { queryKey: [...getGetHroEmailIntakeQueryKey(), scope], enabled: Boolean(org), retry: false,
    refetchInterval: q => emailAccessRefresh(q) ? 60_000 : false, refetchOnWindowFocus: emailAccessRefresh, refetchOnMount: emailAccessRefresh } });
  useClearDeniedEmailData(intake.error, intake.isSuccess && intake.data?.canReview === false);
  const canReview = !intake.isError && intake.data?.canReview === true;
  const req = useGetHroEmailRequest(requestId, { request: { headers }, query: { queryKey: [...getGetHroEmailRequestQueryKey(requestId), scope], enabled: Boolean(org) && canReview, retry: false,
    refetchInterval: q => emailAccessRefresh(q) ? 30_000 : false,
    refetchOnWindowFocus: emailAccessRefresh, refetchOnMount: emailAccessRefresh } });
  const reload = async () => {
    await intake.refetch();
    const result = await req.refetch();
    return result.isError ? undefined : result.data;
  };
  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-12">
      <Link href="/email-intake" className="inline-flex items-center gap-1 text-sm text-[var(--primary)]" data-testid="link-back-email-intake"><ArrowLeft className="h-4 w-4" />Email intake</Link>
      <PageHeader title="Review email request" subtitle="Confidential client request. Original content is available only under current private-access and scan safeguards." />
      {intake.isLoading || (canReview && req.isLoading) ? <Skeleton n={4} />
        : intake.isError ? <ErrorNote error={intake.error} onRetry={() => intake.refetch()} />
        : !canReview ? <p role="alert" className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 text-sm" data-testid="text-no-review">You do not have permission to review client email requests.</p>
        : req.isError ? <ErrorNote error={req.error} onRetry={() => req.refetch()} />
        : req.data ? <Editor key={`${scope}:${req.data.id}`} request={req.data} templates={intake.data?.templates ?? []} canReview={canReview} headers={headers} scope={scope} reload={reload} /> : null}
    </div>
  );
}
