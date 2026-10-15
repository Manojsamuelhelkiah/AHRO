import React, { useState } from 'react';
import { format } from 'date-fns';
import {
  useGetOnboardingCaseReadinessSla,
  useSetOnboardingPayrollCutoff,
  useAttestOnboardingReadiness,
  useRebaseOnboardingReadinessSla,
  getGetOnboardingCaseReadinessSlaQueryKey,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@/components/ui-shared';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { AlertTriangle, Clock, RefreshCw, CheckCircle2, XCircle } from 'lucide-react';
import { useOrganizationRole } from '../../../hooks/use-organization-role';

export function ConnectedReadinessSla({ caseId }: { caseId: number }) {
  const { isHR } = useOrganizationRole();
  const queryClient = useQueryClient();

  const { data, isLoading } = useGetOnboardingCaseReadinessSla(caseId, {
    query: { queryKey: getGetOnboardingCaseReadinessSlaQueryKey(caseId) }
  });

  if (isLoading) {
    return <div className="animate-pulse bg-[var(--surface-alt)] h-40 rounded-[var(--radius-lg)] mb-8"></div>;
  }

  if (!data?.enrolled || data.snapshotVersion == null) {
    return null;
  }

  const snapshotVersion = data.snapshotVersion as number;

  return (
    <div className="mb-8 p-6 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)]">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6">
        <div>
          <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)]">Readiness SLA</h2>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
            Tracking critical streams against target deadlines. The ≥ {data.thresholds?.amberMinimum ?? 80}% score threshold is only one requirement for Day-1 Readiness. Current mandatory evidence and a fresh authorized HR final review are still required; a score alone never authorizes completion.
          </p>
        </div>
        <SlaScoreBadge score={data.score} thresholds={data.thresholds || { green: 100, amberMinimum: 80 }} />
      </div>

      <div className="space-y-3">
        {data.streams?.map((stream: any) => (
          <StreamRow key={stream.key} stream={stream} actions={data.actions?.filter((a: any) => a.streamKey === stream.key)} isHR={isHR} caseId={caseId} expectedVersion={snapshotVersion} />
        ))}
      </div>

      {isHR && <RebaseActions caseId={caseId} expectedVersion={snapshotVersion} />}
    </div>
  );
}

function SlaScoreBadge({ score, thresholds }: { score: number, thresholds: any }) {
  let color = 'var(--status-red)';
  let bg = 'var(--status-red-bg)';
  let text = 'text-[var(--status-red-fg)]';

  if (score === thresholds.green) {
    color = 'var(--status-green)';
    bg = 'var(--status-green-bg)';
    text = 'text-[var(--status-green-fg)]';
  } else if (score >= thresholds.amberMinimum) {
    color = 'var(--status-amber)';
    bg = 'var(--status-amber-bg)';
    text = 'text-[var(--status-amber-fg)]';
  }

  return (
    <div className={cn("flex flex-col items-center px-4 py-2 rounded-[var(--radius-md)] border", text)} style={{ backgroundColor: bg, borderColor: color }}>
      <span className="text-[var(--text-2xl)] font-black leading-none">{score}<span className="text-[var(--text-sm)]">%</span></span>
      <span className="text-[10px] font-bold uppercase tracking-wider mt-1 opacity-80">Readiness Score</span>
    </div>
  );
}

