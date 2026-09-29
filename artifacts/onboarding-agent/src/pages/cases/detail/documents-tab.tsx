import React, { useState } from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Clock, FileText, FileCheck2, Loader2, FileSearch, HardHat, ShieldCheck, ShieldAlert, ShieldX, FileMinus, Bell, Info, LockKeyhole, RotateCcw } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, Button, cn } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useListOnboardingCaseEvidence, 
  getListOnboardingCaseEvidenceQueryKey,
  useDecideOnboardingEvidence,
  useRetryOnboardingEvidenceMalwareScan,
  useGetOnboardingCaseBgv,
  getGetOnboardingCaseBgvQueryKey,
  getListOnboardingCaseDocumentsQueryKey,
  getListOnboardingCaseEventsQueryKey,
   getGetOnboardingCaseQueryKey,
   useRecoverOnboardingCaseDocuments,
} from '@workspace/api-client-react';
import { RestrictedActionNotice, useCaseAccess } from './case-access';

const KNOWN_DOCUMENT_CLASS: Record<string, { category: string; classification: 'identity' | 'payroll' }> = {
  'id-proof': { category: 'identity', classification: 'identity' },
  'address-proof': { category: 'identity', classification: 'identity' },
  'education-certs': { category: 'identity', classification: 'identity' },
  'prior-employment': { category: 'identity', classification: 'identity' },
  'pan-card': { category: 'statutory', classification: 'payroll' },
  'uan-epf': { category: 'statutory', classification: 'payroll' },
  'tax-form': { category: 'statutory', classification: 'payroll' },
  'bank-details': { category: 'statutory', classification: 'payroll' },
  'work-authorization': { category: 'statutory', classification: 'identity' },
  'signed-sow': { category: 'contract', classification: 'identity' },
  'signed-offer': { category: 'contract', classification: 'identity' },
  'nda-coc': { category: 'policy', classification: 'identity' },
  'policy-ack': { category: 'policy', classification: 'identity' },
};

export function DocumentsTab({ caseId, docs }: { caseId: number, docs: any[] }) {
  const access = useCaseAccess();
  const canReadAnySensitive = Boolean(access && Object.values(access.sensitive).some((permission) => permission.read));
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const recoverDocuments = useRecoverOnboardingCaseDocuments();
  const { data: evidenceList, isLoading: evidenceLoading } = useListOnboardingCaseEvidence(caseId, {
    query: {
      enabled: !!caseId && canReadAnySensitive,
      queryKey: getListOnboardingCaseEvidenceQueryKey(caseId),
      refetchInterval: 4_000,
    }
  });

  const { data: bgvList, isLoading: bgvLoading } = useGetOnboardingCaseBgv(caseId, {
    query: {
      enabled: !!caseId && access?.sensitive.bgv.read === true,
      queryKey: getGetOnboardingCaseBgvQueryKey(caseId),
      refetchInterval: 10_000,
    }
  });

  return (
    <div className="pb-12 max-w-4xl space-y-6">
      
      {/* Background Verification (BGV) Section */}
      {access?.sensitive.bgv.read ? <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-[var(--primary)]" /> 
            Background Verification (BGV)
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4">
          {bgvLoading ? (
            <div className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--text-muted)] py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading BGV status...
            </div>
          ) : bgvList && bgvList.length > 0 ? (
            <div className="space-y-4">
              {bgvList.map((bgv: any) => (
                <BgvItem key={bgv.id} bgv={bgv} />
              ))}
            </div>
          ) : (
            <p className="text-[var(--text-sm)] text-[var(--text-muted)] italic">No background verification records for this case.</p>
          )}
        </CardContent>
      </Card> : <RestrictedActionNotice>Background-verification details are restricted by your current permissions.</RestrictedActionNotice>}

      {/* Document Checklist & Evidence Section */}
      <Card>
        <CardHeader className="pb-3 border-b">
          <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
            <FileText className="w-4 h-4 text-[var(--primary)]" /> 
            Document Checklist & Evidence
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 space-y-4">
          {evidenceLoading ? (
            <div className="flex items-center gap-2 text-[var(--text-sm)] text-[var(--text-muted)] py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading evidence...
            </div>
          ) : (docs ?? []).length === 0 ? (
            <div className="space-y-3">
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] italic">Documentation pack not issued yet.</p>
              {access?.access.flowEdit && access?.sensitive.identity.edit && <Button size="sm" disabled={recoverDocuments.isPending} onClick={() => {
                setRecoveryNotice(null);
                recoverDocuments.mutate({ id: caseId }, {
                  onSuccess: (result) => {
                    setRecoveryNotice(result.message);
                    queryClient.invalidateQueries({ queryKey: getListOnboardingCaseDocumentsQueryKey(caseId) });
                    queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
                  },
                  onError: (error: any) => {
                    setRecoveryNotice(error?.data?.message || error?.message || 'Document recovery could not be queued.');
                  },
                });
              }}>{recoverDocuments.isPending ? 'Queuing recovery…' : 'Queue legal document recovery'}</Button>}
              {(!access?.access.flowEdit || !access?.sensitive.identity.edit) && <RestrictedActionNotice>Document recovery is restricted by your current case permissions.</RestrictedActionNotice>}
              {recoveryNotice && <p className="text-[var(--text-xs)] text-[var(--text-muted)]" role="status">{recoveryNotice}</p>}
            </div>
          ) : (
            (docs ?? []).map((doc: any) => {
              const evidence = (evidenceList || []).find((e: any) => e.documentId === doc.id);
              return <DocumentItem key={doc.id} caseId={caseId} doc={doc} evidence={evidence} />;
            })
          )}
        </CardContent>
      </Card>

    </div>
  );
}

