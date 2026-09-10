import React, { useState } from 'react';
import { useListOnboardingApprovals, useDecideOnboardingApproval, getListOnboardingApprovalsQueryKey, useGetOnboardingApprovalHistory, getGetOnboardingApprovalHistoryQueryKey } from '@workspace/api-client-react';
import { Card, Button, Badge, cn, Input, Label, PageHeader } from '@/components/ui-shared';
import { useQueryClient, useQuery } from '@tanstack/react-query';
import { useUser } from '@clerk/react';
import { EngineBadge, HitlBadge } from '@/components/engine-badge';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'wouter';
import { useOrganizationRole } from '../hooks/use-organization-role';

export function ApprovalsPage() {
  const [showAll, setShowAll] = useState(false);
  const statusParam = showAll ? 'all' : 'pending';
  const { data: approvals, isLoading } = useListOnboardingApprovals({ status: statusParam }, {
    query: { queryKey: getListOnboardingApprovalsQueryKey({ status: statusParam }) }
  });

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHeader title="Review Queue" subtitle="Human-in-the-loop decisions for agentic actions.">
        <div className="flex items-center gap-2 bg-[var(--surface)] px-3 py-1.5 rounded-md border" style={{ borderColor: 'var(--border)' }}>
          <Label htmlFor="show-all" className="cursor-pointer" style={{ margin: 0, color: 'var(--text-primary)' }}>Show Resolved History</Label>
          <input 
            type="checkbox" 
            id="show-all" 
            checked={showAll} 
            onChange={(e) => setShowAll(e.target.checked)} 
            style={{ accentColor: 'var(--primary)', cursor: 'pointer', width: '14px', height: '14px' }} 
          />
        </div>
      </PageHeader>

      <div className="space-y-4">
        {isLoading ? (
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading queue...</div>
        ) : approvals?.length === 0 ? (
          <Card className="text-center border-dashed" style={{ padding: '64px', borderColor: 'var(--border)', backgroundColor: 'transparent', boxShadow: 'none' }}>
            <ShieldAlert style={{ width: '48px', height: '48px', margin: '0 auto 16px', color: 'var(--text-muted)', opacity: 0.5 }} />
            <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Queue is Clear</h3>
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>No agent actions require human review at this time.</p>
          </Card>
        ) : (
          approvals?.map(app => (
            <ApprovalCard key={app.id} approval={app} statusParam={statusParam} />
          ))
        )}
      </div>
    </div>
  );
}

export function scopeLabel(scope: { kind?: string; from?: number; to?: number } | null | undefined): string {
  switch (scope?.kind) {
    case 'latest': return 'Most recent stint';
    case 'earliest': return 'Earliest stint';
    case 'yearRange': {
      const { from, to } = scope;
      if (from != null && to != null) return `${from}–${to} stint`;
      if (from != null) return `Stints from ${from}`;
      if (to != null) return `Stints to ${to}`;
      return 'Year-scoped stint';
    }
    default: return 'All stints';
  }
}

