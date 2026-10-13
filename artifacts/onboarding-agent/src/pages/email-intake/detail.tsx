import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'wouter';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetHroEmailIntake, useGetHroEmailRequest, useReviewHroEmailRequest, useConvertHroEmailRequest,
  useGetHroEmailPrivateSource,
  getGetHroEmailIntakeQueryKey, getGetHroEmailRequestQueryKey, getListHroEmailRequestsQueryKey,
} from '@workspace/api-client-react';
import type { HroEmailRequest, HroEmailTemplate } from '@workspace/api-client-react';
import { Card, Button, PageHeader } from '@/components/ui-shared';
import { ArrowLeft, Lock } from 'lucide-react';
import { ErrorNote, Pill, Skeleton, fmtDate, inputCls, statusTone, useEmailScope } from './common';

const CONTROL = ['template_id', 'template_version', 'request_id'];

function Editor({ request, templates, canReview, headers, scope }: { request: HroEmailRequest; templates: HroEmailTemplate[]; canReview: boolean; headers: Record<string, string>; scope: string }) {
  const qc = useQueryClient();
  const [current, setCurrent] = useState(request);
  const [templateId, setTemplateId] = useState(request.templateId ?? '');
  const [fields, setFields] = useState<Record<string, string>>({ ...request.fields });
  const [dirty, setDirty] = useState(false);
  const [savedHere, setSavedHere] = useState(false);
  const [ackFiles, setAckFiles] = useState(false);
  const [ackDup, setAckDup] = useState(false);
  const [confirmReject, setConfirmReject] = useState(false);
  const review = useReviewHroEmailRequest({ request: { headers } });
  const convert = useConvertHroEmailRequest({ request: { headers } });
  const source = useGetHroEmailPrivateSource(current.id, { query: { queryKey: ['hro-email-private-source', scope, current.id], enabled: canReview }, request: { headers } });

  const tpl = templates.find((t) => t.template.id === templateId)?.template;
  const allowed = useMemo(() => [...new Set([...CONTROL, ...(tpl?.columns.map((c) => c.key) ?? [])])], [tpl]);
  const closed = current.status === 'converted' || current.status === 'rejected';
  const readOnly = !canReview || closed;

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
    setCurrent(r); setFields({ ...r.fields }); setTemplateId(r.templateId ?? templateId); setDirty(false);
    qc.setQueryData(getGetHroEmailRequestQueryKey(r.id), r);
    qc.invalidateQueries({ queryKey: getListHroEmailRequestsQueryKey() });
    qc.invalidateQueries({ queryKey: getGetHroEmailIntakeQueryKey() });
  };
  const save = () => {
    const out: Record<string, string> = {};
    for (const k of allowed) if ((fields[k] ?? '') !== '') out[k] = fields[k];
    review.mutate({ requestId: current.id, data: { expectedVersion: current.version, action: 'save', ...(templateId ? { templateId } : {}), fields: out } }, { onSuccess: (r) => { setSavedHere(true); touchSaved(r); } });
  };
  const reject = () => review.mutate({ requestId: current.id, data: { expectedVersion: current.version, action: 'reject' } }, { onSuccess: (r) => { setConfirmReject(false); touchSaved(r); } });

  const hasAttach = current.attachments.length > 0;
  const dup = current.potentialDuplicates > 0;
  const reviewerSaved = savedHere || current.reviewed === true;
  const canConvert = canReview && !readOnly && !dirty && current.missingFields.length === 0 && reviewerSaved && (!hasAttach || ackFiles) && (!dup || ackDup);
  const doConvert = () => convert.mutate({ requestId: current.id, data: { expectedVersion: current.version, attachmentsAcknowledged: ackFiles, duplicateAcknowledged: ackDup } }, { onSuccess: (r) => touchSaved(r) });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="space-y-5">
        <Card className="space-y-3 p-4" data-testid="section-classification">
          <div className="flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">Classification</h2><Pill tone={statusTone(current.status)}>{current.status}</Pill><span className="text-xs text-[var(--text-muted)]">Version {current.version}</span></div>
          {current.reason && <p className="rounded-md bg-[var(--status-amber-bg)] p-2 text-xs text-[var(--status-amber-fg)]">{current.reason}</p>}
          <div className="space-y-1"><label htmlFor="tpl-select" className="text-xs font-medium">Template (family: {current.family ?? 'unclassified'})</label>
            <select id="tpl-select" data-testid="select-template" disabled={readOnly} className={inputCls} value={templateId} onChange={(e) => pickTemplate(e.target.value)}>
              <option value="">Select a template</option>
              {templates.map(({ template: t }) => <option key={`${t.id}`} value={t.id}>{t.name} - {t.family} v{t.version}</option>)}
            </select></div>
          <p className="text-xs text-[var(--text-muted)]">Source: {current.sourceUrl ? 'linked mailbox message (content is not shown here)' : 'mailbox'}. Received {fmtDate(current.receivedAt)}.</p>
        </Card>

        <Card className="space-y-3 p-4" data-testid="section-fields">
          <h2 className="text-base font-semibold">Allowed fields</h2>
          {!tpl ? <p className="rounded-md bg-[var(--surface-alt)] p-4 text-sm text-[var(--text-muted)]">Select a template to see the fields that can be recorded.</p> : (
            <div className="grid gap-3 sm:grid-cols-2">
              {[...CONTROL.map((k) => ({ key: k, label: k, required: true, kind: 'text' as const, description: 'Binding field' , values: undefined as string[] | undefined })), ...tpl.columns].map((c) => {
                const id = `f-${c.key}`; const val = fields[c.key] ?? '';
                const src = current.fieldSources[c.key];
                const isMissing = c.required && !val.trim();
                return (
                  <div key={c.key} className="space-y-1">
                    <label htmlFor={id} className="flex flex-wrap items-center gap-1.5 text-xs font-medium">{c.label}{c.required && <span className="text-[var(--status-red-fg)]" aria-label="required">*</span>}{src && <Pill tone={src === 'email' ? 'blue' : 'green'}>{src}</Pill>}</label>
                    {c.kind === 'choice' && c.values?.length ? (
                      <select id={id} disabled={readOnly} className={inputCls} value={val} onChange={(e) => setField(c.key, e.target.value)}><option value="">Not set</option>{c.values.map((v) => <option key={v} value={v}>{v}</option>)}</select>
                    ) : (
                      <input id={id} data-testid={`input-field-${c.key}`} disabled={readOnly} className={inputCls} type={c.kind === 'date' ? 'date' : c.kind === 'email' ? 'email' : 'text'} value={val} onChange={(e) => setField(c.key, e.target.value)} aria-invalid={isMissing} aria-describedby={`${id}-d`} />
                    )}
                    <p id={`${id}-d`} className={`text-[11px] ${isMissing ? 'text-[var(--status-amber-fg)]' : 'text-[var(--text-muted)]'}`}>{isMissing ? 'Missing. ' : ''}{c.description}</p>
                  </div>);
              })}
            </div>)}
          <p className="text-xs text-[var(--text-muted)]">Only template fields and the binding fields template_id, template_version and request_id are accepted. Incomplete drafts can be saved.</p>
          {canReview && !closed && (
            <div className="flex flex-wrap gap-2">
              <Button data-testid="button-save-review" disabled={readOnly || review.isPending || !tpl} onClick={save}>{review.isPending ? 'Saving...' : 'Save review'}</Button>
              <Button variant="destructive" data-testid="button-reject-request" disabled={review.isPending} onClick={() => setConfirmReject(true)}>Reject request</Button>
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
          {source.data?.state === 'clean' ? <div className="space-y-2 text-sm"><p className="break-words">{source.data.subject}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded border border-[var(--border)] p-2 text-xs">{source.data.body}</pre></div> :
            <p role="status" className="text-sm">Private source unavailable or quarantined ({source.data?.state ?? 'checking'}). Use approved secure collection for sensitive facts.</p>}
          {source.isError && <ErrorNote error={source.error} />}
        </Card>
        <Card className="space-y-2 p-4" data-testid="section-missing">
          <h2 className="text-base font-semibold">Missing fields</h2>
          {missing.length === 0 && ctlMissing.length === 0 ? <p className="text-sm text-[var(--status-green-fg)]">No required fields are missing{dirty ? ' in this draft' : ''}.</p>
            : <ul className="list-disc space-y-0.5 pl-5 text-sm">{[...ctlMissing, ...missing].map((m) => <li key={m} className="font-mono text-xs">{m}</li>)}</ul>}
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
  const intake = useGetHroEmailIntake({ request: { headers }, query: { queryKey: [...getGetHroEmailIntakeQueryKey(), scope], enabled: Boolean(org), retry: false } });
  const canReview = intake.data?.canReview === true;
  const req = useGetHroEmailRequest(requestId, { request: { headers }, query: { queryKey: [...getGetHroEmailRequestQueryKey(requestId), scope], enabled: Boolean(org) && canReview, retry: false } });
  const [resetKey, setResetKey] = useState(scope);
  useEffect(() => { setResetKey(scope); }, [scope]);
  return (
    <div className="mx-auto max-w-7xl space-y-5 pb-12">
      <Link href="/email-intake" className="inline-flex items-center gap-1 text-sm text-[var(--primary)]" data-testid="link-back-email-intake"><ArrowLeft className="h-4 w-4" />Email intake</Link>
      <PageHeader title="Review email request" subtitle="Confidential client request. Original content is available only under current private-access and scan safeguards." />
      {intake.isLoading || (canReview && req.isLoading) ? <Skeleton n={4} />
        : intake.isError ? <ErrorNote error={intake.error} onRetry={() => intake.refetch()} />
        : !canReview ? <p role="alert" className="rounded-md border border-[var(--border)] bg-[var(--surface)] p-4 text-sm" data-testid="text-no-review">You do not have permission to review client email requests.</p>
        : req.isError ? <ErrorNote error={req.error} onRetry={() => req.refetch()} />
        : req.data ? <Editor key={`${resetKey}:${req.data.id}`} request={req.data} templates={intake.data?.templates ?? []} canReview={canReview} headers={headers} scope={scope} /> : null}
    </div>
  );
}