function BgvItem({ bgv }: { bgv: any }) {
  const isOverdue = bgv.status === 'overdue';
  const isClear = bgv.status === 'clear';
  const isRejected = bgv.status === 'rejected';
  const isReview = bgv.status === 'manual_review';
  const isPending = bgv.status === 'pending' || bgv.status === 'incomplete';

  let statusColor = 'var(--text-muted)';
  let bgStatusColor = 'var(--surface-alt)';
  let icon = <Clock className="w-4 h-4 text-[var(--text-muted)]" />;

  if (isClear || bgv.status === 'done') {
    statusColor = 'var(--status-green)';
    bgStatusColor = 'var(--status-green-bg)';
    icon = <ShieldCheck className="w-4 h-4 text-[var(--status-green)]" />;
  } else if (isOverdue || isRejected) {
    statusColor = 'var(--status-red)';
    bgStatusColor = 'var(--status-red-bg)';
    icon = <ShieldAlert className="w-4 h-4 text-[var(--status-red)]" />;
  } else if (isReview) {
    statusColor = 'var(--status-amber)';
    bgStatusColor = 'var(--status-amber-bg)';
    icon = <HardHat className="w-4 h-4 text-[var(--status-amber)]" />;
  } else if (isPending) {
    statusColor = 'var(--status-blue)';
    bgStatusColor = 'var(--status-info-bg)';
    icon = <Loader2 className="w-4 h-4 text-[var(--status-blue)] animate-spin" />;
  }

  return (
    <div className="flex flex-col md:flex-row md:items-start gap-4 p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
      <div className="mt-0.5 bg-[var(--surface)] p-2 rounded-full shadow-sm shrink-0 border border-[var(--border)]">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
          <p className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">
            Provider: {bgv.system}
          </p>
          <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full" style={{ backgroundColor: bgStatusColor, color: statusColor }}>
            {bgv.status.replace('_', ' ')}
          </span>
        </div>
        
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3 text-[var(--text-xs)]">
          <div>
            <span className="text-[var(--text-muted)] block text-[10px] uppercase font-semibold">Requested</span>
            <span className="text-[var(--text-secondary)] font-medium">{format(new Date(bgv.requestedAt), 'MMM d, yyyy')}</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)] block text-[10px] uppercase font-semibold">SLA Deadline</span>
            <span className={cn("font-medium", isOverdue ? "text-[var(--status-red)] font-bold" : "text-[var(--text-secondary)]")}>
              {format(new Date(bgv.dueAt), 'MMM d, yyyy')}
            </span>
          </div>
          <div>
            <span className="text-[var(--text-muted)] block text-[10px] uppercase font-semibold">Completed</span>
            <span className="text-[var(--text-secondary)] font-medium">{bgv.completedAt ? format(new Date(bgv.completedAt), 'MMM d, yyyy') : '—'}</span>
          </div>
          <div>
            <span className="text-[var(--text-muted)] block text-[10px] uppercase font-semibold">Reference</span>
            <span className="text-[var(--text-secondary)] font-mono text-[11px]">{bgv.externalRef}</span>
          </div>
        </div>

        {bgv.note && (
          <div className="mt-3 bg-[var(--surface-alt)] p-2.5 rounded text-[var(--text-xs)] text-[var(--text-secondary)] border border-[var(--border)] italic">
            {bgv.note}
          </div>
        )}
      </div>
    </div>
  );
}

