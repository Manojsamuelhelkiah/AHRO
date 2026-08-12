import React, { useState } from 'react';
import { useListOnboardingApprovals, useDecideOnboardingApproval, getListOnboardingApprovalsQueryKey } from '@workspace/api-client-react';
import { Card, Button, Badge, cn, Input, Label } from '@/components/ui-shared';
import { useQueryClient } from '@tanstack/react-query';
import { EngineBadge, HitlBadge } from '@/components/engine-badge';
import { format } from 'date-fns';
import { Check, X, ShieldAlert } from 'lucide-react';
import { Link } from 'wouter';

export function ApprovalsPage() {
  const [showAll, setShowAll] = useState(false);
  const statusParam = showAll ? 'all' : 'pending';
  const { data: approvals, isLoading } = useListOnboardingApprovals({ status: statusParam }, {
    query: { queryKey: getListOnboardingApprovalsQueryKey({ status: statusParam }) }
  });

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Review Queue</h1>
          <p className="text-muted-foreground mt-1">Human-in-the-loop decisions for agentic actions.</p>
        </div>
        <div className="flex items-center gap-2 bg-secondary/50 px-3 py-1.5 rounded-md border">
          <Label htmlFor="show-all" className="text-sm cursor-pointer">Show Resolved History</Label>
          <input 
            type="checkbox" 
            id="show-all" 
            checked={showAll} 
            onChange={(e) => setShowAll(e.target.checked)} 
            className="rounded border-input h-4 w-4 text-primary focus:ring-primary cursor-pointer" 
          />
        </div>
      </div>

      <div className="space-y-4">
        {isLoading ? (
          <div className="text-center py-12 text-muted-foreground">Loading queue...</div>
        ) : approvals?.length === 0 ? (
          <Card className="p-16 text-center text-muted-foreground border-dashed">
            <ShieldAlert className="w-12 h-12 mx-auto text-muted mb-4 opacity-50" />
            <h3 className="text-lg font-semibold text-foreground mb-1">Queue is Clear</h3>
            <p>No agent actions require human review at this time.</p>
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

function ApprovalCard({ approval, statusParam }: { approval: any, statusParam: string }) {
  const decide = useDecideOnboardingApproval();
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [reviewer, setReviewer] = useState('Current User');

  const handleDecide = (decision: string) => {
    decide.mutate({
      id: approval.id,
      data: { decision, decidedBy: reviewer, comment: comment || undefined }
    }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingApprovalsQueryKey({ status: statusParam }) });
      }
    });
  };

  const isPending = approval.status === 'pending';
  const isHardBlock = approval.hitlPattern === 'hard-block';

  return (
    <Card className={cn("overflow-hidden transition-all shadow-sm", !isPending && "opacity-75 bg-muted/20")}>
      <div className="p-6">
        <div className="flex flex-col md:flex-row justify-between items-start gap-4">
          <div className="flex-1 w-full">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-sm font-bold text-primary px-2 py-0.5 bg-primary/10 rounded-md">Case #{approval.caseId}</span>
              <span className="text-muted-foreground text-sm">•</span>
              <EngineBadge engine={approval.agent} />
              <HitlBadge pattern={approval.hitlPattern} />
              {approval.ruleRef && <span className="text-[10px] bg-secondary border text-secondary-foreground px-1.5 py-0.5 rounded font-mono">{approval.ruleRef}</span>}
              <span className="text-xs text-muted-foreground md:ml-auto bg-secondary px-2 py-0.5 rounded-full font-mono">{format(new Date(approval.createdAt), 'MMM d, HH:mm')}</span>
            </div>
            <h3 className="text-xl font-bold mb-2 leading-tight">{approval.recommendation}</h3>
            <div className="bg-slate-50 dark:bg-slate-900 border p-4 rounded-md text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed">
              {approval.rationale}
            </div>
          </div>
          {!isPending && (
            <div className="shrink-0 md:text-right w-full md:w-auto mt-4 md:mt-0 flex md:flex-col justify-between items-center md:items-end p-4 md:p-0 bg-background md:bg-transparent rounded-md border md:border-0">
              <Badge variant={approval.status === 'approved' ? 'default' : 'destructive'} className={cn("mb-2 px-3 py-1", approval.status === 'approved' ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-100 border-emerald-200" : "")}>
                {approval.status.toUpperCase()}
              </Badge>
              <div className="text-xs text-muted-foreground text-right">
                <p>Reviewed by <strong>{approval.decidedBy ?? ""}</strong></p>
                {approval.comment && <p className="mt-1 italic border-t pt-1 mt-2">"{approval.comment}"</p>}
              </div>
            </div>
          )}
        </div>

        {isPending && (
          <div className="mt-6 pt-6 border-t flex flex-col lg:flex-row items-start lg:items-end gap-6 bg-secondary/10 -mx-6 -mb-6 p-6">
            <div className="flex-1 w-full space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-xl">
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Reviewer Name</Label>
                  <Input value={reviewer} onChange={(e) => setReviewer(e.target.value)} className="bg-background shadow-sm" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs font-bold text-muted-foreground uppercase tracking-wider">Decision Comment (Optional)</Label>
                  <Input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Rationale for override..." className="bg-background shadow-sm" />
                </div>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3 shrink-0 w-full lg:w-auto">
              {!isHardBlock && (
                <Button variant="outline" size="lg" className="flex-1 lg:flex-none text-red-600 border-red-200 hover:bg-red-50 hover:text-red-700 bg-background" onClick={() => handleDecide('rejected')} disabled={decide.isPending}>
                  <X className="w-5 h-5 mr-2" /> Reject Action
                </Button>
              )}
              <Button size="lg" className="flex-1 lg:flex-none bg-emerald-600 hover:bg-emerald-700 text-white shadow-md shadow-emerald-600/20" onClick={() => handleDecide('approved')} disabled={decide.isPending}>
                <Check className="w-5 h-5 mr-2" /> {isHardBlock ? 'Acknowledge & Clear' : 'Approve Action'}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="bg-card px-6 py-3 border-t text-sm flex justify-between items-center shadow-sm relative z-10">
        <Link href={`/cases/${approval.caseId}`} className="text-primary hover:underline font-semibold flex items-center gap-1">
          Open Full Case Context →
        </Link>
        <span className="text-xs text-muted-foreground font-mono bg-secondary px-2 py-0.5 rounded">ID: APP-{approval.id}</span>
      </div>
    </Card>
  );
}