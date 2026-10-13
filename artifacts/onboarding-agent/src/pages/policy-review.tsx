import React, { useState } from 'react';
import { useQueryClient, useQueries } from '@tanstack/react-query';
import { getListOnboardingCasesQueryKey, useListOnboardingCases } from '@workspace/api-client-react';
import { PageHeader, Card, CardContent, Button, Badge, LoadingBlock, cn, IconTile } from '@/components/ui-shared';
import { 
  useGetGovernanceDecisions, 
   usePostGovernanceDecisions,
  useGetGovernanceDecisionsKeyHistory, 
  usePostGovernanceDecisionsKeyRevisions,
  usePostGovernanceDecisionsKeyReviews,
  useGetGovernanceHistory,
  type GovernanceDecision,
   type GovernanceAssignment,
   type GovernanceDecisionReview
} from '../hooks/use-governance';
import {
  governanceCaseImpactQuery,
  type GovernanceCaseImpactResponse,
} from '../hooks/use-governance-impact';
import { useOrganizationRole } from '../hooks/use-organization-role';
import { useHumanPermissions } from '../hooks/use-human-permissions';
import { useUser } from '@clerk/react';
import { Shield, Check, X, AlertTriangle, Clock, History, AlertCircle } from 'lucide-react';
import { format } from 'date-fns';

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'data' in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === 'object' && 'message' in data && typeof data.message === 'string') return data.message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function assignmentState(assignment: GovernanceAssignment, now = Date.now()) {
  if (assignment.revokedAt) return 'revoked' as const;
  if (assignment.expiresAt && new Date(assignment.expiresAt).getTime() <= now) return 'expired' as const;
  if (assignment.verificationStatus !== 'verified') return 'pending' as const;
  return 'active' as const;
}

function hasActiveAuthority(assignments: GovernanceAssignment[], role: string, userId?: string) {
  return assignments.some((assignment) =>
    assignment.role === role &&
    assignment.assigneeUserId === userId &&
    assignmentState(assignment) === 'active',
  );
}

