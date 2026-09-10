import React, { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetOnboardingReadinessSlaPolicy,
  useUpdateOnboardingReadinessSlaPolicy,
  getGetOnboardingReadinessSlaPolicyQueryKey,
} from '@workspace/api-client-react';
import { Card, Button, cn, IconTile, Badge } from '@/components/ui-shared';
import { Settings2, Check, X, AlertTriangle, RefreshCw, Mail } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';

export function ReadinessSlaSettingsCard() {
  const queryClient = useQueryClient();
  const { data: policyView, isLoading, isError, refetch } = useGetOnboardingReadinessSlaPolicy({
    query: { queryKey: getGetOnboardingReadinessSlaPolicyQueryKey() }
  });
  
  const update = useUpdateOnboardingReadinessSlaPolicy();

  const [localActions, setLocalActions] = useState<any[]>([]);
  const [baseVersion, setBaseVersion] = useState(0);
  const [touched, setTouched] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; message: string; versionConflict?: boolean } | null>(null);

  useEffect(() => {
    if (policyView && !touched) {
      setLocalActions(policyView.policy.actions || []);
      setBaseVersion(policyView.version || 0);
    }
  }, [policyView, touched]);

  const updateAction = (index: number, updates: any) => {
    const newActions = [...localActions];
    newActions[index] = { ...newActions[index], ...updates };
    setLocalActions(newActions);
    setTouched(true);
    setNotice(null);
  };

  const handleSave = () => {
    if (!policyView) return;
    
    update.mutate({ 
      data: { 
        expectedVersion: baseVersion, 
        policy: { ...policyView.policy, actions: localActions } 
      } 
    }, {
      onSuccess: (saved: any) => {
        setTouched(false);
        setBaseVersion(saved.version);
        setLocalActions(saved.policy.actions || []);
        setNotice({ ok: true, message: `SLA policy updated successfully.` });
        queryClient.invalidateQueries({ queryKey: getGetOnboardingReadinessSlaPolicyQueryKey() });
      },
      onError: (err: any) => {
        const isConflict = err?.response?.status === 409 || err?.message?.includes('409');
        setNotice({ 
          ok: false, 
          message: isConflict ? 'Another user has updated this policy since you loaded it. Please refresh and try again.' : (err?.message || 'Failed to update SLA policy'),
          versionConflict: isConflict
        });
      }
    });
  };

  const handleRefresh = () => {
    setTouched(false);
    setNotice(null);
    refetch();
  };

  if (isLoading) {
    return (
      <div className="mt-8 border border-[var(--border)] rounded-[var(--radius-lg)] p-8 bg-[var(--surface)] text-center animate-pulse">
        Loading SLA policy...
      </div>
    );
  }

  if (isError || !policyView) {
    return (
      <div className="mt-8 border border-[var(--border)] rounded-[var(--radius-lg)] p-8 bg-[var(--surface)] text-center">
        Failed to load SLA policy. <Button variant="outline" onClick={() => refetch()}>Retry</Button>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-sm)' }} className="mt-8">
      <div style={{ backgroundColor: 'var(--surface-alt)', borderBottom: '1px solid var(--border)', padding: 'var(--space-md) var(--space-lg)' }}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <IconTile icon={Settings2} className="bg-[var(--surface-soft)] text-[var(--text-secondary)] border-transparent" />
            <div>
              <h3 style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--text-primary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>Readiness SLA Policy</h3>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: '2px', marginBottom: 0 }}>
                Configure deadlines, notifications, and ownership for critical readiness actions. Changes do not affect active cases unless explicitly rebased.
              </p>
            </div>
          </div>
          <Badge className="bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] font-mono shadow-none">
            v{baseVersion}
          </Badge>
        </div>
      </div>
      
      <div className="p-4 md:p-[var(--space-lg)] space-y-6">
        {localActions.map((action, i) => (
          <div key={action.key} className={cn("p-4 border rounded-[var(--radius-md)] transition-colors", action.enabled ? "bg-[var(--surface)] border-[var(--border)] shadow-sm" : "bg-[var(--surface-alt)] border-[var(--border)] opacity-70")}>
            <div className="flex flex-col md:flex-row justify-between md:items-center gap-4 mb-4 pb-4 border-b border-[var(--border)]">
              <div>
                <div className="flex items-center gap-2">
                  <h4 className="font-bold text-[var(--text-sm)] text-[var(--text-primary)]">{action.label}</h4>
                  {!action.enabled && <Badge variant="outline" className="text-[9px]">DISABLED</Badge>}
                  {action.mandatory && <Badge className="bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] text-[9px] shadow-none">MANDATORY</Badge>}
                </div>
                <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1 font-mono uppercase tracking-wider">Stream: {action.streamKey}</p>
              </div>
              
              <div className="flex items-center gap-3 bg-[var(--surface-alt)] px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border)] w-full md:w-auto">
                <span className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">Enabled</span>
                <input 
                  type="checkbox" 
                  checked={action.enabled}
                  onChange={(e) => updateAction(i, { enabled: e.target.checked })}
                  className="w-4 h-4 accent-[var(--primary)]"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Anchor</label>
                <select 
                  value={action.anchor} 
                  onChange={(e) => updateAction(i, { anchor: e.target.value })}
                  disabled={!action.enabled}
                  className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                >
                  <option value="joining">Joining Date</option>
                  <option value="offer">Offer Date</option>
                  <option value="payroll-cutoff">Payroll Cutoff</option>
                </select>
              </div>
              
              {action.anchor !== 'payroll-cutoff' && (
                <>
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Offset Days</label>
                    <input 
                      type="number" 
                      value={action.offsetDays} 
                      onChange={(e) => updateAction(i, { offsetDays: parseInt(e.target.value) || 0 })}
                      disabled={!action.enabled}
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Deadline Time</label>
                    <input 
                      type="time" 
                      value={action.deadlineLocalTime} 
                      onChange={(e) => updateAction(i, { deadlineLocalTime: e.target.value })}
                      disabled={!action.enabled}
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Timezone</label>
                    <input 
                      type="text" 
                      value={action.timezone} 
                      onChange={(e) => updateAction(i, { timezone: e.target.value })}
                      disabled={!action.enabled}
                      placeholder="e.g. Asia/Kolkata"
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)] font-mono text-[11px]"
                    />
                  </div>
                  
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Calendar</label>
                    <select 
                      value={action.calendar} 
                      onChange={(e) => updateAction(i, { calendar: e.target.value })}
                      disabled={!action.enabled}
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                    >
                      <option value="days">Calendar Days</option>
                      <option value="business">Business Days</option>
                    </select>
                  </div>
                  
                  <div className="space-y-1">
                    <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Holidays</label>
                    <input 
                      type="text" 
                      value={(action.holidayDates || []).join(', ')} 
                      onChange={(e) => {
                        const dates = e.target.value.split(',').map(s => s.trim()).filter(Boolean);
                        updateAction(i, { holidayDates: dates });
                      }}
                      disabled={!action.enabled}
                      placeholder="YYYY-MM-DD, ..."
                      className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)] font-mono text-[11px]"
                    />
                  </div>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-4 pt-4 border-t border-[var(--border)]">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Action Owner</label>
                <input 
                  type="text" 
                  value={action.owner} 
                  onChange={(e) => updateAction(i, { owner: e.target.value })}
                  disabled={!action.enabled}
                  className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Backup Email</label>
                <input 
                  type="email" 
                  value={action.backupEmail || ''} 
                  onChange={(e) => updateAction(i, { backupEmail: e.target.value || null })}
                  disabled={!action.enabled}
                  placeholder="escalation@example.com"
                  className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Warn (Hours)</label>
                <input 
                  type="number" 
                  value={action.warnHours} 
                  onChange={(e) => updateAction(i, { warnHours: parseInt(e.target.value) || 0 })}
                  disabled={!action.enabled}
                  className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">Escalate (Hours)</label>
                <input 
                  type="number" 
                  value={action.escalationAfterHours} 
                  onChange={(e) => updateAction(i, { escalationAfterHours: parseInt(e.target.value) || 0 })}
                  disabled={!action.enabled}
                  className="w-full border border-[var(--border)] rounded-[var(--radius-md)] bg-[var(--surface)] p-2 text-[var(--text-sm)] outline-none focus:border-[var(--primary)]"
                />
              </div>
            </div>
            
            <div className="flex gap-4 mt-4 pt-4 border-t border-[var(--border)]">
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={action.notifyInApp} 
                  onChange={(e) => updateAction(i, { notifyInApp: e.target.checked })}
                  disabled={!action.enabled}
                  className="w-3.5 h-3.5 accent-[var(--primary)]"
                />
                <span className="text-[var(--text-xs)] text-[var(--text-primary)]">In-App Notices</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input 
                  type="checkbox" 
                  checked={action.notifyEmail} 
                  onChange={(e) => updateAction(i, { notifyEmail: e.target.checked })}
                  disabled={!action.enabled}
                  className="w-3.5 h-3.5 accent-[var(--primary)]"
                />
                <span className="text-[var(--text-xs)] text-[var(--text-primary)]">Email Notices</span>
              </label>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-3 bg-[var(--surface-alt)] p-[var(--space-md)] border-t border-[var(--border)] rounded-b-[var(--radius-lg)]">
        <Button onClick={handleSave} disabled={update.isPending || !touched} className="gap-2 bg-[var(--primary)] text-white hover:bg-[var(--primary)]/90">
          <Check className="w-4 h-4" /> Save Policy
        </Button>
        {touched && (
          <Button variant="outline" onClick={handleRefresh} disabled={update.isPending}>
            Discard Changes
          </Button>
        )}
        {notice && (
          <div className={cn('p-2 ml-auto text-[var(--text-sm)] rounded-[var(--radius-md)] flex items-center gap-2',
            notice.ok ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)] border border-[var(--status-green)]/30' : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border border-[var(--status-red)]/30')}>
            {notice.ok ? <Check className="w-4 h-4 shrink-0" /> : <AlertTriangle className="w-4 h-4 shrink-0" />}
            <span>{notice.message}</span>
            {notice.versionConflict && (
              <Button size="sm" variant="outline" className="h-6 text-xs px-2 ml-2 bg-white" onClick={handleRefresh}>Refresh</Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
