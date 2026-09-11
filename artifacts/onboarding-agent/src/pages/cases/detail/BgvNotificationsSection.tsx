import React, { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { 
  ShieldAlert, Shield, Mail, Send, AlertTriangle, Info, Clock, CheckCircle2, 
  RotateCcw, Save, RefreshCw, XCircle, Bot, MailWarning, EyeOff
} from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent, Button, cn, Input, Label } from '@/components/ui-shared';
import { Switch } from '@/components/ui/switch';
import { useQueryClient } from '@tanstack/react-query';

import { 
  useGetOnboardingBgvNotifications,
  useUpdateOnboardingBgvNotifications,
  useReconcileOnboardingBgvNotifications,
  getGetOnboardingBgvNotificationsQueryKey,
  getListOnboardingCaseCommunicationsQueryKey,
  getListOnboardingCaseEventsQueryKey,
  BgvNotificationConfig,
  BgvNotificationConfigFlags,
  BgvNotificationRecipientConfig,
  BgvNotificationConfigCandidate,
  BgvNotificationDeliveryState,
  BgvNotificationRole
} from '@workspace/api-client-react';

export function BgvNotificationsSection({ caseId, caseData }: { caseId: number, caseData?: { workerEmail?: string } }) {
  const queryClient = useQueryClient();
  const getQueryKey = () => getGetOnboardingBgvNotificationsQueryKey(caseId);

  const { data, isLoading, isError, error, refetch } = useGetOnboardingBgvNotifications(caseId, {
    query: {
      enabled: !!caseId,
      queryKey: getQueryKey(),
      retry: false,
      refetchInterval: 15000
    }
  });

  const updateConfig = useUpdateOnboardingBgvNotifications();
  const reconcile = useReconcileOnboardingBgvNotifications();

  const [editState, setEditState] = useState<BgvNotificationConfig | null>(null);
  const [conflictError, setConflictError] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const initializedVersion = useRef<number | null>(null);
  const dirty = useRef(false);
  const initializedCase = useRef(caseId);

  // Initialize edit state when data arrives
  useEffect(() => {
    if (initializedCase.current !== caseId) {
      initializedCase.current = caseId;
      initializedVersion.current = null;
      dirty.current = false;
    }
    if (data && data.caseId === caseId && !dirty.current && initializedVersion.current !== data.version) {
      setEditState(JSON.parse(JSON.stringify(data.config)));
      initializedVersion.current = data.version;
      setConflictError(false);
      setSaveError(null);
    }
  }, [data, caseId]);

  if (isLoading) {
    return (
      <Card className="border-[var(--border)] shadow-sm">
        <CardContent className="p-5 text-sm text-[var(--text-muted)]">
          Loading BGV notification configuration...
        </CardContent>
      </Card>
    );
  }

  if (isError || !data) {
    // If the endpoint is 404, it might mean the case doesn't have BGV notifications setup or API is absent
    const msg = (error as any)?.data?.message || (error as any)?.message || 'Unable to load BGV notifications.';
    return (
      <Card className="border-[var(--border)] shadow-sm bg-[var(--surface-soft)] mt-6">
        <CardContent className="p-6 text-center space-y-3">
          <ShieldAlert className="w-8 h-8 text-[var(--text-muted)] mx-auto" />
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)]">{msg}</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Retry</Button>
        </CardContent>
      </Card>
    );
  }

  const res = data;
  const canManage = res.authority.canManage && !res.authority.offline && !updateConfig.isPending && !reconcile.isPending;
  const isOffline = res.authority.offline;

  const handleSave = () => {
    if (!editState) return;
    setSaveError(null);
    setConflictError(false);

    updateConfig.mutate({ caseId, data: { version: editState.version, config: editState } }, {
      onSuccess: (updatedData) => {
        // Optimistically update query cache
        queryClient.setQueryData(getQueryKey(), updatedData);
        setEditState(JSON.parse(JSON.stringify(updatedData.config)));
        initializedVersion.current = updatedData.version;
        dirty.current = false;
      },
      onError: (err: any) => {
        if (err?.status === 409) {
          setConflictError(true);
        } else {
          setSaveError(err?.data?.message || err?.message || 'Failed to save configuration');
        }
      }
    });
  };

  const handleRefreshConflict = async () => {
    const latest = await refetch();
    if (!latest.isError && latest.data) {
      setEditState(structuredClone(latest.data.config));
      initializedVersion.current = latest.data.version;
      dirty.current = false;
      setConflictError(false);
      setSaveError(null);
    }
  };

  const handleReconcile = (simulation: boolean) => {
    if (!confirm(simulation ? 
      "Simulate sending these notifications? (No actual emails will be sent)" : 
      "Trigger live reconciliation? This may deliver real human emails to authorized recipients if criteria are met."
    )) return;

    reconcile.mutate({ caseId, data: { reason: 'manual', simulation } }, {
      onSuccess: (updatedData) => {
        queryClient.setQueryData(getQueryKey(), updatedData);
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
      },
      onError: (err: any) => {
         alert(err?.data?.message || err?.message || 'Reconciliation failed.');
      }
    });
  };

  const updateRoleField = (role: keyof Omit<BgvNotificationConfig, 'version' | 'flags' | 'candidate'>, field: keyof BgvNotificationRecipientConfig, value: any) => {
    dirty.current = true;
    if (!editState) return;
    setEditState(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      const currentRoleObj = next[role] || { enabled: false, purposeAuthorized: false, email: null };
      next[role] = { ...currentRoleObj, [field]: value } as BgvNotificationRecipientConfig;
      return next;
    });
  };

  const updateCandidateField = (field: keyof BgvNotificationConfigCandidate, value: boolean) => {
    dirty.current = true;
    if (!editState) return;
    setEditState(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      const currentCandidateObj = next.candidate || { enabled: false, purposeAuthorized: false };
      next.candidate = { ...currentCandidateObj, [field]: value } as BgvNotificationConfigCandidate;
      return next;
    });
  };

  const updateFlag = (flag: keyof BgvNotificationConfigFlags, value: boolean) => {
    dirty.current = true;
    if (!editState) return;
    setEditState(prev => {
      if (!prev) return prev;
      const next = { ...prev };
      next.flags = { ...(next.flags || {}), [flag]: value };
      return next;
    });
  };

  const activeCycle = res.currentCycle;
  const isPending = !activeCycle;

  // Attempt to resolve candidate email from active cycle or case data
  const activeCandidate = activeCycle?.notifications?.find((n: any) => n.role === 'candidate');
  const candidateEmail = activeCandidate?.email || caseData?.workerEmail || 'No email on file';

  return (
    <Card className="border-[var(--border)] shadow-[var(--shadow-sm)] flex flex-col mt-6">
      <CardHeader className="pb-4 border-b bg-[var(--surface-alt)]">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <CardTitle className="text-[var(--text-base)] flex items-center gap-2">
              <Shield className="h-5 w-5 text-[var(--violet)]" />
              Background Verification Notifications
            </CardTitle>
            <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1.5 max-w-2xl leading-relaxed">
              Coordinate delayed onboarding with accountable recipients. Raw vendor findings and 
              adverse details are never exposed here. HR can authorize safe coordination signals.
            </p>
          </div>
          {isOffline && (
            <span className="text-[10px] px-2 py-1 rounded border border-[var(--violet)] text-[var(--violet-fg)] bg-[var(--violet-light-bg)] font-bold tracking-wider uppercase shrink-0">
              OFFLINE · READ-ONLY
            </span>
          )}
        </div>
      </CardHeader>

      <CardContent className="p-0">
        {!isPending && activeCycle && (
          <div className="p-6 border-b border-[var(--border)] bg-[var(--surface)]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-[var(--text-sm)]">Current BGV Status: <span className={cn("uppercase tracking-wider px-2 py-0.5 rounded text-[10px]", activeCycle.episode === 'blocked' ? "bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border border-[var(--status-amber)]" : "bg-[var(--status-green-bg)] text-[var(--status-green-fg)] border border-[var(--status-green)]")}>{activeCycle.episode}</span></h3>
              <div className="flex items-center gap-2">
                <span className="text-[var(--text-xs)] text-[var(--text-muted)]">{format(new Date(activeCycle.createdAt), 'MMM d, HH:mm')}</span>
                <span className="text-[var(--text-xs)] font-mono text-[var(--text-muted)] bg-[var(--surface-alt)] px-2 py-1 rounded border border-[var(--border)]">
                  Cycle: {activeCycle.cycleId.substring(0,8)}...
                </span>
              </div>
            </div>
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">Effective Flags</h4>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(res.effectiveFlags).map(([k, v]) => {
                    if (!v) return null;
                    const isSourceDerived = k === 'discrepancy' || k === 'reviewRequired' || k === 'missingInfo' || k === 'delay';
                    return (
                      <span key={k} className={cn("text-[11px] px-2 py-1 rounded font-medium border", isSourceDerived ? "bg-[var(--surface-soft)] text-[var(--text-secondary)] border-[var(--border-strong)]" : "bg-[var(--status-info-bg)] text-[var(--status-info-fg)] border-[var(--primary)]")}>
                        {k.replace(/([A-Z])/g, ' $1').trim()} {isSourceDerived && <LockIcon />}
                      </span>
                    );
                  })}
                  {!Object.values(res.effectiveFlags).some(Boolean) && <span className="text-[var(--text-xs)] text-[var(--text-muted)] italic">No active flags</span>}
                </div>
              </div>

              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">Latest Notifications</h4>
                <div className="space-y-2">
                  {activeCycle.notifications.map((n: any, i: number) => (
                    <div key={i} className="flex flex-col sm:flex-row sm:items-center justify-between text-[var(--text-xs)] p-2 rounded bg-[var(--surface-alt)] border border-[var(--border)]">
                      <div className="flex items-center gap-2">
                        <span className="font-bold w-24 truncate" title={n.role}>{n.role}</span>
                        <DeliveryBadge state={n.actualDeliveryState as BgvNotificationDeliveryState} />
                      </div>
                      <span className="text-[var(--text-muted)] truncate max-w-[200px]" title={n.reason}>{n.reason}</span>
                    </div>
                  ))}
                  {activeCycle.notifications.length === 0 && <span className="text-[var(--text-xs)] text-[var(--text-muted)] italic">No recipients recorded in cycle</span>}
                </div>
              </div>
            </div>
            {res.cycles.length > 1 && (
              <details className="mt-4 border-t border-[var(--border)] pt-4">
                <summary className="text-[var(--text-xs)] font-medium text-[var(--text-muted)] cursor-pointer select-none">
                  View Previous Cycles ({res.cycles.length - 1})
                </summary>
                <div className="mt-3 space-y-3">
                  {res.cycles.slice(1).map((c: any) => (
                    <div key={c.cycleId} className="p-3 bg-[var(--surface-alt)] border border-[var(--border)] rounded text-[var(--text-xs)]">
                      <div className="flex justify-between items-center mb-2">
                        <span className="font-bold">{c.episode} <span className="font-normal text-[var(--text-muted)] ml-2">Cycle {c.cycleId.substring(0,8)}</span></span>
                        <span className="text-[var(--text-muted)]">{format(new Date(c.createdAt), 'MMM d, HH:mm')}</span>
                      </div>
                      <div className="flex flex-wrap gap-2 mb-2">
                        {c.classifications.map((cl: string, i: number) => (
                          <span key={i} className="px-1.5 py-0.5 rounded bg-[var(--surface)] border text-[10px] text-[var(--text-secondary)]">{cl}</span>
                        ))}
                      </div>
                      <div className="space-y-1 pl-2 border-l-2 border-[var(--border-strong)]">
                        {c.notifications.map((n: any, i: number) => (
                          <div key={i} className="flex justify-between items-center">
                            <span className="w-24 truncate">{n.role}</span>
                            <span className="text-[10px] text-[var(--text-muted)]">{n.reason}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {isPending && (
          <div className="p-6 border-b border-[var(--border)] bg-[var(--surface)] text-center text-[var(--text-secondary)] text-[var(--text-sm)]">
            <Clock className="w-6 h-6 mx-auto mb-2 text-[var(--text-muted)]" />
            No active BGV events reported for this case yet.
          </div>
        )}

        <div className="p-6 bg-[var(--surface-alt)]">
          <div className="flex justify-between items-center mb-4">
            <h3 className="font-bold text-[var(--text-sm)]">Stakeholder Configuration</h3>
            {!canManage && (
              <span className="text-[10px] text-[var(--text-muted)] font-medium bg-[var(--surface)] border border-[var(--border)] px-2 py-1 rounded flex items-center gap-1">
                <EyeOff className="w-3 h-3" /> Read-only mode
              </span>
            )}
            {res.authority.reason && canManage === false && (
               <span className="text-[10px] text-[var(--status-red)] ml-2">{res.authority.reason}</span>
            )}
          </div>

          {conflictError && (
            <div className="mb-4 p-3 bg-[var(--status-amber-bg)] border border-[var(--status-amber)] text-[var(--status-amber-fg)] text-[var(--text-sm)] rounded-[var(--radius-md)] flex justify-between items-center shadow-sm">
              <span className="flex items-center gap-2"><AlertTriangle className="w-4 h-4" /> The configuration was updated by another user.</span>
              <Button size="sm" variant="outline" className="border-[var(--status-amber)] text-[var(--status-amber-fg)] hover:bg-[var(--status-amber)] hover:text-white" onClick={handleRefreshConflict}>Reload Latest</Button>
            </div>
          )}

          {saveError && (
             <div className="mb-4 p-3 bg-[var(--status-red-bg)] border border-[var(--status-red)] text-[var(--status-red-fg)] text-[var(--text-sm)] rounded-[var(--radius-md)]">
               {saveError}
             </div>
          )}

          {editState && (
            <div className="space-y-6">
              <div className="bg-[var(--surface)] p-4 rounded-[var(--radius-lg)] border border-[var(--border)] shadow-sm">
                 <h4 className="text-[11px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mb-3 border-b border-[var(--border)] pb-2">HR Coordination Flags</h4>
                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                   <FlagToggle label="Candidate Action Required" checked={!!editState.flags?.candidateActionRequired} onChange={(v) => updateFlag('candidateActionRequired', v)} disabled={!canManage} />
                   <FlagToggle label="Provider Action Required" checked={!!editState.flags?.providerActionRequired} onChange={(v) => updateFlag('providerActionRequired', v)} disabled={!canManage} />
                   <FlagToggle label="Start Date at Risk" checked={!!editState.flags?.startDateAtRisk} onChange={(v) => updateFlag('startDateAtRisk', v)} disabled={!canManage} />
                   <FlagToggle label="HR / Recruiter Coordination Required" checked={!!editState.flags?.coordinationRequired} onChange={(v) => updateFlag('coordinationRequired', v)} disabled={!canManage} />
                   <FlagToggle label="Dependent Work on Hold" checked={!!editState.flags?.dependentWorkOnHold} onChange={(v) => updateFlag('dependentWorkOnHold', v)} disabled={!canManage} />
                 </div>
              </div>

              <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-sm overflow-hidden">
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[var(--text-sm)] min-w-[600px]">
                    <thead className="bg-[var(--surface-alt)] border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-bold">
                      <tr>
                        <th className="p-3">Role</th>
                        <th className="p-3">Enabled</th>
                        <th className="p-3">Authorized for Purpose</th>
                        <th className="p-3">Email Address</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[var(--border)]">
                      <RecipientRow role="hr" label="HR Owner" config={editState.hr} onChange={(f, v) => updateRoleField('hr', f, v)} canManage={canManage} />
                      <RecipientRow role="bgvTeam" label="BGV Team" config={editState.bgvTeam} onChange={(f, v) => updateRoleField('bgvTeam', f, v)} canManage={canManage} />
                      <RecipientRow role="recruiter" label="Recruiter" config={editState.recruiter} onChange={(f, v) => updateRoleField('recruiter', f, v)} canManage={canManage} />
                      <RecipientRow role="hiringManager" label="Hiring Manager" config={editState.hiringManager} onChange={(f, v) => updateRoleField('hiringManager', f, v)} canManage={canManage} />
                      <RecipientRow role="compliance" label="Compliance" config={editState.compliance} onChange={(f, v) => updateRoleField('compliance', f, v)} canManage={canManage} />
                      
                      {/* Candidate is special (read-only email, typically mapped internally) */}
                      <tr className="hover:bg-[var(--surface-alt)] transition-colors group">
                        <td className="p-3 font-medium text-[var(--text-primary)]">Candidate</td>
                        <td className="p-3">
                          <Switch checked={!!editState.candidate?.enabled} onCheckedChange={(v) => updateCandidateField('enabled', v)} disabled={!canManage} />
                        </td>
                        <td className="p-3">
                          <Switch checked={!!editState.candidate?.purposeAuthorized} onCheckedChange={(v) => updateCandidateField('purposeAuthorized', v)} disabled={!canManage} />
                        </td>
                        <td className="p-3 text-[var(--text-muted)] italic text-xs break-all">
                          {candidateEmail}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              {canManage && (
                <div className="flex justify-end pt-2 border-t border-[var(--border)]">
                  <Button onClick={handleSave} disabled={updateConfig.isPending || conflictError} className="gap-2 shadow-sm">
                    <Save className="w-4 h-4" /> Save Configuration
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
      
      {canManage && (
        <div className="p-4 bg-[var(--surface)] border-t border-[var(--border)] flex flex-wrap gap-3 items-center justify-between rounded-b-[var(--radius-lg)]">
          <div className="flex items-center gap-2 text-[var(--text-xs)] text-[var(--text-muted)] max-w-lg">
            <Info className="w-4 h-4 shrink-0" />
            <span>Reconciliation processes the current active cycle against the saved configuration.</span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => handleReconcile(true)} disabled={reconcile.isPending} className="gap-2">
               <Bot className="w-4 h-4" /> Simulate Reconcile
            </Button>
            <Button size="sm" onClick={() => handleReconcile(false)} disabled={reconcile.isPending} className="gap-2 bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] shadow-sm">
               <Send className="w-4 h-4" /> Live Reconcile
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function FlagToggle({ label, checked, onChange, disabled }: { label: string, checked: boolean, onChange: (v: boolean) => void, disabled: boolean }) {
  return (
    <div className="flex items-center space-x-2 p-2 rounded hover:bg-[var(--surface-alt)] transition-colors">
      <Switch id={`flag-${label.replace(/\s+/g, '-')}`} checked={checked} onCheckedChange={onChange} disabled={disabled} />
      <Label htmlFor={`flag-${label.replace(/\s+/g, '-')}`} className={cn("text-[var(--text-sm)] cursor-pointer select-none", disabled && "text-[var(--text-muted)] cursor-not-allowed")}>{label}</Label>
    </div>
  );
}

function RecipientRow({ role, label, config, onChange, canManage }: { role: string, label: string, config: BgvNotificationRecipientConfig | undefined, onChange: (field: keyof BgvNotificationRecipientConfig, value: any) => void, canManage: boolean }) {
  return (
    <tr className="hover:bg-[var(--surface-alt)] transition-colors group">
      <td className="p-3 font-medium text-[var(--text-primary)]">{label}</td>
      <td className="p-3">
        <Switch aria-label={`Enable ${label} notifications`} checked={!!config?.enabled} onCheckedChange={(v) => onChange('enabled', v)} disabled={!canManage} />
      </td>
      <td className="p-3">
        <Switch aria-label={`Authorize ${label} notification purpose`} checked={!!config?.purposeAuthorized} onCheckedChange={(v) => onChange('purposeAuthorized', v)} disabled={!canManage} />
      </td>
      <td className="p-3">
        <Input 
          aria-label={`${label} email`}
          type="email"
          value={config?.email || ''} 
          onChange={(e) => onChange('email', e.target.value || null)} 
          placeholder={`Enter ${label.toLowerCase()} email`}
          disabled={!canManage}
          className="h-8 text-xs max-w-[240px] bg-transparent group-hover:bg-[var(--surface)] transition-colors"
        />
      </td>
    </tr>
  );
}

function DeliveryBadge({ state }: { state: BgvNotificationDeliveryState }) {
  const map: Record<string, { bg: string, fg: string, border: string, icon: React.ReactNode }> = {
    'sent': { bg: 'var(--status-green-bg)', fg: 'var(--status-green-fg)', border: 'var(--status-green)', icon: <CheckCircle2 className="w-3 h-3" /> },
    'queued': { bg: 'var(--status-info-bg)', fg: 'var(--status-info-fg)', border: 'var(--primary)', icon: <Clock className="w-3 h-3" /> },
    'failed': { bg: 'var(--status-red-bg)', fg: 'var(--status-red-fg)', border: 'var(--status-red)', icon: <AlertTriangle className="w-3 h-3" /> },
    'missing-recipient': { bg: 'var(--surface-soft)', fg: 'var(--text-muted)', border: 'var(--border-strong)', icon: <MailWarning className="w-3 h-3" /> },
    'uncertain': { bg: 'var(--status-amber-bg)', fg: 'var(--status-amber-fg)', border: 'var(--status-amber)', icon: <RotateCcw className="w-3 h-3" /> },
    'simulated': { bg: 'var(--violet-light-bg)', fg: 'var(--violet-fg)', border: 'var(--violet)', icon: <Bot className="w-3 h-3" /> },
    'skipped': { bg: 'var(--surface-soft)', fg: 'var(--text-muted)', border: 'var(--border-strong)', icon: <XCircle className="w-3 h-3" /> },
  };
  const style = map[state] || map['skipped'];

  return (
    <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider border whitespace-nowrap" style={{ backgroundColor: style.bg, color: style.fg, borderColor: style.border }}>
      {style.icon} {state.replace('-', ' ')}
    </span>
  );
}

function LockIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="inline-block ml-1 opacity-60">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
    </svg>
  );
}