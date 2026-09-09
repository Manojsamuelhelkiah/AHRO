import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useUpdateOnboardingChecklistItem,
  useRecalculateOnboardingChecklistProfile,
  getGetOnboardingCaseQueryKey,
  getListOnboardingCaseEventsQueryKey,
  type OnbCase,
  type OnbReadinessItem,
  type OnbChecklistItemStatusUpdateStatus
} from '@workspace/api-client-react';
import { CheckCircle2, Clock, AlertTriangle, Settings2, RefreshCw } from 'lucide-react';
import { Button, cn, Label } from '@/components/ui-shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { StatusBadgeText } from './components';

export function CaseReadiness({ c, setTab }: { c: OnbCase, setTab: (t: string) => void }) {
  const queryClient = useQueryClient();
  const updateItem = useUpdateOnboardingChecklistItem();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [manageOpen, setManageOpen] = useState(false);
  const [replaceReason, setReplaceReason] = useState('');
  const recalculate = useRecalculateOnboardingChecklistProfile();

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
          <Button variant="outline" size="sm" onClick={() => setManageOpen(true)} className="gap-2 shrink-0"><Settings2 className="w-3.5 h-3.5" /> Manage</Button>
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
                  {w.note && <span className="text-[var(--text-xs)] text-[var(--text-secondary)] flex-1 truncate">&bull; {w.note}</span>}
                </div>
              </div>
              
              {isCustom && w.id && (
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
            </div>
          );
        })}
      </div>
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
