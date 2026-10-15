import React, { useState } from 'react';
import { lifecycleStageText } from '../lib/lifecycle-stage-presentation';
import { useListOnboardingApprovals, getListOnboardingApprovalsQueryKey, useGetOnboardingApprovalHistory, getGetOnboardingApprovalHistoryQueryKey, type OnbApproval } from '@workspace/api-client-react';
import { Card, Button, Badge, cn, Input, Label, PageHeader } from '@/components/ui-shared';
import { useUser } from '@clerk/react';
import { EngineBadge, HitlBadge } from '@/components/engine-badge';
import { format } from 'date-fns';
import { ShieldAlert } from 'lucide-react';
import { Link, useLocation, useSearch } from 'wouter';
import { useEffect } from 'react';
import { useApprovalAction, useApprovalCapability, useFreshApprovalReview } from '../hooks/use-approval-action';
import {
  getApprovalRefetchInterval,
  getApprovalVersionLabel,
  isApprovalAcknowledgement,
} from '../lib/approval-actions';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CASE_TYPES } from './cases/case-presentation';
import { useActionCenterCaseType, useActionCenterScope, useActionCenter } from '../hooks/use-action-center-filter';
import { ActionCasePresentation, ActionReference, useActionCase, ActionConversationLink } from './action-center-domain-records';
import { actionCenterTypeHref } from '../lib/action-center-filter';

// Import the newly created tab components
import { ActionConversationPanel, ConversationCaseOpener } from '@/components/action-conversation';
import { NeedsAttentionTab, CompletedTab, CommunicationsTab } from './action-center-tabs';

export function ApprovalsPage() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const caseType = useActionCenterCaseType();
  const scope = useActionCenterScope();
  const presentation = useActionCenter({ scope: 'all' });
  const tabParam = searchParams.get('tab');

  const activeTab = tabParam && ['needs-attention', 'approvals', 'communications', 'completed', 'conversation'].includes(tabParam)
    ? tabParam : 'needs-attention';

  const posInt = (v: string | null) => (v && /^[1-9]\d*$/.test(v) ? Number(v) : undefined);
  const conversationCaseId = posInt(searchParams.get('caseId'));
  const conversationWorkItemId = posInt(searchParams.get('workItemId'));

  const setActiveTab = (val: string) => {
    const next = new URLSearchParams(search);
    next.set('tab', val);
    setLocation(`${location}?${next.toString()}`);
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto">
      <PageHeader title="Action Center" subtitle="One accountable view of employee followups and human decisions." />
      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="action-center-case-type" className="text-sm font-semibold">Case type</label>
        <select id="action-center-case-type" value={caseType ?? ''} className="h-9 max-w-full rounded border border-[var(--border)] bg-[var(--surface)] px-3 text-sm"
          onChange={e => {
            setLocation(actionCenterTypeHref(location, search, e.target.value, window.location.hash));
          }}>
          {CASE_TYPES.map(type => <option key={type} value={type === 'All Cases' ? '' : type}>{type === 'All Cases' ? 'All case types' : type}</option>)}
        </select>
        {caseType && <Button size="sm" variant="outline" onClick={() => {
          setLocation(actionCenterTypeHref(location, search, undefined, window.location.hash));
        }}>Clear case type</Button>}
      </div>
      {presentation.data?.offboardingSource === 'denied' && <p role="status" className="text-xs text-[var(--text-muted)]">Offboarding source access was denied. Other authorized case records remain available.</p>}
      {presentation.data?.offboardingSource === 'partial' && <p role="status" className="text-xs text-[var(--text-muted)]">Only authorized offboarding records are shown.</p>}
      {presentation.isError && <p role="alert" className="text-sm text-[var(--status-red)]">Action Center sources could not be loaded or access was denied. No cached records are shown.</p>}

      <ActionCasePresentation.Provider value={presentation.data?.caseSummaries ?? []}>
      <Tabs key={scope.join('|')} value={activeTab} onValueChange={setActiveTab} className="w-full">
        <div className="min-w-0 overflow-hidden pb-2">
          <TabsList className="grid h-auto w-full grid-cols-2 gap-1 sm:grid-cols-5 mb-4">
            <TabsTrigger value="needs-attention">Needs Attention</TabsTrigger>
            <TabsTrigger value="approvals">Approvals</TabsTrigger>
            <TabsTrigger value="communications">Communications</TabsTrigger>
            <TabsTrigger value="completed">Completed</TabsTrigger>
            <TabsTrigger value="conversation" className="col-span-2 sm:col-span-1">Conversation</TabsTrigger>
          </TabsList>
        </div>


        <TabsContent value="needs-attention">
          <NeedsAttentionTab />
        </TabsContent>

        <TabsContent value="approvals">
          <LegacyApprovalsQueue />
        </TabsContent>

        <TabsContent value="communications">
          <CommunicationsTab />
        </TabsContent>

        <TabsContent value="completed">
          <CompletedTab />
        </TabsContent>

        <TabsContent value="conversation">
          {conversationCaseId ? (
            <>
            <p className="mb-2 text-xs text-[var(--text-muted)]">Case type filters apply to discovery. This explicitly opened conversation remains on its selected case.</p>
            <ActionConversationPanel caseId={conversationCaseId} workItemId={conversationWorkItemId} />
            </>
          ) : (
            <>
            <ConversationCaseOpener onOpen={(id) => {
              const next = new URLSearchParams(search);
              next.set('tab', 'conversation');
              next.set('caseId', String(id));
              next.delete('workItemId');
              setLocation(`${location}?${next.toString()}`);
            }} />
            <ConversationCaseDiscovery />
            </>
          )}
        </TabsContent>
      </Tabs>
      </ActionCasePresentation.Provider>
    </div>
  );
}

