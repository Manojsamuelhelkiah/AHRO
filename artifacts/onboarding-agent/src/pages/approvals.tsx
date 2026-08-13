import React, { useState } from 'react';
import { useListOnboardingApprovals, useDecideOnboardingApproval, getListOnboardingApprovalsQueryKey } from '@workspace/api-client-react';
import { Card, Button, Badge, cn, Input, Label, PageHeader } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { useUser } from '@clerk/react';
import { EngineBadge, HitlBadge } from '@/components/engine-badge';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { Link } from 'wouter';

export function ApprovalsPage() {
  const [showAll, setShowAll] = useState(false);
  const statusParam = showAll ? 'all' : 'pending';
  const { data: approvals, isLoading } = useListOnboardingApprovals({ status: statusParam }, {
    query: { queryKey: getListOnboardingApprovalsQueryKey({ status: statusParam }) }
  });

  return (
    <div className="space-y-4 max-w-4xl mx-auto">
      <PageHeader title="Review Queue" subtitle="Human-in-the-loop decisions for agentic actions.">
        <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-md border" style={{ borderColor: 'var(--border)' }}>
          <Label htmlFor="show-all" className="cursor-pointer" style={{ margin: 0 }}>Show Resolved History</Label>
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
          <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: '13px' }}>Loading queue...</div>
        ) : approvals?.length === 0 ? (
          <Card className="text-center border-dashed" style={{ padding: '64px', borderColor: 'var(--border)', backgroundColor: 'transparent', boxShadow: 'none' }}>
            <ShieldAlert style={{ width: '48px', height: '48px', margin: '0 auto 16px', color: 'var(--text-muted)', opacity: 0.5 }} />
            <h3 style={{ fontSize: '16px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Queue is Clear</h3>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>No agent actions require human review at this time.</p>
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
  
  const role = typeof window !== 'undefined' ? localStorage.getItem('hro_role') || 'Reviewer' : 'Reviewer';

  const handleDecide = (decision: string) => {
    decide.mutate({
      id: approval.id,
      data: { decision, comment: comment || undefined }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingApprovalsQueryKey({ status: statusParam }) });
      }
    });
  };

  const isPending = approval.status === 'pending';
  const isHardBlock = approval.hitlPattern === 'hard-block';

  return (
    <Card 
      className={cn("overflow-hidden transition-all group", !isPending && "opacity-75 bg-[var(--surface-alt)]")}
      style={{ padding: '0', backgroundColor: '#ffffff', borderRadius: 'var(--radius-lg)' }}
    >
      <div style={{ padding: '20px 24px' }}>
        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
          <div className="flex-1 w-full">
            <div className="flex flex-wrap items-center gap-2">
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--primary)', backgroundColor: 'var(--primary-light)', padding: '2px 8px', borderRadius: '999px' }}>Case #{approval.caseId}</span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <EngineBadge engine={approval.agent} />
              <HitlBadge pattern={approval.hitlPattern} />
              {approval.ruleRef && <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{approval.ruleRef}</span>}
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }} className="md:ml-auto">{format(new Date(approval.createdAt), 'MMM d, HH:mm')}</span>
            </div>
            
            <h3 style={{ fontSize: '15px', fontWeight: 600, color: 'var(--text-primary)', marginTop: '12px', marginBottom: '8px' }}>{approval.recommendation}</h3>
            
            <div style={{ backgroundColor: '#f8f7ff', border: '1px solid var(--border-strong)', borderLeft: '3px solid var(--primary)', borderRadius: 'var(--radius-md)', padding: '12px 16px', fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {approval.rationale}
            </div>
            
            {Array.isArray(approval.recordsEvidence) && approval.recordsEvidence.length > 0 && (
              <div className="mt-4 border rounded-md divide-y" style={{ borderColor: 'var(--border)' }}>
                <div style={{ padding: '8px 16px', fontSize: '11px', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', backgroundColor: '#f9fafb' }}>Archive evidence</div>
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
                          backgroundColor: ev.scope?.kind === 'all' || !ev.scope ? '#f3f4f6' : '#e0e7ff',
                          color: ev.scope?.kind === 'all' || !ev.scope ? '#4b5563' : '#4338ca',
                          border: ev.scope?.kind === 'all' || !ev.scope ? '1px solid transparent' : '1px solid #c7d2fe'
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
              <span style={{ padding: '4px 12px', borderRadius: '4px', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', backgroundColor: approval.status === 'approved' ? 'var(--status-green)' : 'var(--status-red)', color: '#ffffff' }}>
                {approval.status}
              </span>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', textAlign: 'right', marginTop: '8px' }}>
                <p>Reviewed by <strong>{approval.decidedBy ?? ""}</strong></p>
                {approval.comment && <p className="italic border-t pt-1 mt-1" style={{ borderColor: 'var(--border)' }}>"{approval.comment}"</p>}
              </div>
            </div>
          )}
        </div>

        {isPending && (
          <div style={{ borderTop: '1px solid var(--border)', marginTop: '16px', paddingTop: '16px' }}>
            <div className="flex flex-col lg:flex-row items-start lg:items-end gap-6">
              <div className="flex-1 w-full space-y-2">
                <Label>Decision Comment (Optional)</Label>
                <textarea 
                  value={comment} 
                  onChange={(e) => setComment(e.target.value)} 
                  placeholder="Rationale for override..." 
                  style={{ width: '100%', minHeight: '36px', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: '8px 12px', fontSize: '13px', outline: 'none', resize: 'vertical' }}
                  onFocus={e => e.currentTarget.style.borderColor = 'var(--primary)'}
                  onBlur={e => e.currentTarget.style.borderColor = 'var(--border)'}
                />
                <p style={{ fontSize: '12px', color: 'var(--text-muted)', fontStyle: 'italic' }}>Decision will be recorded as <strong>{role}</strong>.</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 w-full lg:w-auto">
                {!isHardBlock && (
                  <button 
                    style={{ height: '36px', borderRadius: 'var(--radius-md)', padding: '0 16px', fontSize: '13px', fontWeight: 500, border: '1px solid var(--status-red)', color: 'var(--status-red)', backgroundColor: '#ffffff', cursor: decide.isPending ? 'not-allowed' : 'pointer' }}
                    onClick={() => handleDecide('rejected')} 
                    disabled={decide.isPending}
                    onMouseEnter={e => { if(!decide.isPending) e.currentTarget.style.backgroundColor = '#fef2f2' }}
                    onMouseLeave={e => { if(!decide.isPending) e.currentTarget.style.backgroundColor = '#ffffff' }}
                  >
                    Reject Action
                  </button>
                )}
                <button 
                  style={{ height: '36px', borderRadius: 'var(--radius-md)', padding: '0 16px', fontSize: '13px', fontWeight: 500, backgroundColor: 'var(--status-green)', color: '#ffffff', border: 'none', cursor: decide.isPending ? 'not-allowed' : 'pointer' }}
                  onClick={() => handleDecide('approved')} 
                  disabled={decide.isPending}
                  onMouseEnter={e => { if(!decide.isPending) e.currentTarget.style.backgroundColor = '#047857' }}
                  onMouseLeave={e => { if(!decide.isPending) e.currentTarget.style.backgroundColor = 'var(--status-green)' }}
                >
                  {isHardBlock ? 'Acknowledge & Clear' : 'Approve Action'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div style={{ backgroundColor: '#ffffff', padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Link href={`/cases/${approval.caseId}`} style={{ fontSize: '12px', color: 'var(--primary)', fontWeight: 500 }} className="hover:underline">
          Open Full Case Context →
        </Link>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>ID: APP-{approval.id}</span>
      </div>
    </Card>
  );
}