function StreamRow({ stream, actions, isHR, caseId, expectedVersion }: { stream: any, actions: any[], isHR: boolean, caseId: number, expectedVersion: number }) {
  const queryClient = useQueryClient();
  const attest = useAttestOnboardingReadiness();
  const updateCutoff = useSetOnboardingPayrollCutoff();

  const [hrisOpen, setHrisOpen] = useState(false);
  const [hrisReason, setHrisReason] = useState('');

  const [payrollOpen, setPayrollOpen] = useState(false);
  const [payrollCutoffDate, setPayrollCutoffDate] = useState('');
  const [payrollReason, setPayrollReason] = useState('');

  const isN_A = stream.status === 'not-applicable';
  const isComplete = stream.status === 'complete';
  const isIncomplete = stream.status === 'incomplete';
  const isNeedsConfig = stream.status === 'needs-configuration';

  const handleAttest = () => {
    if (!hrisReason.trim()) return;
    attest.mutate({ id: caseId, data: { stream: stream.key, complete: true, expectedSnapshotVersion: expectedVersion, reason: hrisReason } }, {
      onSuccess: () => {
        setHrisOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseReadinessSlaQueryKey(caseId) });
      }
    });
  };

  const handlePayrollUpdate = () => {
    if (!payrollReason.trim() || !payrollCutoffDate) return;
    updateCutoff.mutate({ id: caseId, data: { expectedSnapshotVersion: expectedVersion, payrollCutoff: new Date(payrollCutoffDate).toISOString(), reason: payrollReason } }, {
      onSuccess: () => {
        setPayrollOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseReadinessSlaQueryKey(caseId) });
      }
    });
  };

  return (
    <div className={cn(
      "p-3 md:p-4 rounded-[var(--radius-md)] border flex flex-col md:flex-row gap-4 items-start md:items-center transition-colors",
      isComplete ? "bg-[var(--status-green-bg)] border-[var(--status-green)]/30" : 
      isN_A ? "bg-[var(--surface-alt)] border-[var(--border)] opacity-60" : 
      isNeedsConfig ? "bg-[var(--status-amber-bg)] border-[var(--status-amber)]/30" :
      "bg-[var(--surface)] border-[var(--border)] shadow-sm"
    )}>
      <div className="flex items-start gap-3 flex-1 min-w-0">
        <div className="mt-0.5 shrink-0">
          {isComplete ? <CheckCircle2 className="w-5 h-5 text-[var(--status-green)]" /> : 
           isN_A ? <div className="w-5 h-5 flex items-center justify-center font-bold text-[10px] text-[var(--text-muted)] bg-[var(--surface)] rounded border border-[var(--border)]">N/A</div> : 
           <Clock className={cn("w-5 h-5", isIncomplete ? "text-[var(--status-blue)]" : "text-[var(--status-amber)]")} />}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h4 className={cn("text-[var(--text-sm)] font-bold", isN_A ? "text-[var(--text-muted)] line-through" : "text-[var(--text-primary)]")}>{stream.label}</h4>
            <span className="text-[10px] font-bold text-[var(--text-muted)] bg-[var(--surface-alt)] px-1.5 py-0.5 rounded border border-[var(--border)]">{stream.weight}W</span>
          </div>
          <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">{stream.reason || (isComplete ? `Completed at ${stream.completedAt ? format(new Date(stream.completedAt), 'MMM d, HH:mm') : ''}` : 'Pending validation')}</p>
          
          {actions?.length > 0 && !isN_A && (
            <div className="mt-2 space-y-1">
              {actions.map((a: any, i: number) => (
                <div key={i} className="text-[10px] flex flex-wrap items-center gap-1.5 font-medium text-[var(--text-secondary)] bg-[var(--surface-alt)] px-2 py-1 rounded w-fit">
                  <span className="text-[var(--text-primary)]">{a.label}</span>
                  <span className="opacity-50">•</span>
                  <span>Owner: {a.owner}</span>
                  {a.status === 'breached' && <span className="text-[var(--status-red)] ml-1 font-bold bg-[var(--status-red-bg)] px-1 rounded-sm">BREACHED</span>}
                  {a.dueAt && <span className="ml-1 opacity-75">Due {format(new Date(a.dueAt), 'MMM d')}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      
      {isHR && !isComplete && !isN_A && (
        <div className="shrink-0 flex gap-2 w-full md:w-auto">
          {stream.key === 'hris' && (
            <>
              <Button size="sm" variant="outline" onClick={() => setHrisOpen(true)} className="w-full md:w-auto">Manual Attest</Button>
              <Dialog open={hrisOpen} onOpenChange={setHrisOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Attest HRIS Readiness</DialogTitle>
                    <DialogDescription>Manually verify and mark the HRIS stream as complete.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <label className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">Reason for manual attestation</label>
                    <textarea 
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]" 
                      rows={3} 
                      placeholder="e.g., HRIS record activation verified in the HRIS console"
                      value={hrisReason}
                      onChange={(e) => setHrisReason(e.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setHrisOpen(false)}>Cancel</Button>
                    <Button onClick={handleAttest} disabled={attest.isPending || !hrisReason.trim()} className="bg-[var(--primary)] text-white">Save Attestation</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}

          {stream.key === 'payroll' && (
            <>
              <Button size="sm" variant="outline" onClick={() => setPayrollOpen(true)} className="w-full md:w-auto">Set Cutoff</Button>
              <Dialog open={payrollOpen} onOpenChange={setPayrollOpen}>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Set Payroll Cutoff</DialogTitle>
                    <DialogDescription>Explicitly configure the payroll cutoff deadline for this case.</DialogDescription>
                  </DialogHeader>
                  <div className="space-y-3 py-2">
                    <label className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] block">Cutoff Date & Time</label>
                    <input 
                      type="datetime-local" 
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                      value={payrollCutoffDate}
                      onChange={(e) => setPayrollCutoffDate(e.target.value)}
                    />
                    <label className="text-[var(--text-sm)] font-medium text-[var(--text-primary)] block mt-2">Audit Reason</label>
                    <textarea 
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]" 
                      rows={2} 
                      placeholder="e.g., Payroll run confirmed by payroll lead"
                      value={payrollReason}
                      onChange={(e) => setPayrollReason(e.target.value)}
                    />
                  </div>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setPayrollOpen(false)}>Cancel</Button>
                    <Button onClick={handlePayrollUpdate} disabled={updateCutoff.isPending || !payrollReason.trim() || !payrollCutoffDate} className="bg-[var(--primary)] text-white">Save Cutoff</Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function RebaseActions({ caseId, expectedVersion }: { caseId: number, expectedVersion: number }) {
  const queryClient = useQueryClient();
  const rebase = useRebaseOnboardingReadinessSla();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');

  const handleRebase = () => {
    if (!reason.trim()) return;
    rebase.mutate({ id: caseId, data: { expectedSnapshotVersion: expectedVersion, reason } }, {
      onSuccess: () => {
        setOpen(false);
        queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseReadinessSlaQueryKey(caseId) });
      }
    });
  };

  return (
    <div className="mt-4 flex justify-end">
      <button onClick={() => setOpen(true)} className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--primary)] flex items-center gap-1 transition-colors">
        <RefreshCw className="w-3 h-3" /> Rebase SLA Snapshot
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rebase Readiness Policy Snapshot</DialogTitle>
            <DialogDescription>Update this case to the latest global organization policy. This is an audited action.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="p-3 bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] text-[var(--text-xs)] rounded-[var(--radius-md)] flex items-start gap-2 border border-[var(--status-amber)]/30">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>Rebasing replaces the case's immutable policy snapshot and re-evaluates all SLA actions. Notifications may be re-triggered.</p>
            </div>
            <label className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">Reason for rebase</label>
            <textarea 
              className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]" 
              rows={3} 
              placeholder="e.g., Approved policy correction after process review"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleRebase} disabled={rebase.isPending || !reason.trim()} className="bg-[var(--primary)] text-white">Confirm Rebase</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