function DecisionHistory({ decisionKey, currentRevision }: { decisionKey: string, currentRevision: number }) {
  const { data: historyData, isLoading, error } = useGetGovernanceDecisionsKeyHistory(decisionKey);
  
  if (isLoading) return <div className="text-[var(--text-xs)] text-[var(--text-muted)] py-2">Loading history...</div>;
  if (error) return <div role="alert" className="py-2 text-[var(--text-xs)] text-[var(--status-red)]">{errorMessage(error, 'Could not load decision history.')}</div>;
  if (!historyData?.revisions || historyData.revisions.length === 0) return null;

  return (
    <div className="mt-4 border-t border-[var(--border)] pt-4 space-y-3">
      <h4 className="text-[var(--text-xs)] font-bold text-[var(--text-muted)] uppercase">Revision History</h4>
      <div className="space-y-2">
        {historyData.revisions.map(rev => (
          <div key={rev.revision} className={cn("p-2 border rounded text-[var(--text-xs)] flex justify-between items-center", 
            rev.revision === currentRevision ? "bg-[var(--surface-alt)] border-[var(--primary)]" : "bg-[var(--surface)] border-[var(--border)]"
          )}>
            <div>
              <span className="font-semibold mr-2">Rev {rev.revision}</span>
              <span className={cn("px-1.5 py-0.5 rounded text-[10px] uppercase font-bold", 
                rev.status === 'approved' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' :
                rev.status === 'rejected' ? 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]' :
                rev.status === 'superseded' ? 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)]' :
                'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]'
              )}>
                {rev.status}
              </span>
              <div className="text-[var(--text-muted)] mt-1 truncate max-w-[200px]">{typeof rev.proposedValue === 'string' ? rev.proposedValue : JSON.stringify(rev.proposedValue)}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <h5 className="text-[10px] font-bold uppercase text-[var(--text-muted)]">Review receipts</h5>
        {historyData.reviews.length === 0 ? (
          <p className="text-[var(--text-xs)] text-[var(--text-muted)]">No review receipt has been recorded for this decision.</p>
        ) : historyData.reviews.map((review: GovernanceDecisionReview) => (
          <div key={review.id} className="rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text-xs)]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">Rev {review.revision}</span>
              <Badge className={cn("shadow-none text-[10px] uppercase", review.outcome === 'approved' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]')}>{review.outcome}</Badge>
              <span className="text-[var(--text-muted)]">{format(new Date(review.createdAt), 'MMM d, yyyy p')}</span>
            </div>
            <p className="mt-1">{review.reason}</p>
            <p className="mt-1 font-mono text-[10px] text-[var(--text-muted)]">Reviewer {review.reviewedByUserId} · authority assignment {review.authorityAssignmentId} · receipt {review.verificationReference}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function DecisionCard({ decision, assignments, canDraft }: {
  decision: GovernanceDecision;
  assignments: GovernanceAssignment[];
  canDraft: boolean;
}) {
  const qc = useQueryClient();
  const proposeRevision = usePostGovernanceDecisionsKeyRevisions();
  const reviewDecision = usePostGovernanceDecisionsKeyReviews();
  const { user } = useUser();
  const userId = user?.id;

  const [isEditing, setIsEditing] = useState(false);
  const [draftValue, setDraftValue] = useState(typeof decision.proposedValue === 'string' ? decision.proposedValue : JSON.stringify(decision.proposedValue, null, 2));
  const [draftRationale, setDraftRationale] = useState(decision.rationale);
  const [reviewReason, setReviewReason] = useState("");
  const [reviewVerificationReference, setReviewVerificationReference] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showReview, setShowReview] = useState(false);

  const permissions = useHumanPermissions();
  const isReviewer = permissions.data?.allows.includes('tool.policy.manage') === true && !permissions.isError;

  const handlePropose = () => {
    let parsedValue = draftValue;
    try {
      if (draftValue.startsWith('{') || draftValue.startsWith('[')) {
        parsedValue = JSON.parse(draftValue);
      }
    } catch (e) {}

    proposeRevision.mutate({
      key: decision.key,
      expectedRevision: decision.revision,
      data: {
        proposedValue: parsedValue,
        rationale: draftRationale
      }
    }, {
      onSuccess: () => setIsEditing(false),
      onError: () => qc.invalidateQueries({ queryKey: ['governance', 'decisions'] }),
    });
  };

  const handleReview = (outcome: 'approved' | 'rejected') => {
    if (!isReviewer || !reviewReason.trim() || !reviewVerificationReference.trim()) return;
    reviewDecision.mutate({
      key: decision.key,
      expectedRevision: decision.revision,
      outcome,
      reason: reviewReason.trim(),
      verificationReference: reviewVerificationReference.trim()
    }, {
      onSuccess: () => {
        setShowReview(false);
        setReviewReason("");
        setReviewVerificationReference("");
      },
      onError: () => {
        qc.invalidateQueries({ queryKey: ['governance', 'decisions'] });
        qc.invalidateQueries({ queryKey: ['governance', 'assignments'] });
      }
    });
  };

  const statusColors = {
    draft: 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] border-[var(--status-gray)]',
    provisional: 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] border-[var(--status-amber)]',
    approved: 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)] border-[var(--status-green)]',
    rejected: 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)] border-[var(--status-red)]',
    superseded: 'bg-[var(--status-gray-bg)] text-[var(--status-gray-fg)] border-[var(--status-gray)]',
  };

  return (
    <Card className={cn("overflow-hidden border transition-all", 
      decision.status === 'provisional' ? "border-[var(--status-amber)] ring-1 ring-[var(--status-amber)]/20" : 
      decision.status === 'draft' ? "border-[var(--status-gray)]" :
      "border-[var(--border)]"
    )}>
      <div className="p-[var(--space-md)] bg-[var(--surface-alt)] border-b border-[var(--border)] flex justify-between items-start gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)]">{decision.title}</h3>
            <Badge className={cn("shadow-none text-[10px] uppercase font-bold px-1.5 py-0.5", statusColors[decision.status] || statusColors.draft)}>
              {decision.status === 'provisional' ? 'Pending Policy Review' : decision.status}
            </Badge>
            <span className="text-[10px] text-[var(--text-muted)] font-mono bg-[var(--surface)] px-1.5 py-0.5 rounded border border-[var(--border)]">
              Rev {decision.revision}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[var(--text-xs)] text-[var(--text-muted)]">
            <span className="flex items-center gap-1"><Shield className="w-3 h-3" /> Accountable: {decision.accountableRole}</span>
             <span>Latest approved revision: {decision.approvedRevision ?? 'none'}</span>
            {decision.reviewDueAt && <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> Due: {format(new Date(decision.reviewDueAt), 'MMM d, yyyy')}</span>}
            {decision.sourceReference && <span>Ref: {decision.sourceReference}</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowHistory(!showHistory)} className="h-8 text-[var(--text-xs)]">
            <History className="w-3.5 h-3.5 mr-1" /> History
          </Button>
          {!isEditing && canDraft && (
            <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} className="h-8 text-[var(--text-xs)]">
              Revise decision
            </Button>
          )}
        </div>
      </div>
      
      <CardContent className="p-[var(--space-md)] text-[var(--text-sm)] space-y-4">
        {isEditing ? (
          <div className="space-y-3 bg-[var(--surface-soft)] p-3 rounded-md border border-[var(--border)]">
            <h4 className="text-[var(--text-xs)] font-bold text-[var(--text-primary)] uppercase">Draft New Revision</h4>
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Proposed Value</label>
              <textarea 
                className="w-full text-[var(--text-sm)] rounded-[var(--radius-md)] p-2 border border-input outline-none focus:border-[var(--primary)] min-h-[60px] bg-background font-mono"
                value={draftValue}
                onChange={e => setDraftValue(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Rationale</label>
              <textarea 
                className="w-full text-[var(--text-sm)] rounded-[var(--radius-md)] p-2 border border-input outline-none focus:border-[var(--primary)] min-h-[60px] bg-background"
                value={draftRationale}
                onChange={e => setDraftRationale(e.target.value)}
                placeholder="Why are we making this change?"
              />
            </div>
            <div className="flex gap-2 justify-end pt-2">
              <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)}>Cancel</Button>
              <Button size="sm" onClick={handlePropose} disabled={proposeRevision.isPending} className="bg-[var(--primary)] text-white">
                {proposeRevision.isPending ? 'Saving...' : 'Submit as Draft/Provisional'}
              </Button>
            </div>
            {proposeRevision.isError && (
              <div className="text-[var(--status-red)] text-[10px] uppercase font-bold text-right">
                {errorMessage(proposeRevision.error, 'Could not save this revision.')}
              </div>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Proposed Value</h4>
              <div className="p-2 rounded bg-[var(--surface-alt)] border border-[var(--border)] font-mono text-[var(--text-xs)] overflow-x-auto">
                {typeof decision.proposedValue === 'string' ? decision.proposedValue : JSON.stringify(decision.proposedValue, null, 2)}
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Rationale</h4>
                <p className="text-[var(--text-primary)]">{decision.rationale}</p>
              </div>
              <div>
                <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Risk</h4>
                <p className="text-[var(--text-primary)]">{decision.risk}</p>
              </div>
            </div>
          </div>
        )}

        {decision.impactedWorkflows && decision.impactedWorkflows.length > 0 && (
          <div>
            <h4 className="text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Impacted Workflows / Cases</h4>
            <div className="flex flex-wrap gap-1.5">
              {decision.impactedWorkflows.map(wf => (
                <Badge key={wf} variant="secondary" className="text-[10px] font-medium bg-[var(--surface-alt)] border border-[var(--border)]">
                  {wf}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {(decision.status === 'provisional' || decision.status === 'draft') && !isEditing && (
          <div className="mt-4 pt-4 border-t border-[var(--border)]">
            {isReviewer ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-[var(--status-amber)] bg-[var(--status-amber-bg)] p-2 rounded text-[var(--text-xs)]">
                  <AlertCircle className="w-4 h-4" />
                  <span>You have authority to review this decision.</span>
                </div>
                {showReview ? (
                  <div className="space-y-2">
                    <input 
                      type="text" 
                      placeholder="Reason for decision..." 
                      className="w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background"
                      value={reviewReason}
                      onChange={e => setReviewReason(e.target.value)}
                    />
                     <input
                       type="text"
                       placeholder="Review verification reference..."
                       className="w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background"
                       value={reviewVerificationReference}
                       onChange={e => setReviewVerificationReference(e.target.value)}
                     />
                    <div className="flex gap-2">
                       <Button size="sm" onClick={() => handleReview('approved')} disabled={reviewDecision.isPending || !reviewReason.trim() || !reviewVerificationReference.trim()} className="bg-[var(--status-green)] text-white hover:bg-[var(--status-green)]/90">
                        <Check className="w-4 h-4 mr-1" /> Approve
                      </Button>
                       <Button size="sm" onClick={() => handleReview('rejected')} disabled={reviewDecision.isPending || !reviewReason.trim() || !reviewVerificationReference.trim()} className="bg-[var(--status-red)] text-white hover:bg-[var(--status-red)]/90">
                        <X className="w-4 h-4 mr-1" /> Reject
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setShowReview(false)}>Cancel</Button>
                    </div>
                    {reviewDecision.isError && (
                      <div className="text-[var(--status-red)] text-[10px] uppercase font-bold mt-1">
                         {errorMessage(reviewDecision.error, 'Review failed. Reload the decision before retrying.')}
                      </div>
                    )}
                  </div>
                ) : (
                  <Button onClick={() => setShowReview(true)} className="bg-[var(--primary)] text-white">Review Decision</Button>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-[var(--text-muted)] bg-[var(--surface-alt)] p-2 rounded text-[var(--text-xs)]">
                <Shield className="w-4 h-4" />
                <span>Pending review by {decision.accountableRole}. You do not have this authority.</span>
              </div>
            )}
          </div>
        )}

        {showHistory && (
          <DecisionHistory decisionKey={decision.key} currentRevision={decision.revision} />
        )}
      </CardContent>
    </Card>
  );
}

function NewDecisionForm({ canDraft }: { canDraft: boolean }) {
  const createDecision = usePostGovernanceDecisions();
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState('');
  const [title, setTitle] = useState('');
  const [proposedValue, setProposedValue] = useState('');
  const [rationale, setRationale] = useState('');
  const [risk, setRisk] = useState('');
  const [accountableRole, setAccountableRole] = useState('');
  const [impactedWorkflows, setImpactedWorkflows] = useState('');
  const [sourceReference, setSourceReference] = useState('');
  const [reviewDueAt, setReviewDueAt] = useState('');

  if (!canDraft) return null;

  const save = () => {
    if (!key.trim() || !title.trim() || !proposedValue.trim() || !rationale.trim() || !risk.trim() || !accountableRole.trim()) return;
    const proposedValueText = proposedValue.trim();
    let value: unknown = proposedValueText;
    try {
      if (proposedValueText.startsWith('{') || proposedValueText.startsWith('[')) value = JSON.parse(proposedValueText);
    } catch {
      // Keep non-JSON values as the explicit string the editor entered.
    }
    createDecision.mutate({
      key: key.trim(),
      title: title.trim(),
      proposedValue: value,
      rationale: rationale.trim(),
      risk: risk.trim(),
      accountableRole: accountableRole.trim(),
      impactedWorkflows: impactedWorkflows.split(',').map((workflow) => workflow.trim()).filter(Boolean),
      sourceReference: sourceReference.trim() || undefined,
      reviewDueAt: reviewDueAt ? new Date(reviewDueAt).toISOString() : null,
    }, {
      onSuccess: () => {
        setOpen(false);
        setKey(''); setTitle(''); setProposedValue(''); setRationale(''); setRisk('');
        setAccountableRole(''); setImpactedWorkflows(''); setSourceReference(''); setReviewDueAt('');
      },
    });
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3 p-[var(--space-md)]">
        <div><h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)]">Draft a policy decision</h3><p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Drafting requires an authorized owner/admin with policy-management permission. A named reviewer must explicitly review the current revision. Access does not establish professional qualifications.</p></div>
        <Button onClick={() => setOpen((value) => !value)} variant={open ? 'outline' : 'default'}>{open ? 'Cancel draft' : 'New decision'}</Button>
      </div>
      {open && <CardContent className="grid grid-cols-1 gap-3 border-t border-[var(--border)] p-[var(--space-md)] md:grid-cols-2">
        <label className="text-[var(--text-xs)] font-semibold">Decision key<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="e.g. GD-CUSTOM-01" className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-mono font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Title<input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Reviewer routing label<input value={accountableRole} onChange={(event) => setAccountableRole(event.target.value)} placeholder="e.g. Legal (routing only)" className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Review due (optional)<input type="datetime-local" value={reviewDueAt} onChange={(event) => setReviewDueAt(event.target.value)} className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold md:col-span-2">Proposed value<textarea value={proposedValue} onChange={(event) => setProposedValue(event.target.value)} placeholder="Text, or a JSON value" className="mt-1 min-h-16 w-full rounded border border-input bg-background p-2 font-mono font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Rationale<textarea value={rationale} onChange={(event) => setRationale(event.target.value)} className="mt-1 min-h-16 w-full rounded border border-input bg-background p-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Risk<textarea value={risk} onChange={(event) => setRisk(event.target.value)} className="mt-1 min-h-16 w-full rounded border border-input bg-background p-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Impacted workflows (comma-separated)<input value={impactedWorkflows} onChange={(event) => setImpactedWorkflows(event.target.value)} className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Source reference (optional)<input value={sourceReference} onChange={(event) => setSourceReference(event.target.value)} className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
        <div className="flex flex-wrap items-center justify-end gap-2 md:col-span-2">
          {createDecision.isError && <p role="alert" className="mr-auto text-[var(--text-xs)] text-[var(--status-red)]">{errorMessage(createDecision.error, 'Could not create the decision.')}</p>}
          <Button onClick={save} disabled={createDecision.isPending || !key.trim() || !title.trim() || !proposedValue.trim() || !rationale.trim() || !risk.trim() || !accountableRole.trim()}>{createDecision.isPending ? 'Saving draft…' : 'Create draft'}</Button>
        </div>
      </CardContent>}
    </Card>
  );
}

function AffectedCases() {
  const casesQuery = useListOnboardingCases({ query: { queryKey: getListOnboardingCasesQueryKey(), refetchInterval: 30000, refetchIntervalInBackground: true } });
  const caseIds = casesQuery.data?.map((onboardingCase) => onboardingCase.id) ?? [];
  const impactQueries = useQueries({
    queries: caseIds.map((caseId) => governanceCaseImpactQuery(caseId)),
  });
  const affectedCases = (casesQuery.data ?? []).flatMap((onboardingCase, index) => {
    const impact = impactQueries[index]?.data as GovernanceCaseImpactResponse | undefined;
    if (!impact) return [];
    if (impact.snapshot === null) {
      return [{ onboardingCase, impact, label: 'Legacy case has no governance snapshot' }];
    }
    if (impact.impacts.length === 0) return [];
    return [{ onboardingCase, impact, label: `${impact.impacts.length} governance change${impact.impacts.length === 1 ? '' : 's'} to review` }];
  });

  return (
    <Card>
      <div className="p-[var(--space-md)] bg-[var(--surface-alt)] border-b border-[var(--border)]">
        <h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)] flex items-center gap-2"><AlertTriangle className="w-4 h-4 text-[var(--status-amber)]" /> Affected cases</h3>
        <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Active cases retain their adopted decision snapshot. This list uses each case’s governance-impact response; it does not apply current decisions automatically.</p>
      </div>
      <CardContent className="space-y-2 p-[var(--space-md)]">
        {casesQuery.isLoading ? <LoadingBlock>Loading cases and adopted governance snapshots...</LoadingBlock> : null}
        {casesQuery.error ? <p role="alert" className="text-[var(--text-sm)] text-[var(--status-red)]">{errorMessage(casesQuery.error, 'Could not load onboarding cases.')}</p> : null}
        {!casesQuery.isLoading && !casesQuery.error && impactQueries.some((query) => query.error) ? <p role="alert" className="text-[var(--text-xs)] text-[var(--status-red)]">Some case impact records could not be loaded. Refresh before taking action.</p> : null}
        {!casesQuery.isLoading && !casesQuery.error && affectedCases.length === 0 ? <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No case currently reports a governance revision impact.</p> : null}
        {affectedCases.map(({ onboardingCase, impact, label }) => (
          <div key={onboardingCase.id} className="rounded border border-[var(--border)] bg-[var(--surface)] p-3 text-[var(--text-sm)]">
            <p className="font-semibold">{onboardingCase.workerName} <span className="font-mono text-[var(--text-xs)] text-[var(--text-muted)]">Case {onboardingCase.id}</span></p>
            <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">{label}</p>
            {impact.snapshot === null ? <p className="mt-1 text-[var(--text-xs)] text-[var(--status-amber-fg)]">An audited version-0 legacy adoption can be requested from the case Readiness view. Sensitive future live actions fail closed until then.</p> : (
              <div className="mt-2 space-y-1 text-[var(--text-xs)]">
                {impact.impacts.map((item) => <p key={item.key}><span className="font-semibold">{item.key}</span>: adopted rev {item.adoptedRevision ?? 'none'} → current rev {item.currentRevision ?? 'missing'} · {item.reason.replace(/-/g, ' ')}{item.blocksLiveActions ? ' · blocks affected live actions' : ''}</p>)}
              </div>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function GovernanceAuditHistory() {
  const { data: history, isLoading, error } = useGetGovernanceHistory();
  if (isLoading) return <LoadingBlock>Loading review and reminder history...</LoadingBlock>;
  if (error) return <p role="alert" className="text-[var(--status-red)]">{errorMessage(error, 'Could not load governance history.')}</p>;
  return (
    <Card>
      <div className="p-[var(--space-md)] bg-[var(--surface-alt)] border-b border-[var(--border)]">
        <h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)] flex items-center gap-2"><History className="w-4 h-4 text-[var(--primary)]" /> Review and reminder history</h3>
        <p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Durable reminder dispatches appear as <span className="font-mono">review-reminder-due</span> receipts. The dispatch endpoint sends no provider message.</p>
      </div>
      <CardContent className="space-y-2 p-[var(--space-md)]">
        {!history?.length ? <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No governance audit events have been recorded.</p> : history.map((event) => (
          <div key={event.id} className="rounded border border-[var(--border)] bg-[var(--surface)] p-2 text-[var(--text-xs)]">
            <div className="flex flex-wrap gap-x-2 gap-y-1"><span className="font-semibold">{event.eventType}</span><span>{event.entityType} · {event.entityKey}</span><span className="text-[var(--text-muted)]">{format(new Date(event.createdAt), 'MMM d, yyyy p')}</span></div>
            <p className="mt-1 text-[var(--text-muted)]">Actor: {event.actorUserId ?? 'durable scheduler'} · Details: {JSON.stringify(event.detail)}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function PolicyReviewPage() {
  const [tab, setTab] = useState<'decisions' | 'history'>('decisions');
  const { isHR } = useOrganizationRole();
  
  const { data: decisions, isLoading: isLoadingDecisions } = useGetGovernanceDecisions({ query: { refetchInterval: 30000, refetchIntervalInBackground: true } });
  const permissions = useHumanPermissions();
  const assignments: GovernanceAssignment[] = [];
  const canDraft = isHR && permissions.data?.allows.includes('tool.policy.manage') === true && !permissions.isError;

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20">
      <PageHeader 
        title="Governance & Policy Review" 
        subtitle="Manage platform decisions and track pending policy reviews."
      />

      <div className="grid grid-cols-2 gap-x-3 border-b border-[var(--border)] sm:flex sm:flex-wrap sm:gap-4" role="tablist" aria-label="Policy review sections">
        <button 
          onClick={() => setTab('decisions')}
          role="tab"
          aria-selected={tab === 'decisions'}
          className={cn("min-w-0 pb-2 text-left text-[var(--text-sm)] font-semibold transition-colors border-b-2", tab === 'decisions' ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
        >
          Policy Decisions
        </button>
        <button
          onClick={() => setTab('history')}
          role="tab"
          aria-selected={tab === 'history'}
          className={cn("min-w-0 pb-2 text-left text-[var(--text-sm)] font-semibold transition-colors border-b-2", tab === 'history' ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
        >
          Audit history
        </button>
      </div>

      <div>
        {tab === 'decisions' && (
          <div className="space-y-4">
             <NewDecisionForm canDraft={canDraft} />
             <AffectedCases />
            {isLoadingDecisions ? <LoadingBlock>Loading decisions...</LoadingBlock> : (
               decisions?.map(d => <DecisionCard key={d.key} decision={d} assignments={assignments || []} canDraft={canDraft} />)
            )}
            {!isLoadingDecisions && !decisions?.length && (
              <div className="text-center p-8 text-[var(--text-muted)] bg-[var(--surface-alt)] rounded-lg border border-[var(--border)]">
                No policy decisions registered.
              </div>
            )}
          </div>
        )}

         {tab === 'history' && <GovernanceAuditHistory />}
      </div>
    </div>
  );
}