function ApprovalCard({ approval, statusParam }: { approval: any, statusParam: string }) {
  const decide = useDecideOnboardingApproval();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const { user } = useUser();
  
  const { role } = useOrganizationRole();

  const handleDecide = (decision: string) => {
    decide.mutate({
      id: approval.id,
      data: { decision, comment: comment || undefined, expectedVersion: approval.version }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingApprovalsQueryKey({ status: statusParam }) });
      }
    });
  };

  const isPending = approval.status === 'pending';
  const isHardBlock = approval.hitlPattern === 'hard-block';
  
  const [historyOpen, setHistoryOpen] = useState(false);
  const { data: history, isLoading: historyLoading } = useGetOnboardingApprovalHistory(approval.id, {
    query: {
      queryKey: getGetOnboardingApprovalHistoryQueryKey(approval.id),
      enabled: historyOpen
    }
  });

  return (
    <Card 
      className={cn("overflow-hidden transition-all group", !isPending && "opacity-75 bg-[var(--surface-alt)]")}
      style={{ padding: '0', backgroundColor: 'var(--surface)', borderRadius: 'var(--radius-lg)' }}
    >
      <div style={{ padding: 'var(--space-lg) var(--space-xl)' }}>
        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
          <div className="flex-1 w-full">
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)', backgroundColor: 'var(--primary-light)', padding: '2px 8px', borderRadius: '999px' }}>Case #{approval.caseId}</span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <EngineBadge engine={approval.agent} />
              <HitlBadge pattern={approval.hitlPattern} />
              {approval.ruleRef && <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{approval.ruleRef}</span>}
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }} className="md:ml-auto">{format(new Date(approval.createdAt), 'MMM d, HH:mm')}</span>
            </div>
            
            <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', marginTop: '12px', marginBottom: '8px' }}>{approval.recommendation}</h3>
            
            <div style={{ backgroundColor: 'var(--surface-alt)', border: '1px solid var(--border)', borderLeft: '3px solid var(--primary)', borderRadius: 'var(--radius-md)', padding: '12px 16px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {approval.rationale}
              {approval.ruleRef?.includes('sla') && (
                <div className="mt-3 pt-3 border-t border-[var(--border)] flex flex-wrap gap-x-4 gap-y-2 text-[11px] font-mono">
                  <span className="text-[var(--primary)]">SLA Monitor Active</span>
                  <span className="text-[var(--text-muted)]">Check specific case SLA for ledger email delivery details.</span>
                </div>
              )}
            </div>
            
            {Array.isArray(approval.recordsEvidence) && approval.recordsEvidence.length > 0 && (
              <div className="mt-4 border rounded-md divide-y" style={{ borderColor: 'var(--border)' }}>
                <div style={{ padding: '8px 16px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', backgroundColor: 'var(--surface-alt)' }}>Archive evidence</div>
                {approval.recordsEvidence.map((ev: any, i: number) => (
                  <div key={i} style={{ padding: '12px 16px', fontSize: '13px' }} className="space-y-1">
                    <div className="flex items-start justify-between gap-3 mb-1">
                      <p style={{ fontWeight: 500, color: 'var(--text-primary)', lineHeight: 1.4 }}>{ev.question}</p>
                      <span
                        className={cn(
                          "shrink-0",
                          ev.scope?.kind === 'all' || !ev.scope
                            ? ""
                            : ""
                        )}
                        style={{
                          fontSize: '10px', fontWeight: 600, padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap',
                          backgroundColor: ev.scope?.kind === 'all' || !ev.scope ? 'var(--surface-alt)' : 'var(--primary-light)',
                          color: ev.scope?.kind === 'all' || !ev.scope ? 'var(--text-muted)' : 'var(--primary)',
                          border: ev.scope?.kind === 'all' || !ev.scope ? '1px solid transparent' : '1px solid var(--primary)'
                        }}
                      >
                        {scopeLabel(ev.scope)}
                      </span>
                    </div>
                    <p style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{ev.answer}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
          
          {!isPending && (
            <div className="shrink-0 md:text-right w-full md:w-auto mt-4 md:mt-0 flex md:flex-col justify-between items-center md:items-end">
              <span style={{ padding: '4px 12px', borderRadius: '4px', fontSize: 'var(--text-xs)', fontWeight: 600, textTransform: 'uppercase', backgroundColor: approval.status === 'approved' ? 'var(--status-green)' : 'var(--status-red)', color: '#ffffff' }}>
                {approval.status}
              </span>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textAlign: 'right', marginTop: '8px' }}>
                <p>Reviewed by <strong>{approval.decidedBy ?? ""}</strong></p>
                {approval.comment && <p className="italic border-t pt-1 mt-1" style={{ borderColor: 'var(--border)' }}>"{approval.comment}"</p>}
              </div>
            </div>
          )}
        </div>

        {historyOpen && (
          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-3">Cycle History</h4>
            {historyLoading ? (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">Loading history...</p>
            ) : history?.length === 0 ? (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)]">No previous cycles for this approval.</p>
            ) : (
              <div className="space-y-3 pl-3 border-l-2 border-[var(--border-strong)]">
                {history?.map((h: any) => (
                  <div key={h.id} className="relative text-[var(--text-sm)] bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] border border-[var(--border)]">
                    <div className="absolute -left-[19px] top-4 w-2.5 h-2.5 rounded-full bg-[var(--surface-alt)] border-[1.5px] border-[var(--primary)]"></div>
                    <div className="flex justify-between gap-4">
                      <div>
                        <span className="font-bold text-[10px] uppercase tracking-wider bg-[var(--primary-light)] text-[var(--primary)] px-1.5 py-0.5 rounded mr-2">V{h.version}</span>
                        <span className="font-semibold text-[var(--text-primary)]">{h.eventType === 'decided' ? `Decided: ${h.status}` : 'Reopened'}</span>
                      </div>
                      <span className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">{format(new Date(h.createdAt), 'MMM d, HH:mm')}</span>
                    </div>
                    {h.decidedBy && <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1">By: {h.decidedBy}</p>}
                    {h.reason && <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1 italic">Reason: {h.reason}</p>}
                    {h.comment && <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-1 italic border-l-2 pl-2 border-[var(--border)]">"{h.comment}"</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {isPending && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: '16px', paddingTop: '16px' }}>
            <div className="flex flex-col lg:flex-row items-start lg:items-end gap-6">
              <div className="flex-1 w-full space-y-2">
                <Label>Decision Comment (Optional)</Label>
                <textarea 
                  value={comment} 
                  onChange={(e) => setComment(e.target.value)} 
                  placeholder="Rationale for override..." 
                  style={{ width: '100%', minHeight: '36px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: 'var(--text-sm)', outline: 'none', resize: 'vertical', backgroundColor: 'var(--surface)', color: 'var(--text-primary)' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
                />
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>Decision will be recorded as <strong>{role || 'Reviewer'}</strong>.</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 w-full lg:w-auto">
                {!isHardBlock && (
                  <button 
                    style={{ height: '32px', borderRadius: 'var(--radius-md)', padding: '0 16px', fontSize: 'var(--text-sm)', fontWeight: 500, border: '1px solid var(--status-red)', color: 'var(--status-red)', backgroundColor: 'var(--surface)', cursor: decide.isPending ? 'not-allowed' : 'pointer', transition: 'all 0.15s' }}
                    onClick={() => handleDecide('rejected')} 
                    disabled={decide.isPending}
                    onMouseEnter={e => { if(!decide.isPending) { e.currentTarget.style.backgroundColor = 'var(--status-red)'; e.currentTarget.style.color = '#fff'; } }}
                    onMouseLeave={e => { if(!decide.isPending) { e.currentTarget.style.backgroundColor = 'var(--surface)'; e.currentTarget.style.color = 'var(--status-red)'; } }}
                  >
                    Reject Action
                  </button>
                )}
                <button 
                  style={{ height: '32px', borderRadius: 'var(--radius-md)', padding: '0 16px', fontSize: 'var(--text-sm)', fontWeight: 500, backgroundColor: 'var(--status-green)', color: '#ffffff', border: 'none', cursor: decide.isPending ? 'not-allowed' : 'pointer' }}
                  onClick={() => handleDecide('approved')} 
                  disabled={decide.isPending}
                  onMouseEnter={e => { if(!decide.isPending) e.currentTarget.style.opacity = '0.9' }}
                  onMouseLeave={e => { if(!decide.isPending) e.currentTarget.style.opacity = '1' }}
                >
                  {isHardBlock ? 'Acknowledge & Clear' : 'Approve Action'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div style={{ backgroundColor: 'var(--surface-alt)', padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="flex items-center gap-4">
          <Link href={`/cases/${approval.caseId}`} style={{ fontSize: 'var(--text-xs)', color: 'var(--primary)', fontWeight: 600 }} className="hover:underline">
            Open Full Case Context →
          </Link>
          <button onClick={() => setHistoryOpen(!historyOpen)} className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            {historyOpen ? 'Hide History' : 'Show History'}
          </button>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>ID: AP-{approval.id}-V{approval.version ?? 1}</span>
      </div>
    </Card>
  );
}
