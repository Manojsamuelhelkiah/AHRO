import React, { useRef, useState, useMemo } from 'react';
import { 
  useGetOnboardingDemoRun, 
  useApplyOnboardingDemoRunAction, 
  useGetOnboardingDemoController, 
  getGetOnboardingDemoRunQueryKey,
  getListOnboardingCasesQueryKey,
  downloadOnboardingDemoRunDocuments,
  type DemoRun,
  type DemoRunAction,
  type DemoRunActionKind,
  type DemoRunActionSystem,
  type DemoRunActionOutcome,
  type DemoRunActionStep,
  type DemoRunActionChannel
} from '@workspace/api-client-react';
import { useParams, Link, useLocation } from 'wouter';
import { PageHeader, Card, Button, Label, Input } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { 
  Presentation, AlertTriangle, RefreshCw, ChevronRight, CheckCircle, 
  Clock, XCircle, ArrowRight, Save, FileText, Send, Phone, Mail, FileCheck 
} from 'lucide-react';
import { format } from 'date-fns';
import type { DemoControllerVolunteer } from '@workspace/api-client-react';
import * as Dialog from '@radix-ui/react-dialog';
import { getRequestIdForAction } from './action-identity';

export function DemoControllerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  
  const { data: run, isLoading, isError, refetch } = useGetOnboardingDemoRun(id as string, {
    query: { queryKey: getGetOnboardingDemoRunQueryKey(id as string) }
  });

  const applyMutation = useApplyOnboardingDemoRunAction();
  const lastActionAttemptRef = useRef<{ payload: Omit<DemoRunAction, 'requestId'>; requestId: string } | null>(null);
  const [actionError, setActionError] = useState<string|null>(null);
  
  const handleAction = async (payload: Partial<DemoRunAction>) => {
    if (!run) return;
    setActionError(null);
    try {
      const payloadWithoutId = {
         expectedVersion: run.version,
         kind: payload.kind as DemoRunActionKind,
         ...payload
      } as Omit<DemoRunAction, 'requestId'>;

      const { requestId, nextAttempt } = getRequestIdForAction(payloadWithoutId, lastActionAttemptRef.current);
      lastActionAttemptRef.current = nextAttempt;

      const fullPayload = {
         ...payloadWithoutId,
         requestId
      } as DemoRunAction;
      
      const updatedRun = await applyMutation.mutateAsync({ runId: run.runId, data: fullPayload });
      
      // Success -> clear last action attempt so a fresh UI interaction creates a fresh ID
      lastActionAttemptRef.current = null;
      
      // Invalidate relevant queries
      queryClient.invalidateQueries({ queryKey: getListOnboardingCasesQueryKey() });
      
      if (payload.kind === 'restart' && updatedRun.runId !== run.runId) {
          setLocation(`/demo-controller/${updatedRun.runId}`);
      } else {
          queryClient.setQueryData(getGetOnboardingDemoRunQueryKey(updatedRun.runId), updatedRun);
      }
    } catch (err: any) {
      if (err?.response?.status === 409) {
         setActionError("Version mismatch - this run has been updated elsewhere. Please refresh the page to get the latest state.");
      } else {
         setActionError(err?.response?.data?.message || err.message || "Failed to apply action.");
      }
    }
  };

  if (isLoading) return <div className="p-12 text-center text-sm text-[var(--text-muted)]">Loading demo run...</div>;
  if (isError || !run) return (
    <div className="p-12 flex flex-col items-center gap-4">
      <AlertTriangle className="w-8 h-8 text-[var(--status-red)]" />
      <p className="text-sm font-medium">Failed to load demo run.</p>
      <Button variant="outline" onClick={() => refetch()}>Retry</Button>
    </div>
  );

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-20">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
        <Link href="/demo-controller" className="hover:text-[var(--primary)] transition-colors">Demo Center</Link>
        <ChevronRight className="w-3 h-3" />
        <span>Run Control</span>
      </div>

      <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-[var(--radius-lg)] border bg-[var(--surface)] shadow-sm">
        <div>
          <h1 className="text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
            <Presentation className="w-5 h-5 text-[var(--primary)]" />
            {run.caseName || 'Demo Walkthrough'}
          </h1>
          <div className="flex flex-wrap items-center gap-3 mt-2 text-xs font-mono text-[var(--text-muted)]">
            <span className="bg-[var(--surface-alt)] px-2 py-0.5 rounded border">ID: {run.runId.split('-')[0]}...</span>
            <span className="bg-[var(--surface-alt)] px-2 py-0.5 rounded border">
              Case: <Link href={`/cases/${run.caseId}`} className="text-[var(--primary)] hover:underline">{run.caseId}</Link>
            </span>
            <span className="bg-[var(--primary-light)] text-[var(--primary-dark)] px-2 py-0.5 rounded font-bold uppercase">{run.scenario}</span>
            <span className="bg-[var(--surface-alt)] px-2 py-0.5 rounded border flex items-center gap-1">
              <Clock className="w-3 h-3" /> Offset: +{run.clock.offsetHours}h
            </span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider font-semibold mb-0.5">Status</div>
            <div className="text-sm font-bold text-[var(--text-primary)] capitalize">{run.status}</div>
          </div>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
            <RefreshCw className="w-4 h-4" /> Refresh
          </Button>
        </div>
      </header>

      {actionError && (
        <div className="p-3 bg-[var(--status-red-bg)] text-[var(--status-red-fg)] text-sm rounded-md border border-[var(--status-red)] flex items-start gap-3">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="flex-1">{actionError}</div>
          {actionError.includes('Version mismatch') && (
            <Button size="sm" onClick={() => { setActionError(null); refetch(); }}>Refresh Now</Button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 space-y-6">
          <ControlsPanel 
            run={run} 
            onAction={handleAction} 
            isPending={applyMutation.isPending} 
            onError={setActionError}
          />
        </div>
        
        <div className="lg:col-span-7 space-y-6">
          <StateView run={run} />
          <ActivityLog run={run} />
        </div>
      </div>
    </div>
  );
}

// --- Components ---

function ControlsPanel({ run, onAction, isPending, onError }: { run: DemoRun, onAction: (p: Partial<DemoRunAction>) => void, isPending: boolean, onError: (e: string) => void }) {
  
  const [sysName, setSysName] = useState<NonNullable<DemoRunActionSystem>>('bgv');
  const [sysOutcome, setSysOutcome] = useState<NonNullable<DemoRunActionOutcome>>('complete');
  
  const [overrideStep, setOverrideStep] = useState<NonNullable<DemoRunActionStep>>('offer');
  const [overrideReason, setOverrideReason] = useState('');

  const [timeOffset, setTimeOffset] = useState<string>('24');
  
  const [liveConfirm, setLiveConfirm] = useState<{ open: boolean, channel: NonNullable<DemoRunActionChannel> } | null>(null);
  
  const [isDownloading, setIsDownloading] = useState(false);

  const handleDownloadDocs = async () => {
    setIsDownloading(true);
    try {
      const text = await downloadOnboardingDemoRunDocuments(run.runId);
      const blob = new Blob([text], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `synthetic-pack-${run.runId}.txt`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: any) {
      onError("Failed to download documents: " + e.message);
    } finally {
      setIsDownloading(false);
    }
  };

  const volunteer = run.selectedVolunteer;
  
  return (
    <div className="space-y-4">
      <Card className="p-5 border-[var(--border)] bg-[var(--surface)] shadow-sm space-y-5">
        <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Presentation className="w-4 h-4 text-[var(--primary)]" /> Orchestration Controls
        </h3>

        <div className="space-y-2">
          <Label className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Walkthrough</Label>
          <div className="flex flex-col gap-2">
            <Button className="w-full gap-2" disabled={isPending} onClick={() => onAction({ kind: 'advance' })}>
              <ArrowRight className="w-4 h-4" /> Next Step
            </Button>
            <div className="flex flex-col sm:flex-row gap-2">
              <Button variant="outline" className="flex-1 min-w-0 gap-2 truncate" disabled={isPending} onClick={() => onAction({ kind: 'load-documents' })}>
                <FileText className="w-4 h-4 shrink-0" /> <span className="truncate">Load Documents</span>
              </Button>
              <Button variant="outline" className="flex-1 min-w-0 gap-2 truncate border-[var(--primary)] text-[var(--primary)] hover:bg-[var(--primary-light)]" disabled={isPending || isDownloading} onClick={handleDownloadDocs}>
                <FileText className="w-4 h-4 shrink-0" /> 
                <span className="truncate">{isDownloading ? 'Downloading...' : 'Simulated Pack'}</span>
              </Button>
            </div>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-[var(--border)]">
          <Label className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">System Outcomes</Label>
          <div className="flex flex-col sm:flex-row gap-2">
            <select className="flex-1 h-9 min-w-0 rounded-md border border-[var(--border)] px-3 text-sm focus:border-[var(--primary)] outline-none" value={sysName} onChange={e => setSysName(e.target.value as any)}>
              <option value="bgv">Background Check</option>
              <option value="hris">HRIS</option>
              <option value="access">IT Access</option>
              <option value="assets">Assets</option>
              <option value="payroll">Payroll</option>
              <option value="learning">Learning</option>
            </select>
            <select className="flex-1 h-9 min-w-0 rounded-md border border-[var(--border)] px-3 text-sm focus:border-[var(--primary)] outline-none" value={sysOutcome} onChange={e => setSysOutcome(e.target.value as any)}>
              <option value="pending">Pending</option>
              <option value="complete">Complete</option>
              <option value="exception">Exception</option>
              <option value="overdue">Overdue</option>
            </select>
            <Button variant="outline" size="icon" className="shrink-0 w-9 h-9 hidden sm:flex" disabled={isPending} onClick={() => onAction({ kind: 'system-outcome', system: sysName, outcome: sysOutcome })} title="Apply Outcome">
              <Save className="w-4 h-4 text-[var(--primary)]" />
            </Button>
            <Button variant="outline" className="w-full gap-2 sm:hidden text-[var(--primary)]" disabled={isPending} onClick={() => onAction({ kind: 'system-outcome', system: sysName, outcome: sysOutcome })}>
              <Save className="w-4 h-4 text-[var(--primary)]" /> Apply Outcome
            </Button>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-[var(--border)]">
          <Label className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Time Travel</Label>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="flex items-center gap-2">
              <Input type="number" min="1" max="8760" className="w-24 h-9" value={timeOffset} onChange={e => setTimeOffset(e.target.value)} />
              <span className="text-sm text-[var(--text-muted)]">hours</span>
            </div>
            <Button variant="outline" className="flex-1 gap-2" disabled={isPending || !timeOffset || isNaN(Number(timeOffset)) || Number(timeOffset) <= 0 || Number(timeOffset) > 8760} onClick={() => onAction({ kind: 'advance-time', hours: parseInt(timeOffset, 10) })}>
              <Clock className="w-4 h-4 shrink-0" /> <span className="truncate">Fast Forward</span>
            </Button>
          </div>
        </div>

        <div className="space-y-2 pt-2 border-t border-[var(--border)]">
          <Label className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Manual Override</Label>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col sm:flex-row gap-2">
              <select className="flex-1 h-9 min-w-0 rounded-md border border-[var(--border)] px-3 text-sm focus:border-[var(--primary)] outline-none" value={overrideStep} onChange={e => setOverrideStep(e.target.value as any)}>
                <option value="offer">Offer</option>
                <option value="documents">Documents</option>
                <option value="bgv">Background Check</option>
                <option value="systems">Systems</option>
                <option value="hr-approval">HR Approval</option>
                <option value="day1">Day 1</option>
              </select>
              <Input className="flex-[2] min-w-0 h-9" placeholder="Reason (Required)" value={overrideReason} onChange={e => setOverrideReason(e.target.value)} />
            </div>
            <Button variant="outline" className="w-full gap-2" disabled={isPending || !overrideReason.trim()} onClick={() => onAction({ kind: 'override-step', step: overrideStep, reason: overrideReason })}>
              <FileCheck className="w-4 h-4 text-[var(--status-amber)] shrink-0" /> <span className="truncate">Force Override Step</span>
            </Button>
          </div>
        </div>

      </Card>

      <Card className="p-5 border-[var(--border)] bg-[var(--surface)] shadow-sm space-y-4">
        <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
          <Send className="w-4 h-4 text-[var(--violet-fg)]" /> Communications
        </h3>
        
        <div className="text-xs text-[var(--text-muted)] mb-3">
          Simulate generates outcomes without sending. Live uses real APIs to contact the volunteer.
        </div>

        <div className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="w-20 font-medium text-sm text-[var(--text-primary)] flex items-center gap-1.5"><Mail className="w-4 h-4" /> Email</div>
            <div className="flex-1 flex gap-2">
              <Button variant="outline" className="flex-1 text-xs" disabled={isPending} onClick={() => onAction({ kind: 'communication', channel: 'email', mode: 'simulated' })}>
                Simulate
              </Button>
              <Button 
                className="flex-1 text-xs bg-[var(--violet-fg)] hover:bg-[var(--violet)] text-white" 
                disabled={isPending || !volunteer || !volunteer.liveEmailAvailable} 
                onClick={() => setLiveConfirm({ open: true, channel: 'email' })}
              >
                Live Email
              </Button>
            </div>
          </div>
          
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="w-20 font-medium text-sm text-[var(--text-primary)] flex items-center gap-1.5"><Phone className="w-4 h-4" /> Call</div>
            <div className="flex-1 flex gap-2">
              <Button variant="outline" className="flex-1 text-xs" disabled={isPending} onClick={() => onAction({ kind: 'communication', channel: 'call', mode: 'simulated' })}>
                Simulate
              </Button>
              <Button 
                className="flex-1 text-xs bg-[var(--violet-fg)] hover:bg-[var(--violet)] text-white" 
                disabled={isPending || !volunteer || !volunteer.liveCallAvailable} 
                onClick={() => setLiveConfirm({ open: true, channel: 'call' })}
              >
                Live Call
              </Button>
            </div>
          </div>

          {(!volunteer || (!volunteer.liveEmailAvailable && !volunteer.liveCallAvailable)) && (
            <div className="text-[10px] text-[var(--status-amber)] mt-1 font-medium bg-[var(--status-amber-bg)] p-2 rounded border border-[var(--status-amber)] border-opacity-30">
              Live communications disabled: {volunteer ? (volunteer.capabilityReason || 'Volunteer channel restricted.') : 'No approved volunteer selected.'}
            </div>
          )}
        </div>
      </Card>

      <Card className="p-4 border-dashed border-[var(--border-strong)] bg-[var(--surface-alt)] flex items-center justify-between">
         <div className="text-sm font-medium text-[var(--text-primary)]">Restart Demo</div>
         <Button variant="outline" disabled={isPending} onClick={() => onAction({ kind: 'restart' })} className="border-[var(--status-amber)] text-[var(--status-amber)] hover:bg-[var(--status-amber-bg)]">
           Restart Session
         </Button>
      </Card>

      {liveConfirm && (
        <Dialog.Root open={liveConfirm.open} onOpenChange={(open) => !open && setLiveConfirm(null)}>
          <Dialog.Portal>
            <Dialog.Overlay className="fixed inset-0 bg-black/40 z-50 backdrop-blur-sm" />
            <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-[var(--surface)] p-6 rounded-xl shadow-xl z-50 border border-[var(--border)]">
              <Dialog.Title className="text-lg font-bold text-[var(--text-primary)] flex items-center gap-2 mb-2">
                <AlertTriangle className="w-5 h-5 text-[var(--status-red)]" /> Confirm Live {liveConfirm.channel === 'email' ? 'Email' : 'Call'}
              </Dialog.Title>
              <div className="text-sm text-[var(--text-secondary)] space-y-3 mt-4">
                <p>You are about to execute a <strong>LIVE</strong> communication. Real API requests will be dispatched.</p>
                <div className="bg-[var(--surface-alt)] border border-[var(--border)] p-3 rounded text-sm font-medium">
                   <strong>Recipient:</strong> {volunteer?.name}<br/>
                   <strong>Contact:</strong> {liveConfirm.channel === 'email' ? volunteer?.email : volunteer?.phone || 'Unknown'}
                </div>
                <p className="text-[var(--status-red)] text-xs font-semibold">Do not use real PII. This action cannot be undone.</p>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                <Button variant="outline" onClick={() => setLiveConfirm(null)}>Cancel</Button>
                <Button 
                  className="bg-[var(--status-red)] hover:bg-red-700 text-white" 
                  onClick={() => {
                    onAction({ 
                      kind: 'communication', 
                      channel: liveConfirm.channel, 
                      mode: 'live', 
                      liveConfirmation: 'I_UNDERSTAND_LIVE_DEMO' 
                    });
                    setLiveConfirm(null);
                  }}
                >
                  I Understand, Send Live
                </Button>
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </div>
  );
}

function StateView({ run }: { run: DemoRun }) {
  return (
    <Card className="border-[var(--border)] bg-[var(--surface)] shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-alt)]">
        <h3 className="font-semibold text-[var(--text-primary)]">System & Checkpoint State</h3>
      </div>
      
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
           <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-3">Workflow Checkpoints</div>
           <div className="space-y-2 border-l-2 border-[var(--border-strong)] ml-2 pl-4 py-1">
             {run.checkpoints.map(cp => {
               const isComplete = cp.status === 'completed' || cp.status === 'overridden';
               const isBlocked = cp.status === 'blocked';
               let icon = <div className="w-2.5 h-2.5 rounded-full bg-[var(--border-strong)]" />;
               if (isComplete) icon = <CheckCircle className="w-4 h-4 text-[var(--status-green)]" />;
               if (isBlocked) icon = <XCircle className="w-4 h-4 text-[var(--status-red)]" />;

               return (
                 <div key={cp.key} className="relative flex items-start gap-3">
                    <div className="absolute -left-[25px] top-0.5 bg-[var(--surface)] p-0.5">
                      {icon}
                    </div>
                    <div>
                      <div className={`text-sm font-medium ${isComplete ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                        {cp.key}
                      </div>
                      <div className="text-[10px] uppercase font-bold text-[var(--text-muted)]">
                        {cp.status}
                      </div>
                      {cp.reason && <div className="text-xs text-[var(--status-amber)] mt-0.5">{cp.reason}</div>}
                    </div>
                 </div>
               )
             })}
           </div>
        </div>

        <div>
           <div className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-3">Connected Systems</div>
           <div className="space-y-2">
             {run.systems.map(sys => {
                let statusColor = 'var(--text-muted)';
                if (sys.status === 'complete') statusColor = 'var(--status-green)';
                if (sys.status === 'exception' || sys.status === 'overdue') statusColor = 'var(--status-red)';
                
                return (
                  <div key={sys.system} className="flex items-center justify-between p-2 rounded border border-[var(--border)] bg-[var(--surface-alt)]">
                     <span className="text-sm font-medium text-[var(--text-primary)] capitalize">{sys.system}</span>
                     <div className="flex items-center gap-2">
                        {sys.simulated && <span className="text-[9px] uppercase font-bold text-[var(--primary)] bg-[var(--primary-light)] px-1.5 py-0.5 rounded">SIM</span>}
                        <span className="text-[10px] uppercase font-bold" style={{ color: statusColor }}>{sys.status}</span>
                     </div>
                  </div>
                )
             })}
           </div>
        </div>
      </div>
    </Card>
  );
}

function ActivityLog({ run }: { run: DemoRun }) {
  // Sort descending by time
  const activities = [...run.activity].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  return (
    <Card className="border-[var(--border)] bg-[var(--surface)] shadow-sm flex flex-col max-h-[600px]">
      <div className="px-5 py-4 border-b border-[var(--border)] bg-[var(--surface-alt)] shrink-0">
        <h3 className="font-semibold text-[var(--text-primary)]">Audit Trail & Evidence</h3>
      </div>
      <div className="p-5 overflow-y-auto flex-1 space-y-4">
        {activities.length === 0 ? (
           <div className="text-center text-sm text-[var(--text-muted)] py-8">No activity recorded yet.</div>
        ) : (
          activities.map(act => (
            <div key={act.id} className="flex gap-3 text-sm">
               <div className="w-16 shrink-0 text-right pt-0.5 text-xs text-[var(--text-muted)] font-mono">
                 {format(new Date(act.at), 'HH:mm')}
               </div>
               <div className="flex-1 space-y-1.5 pb-4 border-b border-[var(--border)]">
                 <div className="flex items-start justify-between gap-2">
                   <div className="font-medium text-[var(--text-primary)] whitespace-pre-wrap break-words">{act.message}</div>
                   <span className={`shrink-0 text-[9px] uppercase font-bold px-1.5 py-0.5 rounded border ${act.provenance === 'live' ? 'bg-[var(--status-red-bg)] text-[var(--status-red)] border-[var(--status-red)]' : 'bg-[var(--surface-alt)] text-[var(--text-secondary)] border-[var(--border)]'}`}>
                     {act.provenance}
                   </span>
                 </div>
                 
                 <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                   <span className="font-medium">{act.actor}</span>
                   <span>•</span>
                   <span className="font-mono">{act.kind}</span>
                   {act.providerStatus && (
                     <>
                       <span>•</span>
                       <span className="text-[var(--status-amber)] font-mono bg-[var(--status-amber-bg)] px-1 rounded">{act.providerStatus}</span>
                     </>
                   )}
                 </div>

                 {act.transcript && (
                   <pre className="mt-2 p-2 bg-[var(--surface-alt)] border border-[var(--border)] rounded text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                     {act.transcript}
                   </pre>
                 )}
               </div>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}