function DocumentItem({ caseId, doc, evidence }: { caseId: number, doc: any, evidence: any }) {
  const access = useCaseAccess();
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [decisionMessage, setDecisionMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  
  const queryClient = useQueryClient();
  const decide = useDecideOnboardingEvidence();
  const retryScan = useRetryOnboardingEvidenceMalwareScan();
  const knownDocumentClass = KNOWN_DOCUMENT_CLASS[doc.key];
  const documentSensitiveClass = knownDocumentClass?.category === doc.category ? knownDocumentClass.classification : null;
  const requiredSensitiveClasses = documentSensitiveClass
    ? [documentSensitiveClass]
    : (['identity', 'medical', 'payroll', 'bgv'] as const);
  const canReadDocument = requiredSensitiveClasses.every((classification) => access?.sensitive[classification].read === true);
  const canEditDocument = canReadDocument
    && access?.access.flowEdit === true
    && access?.access.notesEdit === true
    && requiredSensitiveClasses.every((classification) => access?.sensitive[classification].edit === true);

  const handleDecision = (decision: 'approve' | 'reject' | 'request_correction') => {
    if (!canEditDocument) return;
    if (reason.trim().length < 3) {
      setDecisionMessage({ kind: 'error', text: 'Enter a reason of at least 3 characters.' });
      return;
    }
    setDecisionMessage(null);
    decide.mutate({ 
      id: caseId, 
      evidenceId: evidence.id, 
      data: { decision, reason: reason.trim() } 
    }, {
      onSuccess: () => {
        setDecisionOpen(false);
        setReason('');
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEvidenceQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseDocumentsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseBgvQueryKey(caseId) });
        setDecisionMessage({ kind: 'success', text: 'Review decision saved.' });
      },
      onError: (err: any) => {
        setDecisionMessage({ kind: 'error', text: err?.data?.message || err.message || 'Failed to submit decision.' });
      }
    });
  };

  const retryMalwareScan = () => {
    if (!canEditDocument) return;
    if (!evidence?.canRetryScan || retryScan.isPending) return;
    setDecisionMessage(null);
    retryScan.mutate({ id: caseId, evidenceId: evidence.id }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEvidenceQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseDocumentsQueryKey(caseId) });
        setDecisionMessage({ kind: 'success', text: 'Security scan queued again.' });
      },
      onError: (error: any) => {
        setDecisionMessage({ kind: 'error', text: error?.data?.message || error?.message || 'Unable to retry the security scan.' });
      },
    });
  };

  const retryingScan = retryScan.isPending;
  const hasEvidence = !!evidence;
  const malwareState = evidence?.malwareScanState as string | null | undefined;
  const malwareClean = evidence?.malwareClean === true;
  const malwareLocked = hasEvidence && !malwareClean;
  const canReject = hasEvidence && evidence.isLatest === true
    && (evidence.validationState === 'manual_review' || evidence.validationState === 'correction_requested');
  const canRequestCorrection = hasEvidence && evidence.canRequestCorrection === true;
  const isReviewNeeded = canRequestCorrection;
  const approvalLocked = isReviewNeeded && evidence.canReview !== true;
  const isRejected = hasEvidence && evidence.validationState === 'rejected';
  const isVerified = !hasEvidence
    ? doc.status === 'verified'
    : malwareClean && (doc.status === 'verified' || evidence.validationState === 'passed');
  
  let docIcon = <FileMinus className="w-4 h-4 text-[var(--text-muted)] opacity-50" />;
  if (isVerified) docIcon = <FileCheck2 className="w-4 h-4 text-[var(--status-green)]" />;
  else if (isRejected) docIcon = <ShieldAlert className="w-4 h-4 text-[var(--status-red)]" />;
  else if (isReviewNeeded) docIcon = <FileSearch className="w-4 h-4 text-[var(--status-amber)]" />;
  else if (doc.status === 'received') docIcon = <Clock className="w-4 h-4 text-[var(--status-blue)]" />;

  return (
    !canReadDocument || doc.restricted ? (
      <RestrictedActionNotice>Document details and review actions are restricted by your current permissions.</RestrictedActionNotice>
    ) :
    <div className="flex flex-col p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-alt)]">
      <div className="flex items-start gap-4">
        <div className="mt-0.5 bg-[var(--surface)] p-2 rounded-full shadow-sm shrink-0 border border-[var(--border)]">
          {docIcon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[var(--text-sm)] font-bold leading-snug text-[var(--text-primary)]">
              {doc.label}
              {!doc.required && <span className="ml-2 text-[9px] uppercase tracking-wider bg-[var(--surface)] border border-[var(--border)] px-1.5 py-0.5 rounded text-[var(--text-muted)] font-bold">optional</span>}
            </p>
            <span className={cn(
              "font-bold uppercase tracking-wider text-[10px]",
              isVerified ? "text-[var(--status-green)]" : 
               isRejected ? "text-[var(--status-red)]" :
               isReviewNeeded ? "text-[var(--status-amber)]" : 
              doc.status === 'received' ? "text-[var(--status-blue)]" : "text-[var(--text-muted)]"
            )}>
              {doc.status}
            </span>
          </div>
          <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">{doc.note}</p>

          {!hasEvidence && doc.status === 'pending' && (
             <div className="mt-3 flex items-center gap-4 text-[var(--text-xs)] text-[var(--text-muted)]">
                <span className="flex items-center gap-1"><Bell className="w-3.5 h-3.5" /> Reminders: {doc.reminderCount || 0}</span>
                {doc.reminderNextAt && <span>Next: {formatDistanceToNow(new Date(doc.reminderNextAt), {addSuffix: true})}</span>}
             </div>
          )}

          {hasEvidence && (
            <div className="mt-4 bg-[var(--surface)] rounded-[var(--radius-md)] border border-[var(--border)] p-3">
              <div className="flex flex-wrap gap-x-4 gap-y-2 text-[var(--text-xs)] mb-3 pb-3 border-b border-[var(--border)]">
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block">File</span>
                  <span className="font-medium text-[var(--text-secondary)] truncate max-w-[200px] block" title={evidence.originalName}>{evidence.originalName}</span>
                </div>
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block">Size</span>
                  <span className="font-medium text-[var(--text-secondary)]">{(evidence.sizeBytes / 1024).toFixed(1)} KB</span>
                </div>
                <div>
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block">Type</span>
                  <span className="font-medium text-[var(--text-secondary)]">{evidence.contentType}</span>
                </div>
                {evidence.fingerprint && (
                  <div>
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] block">Fingerprint</span>
                    <span className="font-mono text-[10px] text-[var(--text-secondary)]">{evidence.fingerprint.substring(0, 12)}...</span>
                  </div>
                )}
              </div>

              {(malwareLocked || approvalLocked) && (
                <div className="mb-3 flex flex-col gap-2 rounded border border-[var(--status-amber)] bg-[var(--status-amber-bg)] p-2.5 text-[var(--text-xs)] text-[var(--text-secondary)] sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-1.5">
                    {malwareState === 'infected' ? (
                      <ShieldX className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-red)]" />
                    ) : (
                      <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--status-amber)]" />
                    )}
                    <span>
                      <strong>Approval locked:</strong>{' '}
                      {approvalLocked && !malwareLocked
                        ? 'Only the latest upload for this document can be approved.'
                        : malwareState === 'infected'
                        ? 'This file is quarantined and cannot be opened or approved.'
                        : malwareState === 'clean'
                          ? 'The security result does not match this upload.'
                          : malwareState === 'pending' || malwareState === 'scanning'
                            ? 'Security scanning is still in progress.'
                            : malwareState === 'unavailable' || malwareState === 'timeout' || malwareState === 'indeterminate'
                              ? 'The security scan needs to be retried before approval.'
                              : 'A security scan is required before approval.'}
                    </span>
                  </div>
                  {evidence.canRetryScan && canEditDocument && (
                    <Button
                      data-testid={`button-retry-malware-scan-${evidence.id}`}
                      size="sm"
                      variant="outline"
                      onClick={() => void retryMalwareScan()}
                      disabled={retryingScan}
                      className="shrink-0"
                    >
                      <RotateCcw className={cn("mr-1.5 h-3.5 w-3.5", retryingScan && "animate-spin")} />
                      {retryingScan ? 'Retrying...' : 'Retry security scan'}
                    </Button>
                  )}
                </div>
              )}
              {!malwareLocked && !approvalLocked && malwareState === 'clean' && (
                <div className="mb-3 flex items-center gap-1.5 rounded border border-[var(--status-green)] bg-[var(--status-green-bg)] p-2.5 text-[var(--text-xs)] text-[var(--status-green-fg)]">
                  <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
                  <span>
                    Security scan passed
                    {evidence.malwareScannedAt ? ` on ${format(new Date(evidence.malwareScannedAt), 'MMM d, yyyy h:mm a')}` : ''}
                  </span>
                </div>
              )}

              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Validation Status:</span>
                    <span className={cn(
                      "text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full",
                      evidence.validationState === 'passed' ? "bg-[var(--status-green-bg)] text-[var(--status-green-fg)]" :
                       evidence.validationState === 'processing' || evidence.validationState === 'queued' ? "bg-[var(--status-info-bg)] text-[var(--status-blue)]" :
                       evidence.validationState === 'rejected' ? "bg-[var(--status-red-bg)] text-[var(--status-red)]" :
                      "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]"
                    )}>
                       {evidence.validationState.replaceAll('_', ' ')}
                    </span>
                  </div>
                  
                  {evidence.validationReasons && evidence.validationReasons.length > 0 && (
                    <ul className="space-y-1.5 mt-2 text-[var(--text-xs)]">
                      {evidence.validationReasons.map((r: any, idx: number) => (
                        <li key={idx} className="flex items-start gap-1.5 text-[var(--text-secondary)] bg-[var(--surface-alt)] p-1.5 rounded">
                          <Info className="w-3.5 h-3.5 text-[var(--status-amber)] shrink-0 mt-0.5" />
                           <span><strong>{String(r.code).replaceAll('_', ' ')}:</strong> {r.message}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {isReviewNeeded && canEditDocument && (
                  <Button
                    data-testid={`button-open-document-review-${evidence.id}`}
                    size="sm" 
                    variant="outline" 
                    onClick={() => setDecisionOpen(!decisionOpen)}
                    className={decisionOpen ? "bg-[var(--surface-alt)]" : ""}
                  >
                    Human Review
                  </Button>
                )}
              </div>

              {decisionOpen && isReviewNeeded && canEditDocument && (
                <div className="mt-4 pt-4 border-t border-[var(--border)]">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2">Manual Decision Required</p>
                  <textarea 
                    data-testid={`input-document-decision-reason-${evidence.id}`}
                    className="w-full text-[var(--text-sm)] p-2 rounded border border-[var(--border)] bg-[var(--surface)] mb-3 focus:outline-none focus:ring-1 focus:ring-[var(--primary)]" 
                    rows={2}
                    placeholder="Enter reason for decision (required)..."
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  {decisionMessage && (
                    <p role="status" className={cn(
                      "mb-3 rounded border p-2 text-[var(--text-xs)]",
                      decisionMessage.kind === 'error'
                        ? "border-[var(--status-red)] text-[var(--status-red)]"
                        : "border-[var(--status-green)] text-[var(--status-green)]",
                    )}>
                      {decisionMessage.text}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button 
                      data-testid={`button-approve-document-${evidence.id}`}
                      size="sm" 
                      className="bg-[var(--status-green)] hover:bg-[#1bbd72] text-white border-transparent flex-1"
                       onClick={() => handleDecision('approve')}
                       disabled={decide.isPending || evidence.canReview !== true}
                       title={!malwareClean ? 'Approval is locked until the latest upload has a clean, matching security result.' : undefined}
                    >
                       {decide.isPending && decide.variables?.data?.decision === 'approve' ? 'Saving...' : 'Approve after review'}
                    </Button>
                    <Button 
                      data-testid={`button-request-document-correction-${evidence.id}`}
                      size="sm" 
                      className="bg-[var(--status-amber)] hover:bg-[#d97706] text-white border-transparent flex-1"
                       onClick={() => handleDecision('request_correction')}
                      disabled={decide.isPending}
                    >
                      {decide.isPending && decide.variables?.data?.decision === 'request_correction' ? 'Saving...' : 'Request Correction'}
                    </Button>
                    <Button 
                      data-testid={`button-reject-document-${evidence.id}`}
                      size="sm" 
                      variant="destructive"
                      className="flex-1"
                      onClick={() => handleDecision('reject')}
                       disabled={decide.isPending || !canReject}
                    >
                      {decide.isPending && decide.variables?.data?.decision === 'reject' ? 'Saving...' : 'Reject File'}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}