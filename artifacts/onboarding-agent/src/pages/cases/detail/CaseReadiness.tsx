import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { 
  useUpdateOnboardingChecklistItem, 
  getGetOnboardingCaseQueryKey,
  getListOnboardingCaseEventsQueryKey,
  type OnbCase,
  type OnbReadinessItem,
  type OnbChecklistItemStatusUpdateStatus
} from '@workspace/api-client-react';
import { CheckCircle2, Clock, AlertTriangle } from 'lucide-react';
import { Button, cn } from '@/components/ui-shared';
import { StatusBadgeText } from './components';

export function CaseReadiness({ c, setTab }: { c: OnbCase, setTab: (t: string) => void }) {
  const queryClient = useQueryClient();
  const updateItem = useUpdateOnboardingChecklistItem();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="mb-10">
      <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-4">Case Readiness</h2>
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
    </div>
  );
}
