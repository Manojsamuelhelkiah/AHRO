import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useUpdateOnboardingChecklistItem,
  useRecalculateOnboardingChecklistProfile,
  useCorrectOnboardingWorkforceContext,
  useVerifyOnboardingChecklistEvidence,
  getGetOnboardingCaseQueryKey,
  getListOnboardingCaseEventsQueryKey,
  type OnbCase,
  type OnbReadinessItem,
  type OnbChecklistItemStatusUpdateStatus
} from '@workspace/api-client-react';
import { CheckCircle2, Clock, AlertTriangle, Settings2, RefreshCw, Pencil } from 'lucide-react';
import { Button, cn, Label } from '@/components/ui-shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { StatusBadgeText } from './components';
import { updateWorkforceContext } from '@/lib/workforce-policy-api';

export function CaseReadiness({ c, setTab }: { c: OnbCase, setTab: (t: string) => void }) {
  const queryClient = useQueryClient();
  const updateItem = useUpdateOnboardingChecklistItem();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [replaceReason, setReplaceReason] = useState('');
  const recalculate = useRecalculateOnboardingChecklistProfile();
  const verifyEvidence = useVerifyOnboardingChecklistEvidence();
  const [evidenceItem, setEvidenceItem] = useState<OnbReadinessItem | null>(null);
  const [evidenceReference, setEvidenceReference] = useState('');
  const [evidenceReason, setEvidenceReason] = useState('');
  const [contextOpen, setContextOpen] = useState(false);
  const [contextReason, setContextReason] = useState('');
  const [contextDraft, setContextDraft] = useState(c.workforceContext ?? {});
  const correctContext = useCorrectOnboardingWorkforceContext();

  const readinessItems = [...(c.readiness || [])].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const systemManagedIds = new Set(['profile', 'documentation', 'payroll', 'access', 'assets', 'learning', 'checkpoints']);
  const blockedStage = c.orchestrationStatus === 'checklist-blocked'
    ? c.orchestrationCheckpoint?.replace('blocked:', '')
    : null;
  const blockedStageLabel = blockedStage === 're-review'
    ? 'the final Day-1 review'
    : blockedStage?.replace(/-/g, ' ');

  const handleUpdate = (item: OnbReadinessItem, status: OnbChecklistItemStatusUpdateStatus) => {
    if (!item.id || systemManagedIds.has(item.id)) return;
    setError(null);
    updateItem.mutate({
      id: c.id,
      itemId: item.id,
      data: { status, note: notes[item.id]?.trim() || undefined }
    }, {
      onSuccess: () => {
        setNotes((current) => ({ ...current, [item.id!]: '' }));
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(c.id) });
      },
      onError: (mutationError) => setError(mutationError.message || 'Could not update this checklist item.'),
    });
  };

  const readyCount = readinessItems.filter(w => w.status === 'ready').length;
  const waitingCount = readinessItems.filter(w => w.status === 'in-progress' || w.status === 'pending').length;
  const reviewCount = readinessItems.filter(w => w.status === 'blocked' || w.status === 'exception').length;

  const allowSimpleRecalculate =
    c.orchestrationStatus === 'idle'
    && c.lifecycleStage === 'trigger-received'
    && !c.orchestrationCheckpoint;
  const matchedCriteria = Object.entries(c.checklistMatchedCriteria ?? {});
  const contextImpact = contextDraft.workEnvironment === 'site' || contextDraft.workEnvironment === 'field' || contextDraft.siteExposure || contextDraft.safetyCritical
    ? 'Likely frontline/site policy match. Independent safety evidence gates may apply after an explicit checklist replacement.'
    : contextDraft.workEnvironment === 'mixed'
      ? 'Likely mixed-work policy match. Office and site obligations remain distinct after an explicit checklist replacement.'
      : contextDraft.workEnvironment === 'office' || contextDraft.workEnvironment === 'remote'
        ? contextDraft.siteExposure === false && contextDraft.safetyCritical === false
          ? 'Likely office policy match; the current snapshot remains unchanged until you explicitly replace it.'
          : 'Safety applicability is incomplete. The future policy result will keep a human context review gate.'
        : 'Work environment is unknown. The future policy result will keep a human context review gate.';

  const handleRecalculate = () => {
    const isReplace = !allowSimpleRecalculate;
    if (isReplace && !replaceReason.trim()) return;
    setError(null);
    recalculate.mutate({
      id: c.id,
      data: {
        action: isReplace ? 'replace-active' : 'recalculate',
        reason: isReplace ? replaceReason : undefined,
        expectedChecklistTemplateVersion: c.checklistTemplateVersion,
        expectedChecklistProfileId: c.checklistProfileId,
        expectedChecklistProfileVersion: c.checklistProfileVersion,
      }
    }, {
      onSuccess: () => {
        setManageOpen(false);
        setReplaceReason('');
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(c.id) });
      },
      onError: (err: any) => {
        setError(err?.response?.data?.message || err?.message || 'Failed to update checklist profile.');
        setManageOpen(false);
      }
    });
  };
  const submitEvidence = (decision: 'verified' | 'rejected') => {
    if (!evidenceItem?.id || !evidenceReference.trim() || !evidenceReason.trim()) return;
    setError(null);
    verifyEvidence.mutate({
      id: c.id,
      itemId: evidenceItem.id,
      // The backend compares this exact policy/context provenance under its
      // case-row lock; a reviewer must refresh rather than verify stale facts.
      data: {
        evidenceReference: evidenceReference.trim(),
        authorityRole: evidenceItem.responsibleRole || '',
        decision,
        reason: evidenceReason.trim(),
        expectedPolicy: {
          contextVersion: c.workforceContextVersion,
          templateVersion: c.checklistTemplateVersion,
          profileId: c.checklistProfileId,
          profileVersion: c.checklistProfileVersion,
        },
      },
    }, {
      onSuccess: () => {
        setEvidenceItem(null); setEvidenceReference(''); setEvidenceReason('');
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(c.id) });
      },
      onError: (mutationError: any) => setError(mutationError?.response?.data?.message || mutationError?.message || 'Could not record evidence verification.'),
    });
  };
  const submitContextCorrection = () => {
    if (contextReason.trim().length < 3) return;
    setError(null);
    correctContext.mutate({
      id: c.id,
      data: {
        workforceContext: contextDraft,
        expectedUpdatedAt: c.updatedAt,
        reason: contextReason.trim(),
      },
    }, {
      onSuccess: () => {
        setContextOpen(false);
        setContextReason('');
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseQueryKey(c.id) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(c.id) });
      },
      onError: (mutationError: any) => setError(mutationError?.response?.data?.message || mutationError?.message || 'Could not correct the workforce context.'),
    });
  };

  return (
    <div className="mb-10">
      <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-4">Case Readiness</h2>

      <div className="mb-4 p-4 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface-alt)] shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h3 className="text-[var(--text-sm)] font-bold flex items-center gap-2">
              Active Checklist: {c.checklistProfileName || 'Global Default'}
              {c.checklistProfileVersion && <span className="text-[10px] bg-[var(--surface-soft)] text-[var(--text-secondary)] px-1.5 py-0.5 rounded font-mono border border-[var(--border)]">v{c.checklistProfileVersion}</span>}
            </h3>
            <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">{c.checklistMatchExplanation || 'No targeting matched; using the default Day-1 checklist.'}</p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">Default v{c.checklistTemplateVersion}</span>
              {matchedCriteria.map(([key, value]) => (
                <span key={key} className="rounded border border-[var(--border)] bg-[var(--surface)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                  <span className="font-semibold">{key}</span>: {value}
                </span>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => { setContextDraft(c.workforceContext ?? {}); setContextOpen(true); }} className="gap-2"><Pencil className="w-3.5 h-3.5" /> Correct context</Button>
            <Button variant="outline" size="sm" onClick={() => setManageOpen(true)} className="gap-2"><Settings2 className="w-3.5 h-3.5" /> Rebase policy</Button>
          </div>
        </div>
        <details className="mt-3 border-t border-[var(--border)] pt-3">
          <summary className="cursor-pointer text-[var(--text-xs)] font-semibold text-[var(--primary)]">View snapshotted effective checklist</summary>
          <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
            {[...(c.checklistSnapshot ?? [])].sort((a, b) => a.order - b.order).map((item) => (
              <div key={item.id} className={cn(
                'rounded border p-2 text-[11px]',
                item.enabled ? 'border-[var(--border)] bg-[var(--surface)]' : 'border-dashed border-[var(--border)] opacity-50',
              )}>
                <p className="font-semibold text-[var(--text-primary)]">{item.label}</p>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-[var(--text-muted)]">
                  {item.enabled ? (item.mandatory ? 'Mandatory' : 'Optional') : 'Disabled'} · {item.enforcementStage.replace('before-', 'before ')}
                </p>
              </div>
            ))}
          </div>
        </details>
      </div>

      {blockedStage && (
        <div role="alert" data-testid="status-checklist-blocker" className="mb-4 rounded-[var(--radius-md)] border border-[var(--status-red)]/30 bg-[var(--status-red-bg)] p-3 text-[var(--text-sm)] text-[var(--status-red-fg)]">
          <strong>Onboarding is paused.</strong> Complete the mandatory items marked as blockers before {blockedStageLabel} can begin.
        </div>
      )}
      {error && (
        <div role="alert" data-testid="status-checklist-update-error" className="mb-4 rounded-[var(--radius-md)] border border-[var(--status-red)]/30 bg-[var(--status-red-bg)] p-3 text-[var(--text-sm)] text-[var(--status-red-fg)]">
          {error}
        </div>
      )}
      <div className="space-y-3">
        {readinessItems.map(w => {
          const isCustom = !!w.id && !systemManagedIds.has(w.id);
          const isBlocker = Boolean(
            blockedStage &&
            w.mandatory &&
            w.status !== 'ready' &&
            (blockedStage === 're-review' || w.enforcementStage === blockedStage),
          );

          return (
            <div key={w.key} data-testid={`row-case-checklist-${w.key}`} className={cn(
              "flex items-start gap-3 p-3 rounded-[var(--radius-md)] hover:bg-[var(--surface-alt)] transition-colors border border-transparent hover:border-[var(--border)]",
              (w.status === 'exception' || isBlocker) ? "bg-[var(--status-red-bg)] border-[var(--status-red)]/20" : ""
            )}>
              <div className="mt-0.5 shrink-0">
                 {w.status === 'ready' && <CheckCircle2 className="w-4 h-4 text-[var(--status-green)]" />}
                 {(w.status === 'pending' || w.status === 'in-progress') && <Clock className="w-4 h-4 text-[var(--status-blue)]" />}
                 {(w.status === 'blocked' || w.status === 'exception') && <AlertTriangle className="w-4 h-4 text-[var(--status-amber)]" />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <h4 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)] truncate">{w.label}</h4>
                  <StatusBadgeText status={w.status} />
                  {!w.mandatory && <span className="text-[9px] uppercase tracking-wider font-bold text-[var(--text-muted)] bg-[var(--surface)] px-1.5 py-0.5 rounded border border-[var(--border)]">Optional</span>}
                   {isBlocker && <span className="text-[9px] uppercase tracking-wider font-bold text-[var(--status-red-fg)]">Blocking progress</span>}
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[9px] uppercase tracking-wider font-bold text-[var(--text-secondary)]">Stage: {w.enforcementStage?.replace(/-/g, ' ') || 'Unknown'}</span>
                   {w.evidenceRequired && <span className="text-[9px] uppercase tracking-wider font-bold text-[var(--status-amber-fg)]">Independent evidence · {w.responsibleRole || 'designated human'}</span>}
                  {w.note && <span className="text-[var(--text-xs)] text-[var(--text-secondary)] flex-1 truncate">&bull; {w.note}</span>}
                </div>
              </div>
              
               {isCustom && w.id && !w.evidenceRequired && (
                <div className="shrink-0 flex flex-col sm:flex-row items-end sm:items-center gap-2 ml-4">
                  <input
                    value={notes[w.id] ?? ''}
                    onChange={(event) => setNotes((current) => ({ ...current, [w.id!]: event.target.value }))}
                    aria-label={`Note for ${w.label}`}
                    data-testid={`input-checklist-note-${w.id}`}
                    maxLength={500}
                    placeholder="Add a note"
                    className="h-7 w-40 rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-2 text-[var(--text-xs)] text-[var(--text-primary)]"
                  />
                  {w.status === 'ready' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleUpdate(w, 'pending')}
                      disabled={updateItem.isPending && updateItem.variables?.itemId === w.id}
                      data-testid={`button-reopen-checklist-${w.id}`}
                      className="text-[var(--text-xs)] h-7 px-2"
                    >
                      Reopen
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => handleUpdate(w, 'ready')}
                      disabled={updateItem.isPending && updateItem.variables?.itemId === w.id}
                      data-testid={`button-complete-checklist-${w.id}`}
                      className="bg-[var(--status-green)] text-white hover:bg-[var(--status-green)]/90 h-7 px-3 text-[var(--text-xs)]"
                    >
                      Complete
                    </Button>
                  )}
                </div>
              )}
               {isCustom && w.id && w.evidenceRequired && (
                 <div className="shrink-0 ml-4">
                   <Button size="sm" variant="outline" onClick={() => setEvidenceItem(w)} className="max-w-48 text-[10px]">Record {w.responsibleRole || 'designated human'} evidence</Button>
                 </div>
               )}
            </div>
          );
        })}
      </div>
      <Dialog open={Boolean(evidenceItem)} onOpenChange={(open) => { if (!open) setEvidenceItem(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Verify independent evidence</DialogTitle><DialogDescription>
            {evidenceItem?.label}. You are recording a human decision as the configured {evidenceItem?.responsibleRole} authority. Do not enter medical or other sensitive document content—store only its approved-system reference.
          </DialogDescription></DialogHeader>
          <div className="space-y-3 py-2">
            <div><Label>Evidence reference</Label><input className="mt-1 w-full rounded border border-[var(--border)] p-2 text-sm" value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} placeholder="Approved system record ID or URL" /></div>
            <div><Label>Decision rationale</Label><input className="mt-1 w-full rounded border border-[var(--border)] p-2 text-sm" value={evidenceReason} onChange={(e) => setEvidenceReason(e.target.value)} placeholder="Reason for verification or rejection" /></div>
            <p className="text-[11px] text-[var(--text-muted)]">Calls, reminders, readiness scores, agent assertions, and missing provider data cannot substitute for this verification.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEvidenceItem(null)}>Cancel</Button>
            <Button variant="outline" disabled={verifyEvidence.isPending || evidenceReference.trim().length < 3 || evidenceReason.trim().length < 3} onClick={() => submitEvidence('rejected')}>Reject evidence</Button>
            <Button disabled={verifyEvidence.isPending || evidenceReference.trim().length < 3 || evidenceReason.trim().length < 3} onClick={() => submitEvidence('verified')}>Verify evidence</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={contextOpen} onOpenChange={setContextOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Correct job context</DialogTitle>
            <DialogDescription>Correct explicit job facts only. Saving records an audit event but does not silently alter this case’s active policy snapshot.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div><Label>Work environment</Label><select className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.workEnvironment ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, workEnvironment: (event.target.value || undefined) as any })}><option value="">Unknown</option><option value="office">Office</option><option value="remote">Remote</option><option value="site">Site</option><option value="field">Field</option><option value="mixed">Mixed</option></select></div>
              <div><Label>Site / facility</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.site ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, site: event.target.value || undefined })} /></div>
              <div><Label>Role family</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.roleFamily ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, roleFamily: event.target.value || undefined })} /></div>
              <div><Label>Pay basis</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.payBasis ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, payBasis: event.target.value || undefined })} /></div>
              <div><Label>Work country</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.workCountry ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, workCountry: event.target.value || undefined })} /></div>
              <div><Label>Work state / region</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.workState ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, workState: event.target.value || undefined })} /></div>
              <div><Label>Department</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.department ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, department: event.target.value || undefined })} /></div>
              <div><Label>Legal entity</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.legalEntity ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, legalEntity: event.target.value || undefined })} /></div>
              <div><Label>Shift pattern</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.shiftPattern ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, shiftPattern: event.target.value || undefined })} /></div>
              <div><Label>Employment arrangement</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.employmentArrangement ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, employmentArrangement: event.target.value || undefined })} /></div>
              <div><Label>Required licenses</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={(contextDraft.requiredLicenses ?? []).join(', ')} onChange={(event) => setContextDraft({ ...contextDraft, requiredLicenses: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></div>
              <div><Label>Hazards / conditions</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={(contextDraft.hazards ?? []).join(', ')} onChange={(event) => setContextDraft({ ...contextDraft, hazards: event.target.value.split(',').map((value) => value.trim()).filter(Boolean) })} /></div>
              <div><Label>Accessibility needs</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.accessibilityNeeds ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, accessibilityNeeds: event.target.value || undefined })} /></div>
              <div><Label>Language preference</Label><input className="mt-1 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" value={contextDraft.languagePreference ?? ''} onChange={(event) => setContextDraft({ ...contextDraft, languagePreference: event.target.value || undefined })} /></div>
            </div>
            <div className="grid grid-cols-1 gap-2 text-xs text-[var(--text-secondary)] md:grid-cols-3">
              {(['siteExposure', 'safetyCritical', 'assistedIntake'] as const).map((field) => <label key={field}>{field.replace(/([A-Z])/g, ' $1')}<select className="ml-2 h-7 rounded border border-[var(--border)] bg-[var(--surface)] px-1" value={contextDraft[field] === undefined ? '' : String(contextDraft[field])} onChange={(event) => setContextDraft((current) => updateWorkforceContext(current, field, event.target.value === '' ? undefined : event.target.value === 'true'))}><option value="">Unknown</option><option value="true">Yes</option><option value="false">No</option></select></label>)}
            </div>
            <div className="rounded border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]"><strong>Impact preview:</strong> {contextImpact}</div>
            <div><Label>Reason for correction</Label><textarea className="mt-1 min-h-20 w-full rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-sm" maxLength={500} value={contextReason} onChange={(event) => setContextReason(event.target.value)} placeholder="Explain the verified source of this correction" /></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setContextOpen(false)}>Cancel</Button><Button onClick={submitContextCorrection} disabled={correctContext.isPending || contextReason.trim().length < 3}>Save correction</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <div className="mt-4 flex items-center gap-3 text-[var(--text-xs)] font-semibold text-[var(--text-secondary)] bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] border border-[var(--border)]">
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--status-green)]"></span>{readyCount} complete</span>
        <span className="text-[var(--border-strong)]">|</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--status-blue)]"></span>{waitingCount} waiting</span>
        <span className="text-[var(--border-strong)]">|</span>
        <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-[var(--status-amber)]"></span>{reviewCount} human review</span>
      </div>
      <button type="button" data-testid="button-view-case-tasks" onClick={() => setTab('Tasks')} className="text-[var(--primary)] text-[var(--text-xs)] font-bold mt-4 text-left hover:underline">
        View tasks →
      </button>

      <Dialog open={manageOpen} onOpenChange={setManageOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Manage Case Checklist</DialogTitle>
            <DialogDescription>
              Re-evaluate the targeted checklist profiles against this employee's current attributes.
            </DialogDescription>
          </DialogHeader>

          <div className="py-4">
            {allowSimpleRecalculate ? (
              <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">
                Orchestration has not yet started. You can safely recalculate the checklist.
              </p>
            ) : (
              <div className="space-y-4">
                <div className="p-3 rounded-[var(--radius-md)] bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border border-[var(--status-amber)]/30 text-[var(--text-sm)]">
                  <AlertTriangle className="w-4 h-4 mb-1" />
                  <p className="font-bold">This transaction has already started.</p>
                  <p className="mt-1">Replacing its snapshot is a deliberate policy change. Existing item statuses are preserved where item IDs still match, and the reason is recorded in the audit timeline.</p>
                </div>
                <div className="space-y-2">
                  <Label>Reason for replacement</Label>
                  <textarea
                    value={replaceReason}
                    onChange={(e) => setReplaceReason(e.target.value)}
                    maxLength={500}
                    placeholder="e.g. Employee band updated from L4 to L5"
                    className="min-h-20 w-full rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[var(--text-sm)] text-[var(--text-primary)] outline-none focus:border-[var(--primary)] focus:ring-1 focus:ring-[var(--primary)]"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setManageOpen(false)}>Cancel</Button>
            <Button onClick={handleRecalculate} disabled={recalculate.isPending || (!allowSimpleRecalculate && !replaceReason.trim())} className="gap-2 bg-[var(--primary)] text-white">
              <RefreshCw className="w-4 h-4" /> {allowSimpleRecalculate ? 'Recalculate Profile' : 'Force Replace Checklist'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
