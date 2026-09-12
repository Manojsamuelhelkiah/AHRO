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
  useGetGovernanceRequirements,
  usePutGovernanceRequirementsKeyCoverage,
  useGetGovernanceAssignments,
  usePostGovernanceAuthorityBootstrap,
  usePostGovernanceAssignmentsIdRevoke,
  usePostGovernanceAssignments,
  usePostGovernanceAssignmentsIdVerify,
  useGetGovernanceHistory,
  type GovernanceDecision,
  type GovernanceRequirement,
   type GovernanceAssignment,
   type GovernanceDecisionReview
} from '../hooks/use-governance';
import {
  governanceCaseImpactQuery,
  type GovernanceCaseImpactResponse,
} from '../hooks/use-governance-impact';
import { useOrganizationRole } from '../hooks/use-organization-role';
import { useUser } from '@clerk/react';
import { CheckSquare, Shield, Check, X, AlertTriangle, Clock, History, AlertCircle, FileKey } from 'lucide-react';
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
  if (assignment.verificationStatus !== 'verified') return 'pending' as const;
  if (assignment.expiresAt && new Date(assignment.expiresAt).getTime() <= now) return 'expired' as const;
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

  const isReviewer = hasActiveAuthority(assignments, decision.accountableRole, userId);

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

function RequirementCard({ req, assignments, userId }: {
  req: GovernanceRequirement;
  assignments: GovernanceAssignment[];
  userId?: string;
}) {
  const updateCoverage = usePutGovernanceRequirementsKeyCoverage();
  const [isEditing, setIsEditing] = useState(false);
  const [coverage, setCoverage] = useState(req.coverage);
  const [coverageRelated, setCoverageRelated] = useState(req.relatedImplementation || '');
  const [coverageEvidence, setCoverageEvidence] = useState(req.evidenceReference || '');
  
  const handleSave = () => {
    updateCoverage.mutate({
      key: req.key,
      expectedVersion: req.version,
      coverage,
      relatedImplementation: coverageRelated,
      evidenceReference: coverageEvidence
    }, {
      onSuccess: () => setIsEditing(false)
    });
  };

  const isComplete = coverage.implemented && coverage.tested && coverage.configured && coverage.approvedForLive;
  const canAttest = hasActiveAuthority(assignments, req.reviewOwnerRole, userId);
  const missingPrerequisites = [
    !coverage.implemented && 'implemented',
    !coverage.tested && 'tested',
    !coverage.configured && 'configured',
    !coverage.approvedForLive && 'approved for live',
  ].filter(Boolean);

  return (
    <div className="flex items-start justify-between p-3 border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-soft)] transition-colors">
      <div className="flex-1">
        <div className="flex items-center gap-2 mb-1">
          <h4 className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">{req.title}</h4>
          {isComplete ? (
             <Badge className="bg-[var(--status-green-bg)] text-[var(--status-green-fg)] shadow-none text-[10px] uppercase">Recorded coverage complete</Badge>
          ) : (
            <Badge className="bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)] shadow-none text-[10px] uppercase">Incomplete Prerequisites</Badge>
          )}
        </div>
        <div className="text-[var(--text-xs)] text-[var(--text-muted)] mb-2 flex items-center gap-2">
          <span><span className="font-medium">Ref:</span> {req.sourceReference}</span>
          <span>&bull;</span>
          <span><span className="font-medium">Owner:</span> {req.reviewOwnerRole}</span>
           <span>&bull;</span>
           <span><span className="font-medium">Source coverage:</span> {req.coverageState}</span>
        </div>

        {isEditing ? (
          <div className="bg-[var(--surface)] border border-[var(--border)] p-3 rounded-md mt-2 space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <label className="flex items-center gap-2 text-[var(--text-xs)] cursor-pointer">
                <input type="checkbox" checked={coverage.implemented} onChange={e => setCoverage({...coverage, implemented: e.target.checked})} className="rounded text-[var(--primary)] focus:ring-[var(--primary)]" />
                Implemented
              </label>
              <label className="flex items-center gap-2 text-[var(--text-xs)] cursor-pointer">
                <input type="checkbox" checked={coverage.tested} onChange={e => setCoverage({...coverage, tested: e.target.checked})} className="rounded text-[var(--primary)] focus:ring-[var(--primary)]" />
                Tested
              </label>
              <label className="flex items-center gap-2 text-[var(--text-xs)] cursor-pointer">
                <input type="checkbox" checked={coverage.configured} onChange={e => setCoverage({...coverage, configured: e.target.checked})} className="rounded text-[var(--primary)] focus:ring-[var(--primary)]" />
                Configured
              </label>
              <label className="flex items-center gap-2 text-[var(--text-xs)] cursor-pointer">
                <input type="checkbox" checked={coverage.approvedForLive} onChange={e => setCoverage({...coverage, approvedForLive: e.target.checked})} className="rounded text-[var(--primary)] focus:ring-[var(--primary)]" />
                Approved for Live
              </label>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3 pt-3 border-t border-[var(--border)]">
              <div>
                 <label className="block text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Related Implementation (PR/Jira)</label>
                 <input 
                   type="text" 
                   value={coverageRelated}
                   onChange={e => setCoverageRelated(e.target.value)}
                   className="w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background"
                   placeholder="e.g. PR-1234 or JIRA-987"
                 />
              </div>
              <div>
                 <label className="block text-[10px] font-bold text-[var(--text-muted)] uppercase mb-1">Evidence Reference (Doc/Link)</label>
                 <input 
                   type="text" 
                   value={coverageEvidence}
                   onChange={e => setCoverageEvidence(e.target.value)}
                   className="w-full text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background"
                   placeholder="e.g. Security Signoff Doc"
                 />
              </div>
            </div>
            <div className="flex gap-2 justify-end mt-2">
              <Button size="sm" variant="ghost" onClick={() => { setCoverage(req.coverage); setCoverageRelated(req.relatedImplementation || ''); setCoverageEvidence(req.evidenceReference || ''); setIsEditing(false); }}>Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={updateCoverage.isPending} className="bg-[var(--primary)] text-white">Save Evidence</Button>
            </div>
            {updateCoverage.isError && (
                <div className="text-[var(--status-red)] text-[10px] uppercase font-bold text-right mt-1">{errorMessage(updateCoverage.error, 'Could not update coverage.')}</div>
            )}
          </div>
        ) : (
          <div>
            <div className="flex flex-wrap gap-4 mt-2">
              <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold">
                <span className={cn("w-2 h-2 rounded-full", coverage.implemented ? "bg-[var(--status-green)]" : "bg-[var(--border)]")}></span>
                <span className={coverage.implemented ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>Implemented</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold">
                <span className={cn("w-2 h-2 rounded-full", coverage.tested ? "bg-[var(--status-green)]" : "bg-[var(--border)]")}></span>
                <span className={coverage.tested ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>Tested</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold">
                <span className={cn("w-2 h-2 rounded-full", coverage.configured ? "bg-[var(--status-green)]" : "bg-[var(--border)]")}></span>
                <span className={coverage.configured ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>Configured</span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase font-bold">
                <span className={cn("w-2 h-2 rounded-full", coverage.approvedForLive ? "bg-[var(--status-green)]" : "bg-[var(--border)]")}></span>
                <span className={coverage.approvedForLive ? "text-[var(--text-primary)]" : "text-[var(--text-muted)]"}>Live Apprv.</span>
              </div>
            </div>
            {(req.relatedImplementation || req.evidenceReference) && (
              <div className="flex gap-4 mt-2 text-[var(--text-xs)] text-[var(--text-muted)]">
                {req.relatedImplementation && <span><span className="font-semibold text-[var(--text-primary)]">Impl:</span> {req.relatedImplementation}</span>}
                {req.evidenceReference && <span><span className="font-semibold text-[var(--text-primary)]">Evidence:</span> {req.evidenceReference}</span>}
              </div>
            )}
             {!isComplete && <p className="mt-2 text-[var(--text-xs)] text-[var(--status-amber-fg)]">Incomplete launch prerequisites: {missingPrerequisites.join(', ')}.</p>}
             {isComplete && <p className="mt-2 text-[var(--text-xs)] text-[var(--text-muted)]">These recorded coverage facts do not establish provider activation or source-recorded evidence for a live action.</p>}
             {!canAttest && <p className="mt-2 text-[var(--text-xs)] text-[var(--text-muted)]">A currently active, verified {req.reviewOwnerRole} assignment is required to attest this coverage.</p>}
          </div>
        )}
      </div>
       {!isEditing && canAttest && (
        <Button variant="ghost" size="icon" onClick={() => setIsEditing(true)} className="text-[var(--text-muted)] shrink-0">
          <CheckSquare className="w-4 h-4" />
        </Button>
      )}
    </div>
  );
}

function AuthorityManager() {
  const { data: assignments, isLoading } = useGetGovernanceAssignments({ query: { refetchInterval: 60000, refetchIntervalInBackground: true } });
  const revoke = usePostGovernanceAssignmentsIdRevoke();
  const verify = usePostGovernanceAssignmentsIdVerify();
  const nominate = usePostGovernanceAssignments();
  const bootstrap = usePostGovernanceAuthorityBootstrap();
  const [bootstrapRef, setBootstrapRef] = useState('');
  const [bootstrapRole, setBootstrapRole] = useState('');
  const [bootstrapAssignee, setBootstrapAssignee] = useState('');

  if (isLoading) return <LoadingBlock>Loading authorities...</LoadingBlock>;

  return (
    <Card>
      <div className="p-[var(--space-md)] bg-[var(--surface-alt)] border-b border-[var(--border)]">
        <h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)] flex items-center gap-2">
          <Shield className="w-4 h-4 text-[var(--primary)]" /> Verified Authorities
        </h3>
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
          Server-verified roles allowed to approve or reject policy decisions. Self-declaration is not permitted.
        </p>
      </div>
      <CardContent className="p-0">
        <div className="divide-y divide-[var(--border)]">
          {assignments?.map(a => (
            <div key={a.id} className="p-[var(--space-md)] flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-semibold text-[var(--text-sm)] text-[var(--text-primary)]">{a.role}</span>
                   <Badge className={cn("shadow-none text-[10px] uppercase", assignmentState(a) === 'active' ? 'bg-[var(--status-green-bg)] text-[var(--status-green-fg)]' : assignmentState(a) === 'pending' || assignmentState(a) === 'expired' ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]' : 'bg-[var(--status-red-bg)] text-[var(--status-red-fg)]')}>
                     {assignmentState(a) === 'active' ? 'Verified active' : assignmentState(a) === 'pending' ? 'Nominated — pending verification' : assignmentState(a)}
                   </Badge>
                </div>
                <div className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
                   Assignee: <span className="font-mono">{a.assigneeUserId}</span> &bull; {a.verificationStatus === 'verified' ? <>Verified by: <span className="font-mono">{a.verifiedByUserId}</span></> : 'Owner/admin nomination only — not approval authority'}
                </div>
                 {a.expiresAt && <div className={cn("mt-1 text-[var(--text-xs)]", assignmentState(a) === 'expired' ? 'text-[var(--status-red-fg)]' : 'text-[var(--text-muted)]')}>Expires {format(new Date(a.expiresAt), 'MMM d, yyyy p')}{assignmentState(a) === 'expired' ? ' — no longer active' : ''}</div>}
                {a.verificationStatus === 'pending' && !a.revokedAt && (
                   <div className="mt-2 flex items-center gap-2">
                     <input
                       type="text"
                       placeholder="Verification Token"
                       className="text-[var(--text-sm)] rounded-[var(--radius-md)] h-[24px] px-[8px] border border-input outline-none focus:border-[var(--primary)] bg-background max-w-[200px]"
                       id={`verify-${a.id}`}
                     />
                     <Button size="sm" variant="outline" className="h-[24px] px-2 text-[10px]" onClick={() => {
                        const ref = (document.getElementById(`verify-${a.id}`) as HTMLInputElement)?.value;
                        if (ref) verify.mutate({ id: a.id, verificationReference: ref });
                     }}>
                        Submit for server verification
                     </Button>
                   </div>
                )}
                {a.revokedAt && (
                  <Badge className="bg-[var(--status-red-bg)] text-[var(--status-red-fg)] shadow-none text-[10px] mt-2">Revoked {format(new Date(a.revokedAt), 'MMM d')}</Badge>
                )}
              </div>
              {!a.revokedAt && (
                <Button variant="outline" size="sm" onClick={() => revoke.mutate(a.id)} className="text-[var(--status-red)] hover:text-[var(--status-red)] hover:bg-[var(--status-red-bg)]">
                  Revoke
                </Button>
              )}
            </div>
          ))}
          {!assignments?.length && (
            <div className="p-6 text-center text-[var(--text-muted)] text-[var(--text-sm)]">
               No authority nominations or verified assignments are recorded.
            </div>
          )}
        </div>
        
        <div className="p-[var(--space-md)] bg-[var(--surface-soft)] border-t border-[var(--border)]">
          <h4 className="text-[var(--text-sm)] font-semibold mb-2">Authority nomination and operator assignment</h4>
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] mb-3">An owner or admin can nominate a member, but nomination grants no review authority. Only the server-verified operator path can create or verify an active specialist assignment; ordinary tenant admins cannot self-declare it.</p>
          <div className="flex flex-col md:flex-row gap-2">
            <input 
              type="text" 
              placeholder="Role (e.g. CISO, Legal)" 
              className="flex-1 text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background max-w-[150px]"
              value={bootstrapRole}
              onChange={e => setBootstrapRole(e.target.value)}
            />
            <input 
              type="text" 
              placeholder="Assignee User ID" 
              className="flex-1 text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background max-w-[200px]"
              value={bootstrapAssignee}
              onChange={e => setBootstrapAssignee(e.target.value)}
            />
            <input 
              type="text" 
              placeholder="Verification Reference Token (or Reason for Nomination)" 
              className="flex-1 text-[var(--text-sm)] rounded-[var(--radius-md)] h-[32px] px-[10px] border border-input outline-none focus:border-[var(--primary)] bg-background"
              value={bootstrapRef}
              onChange={e => setBootstrapRef(e.target.value)}
            />
            <div className="flex gap-2 shrink-0">
              <Button size="sm" variant="outline" disabled={!bootstrapRef || !bootstrapRole || !bootstrapAssignee || nominate.isPending} onClick={() => {
                nominate.mutate({ role: bootstrapRole, assigneeUserId: bootstrapAssignee, assignmentReason: bootstrapRef } as any, { onSuccess: () => { setBootstrapRef(''); setBootstrapRole(''); setBootstrapAssignee(''); } });
              }}>
                Nominate
              </Button>
              <Button size="sm" disabled={!bootstrapRef || !bootstrapRole || !bootstrapAssignee || bootstrap.isPending} onClick={() => {
                bootstrap.mutate({ role: bootstrapRole, assigneeUserId: bootstrapAssignee, verificationReference: bootstrapRef }, { onSuccess: () => { setBootstrapRef(''); setBootstrapRole(''); setBootstrapAssignee(''); } });
              }}>
                Request operator assignment
              </Button>
            </div>
          </div>
          {(bootstrap.isError || nominate.isError || verify.isError) && (
             <div className="text-[var(--status-red)] text-[10px] uppercase font-bold mt-2">
                {errorMessage(bootstrap.error ?? nominate.error ?? verify.error, 'Action failed. Reload before retrying.')}
             </div>
          )}
        </div>
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
        <div><h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)]">Draft a policy decision</h3><p className="mt-1 text-[var(--text-xs)] text-[var(--text-muted)]">Drafting is available to organization owners and admins. Approval remains restricted to an active verified specialist.</p></div>
        <Button onClick={() => setOpen((value) => !value)} variant={open ? 'outline' : 'default'}>{open ? 'Cancel draft' : 'New decision'}</Button>
      </div>
      {open && <CardContent className="grid grid-cols-1 gap-3 border-t border-[var(--border)] p-[var(--space-md)] md:grid-cols-2">
        <label className="text-[var(--text-xs)] font-semibold">Decision key<input value={key} onChange={(event) => setKey(event.target.value)} placeholder="e.g. GD-CUSTOM-01" className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-mono font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Title<input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
        <label className="text-[var(--text-xs)] font-semibold">Accountable specialist role<input value={accountableRole} onChange={(event) => setAccountableRole(event.target.value)} placeholder="e.g. Legal" className="mt-1 h-9 w-full rounded border border-input bg-background px-2 font-normal" /></label>
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
  const [tab, setTab] = useState<'decisions' | 'requirements' | 'authorities' | 'history'>('decisions');
  const { user } = useUser();
  const { isHR } = useOrganizationRole();
  
  const { data: decisions, isLoading: isLoadingDecisions } = useGetGovernanceDecisions({ query: { refetchInterval: 30000, refetchIntervalInBackground: true } });
  const { data: requirements, isLoading: isLoadingReqs } = useGetGovernanceRequirements({ query: { refetchInterval: 30000, refetchIntervalInBackground: true } });
  const { data: assignments } = useGetGovernanceAssignments({ query: { refetchInterval: 60000, refetchIntervalInBackground: true } });

  return (
    <div className="max-w-5xl mx-auto space-y-6 pb-20">
      <PageHeader 
        title="Governance & Policy Review" 
        subtitle="Manage platform decisions, view requirement coverage, and track pending policy reviews." 
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
          onClick={() => setTab('requirements')}
          role="tab"
          aria-selected={tab === 'requirements'}
          className={cn("min-w-0 pb-2 text-left text-[var(--text-sm)] font-semibold transition-colors border-b-2", tab === 'requirements' ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
        >
          Requirements Register
        </button>
        <button 
          onClick={() => setTab('authorities')}
          role="tab"
          aria-selected={tab === 'authorities'}
          className={cn("min-w-0 pb-2 text-left text-[var(--text-sm)] font-semibold transition-colors border-b-2", tab === 'authorities' ? "border-[var(--primary)] text-[var(--primary)]" : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]")}
        >
          Authorities
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
             <NewDecisionForm canDraft={isHR} />
             <AffectedCases />
            {isLoadingDecisions ? <LoadingBlock>Loading decisions...</LoadingBlock> : (
               decisions?.map(d => <DecisionCard key={d.key} decision={d} assignments={assignments || []} canDraft={isHR} />)
            )}
            {!isLoadingDecisions && !decisions?.length && (
              <div className="text-center p-8 text-[var(--text-muted)] bg-[var(--surface-alt)] rounded-lg border border-[var(--border)]">
                No policy decisions registered.
              </div>
            )}
          </div>
        )}

        {tab === 'requirements' && (
          <Card>
            <div className="p-[var(--space-md)] bg-[var(--surface-alt)] border-b border-[var(--border)]">
              <h3 className="font-bold text-[var(--text-base)] text-[var(--text-primary)] flex items-center gap-2">
                <FileKey className="w-4 h-4 text-[var(--primary)]" /> Requirements Register
              </h3>
              <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">
                Track implementation and evidence for platform prerequisites. Independent coverage checks required.
              </p>
            </div>
            <div className="divide-y divide-[var(--border)] bg-[var(--surface)]">
              {isLoadingReqs ? <div className="p-4"><LoadingBlock>Loading requirements...</LoadingBlock></div> : (
                 requirements?.map(r => <RequirementCard key={r.key} req={r} assignments={assignments || []} userId={user?.id} />)
              )}
              {!isLoadingReqs && !requirements?.length && (
                <div className="p-8 text-center text-[var(--text-muted)]">No requirements registered.</div>
              )}
            </div>
          </Card>
        )}

        {tab === 'authorities' && (
          <AuthorityManager />
        )}
         {tab === 'history' && <GovernanceAuditHistory />}
      </div>
    </div>
  );
}