function ConversationCaseDiscovery() {
  const query = useActionCenter({ scope: 'all' });
  const search = useSearch();
  if (query.isLoading) return <p role="status">Loading matching cases…</p>;
  if (query.isError) return <p role="alert">Case discovery could not be loaded or access was denied.</p>;
  const cases = query.data?.caseSummaries ?? [];
  return <section className="mt-4 space-y-2">
    <h3 className="text-sm font-semibold">Matching authorized cases ({cases.length})</h3>
    {cases.length === 0 && <p className="text-sm text-[var(--text-muted)]">No authorized cases match this case type. No examples are created by this filter.</p>}
    {cases.map(c => {
      const next = new URLSearchParams(search);
      next.set('tab', 'conversation'); next.set('caseId', String(c.caseId)); next.delete('workItemId');
      return <div key={c.caseId} className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] py-2 text-sm">
        <Link href={c.caseHref} className="text-[var(--primary)]">{c.label}</Link>
        <span>{c.caseType} · {c.status}</span>
        <Link href={`/approvals?${next.toString()}`} className="text-[var(--primary)]">Open conversation</Link>
      </div>;
    })}
  </section>;
}

function LegacyApprovalsQueue() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const filterCaseId = searchParams.get('caseId');
  const filterApprovalId = searchParams.get('approvalId');
  const filterApprovalRef = searchParams.get('approvalRef');
  const hasFilter = filterCaseId || filterApprovalId || filterApprovalRef;
  const [showAll, setShowAll] = useState(!!hasFilter);
  const caseType = useActionCenterCaseType();
  const scope = useActionCenterScope();
  const statusParam = showAll ? 'all' : 'pending';
  const { data: loadedApprovals, isLoading, isError } = useListOnboardingApprovals({ status: statusParam, caseType }, {
    query: {
      queryKey: [...getListOnboardingApprovalsQueryKey({ status: statusParam, caseType }), ...scope],
      retry: false,
      refetchInterval: (query) => getApprovalRefetchInterval(query.state.data),
    }
  });
  const approvals = isError ? undefined : loadedApprovals?.filter(app =>
    (!filterCaseId || app.caseId.toString() === filterCaseId) &&
    (!filterApprovalId || app.id.toString() === filterApprovalId) &&
    (!filterApprovalRef || app.ruleRef === filterApprovalRef));

  return (
    <div className="space-y-4">
      {hasFilter && (
        <div className="bg-[var(--primary-light)] border border-[var(--primary)] text-[var(--primary)] px-4 py-3 rounded-md flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-sm">Filtered View Active:</span>
            <div className="flex gap-2 text-xs">
              {filterCaseId && <Badge variant="outline" className="bg-white/50"><ActionReference caseId={Number(filterCaseId)} /></Badge>}
              {filterApprovalId && <Badge variant="outline" className="bg-white/50">Approval #{filterApprovalId}</Badge>}
              {filterApprovalRef && <Badge variant="outline" className="bg-white/50">Ref: {filterApprovalRef}</Badge>}
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => {
            const next = new URLSearchParams(search);
            ['caseId', 'approvalId', 'approvalRef'].forEach(key => next.delete(key));
            next.set('tab', 'approvals');
            setLocation(`${location}?${next.toString()}`);
          }}>Clear Filters</Button>
        </div>
      )}
      <div className="flex justify-end mb-4">
        <div className="flex items-center gap-2 bg-[var(--surface)] px-3 py-1.5 rounded-md border" style={{ borderColor: 'var(--border)' }}>
          <Label htmlFor="show-all" className="cursor-pointer text-[var(--text-sm)] m-0">Show Resolved History</Label>
          <input
            type="checkbox"
            id="show-all"
            checked={showAll}
            onChange={(e) => setShowAll(e.target.checked)}
            style={{ accentColor: 'var(--primary)', cursor: 'pointer', width: '14px', height: '14px' }}
          />
        </div>
      </div>

      {isError ? <p role="alert">Approvals could not be loaded or access was denied.</p> : isLoading ? (
        <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>Loading queue...</div>
      ) : approvals?.length === 0 ? (
        <Card className="text-center border-dashed" style={{ padding: '64px', borderColor: 'var(--border)', backgroundColor: 'transparent', boxShadow: 'none' }}>
          <ShieldAlert style={{ width: '48px', height: '48px', margin: '0 auto 16px', color: 'var(--text-muted)', opacity: 0.5 }} />
          <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>Queue is Clear</h3>
           <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>No recorded approvals match the selected filters.</p>
        </Card>
      ) : (
        approvals?.filter(app => {
          if (filterCaseId && app.caseId.toString() !== filterCaseId) return false;
          if (filterApprovalId && app.id.toString() !== filterApprovalId) return false;
          if (filterApprovalRef && app.ruleRef !== filterApprovalRef) return false;
          return true;
        }).map(app => (
          <ApprovalCard key={app.id} approval={app} statusParam={statusParam} />
        ))
      )}
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

export function ApprovalCard({ approval, statusParam: _statusParam }: { approval: OnbApproval, statusParam: string }) {
  const casePresentation = useActionCase(approval.caseId);
  const [comment, setComment] = useState('');
  const { user } = useUser();
  const action = useApprovalAction(approval);
  const capability = useApprovalCapability(approval);
  const freshReview = useFreshApprovalReview(approval);

  const handleDecide = (decision: string) => {
    if (decision !== 'approved' && decision !== 'rejected') return;
    action.submit(decision, comment || undefined);
  };

  const isPending = approval.status === 'pending';
  const isAcknowledgement = isApprovalAcknowledgement(approval);
  const isGateA = approval.ruleRef === 'Gate A — offer-acceptance package' && !capability.data?.reviewOnly;

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
               <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--primary)', backgroundColor: 'var(--primary-light)', padding: '2px 8px', borderRadius: '999px' }}><ActionReference caseId={approval.caseId} /></span>
              <span style={{ color: 'var(--text-muted)' }}>•</span>
              <EngineBadge engine={approval.agent} />
              <HitlBadge pattern={approval.hitlPattern} />
              {approval.ruleRef && <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{lifecycleStageText(approval.ruleRef)}</span>}
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }} className="md:ml-auto">{format(new Date(approval.createdAt), 'MMM d, HH:mm')}</span>
            </div>

            <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-primary)', marginTop: '12px', marginBottom: '8px' }}>{lifecycleStageText(approval.recommendation)}</h3>

            <div style={{ backgroundColor: 'var(--surface-alt)', border: '1px solid var(--border)', borderLeft: '3px solid var(--primary)', borderRadius: 'var(--radius-md)', padding: '12px 16px', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {lifecycleStageText(approval.rationale)}
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
                {capability.data?.requiresFreshReview && (
                  <div className="mt-2 space-y-2 rounded border border-[var(--status-amber)] p-2 text-left">
                    <p>This historical or no-longer-current decision does not authorize new effects. Unexecuted work needs a fresh human review; completed provider outcomes will not be replayed.</p>
                    {capability.data.canRequestFreshReview && (
                      <Button size="sm" variant="outline" disabled={freshReview.isPending || capability.isRefetchError}
                        onClick={() => freshReview.mutate()}>
                        {freshReview.isPending ? "Requesting review…" : "Request fresh human review"}
                      </Button>
                    )}
                  </div>
                )}
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
            {isGateA ? (
              <div className="flex items-center justify-between gap-3">
                <p className="text-[var(--text-sm)] text-[var(--text-secondary)] m-0">Offer-Acceptance Package can only be released through its dedicated case confirmation.</p>
                <Link href={`/cases/${approval.caseId}`}><Button size="sm" className="h-auto whitespace-normal">Open Offer-Acceptance Package confirmation</Button></Link>
              </div>
            ) : (
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
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontStyle: 'italic' }}>The server checks current client/case permissions, evidence revision and requester separation before recording this explicit decision. Permission does not establish professional qualifications.</p>
              </div>
              <div className="flex items-center gap-3 shrink-0 w-full lg:w-auto">
                {!isAcknowledgement && (
                  <button
                    style={{ height: '32px', borderRadius: 'var(--radius-md)', padding: '0 16px', fontSize: 'var(--text-sm)', fontWeight: 500, border: '1px solid var(--status-red)', color: 'var(--status-red)', backgroundColor: 'var(--surface)', cursor: action.canAct ? 'pointer' : 'not-allowed', transition: 'all 0.15s' }}
                    onClick={() => handleDecide('rejected')}
                    disabled={!action.canAct}
                    onMouseEnter={e => { if(action.canAct) { e.currentTarget.style.backgroundColor = 'var(--status-red)'; e.currentTarget.style.color = '#fff'; } }}
                    onMouseLeave={e => { if(action.canAct) { e.currentTarget.style.backgroundColor = 'var(--surface)'; e.currentTarget.style.color = 'var(--status-red)'; } }}
                  >
                    Reject Action
                  </button>
                )}
                <button
                  style={{ height: '32px', borderRadius: 'var(--radius-md)', padding: '0 16px', fontSize: 'var(--text-sm)', fontWeight: 500, backgroundColor: 'var(--status-green)', color: '#ffffff', border: 'none', cursor: action.canAct ? 'pointer' : 'not-allowed' }}
                  onClick={() => handleDecide('approved')}
                  disabled={!action.canAct}
                  onMouseEnter={e => { if(action.canAct) e.currentTarget.style.opacity = '0.9' }}
                  onMouseLeave={e => { if(action.canAct) e.currentTarget.style.opacity = '1' }}
                >
                  {action.actionLabel}
                </button>
              </div>
            </div>
            )}
            {!isGateA && isAcknowledgement && (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-3">
                Acknowledgement records the review only; it does not complete assets or advance the case.
              </p>
            )}
            {action.isAuthorityLoading && (
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-3" role="status">
                Checking current decision permissions…
              </p>
            )}
            {!action.isAuthorityLoading && !action.isAuthorized && (
              <p className="text-[var(--text-xs)] text-[var(--status-red)] mt-3" role="alert">
                Current approval-decision and case-flow permissions, applicable field permissions, and an independent named reviewer are required. Membership labels and display personas do not grant access.
              </p>
            )}
            {!action.hasValidVersion && (
              <p className="text-[var(--text-xs)] text-[var(--status-red)] mt-3" role="alert">
                This review has no valid version. Reload the review before taking action.
              </p>
            )}
            {action.actionError && (
              <p className="text-[var(--text-xs)] text-[var(--status-red)] mt-3" role="alert">
                {action.actionError}
              </p>
            )}
            {action.notice && (
              <p className="text-[var(--text-xs)] text-[var(--status-green-fg)] mt-3" role="status">
                {action.notice}
              </p>
            )}
          </div>
        )}
      </div>
      <div style={{ backgroundColor: 'var(--surface-alt)', padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div className="flex items-center gap-4">
           <Link href={casePresentation.href} style={{ fontSize: 'var(--text-xs)', color: 'var(--primary)', fontWeight: 600 }} className="hover:underline">
            Open Full Case Context →
          </Link>
           <ActionConversationLink caseId={approval.caseId} />
          <button onClick={() => setHistoryOpen(!historyOpen)} className="text-[var(--text-xs)] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
            {historyOpen ? 'Hide History' : 'Show History'}
          </button>
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>ID: AP-{approval.id}-{getApprovalVersionLabel(approval)}</span>
      </div>
    </Card>
  );
}
