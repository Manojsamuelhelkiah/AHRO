import React, { useRef, useState } from 'react';
import { format } from 'date-fns';
import { 
  Play, FastForward, CheckCircle2, AlertTriangle, RotateCcw, MonitorPlay, Mail, Bot, UserRound, Clock3
} from 'lucide-react';
import { Link } from 'wouter';
import { Card, CardHeader, CardTitle, CardContent, Button, cn, Input } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { 
  OnbOperationalRequestsEnvelope, 
  OnbOperationalRequest,
  useInitializeOnboardingOperationalRequests,
  useApplyOnboardingOperationalRequestAction,
  getListOnboardingCaseCommunicationsQueryKey,
  getListOnboardingCaseEventsQueryKey,
  getGetOnboardingOperationalRequestsQueryKey
} from '@workspace/api-client-react';
import { useOrganizationRole } from '../../../hooks/use-organization-role';

export function OperationalRequestsSection({ caseId, requestsEnv, loadError }: { caseId: number, requestsEnv?: OnbOperationalRequestsEnvelope, loadError?: boolean }) {
  const queryClient = useQueryClient();
  const initRequests = useInitializeOnboardingOperationalRequests();
  const { isHR: isAdministrator, role, organizationId, loading: roleLoading } = useOrganizationRole();
  const isHR = isAdministrator || (role === 'member' && organizationId === 'demo');
  
  const [error, setError] = useState<string | null>(null);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: getGetOnboardingOperationalRequestsQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
    queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
  };

  const handleInit = () => {
    setError(null);
    initRequests.mutate({ caseId, data: {} }, {
      onSuccess: () => invalidateAll(),
      onError: (err: any) => {
        setError(err?.data?.message || err?.data?.error || err?.message || 'Failed to initialize requests.');
        if (err?.status === 409) invalidateAll();
      }
    });
  };

  if (!requestsEnv) {
    return <Card><CardContent className="p-5 text-sm" role={loadError ? 'alert' : 'status'}>
      {loadError ? 'Operational requests could not be loaded.' : 'Loading operational requests…'}
      {loadError && <Button variant="outline" className="ml-3" onClick={invalidateAll}>Try again</Button>}
    </CardContent></Card>;
  }

  const { requests, offlinePaused, version } = requestsEnv;
  const humanTaskCount = requests.filter((request) => request.method === 'human-task').length;

  if (requests.length === 0) {
    return (
      <Card className="border-[var(--border)] shadow-sm">
        <CardContent className="p-8 flex flex-col items-center justify-center text-center space-y-4">
          <MonitorPlay className="w-10 h-10 text-[var(--text-muted)]" />
          <div>
            <h3 className="text-[var(--text-base)] font-bold">Operational requests & accountable human tasks</h3>
            <p className="text-[var(--text-sm)] text-[var(--text-secondary)] max-w-md mx-auto mt-2 leading-relaxed">
              This case currently has no operational requests tracking. Initialization can create only existing operational simulation requests and declared accountable human tasks.
            </p>
          </div>
          <Button 
            variant="outline" 
            onClick={handleInit}
            disabled={initRequests.isPending || !isHR || roleLoading || offlinePaused}
            title={!isHR ? 'Only HR can initialize simulation' : undefined}
          >
            Initialize requests
          </Button>
          {!isHR && !roleLoading && (
            <p className="text-xs text-[var(--text-muted)] font-medium">An organization administrator is needed to manage these requests outside Demo Organization.</p>
          )}
          {offlinePaused && <p className="text-sm text-[var(--text-muted)]">This offline sample remains paused. No new requests will be created.</p>}
          {error && <p className="text-sm text-[var(--status-red)]">{error}</p>}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-[var(--border)] shadow-[var(--shadow-sm)]">
      <CardHeader className="pb-4 border-b bg-[var(--surface-alt)]">
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
          <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
            <MonitorPlay className="h-5 w-5 text-[var(--violet)]" /> 
             {humanTaskCount ? 'Operational requests & human tasks' : 'Simulated Operational Requests'}
          </CardTitle>
          <span className="text-[10px] sm:text-xs px-2 py-1 rounded border border-[var(--violet)] text-[var(--violet-fg)] bg-[var(--violet-light-bg)] font-bold tracking-wider uppercase self-start sm:self-auto shrink-0">
             {humanTaskCount ? `${humanTaskCount} HUMAN TASK${humanTaskCount === 1 ? '' : 'S'}` : 'SIMULATED'}
          </span>
        </div>
        <p className="text-xs text-[var(--text-muted)] mt-3 leading-relaxed max-w-3xl">
           Simulated requests never verify real operational completion. Workforce learning tasks are accountable human work only: they do not send communication, invoke an LMS, calendar, AI agent, or provider.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-[var(--border)]">
          {requests.map(req => (
            <RequestItem 
              key={req.id} 
              req={req} 
              version={version} 
              caseId={caseId} 
              offlinePaused={offlinePaused}
              isHR={isHR}
              roleLoading={roleLoading}
              onSuccess={invalidateAll}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function RequestItem({ 
  req, 
  version, 
  caseId, 
  offlinePaused,
  isHR,
  roleLoading,
  onSuccess 
}: { 
  req: OnbOperationalRequest, 
  version: number,
  caseId: number, 
  offlinePaused: boolean,
  isHR: boolean,
  roleLoading: boolean,
  onSuccess: () => void 
}) {
  const queryClient = useQueryClient();
  const applyAction = useApplyOnboardingOperationalRequestAction();
  const [error, setError] = useState<string | null>(null);
  const [continuationPending, setContinuationPending] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [isPromptingAction, setIsPromptingAction] = useState<string | null>(null);
  const attemptIds = useRef(new Map<string, string>());
  
  const doAction = (action: string, method?: string, providedReason?: string) => {
    setError(null);
    const actualReason = providedReason ?? reason;
    const fingerprint = JSON.stringify([caseId, req.id, action, method ?? null, version, actualReason]);
    if (!attemptIds.current.has(fingerprint)) attemptIds.current.set(fingerprint, crypto.randomUUID());
    const payloadKey = attemptIds.current.get(fingerprint)!;
    
    applyAction.mutate({
      caseId,
      requestId: req.id,
      data: {
        requestId: payloadKey, // stable tracking
        action: action as any,
        method: method as any,
        reason: actualReason ? actualReason : undefined,
        expectedVersion: version
      }
    }, {
      onSuccess: (result) => {
        setIsPromptingAction(null);
        setReason('');
        setContinuationPending(result.continuationPending === true);
        onSuccess();
      },
      onError: (err: any) => {
        setError(err?.data?.message || err?.data?.error || err?.message || `Action ${action} failed`);
        if (err?.status === 409) {
          queryClient.invalidateQueries({ queryKey: getGetOnboardingOperationalRequestsQueryKey(caseId) });
        }
      }
    });
  };

  const handlePromptSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isPromptingAction) {
      doAction(isPromptingAction);
    }
  };

  const canStart = req.status === 'requested';
  const canSelectMethod = req.status === 'requested' && req.method !== 'human-task';
  const canProgress = req.status === 'in-progress';
  const canComplete = req.status === 'in-progress';
  const canBlock = req.status === 'in-progress';
  const canRetry = req.status === 'blocked';

  // Human-task authorization is determined by the server from the signed-in
  // tenant user, the named assignment, and scoped authority.  Members may
  // attempt those actions; an unrelated admin is still denied server-side.
  const canAttemptAction = req.method === 'human-task' || isHR;
  const disabled = offlinePaused || applyAction.isPending || !canAttemptAction || roleLoading;
  const authorizationHint = req.method === 'human-task'
    ? 'Available to the named assignee or designated specialist; the server verifies your signed-in tenant identity.'
    : !isHR ? 'Only organization owners and admins can act on simulated operational requests.' : undefined;

  return (
    <div className="p-4 sm:p-6 hover:bg-[var(--surface-alt)] transition-colors">
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4 mb-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <h4 className="font-bold text-sm sm:text-base text-[var(--text-primary)] break-words">{req.label}</h4>
            <span className={cn("text-[10px] sm:text-xs font-bold px-2 py-1 rounded tracking-wider uppercase border", 
              req.status === 'completed' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)] border-[var(--status-green)]' :
              req.status === 'blocked' ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border-[var(--status-red)]' :
              req.status === 'in-progress' ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-[var(--status-amber)]' :
              'bg-[var(--surface-soft)] text-[var(--text-muted)] border-[var(--border)]'
            )}>
              {req.status}
            </span>
            <span className="font-mono text-[10px] sm:text-xs text-[var(--text-muted)] px-2 py-1 border border-[var(--border)] rounded bg-[var(--surface)] break-all">
              {req.reference}
            </span>
          </div>
          <div className="flex flex-col sm:flex-row sm:flex-wrap items-start sm:items-center gap-3 text-xs text-[var(--text-secondary)]">
            <span className="break-all"><strong className="text-[var(--text-muted)] mr-1">Owner:</strong>{req.owner}</span>
            <span className="break-all"><strong className="text-[var(--text-muted)] mr-1">Team:</strong>{req.teamRecipientLabel}</span>
            <span className="flex items-center gap-1.5 break-all flex-wrap">
              <strong className="text-[var(--text-muted)]">Method:</strong> 
               {req.method === 'email' ? <Mail className="w-3.5 h-3.5" /> : req.method === 'human-task' ? <UserRound className="w-3.5 h-3.5" /> : <Bot className="w-3.5 h-3.5" />}
               {req.method === 'human-task' ? 'Accountable human task' : req.method === 'email' ? 'Email' :
                req.agentIdentity ? (
                  <span className="inline-flex flex-wrap items-center gap-1">
                    <Link href={`/agents#${req.agentIdentity.id}`} className="text-[var(--primary)] hover:underline font-semibold">
                      {req.agentIdentity.name}
                    </Link>
                    {req.agentIdentity.origin === 'internal' ? (
                      <span className="text-[9px] bg-[var(--violet-light-bg)] text-[var(--violet-fg)] border border-[var(--violet)] px-1 rounded uppercase tracking-wider font-bold" title="Internal Simulated Agent">Internal</span>
                    ) : (
                      <span className="text-[9px] bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border border-[var(--status-amber)] px-1 rounded uppercase tracking-wider font-bold" title="External Agent">External</span>
                    )}
                  </span>
                ) : 'AI agent — identity unavailable'
              }
            </span>
          </div>
           {req.method === 'human-task' && <div className="mt-3 flex flex-wrap gap-1.5 text-[11px]">
             {req.responsibleRole && <span className="rounded bg-[var(--surface-soft)] px-2 py-1"><strong>Role:</strong> {req.responsibleRole}</span>}
             {req.assignedTo && <span className="rounded bg-[var(--surface-soft)] px-2 py-1"><strong>Assignee:</strong> {req.assignedTo}</span>}
             {req.mandatory && <span className="rounded bg-[var(--status-red-bg)] px-2 py-1 font-semibold text-[var(--status-red-fg)]">Mandatory</span>}
             {req.evidenceRequired && <span className="rounded bg-[var(--status-amber-bg)] px-2 py-1 font-semibold text-[var(--status-amber-fg)]">Evidence note required</span>}
             {req.nonblocking && <span className="rounded bg-[var(--surface-alt)] px-2 py-1">Nonblocking</span>}
             {req.parallelGroup && <span className="rounded bg-[var(--surface-alt)] px-2 py-1">Parallel group: {req.parallelGroup}</span>}
             {!!req.prerequisites?.length && <span className="rounded bg-[var(--surface-alt)] px-2 py-1">After: {req.prerequisites.join(', ')}</span>}
             {!!req.permittedChannels?.length && <span className="rounded bg-[var(--surface-alt)] px-2 py-1">Permitted: {req.permittedChannels.join(', ')}</span>}
             {req.notBeforeAt && <span className="rounded bg-[var(--surface-alt)] px-2 py-1">Not before {format(new Date(req.notBeforeAt), 'MMM d, HH:mm')}</span>}
             {req.dueAt && <span className={cn('rounded px-2 py-1', req.overdue ? 'bg-[var(--status-red-bg)] font-semibold text-[var(--status-red-fg)]' : 'bg-[var(--surface-alt)]')}><Clock3 className="mr-1 inline h-3 w-3" />Due {format(new Date(req.dueAt), 'MMM d, HH:mm')}{req.overdue ? ' · overdue' : ''}</span>}
             {req.escalationRequired && <span className="rounded bg-[var(--status-red-bg)] px-2 py-1 font-semibold text-[var(--status-red-fg)]">Escalation required: {req.escalation?.responsibleRole}</span>}
           </div>}
        </div>
        <div className="flex flex-col gap-2 shrink-0">
          <div className="flex flex-wrap items-center xl:justify-end gap-2">
            {canSelectMethod && (
              <select 
                value={req.method} 
                onChange={(e) => doAction('select-method', e.target.value)}
                disabled={disabled}
                className="text-sm bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-2 focus:ring-1 focus:outline-none min-h-[36px]"
                title={authorizationHint}
              >
                <option value="email">Email Method</option>
                <option value="agent">AI Agent Method</option>
              </select>
            )}
            {canStart && (
              <Button size="sm" variant="outline" className="h-9 text-xs sm:text-sm gap-1.5" disabled={disabled} onClick={() => doAction('start')} title={authorizationHint}>
                <Play className="h-4 w-4" /> Start
              </Button>
            )}
            {canProgress && (
              <Button size="sm" variant="outline" className="h-9 text-xs sm:text-sm gap-1.5" disabled={disabled} onClick={() => setIsPromptingAction(isPromptingAction === 'progress' ? null : 'progress')} title={authorizationHint}>
                <FastForward className="h-4 w-4" /> Progress
              </Button>
            )}
             {canComplete && (
               <Button size="sm" variant="outline" className="h-9 text-xs sm:text-sm gap-1.5 border-[var(--status-green)] text-[var(--status-green-fg)] hover:bg-[var(--status-green-bg)]" disabled={disabled} onClick={() => req.method === 'human-task' ? setIsPromptingAction(isPromptingAction === 'complete' ? null : 'complete') : doAction('complete')} title={authorizationHint}>
                <CheckCircle2 className="h-4 w-4" /> Complete
              </Button>
            )}
            {canBlock && (
              <Button size="sm" variant="outline" className="h-9 text-xs sm:text-sm gap-1.5 border-[var(--status-red)] text-[var(--status-red-fg)] hover:bg-[var(--status-red-bg)]" disabled={disabled} onClick={() => setIsPromptingAction(isPromptingAction === 'block' ? null : 'block')} title={authorizationHint}>
                <AlertTriangle className="h-4 w-4" /> Block
              </Button>
            )}
            {canRetry && (
              <Button size="sm" variant="outline" className="h-9 text-xs sm:text-sm gap-1.5" disabled={disabled} onClick={() => setIsPromptingAction(isPromptingAction === 'retry' ? null : 'retry')} title={authorizationHint}>
                <RotateCcw className="h-4 w-4" /> Retry
              </Button>
            )}
          </div>
        </div>
      </div>
      
      {isPromptingAction && (
        <form onSubmit={handlePromptSubmit} className="mb-4 p-4 border border-[var(--border)] bg-[var(--surface)] rounded-[var(--radius-md)] flex flex-col sm:flex-row gap-3 items-start sm:items-center shadow-sm">
          <div className="flex-1 w-full">
            <Input 
              autoFocus
                placeholder={isPromptingAction === 'complete' && req.method === 'human-task' ? 'Evidence note for completion (3+ characters required)...' : `Reason for ${isPromptingAction} (optional)...`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full text-sm h-10"
              disabled={disabled}
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto mt-1 sm:mt-0">
            <Button type="button" variant="outline" className="flex-1 h-10 px-4" onClick={() => { setIsPromptingAction(null); setReason(''); }} disabled={disabled}>Cancel</Button>
             <Button type="submit" className="flex-1 h-10 px-4" disabled={disabled || (isPromptingAction === 'complete' && req.method === 'human-task' && reason.trim().length < 3)}>Confirm</Button>
          </div>
        </form>
      )}

      {error && (
        <div className="mb-4 p-3 bg-[var(--status-red-bg)] border border-[var(--status-red)] text-[var(--status-red-fg)] text-xs rounded-[var(--radius-sm)]">
          <strong>Error:</strong> {error}
        </div>
      )}
      {continuationPending && (
        <div role="status" className="mb-4 rounded-[var(--radius-sm)] border border-[var(--status-amber)]/30 bg-[var(--status-amber-bg)] p-3 text-xs text-[var(--status-amber-fg)]">
          Task saved. Follow-up processing is pending and will retry automatically.
        </div>
      )}

      {req.history && req.history.length > 0 && (
        <details className="mt-2 text-xs border-t border-[var(--border)] pt-4 group">
          <summary className="text-[var(--text-muted)] cursor-pointer select-none font-medium hover:text-[var(--text-primary)] transition-colors inline-block p-1">
            View History ({req.history.length})
          </summary>
          <div className="mt-3 space-y-3 pl-3 border-l-2 border-[var(--border-strong)]">
            {req.history.map((h, i) => (
              <div key={i} className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-1 sm:gap-4">
                <div className="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-2">
                  <span className="font-bold text-[var(--text-secondary)] capitalize shrink-0">{h.status}</span>
                  {h.reason && <span className="text-[var(--text-muted)] sm:before:content-['—'] sm:before:mr-2 block sm:inline break-words leading-relaxed">{h.reason}</span>}
                  
                  {h.agentIdentity && (
                    <span className="text-xs sm:ml-2 inline-flex flex-wrap items-center gap-1 bg-[var(--surface)] border border-[var(--border)] px-1.5 py-0.5 rounded text-[var(--text-secondary)]">
                      <Bot className="w-3 h-3" />
                      <Link href={`/agents#${h.agentIdentity.id}`} className="hover:text-[var(--primary)] hover:underline">
                        {h.agentIdentity.name}
                      </Link>
                      <span className="capitalize">· {h.agentIdentity.origin} · Simulated</span>
                    </span>
                  )}
                  {!h.agentIdentity && (
                     <span className="text-xs sm:ml-2 text-[var(--text-muted)] italic">No agent identity recorded (email or earlier action)</span>
                  )}
                </div>
                <div className="text-left sm:text-right shrink-0 text-[11px] sm:text-xs mt-1 sm:mt-0">
                  <span className="text-[var(--text-muted)]">{format(new Date(h.at), 'MMM d, HH:mm:ss')}</span>
                  <span className="block text-[var(--text-secondary)] break-all mt-0.5">Triggered by: {h.actor}</span>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
