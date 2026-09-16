import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetOnboardingCaseSimulation,
  getGetOnboardingCaseSimulationQueryKey,
  useSimulateNextOnboardingCaseExchange,
  useRestartOnboardingCaseSimulation,
  useSendOnboardingCaseSimulationEmail,
  getListOnboardingCaseEventsQueryKey,
  getListOnboardingCaseCommunicationsQueryKey
} from '@workspace/api-client-react';
import { AlertTriangle, Play, RefreshCw, CheckCircle2, MessageSquare, ArrowRight, Bot, Mail } from 'lucide-react';
import { cn } from '@/components/ui-shared';

export function SimulationPanel({ caseId, recipientEmail }: { caseId: number; recipientEmail?: string | null }) {
  const queryClient = useQueryClient();
  const { data: simState, error, isLoading, refetch } = useGetOnboardingCaseSimulation(caseId, {
    query: {
      queryKey: getGetOnboardingCaseSimulationQueryKey(caseId),
      retry: false,
      refetchInterval: 15000,
    }
  });

  const simulateMutation = useSimulateNextOnboardingCaseExchange();
  const restartMutation = useRestartOnboardingCaseSimulation();
  const emailMutation = useSendOnboardingCaseSimulationEmail();
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [confirmEmail, setConfirmEmail] = useState(false);

  if (isLoading) {
    return (
      <div className="animate-pulse h-32 bg-[var(--surface)] border border-[var(--border)] rounded-lg mb-6 flex items-center justify-center text-[var(--text-muted)] text-sm shadow-sm">
        <RefreshCw className="h-4 w-4 animate-spin mr-2" /> Checking simulation environment...
      </div>
    );
  }

  if (error) {
    const status = (error as any)?.status ?? (error as any)?.response?.status;
    if (status === 403) return null; // Server returns 403 for non-admin profiles
    return (
      <div className="mb-6 p-4 rounded-lg border border-[var(--status-red)] bg-[var(--status-red-bg)] flex items-start gap-3 shadow-sm">
        <AlertTriangle className="h-5 w-5 text-[var(--status-red-fg)] shrink-0 mt-0.5" />
        <div>
          <h3 className="text-sm font-bold text-[var(--status-red-fg)]">Simulation Error</h3>
          <p className="text-xs text-[var(--status-red-fg)] opacity-90 mt-1">Failed to load response-driven simulation state.</p>
          <button onClick={() => refetch()} className="mt-2 text-xs font-semibold text-[var(--status-red-fg)] hover:underline">Retry</button>
        </div>
      </div>
    );
  }

  if (!simState) return null;

  const handleSimulate = () => {
    const requestStorageKey = `onboarding-case-simulation-advance-v2:${caseId}:${simState.generationId}`;
    const data = pendingRequest(requestStorageKey, simState);
    simulateMutation.mutate({
      caseId,
      data,
    }, {
      onSuccess: (newData) => {
        window.sessionStorage.removeItem(requestStorageKey);
        simulateMutation.reset();
        queryClient.setQueryData(getGetOnboardingCaseSimulationQueryKey(caseId), newData);
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
      },
      onError: (err: any) => {
        if ((err?.status ?? err?.response?.status) === 409) {
          void refetch().finally(() => simulateMutation.reset());
          window.sessionStorage.removeItem(requestStorageKey);
        }
      }
    });
  };

  const handleRestart = () => {
    const key = `onboarding-case-simulation-restart-v2:${caseId}`;
    const data = pendingRequest(key, simState);
    restartMutation.mutate({
      caseId,
      data,
    }, {
      onSuccess: (newData) => {
        window.sessionStorage.removeItem(key);
        setConfirmRestart(false);
        simulateMutation.reset();
        restartMutation.reset();
        queryClient.setQueryData(getGetOnboardingCaseSimulationQueryKey(caseId), newData);
        void queryClient.invalidateQueries({ queryKey: getGetOnboardingCaseSimulationQueryKey(caseId) });
        void queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
        void queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
      },
      onError: (err: any) => {
        if ((err?.status ?? err?.response?.status) === 409) {
          window.sessionStorage.removeItem(key);
          setConfirmRestart(false);
          void refetch();
        }
      },
    });
  };
  const handleSendEmail = () => {
    const key = `onboarding-case-simulation-email-v1:${caseId}:${simState.generationId}`;
    const data = pendingRequest(key, simState);
    emailMutation.mutate({ caseId, data }, {
      onSuccess: (newData) => {
        window.sessionStorage.removeItem(key);
        setConfirmEmail(false);
        emailMutation.reset();
        queryClient.setQueryData(getGetOnboardingCaseSimulationQueryKey(caseId), newData);
        void queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
        void queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
      },
      onError: (err: any) => {
        if ((err?.status ?? err?.response?.status) === 409) {
          window.sessionStorage.removeItem(key);
          setConfirmEmail(false);
          void refetch();
        }
      },
    });
  };
  const busy = simulateMutation.isPending || restartMutation.isPending || emailMutation.isPending;
  const isComplete = simState.status === 'completed';

  return (
    <div className="border border-[var(--border)] rounded-lg bg-[var(--surface)] shadow-sm mb-6 overflow-hidden flex flex-col">
      <div className="bg-[var(--surface-alt)] border-b border-[var(--border)] px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Bot className="h-5 w-5 text-[var(--primary)]" />
            <h3 className="font-bold text-[var(--text-primary)] text-sm">Response-Driven Simulation</h3>
            <span className="bg-[var(--primary-light-bg)] text-[var(--primary-dark)] border border-[var(--primary)] border-opacity-30 text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full shadow-sm">
              Simulated State
            </span>
          </div>
            <p className="text-xs text-[var(--text-muted)] font-medium">Business outcomes are always simulated. Optional prompt delivery uses only the pinned Demo volunteer.</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <button
            onClick={() => { restartMutation.reset(); setConfirmRestart(true); }}
            disabled={busy || confirmRestart}
            className="text-xs font-bold border border-[var(--border)] rounded-md px-3 py-1.5 disabled:opacity-50"
          >
            Restart simulation
          </button>
          <button
            onClick={() => { emailMutation.reset(); setConfirmEmail(true); }}
            disabled={busy || confirmRestart || !recipientEmail || isComplete}
            className={cn(
              "flex items-center gap-1.5 border border-[var(--primary)] text-[var(--primary-dark)] px-3 py-1.5 rounded-md text-xs font-bold transition-all",
              busy || confirmRestart || !recipientEmail || isComplete ? "opacity-50 cursor-not-allowed" : "hover:bg-[var(--primary-light)]",
            )}
            title={recipientEmail ? `Pinned approved Demo volunteer: ${recipientEmail}` : "Select an approved Demo volunteer in Demo Controller first"}
          >
            <Mail className="h-3.5 w-3.5" /> Email current prompt
          </button>
          {isComplete && (
            <span className="text-xs font-semibold text-[var(--status-green-fg)] bg-[var(--status-green-bg)] px-2 py-1 rounded border border-[var(--status-green)] border-opacity-20 flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" /> Simulation Complete
            </span>
          )}
          <button
            onClick={handleSimulate}
            disabled={busy || confirmRestart || isComplete}
            className={cn(
              "flex items-center gap-1.5 text-white px-3 py-1.5 rounded-md text-xs font-bold transition-all shadow-sm",
              busy || confirmRestart || isComplete 
                ? "bg-[var(--status-gray)] opacity-50 cursor-not-allowed" 
                : "bg-[var(--primary)] hover:bg-[var(--primary-dark)] hover:shadow-md active:scale-95"
            )}
          >
            {simulateMutation.isPending ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
            {simulateMutation.isPending ? 'Simulating...' : 'Simulate next exchange'}
          </button>
        </div>
        <div className="text-[10px] text-[var(--text-muted)] mt-2">
          {recipientEmail
            ? <>Controlled real-email recipient (revalidated before send): <strong>{recipientEmail}</strong>. Gmail replies are polled by the server.</>
            : <>Setup required: pin an approved Demo volunteer in Demo Controller before real-email simulation is available.</>}
        </div>
      </div>
      {confirmRestart && (
        <div role="alertdialog" aria-label="Restart simulation?" aria-describedby="restart-simulation-description" className="p-4 border-b border-[var(--border)] bg-[var(--surface-alt)] space-y-3">
          <h4 className="font-bold text-sm">Restart simulation at offer?</h4>
          <p id="restart-simulation-description" className="text-xs text-[var(--text-secondary)]">
            This retires the current simulated progression and starts a new generation at offer.
            Prior simulated exchanges remain in history, including Communications and the case timeline.
            The underlying offline case is unchanged. No messages are sent and no live provider state is changed.
          </p>
          <div className="flex gap-3">
            <button onClick={() => setConfirmRestart(false)} disabled={busy} className="text-xs font-semibold disabled:opacity-50">Cancel</button>
            <button onClick={handleRestart} disabled={busy} className="text-xs font-bold bg-[var(--primary)] text-white rounded-md px-3 py-2 disabled:opacity-50">
              {restartMutation.isPending ? 'Restarting...' : 'Confirm restart'}
            </button>
          </div>
        </div>
      )}
      {confirmEmail && (
        <div role="alertdialog" aria-label="Send simulated prompt by email?" className="p-4 border-b border-[var(--border)] bg-[var(--primary-light-bg)] space-y-3">
          <h4 className="font-bold text-sm">Send the current simulated prompt by real email?</h4>
          <p className="text-xs text-[var(--text-secondary)]">
            Delivery is real, but the recipient is restricted to the currently pinned approved Demo volunteer and the result remains simulated-only.
            {recipientEmail ? <> Recipient: <strong>{recipientEmail}</strong>.</> : ' No approved volunteer is pinned.'}
            {' '}No readiness, authority, lifecycle, provider evidence, SLA, or KPI state will change. Replies are monitored from Gmail and never accepted from this panel.
          </p>
          <div className="flex gap-3">
            <button onClick={() => setConfirmEmail(false)} disabled={busy} className="text-xs font-semibold disabled:opacity-50">Cancel</button>
            <button onClick={handleSendEmail} disabled={busy || !recipientEmail} className="text-xs font-bold bg-[var(--primary)] text-white rounded-md px-3 py-2 disabled:opacity-50">
              {emailMutation.isPending ? 'Sending...' : 'Confirm real email send'}
            </button>
          </div>
        </div>
      )}
      {restartMutation.isError && (
        <div role="alert" className="px-4 py-3 text-xs text-[var(--status-red-fg)] bg-[var(--status-red-bg)]">
          {((restartMutation.error as any)?.status ?? (restartMutation.error as any)?.response?.status) === 409
            ? 'Simulation changed elsewhere. Review the refreshed state before restarting.'
            : 'Simulation could not be restarted. Retry the confirmation or refresh the page.'}
        </div>
      )}
      
      {simulateMutation.isError && (
        <div className="px-4 py-2 bg-[var(--status-red-bg)] border-b border-[var(--status-red)] border-opacity-20 text-xs text-[var(--status-red-fg)] flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-medium">
            <AlertTriangle className="h-4 w-4"/> 
            {((simulateMutation.error as any)?.status ?? (simulateMutation.error as any)?.response?.status) === 409
              ? 'Simulation state modified elsewhere. Refreshing...'
              : 'Simulation failed to advance. Please retry.'}
          </span>
          {(((simulateMutation.error as any)?.status ?? (simulateMutation.error as any)?.response?.status) !== 409) && (
            <button onClick={handleSimulate} disabled={busy || confirmRestart} className="underline font-bold hover:text-[var(--status-red)] disabled:opacity-50">Retry Action</button>
          )}
        </div>
      )}
      {emailMutation.isError && (
        <div role="alert" className="px-4 py-2 bg-[var(--status-red-bg)] border-b border-[var(--status-red)] border-opacity-20 text-xs text-[var(--status-red-fg)]">
          {(emailMutation.error as any)?.message || 'The controlled Demo email could not be sent. An uncertain delivery is never retried automatically.'}
        </div>
      )}
      {emailMutation.data?.emailDelivery && (
        <div className="px-4 py-2 bg-[var(--status-info-bg)] border-b border-[var(--status-info-fg)] border-opacity-20 text-xs text-[var(--status-info-fg)]">
          <strong>Real delivery:</strong> {emailMutation.data.emailDelivery.status} to {emailMutation.data.emailDelivery.recipient}.
          {' '}<strong>Business result:</strong> simulated-only; awaiting a monitored Gmail reply.
        </div>
      )}

      <div className="p-0 max-h-[600px] overflow-y-auto bg-[var(--surface-soft)]">
        {!simState.exchanges || simState.exchanges.length === 0 ? (
          <div className="p-12 text-center text-sm text-[var(--text-muted)] font-medium bg-[var(--surface)]">
            <Bot className="h-8 w-8 text-[var(--border-strong)] mx-auto mb-3" />
            No simulated exchanges yet.<br/>
            Click &quot;Simulate next exchange&quot; to begin the scenario.
          </div>
        ) : (
          <div className="divide-y divide-[var(--border)] flex flex-col">
            {/* Show the newest exchanges first */}
            {[...simState.exchanges].reverse().map((ex: any) => (
              <ExchangeRecord key={ex.sequence} exchange={ex} />
            ))}
          </div>
        )}
      </div>
      <div className="bg-[var(--surface-alt)] border-t border-[var(--border)] px-4 py-2 text-[10px] text-[var(--text-muted)] font-semibold flex justify-between">
        <span>Generation: {simState.generationId} · Version: {simState.version}</span>
        <span>Stage: {simState.stage}</span>
      </div>
    </div>
  );
}

function pendingRequest(key: string, state: { version: number; generationId: string }) {
  const saved = window.sessionStorage.getItem(key);
  if (saved) {
    try {
      const value = JSON.parse(saved);
      if (typeof value.requestId === 'string' && typeof value.expectedGenerationId === 'string'
        && Number.isInteger(value.expectedVersion)) return value as {
          requestId: string; expectedGenerationId: string; expectedVersion: number;
        };
    } catch { /* Replace an invalid local request, never simulation history. */ }
  }
  const data = { requestId: crypto.randomUUID(), expectedGenerationId: state.generationId, expectedVersion: state.version };
  window.sessionStorage.setItem(key, JSON.stringify(data));
  return data;
}

function ExchangeRecord({ exchange }: { exchange: any }) {
  return (
    <div className="p-4 bg-[var(--surface)] hover:bg-[var(--surface-alt)] transition-colors">
      <div className="flex justify-between items-start mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-mono font-bold text-[var(--text-primary)] bg-[var(--surface-soft)] border border-[var(--border)] px-1.5 py-0.5 rounded shadow-sm">
            SEQ {String(exchange.sequence).padStart(2, '0')}
          </span>
          <span className="text-xs font-bold text-[var(--text-primary)] uppercase tracking-wider bg-[var(--primary-light)] text-[var(--primary-dark)] px-2 py-0.5 rounded-full border border-[var(--primary)] border-opacity-20">
            {exchange.transition || 'EXCHANGE'}
          </span>
          {exchange.reviewRequired && (
            <span className="text-[10px] uppercase font-bold text-[var(--status-amber-fg)] bg-[var(--status-amber-bg)] px-2 py-0.5 rounded-full border border-[var(--status-amber)] border-opacity-30">
              Review Required
            </span>
          )}
        </div>
        <div className="text-[10px] text-[var(--text-muted)] text-right font-medium whitespace-nowrap ml-2">
          {exchange.recordedAt ? new Date(exchange.recordedAt).toLocaleString(undefined, { 
            month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' 
          }) : 'Unknown Time'}
        </div>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="space-y-4">
          <div>
            <h4 className="text-[10px] uppercase tracking-wider font-bold text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5">
              <MessageSquare className="h-3 w-3"/> 
              Simulated Outbound (To {exchange.responderLabel || 'User'})
            </h4>
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-md p-2.5 text-xs text-[var(--text-primary)] leading-relaxed shadow-sm font-medium whitespace-pre-wrap">
              {exchange.requestText || <span className="italic text-[var(--text-muted)] font-normal">No outbound message</span>}
            </div>
          </div>
          <div>
            <h4 className="text-[10px] uppercase tracking-wider font-bold text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5">
              <MessageSquare className="h-3 w-3"/> 
              Simulated Inbound (From {exchange.responderLabel || 'User'})
            </h4>
            <div className="bg-[var(--status-info-bg)] border border-[var(--status-info-fg)] border-opacity-20 rounded-md p-2.5 text-xs text-[var(--status-info-fg)] leading-relaxed shadow-sm font-medium whitespace-pre-wrap">
              {exchange.responseText || <span className="italic opacity-60 font-normal">No reply recorded</span>}
            </div>
          </div>
        </div>
        <div className="space-y-4">
          <div>
            <h4 className="text-[10px] uppercase tracking-wider font-bold text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5">
              <Bot className="h-3 w-3"/> 
               Recorded routing decision
            </h4>
            <div className="bg-[var(--surface-soft)] border border-[var(--border-strong)] rounded-md p-2.5 text-[11px] text-[var(--text-primary)] leading-relaxed shadow-inner">
               {exchange.decisionExplanation || <span className="italic text-[var(--text-muted)]">No routing explanation recorded</span>}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-md p-2.5 shadow-sm">
              <h4 className="text-[9px] uppercase tracking-wider font-bold text-[var(--text-muted)] mb-1">Next Action</h4>
              <p className="text-xs font-bold text-[var(--primary-dark)] truncate" title={exchange.nextAction || 'None'}>
                {exchange.nextAction || 'None'}
              </p>
            </div>
            <div className="bg-[var(--surface)] border border-[var(--border)] rounded-md p-2.5 shadow-sm">
              <h4 className="text-[9px] uppercase tracking-wider font-bold text-[var(--text-muted)] mb-1">Outcome</h4>
              <p className="text-xs font-bold text-[var(--text-primary)] truncate" title={exchange.outcome || 'None'}>
                {exchange.outcome || 'None'}
              </p>
            </div>
          </div>
          {exchange.stageBefore && exchange.stageAfter && exchange.stageBefore !== exchange.stageAfter && (
            <div className="flex items-center gap-2 text-[11px] font-medium text-[var(--text-secondary)] bg-[var(--surface-alt)] border border-[var(--border)] p-2 rounded-md shadow-sm">
              <span className="text-[var(--text-muted)] truncate max-w-[120px]" title={exchange.stageBefore}>{exchange.stageBefore}</span>
              <ArrowRight className="h-3 w-3 text-[var(--primary)] shrink-0" />
              <span className="text-[var(--text-primary)] font-bold truncate max-w-[120px]" title={exchange.stageAfter}>{exchange.stageAfter}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
