import React, { useState } from 'react';
import { lifecycleStageText } from '../../../lib/lifecycle-stage-presentation';
import { format, formatDistanceToNow } from 'date-fns';
import { CaseReadiness } from './CaseReadiness';
import { ConnectedReadinessSla } from './ConnectedReadinessSla';
import { CheckCircle2, Clock, AlertTriangle, ShieldCheck } from 'lucide-react';
import { Button, cn } from '@/components/ui-shared';
import { EngineBadge } from '@/components/engine-badge';
import { isOfflineDemoSample, StatusBadgeText } from './components';
import { useApprovalAction } from '../../../hooks/use-approval-action';
import {
  getApprovalVersionLabel,
  isApprovalAcknowledgement,
} from '../../../lib/approval-actions';
import { CasePrivacyControls } from './case-privacy-controls';
import { RestrictedActionNotice, useCaseAccess } from './case-access';

export function OverviewTab({ c, events, docs, comms, approvals, pendingApprovals, setTab, caseId }: any) {
  const access = useCaseAccess();
  return (
    <div className="flex flex-col xl:flex-row gap-8 pb-12">
      <div className="flex-1 min-w-0">
        <ConnectedReadinessSla caseId={caseId} />
        {access?.access.profileRead
          ? <CaseReadiness c={c} setTab={setTab} />
          : <RestrictedActionNotice>Case profile and readiness details are restricted by your current permissions.</RestrictedActionNotice>}
        <NextActions c={c} pendingApprovals={pendingApprovals} setTab={setTab} />
        {access?.access.notesRead
          ? <RecentActivitySummary events={events} />
          : <RestrictedActionNotice>Case notes and activity details are restricted by your current permissions.</RestrictedActionNotice>}
      </div>
      <div className="w-full xl:w-[360px] shrink-0">
        <div className="xl:sticky xl:top-[120px] space-y-6">
           {access?.access.notesRead
             ? <AttentionPanel approval={pendingApprovals[0]} caseId={caseId} offlineSample={isOfflineDemoSample(c)} />
             : <RestrictedActionNotice>Approval notes and decision details are restricted by your current permissions.</RestrictedActionNotice>}
           {access?.access.profileRead && <WorkforceContextCard c={c} />}
          {isOfflineDemoSample(c) ? <OfflinePrivacyRestricted /> : <CasePrivacyControls caseId={caseId} />}
           {access?.access.notesRead && <CaseOwnerCard events={events} approvals={approvals} />}
           {access?.access.notesRead && access && Object.values(access.sensitive).every((permission) => permission.read)
             ? <LatestCommunicationCard comms={comms} setTab={setTab} />
             : <RestrictedActionNotice>Communication details are restricted by your current permissions.</RestrictedActionNotice>}
          <DocumentsSummaryCard docs={docs} setTab={setTab} />
        </div>
      </div>
    </div>
  );
}

function OfflinePrivacyRestricted() {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-sm)]">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="w-4 h-4 text-[var(--text-muted)]" />
        <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Privacy & Retention</h3>
      </div>
      <p className="text-sm font-medium text-[var(--text-normal)]">Restricted for offline samples</p>
      <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
        This historical test record is read-only and permanently non-operational. Sensitive retention and existing holds still apply.
      </p>
    </div>
  );
}

function WorkforceContextCard({ c }: { c: any }) {
  const classification = c.workforceClassification;
  const context = c.workforceContext ?? {};
  const fact = (value: unknown) => value === true ? 'Yes' : value === false ? 'No' : 'Unknown';
  const label = classification?.label === 'blue-collar-frontline' ? 'Blue-collar / frontline'
    : classification?.label === 'white-collar' ? 'White-collar'
      : classification?.label === 'mixed' ? 'Mixed'
        : classification?.label === 'needs-review' ? 'Needs review' : 'Unclassified';
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-4 shadow-[var(--shadow-sm)]">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Workforce context</h3>
        <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide',
          classification?.label === 'blue-collar-frontline' ? 'bg-[var(--status-amber-bg)] text-[var(--status-amber-fg)]' :
          classification?.label === 'needs-review' || !classification ? 'bg-[var(--surface-soft)] text-[var(--text-secondary)]' : 'bg-[var(--primary-light)] text-[var(--primary)]')}>
          {label}
        </span>
      </div>
      {classification?.rationale ? <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-secondary)]">{classification.rationale}</p>
        : <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">No work context was captured for this existing case. Add an authorized job-context correction before relying on a targeted policy.</p>}
      <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
        <span className="text-[var(--text-muted)]">Environment <b className="text-[var(--text-primary)]">{context.workEnvironment ?? 'Unknown'}</b></span>
        <span className="text-[var(--text-muted)]">Site <b className="text-[var(--text-primary)]">{context.site ?? 'Unknown'}</b></span>
        <span className="text-[var(--text-muted)]">Site exposure <b className="text-[var(--text-primary)]">{fact(context.siteExposure)}</b></span>
        <span className="text-[var(--text-muted)]">Safety critical <b className="text-[var(--text-primary)]">{fact(context.safetyCritical)}</b></span>
        <span className="text-[var(--text-muted)]">Profile <b className="text-[var(--text-primary)]">{c.checklistProfileName ?? 'Organization default'}</b></span>
      </div>
      <p className="mt-3 text-[10px] text-[var(--text-muted)]">Classification is deterministic from explicit job facts; it never infers personal traits.</p>
    </div>
  );
}

export function AttentionPanel({ approval, caseId, offlineSample = false }: any) {
  const access = useCaseAccess();
  const action = useApprovalAction(approval, { caseId });
  const [expanded, setExpanded] = useState(false);

  if (!approval) {
    return (
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] shadow-[var(--shadow-sm)] p-4 flex flex-col items-center justify-center text-center">
        <div className="w-10 h-10 rounded-full bg-[var(--surface-alt)] flex items-center justify-center mb-3">
          <CheckCircle2 className={cn("w-5 h-5", offlineSample ? "text-[var(--text-muted)]" : "text-[var(--status-green)]")} />
        </div>
        <h3 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">{offlineSample ? 'No live decisions' : 'No decisions pending'}</h3>
        <p className="text-[var(--text-xs)] text-[var(--text-muted)] mt-1">{offlineSample ? 'Offline — no execution or approval authority.' : 'Automated execution is proceeding.'}</p>
      </div>
    );
  }

  const isAcknowledgement = isApprovalAcknowledgement(approval);
  const versionLabel = getApprovalVersionLabel(approval);
  const canUseCaseDecision = access?.access.flowEdit === true && access.access.notesEdit;

  return (
    <div className="bg-[var(--surface)] border-2 border-[var(--status-amber)] rounded-[var(--radius-lg)] shadow-[var(--shadow-md)] overflow-hidden">
      <div className="bg-[var(--status-amber-bg)] px-4 py-3 border-b border-[var(--status-amber)] flex items-start justify-between gap-2">
        <div>
          <h3 className="text-[var(--status-amber-fg)] font-bold text-[10px] uppercase tracking-wider mb-1">Approval Required</h3>
          <p className="text-[var(--status-amber-fg)] font-semibold text-[var(--text-sm)]">{lifecycleStageText(approval.recommendation)}</p>
        </div>
        <div className="text-[9px] font-mono font-bold text-[var(--status-amber-fg)] opacity-80 uppercase bg-[var(--status-amber-bg)] px-1.5 py-0.5 rounded border border-[var(--status-amber)]">
          AP-{approval.id}-{versionLabel}
        </div>
      </div>
      <div className="p-4 space-y-4">
        <div>
          <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1">Why this matters</p>
          <p className="text-[var(--text-sm)] text-[var(--text-secondary)] leading-relaxed">{lifecycleStageText(approval.rationale)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-1">Agent recommendation</p>
          <p className="text-[var(--text-sm)] font-medium text-[var(--text-primary)]">
            {isAcknowledgement
              ? 'Acknowledge this review.'
              : 'Approve this reviewed action.'}
          </p>
        </div>
        {isAcknowledgement && (
          <p className="text-[var(--text-xs)] text-[var(--text-muted)] bg-[var(--surface-alt)] border border-[var(--border)] rounded-[var(--radius-sm)] p-2">
            Acknowledgement records the review only; it does not complete assets or advance the case.
          </p>
        )}
        {action.isAuthorityLoading && (
          <p className="text-[var(--text-xs)] text-[var(--text-muted)]" role="status">
            Checking current decision permissions…
          </p>
        )}
        {!action.isAuthorityLoading && !action.isAuthorized && (
          <p className="text-[var(--text-xs)] text-[var(--status-red)]" role="alert">
            A current governance-approved specialist assignment is required. Organization membership and display personas do not grant decision authority.
          </p>
        )}
        {!canUseCaseDecision && (
          <p className="text-[var(--text-xs)] text-[var(--status-amber-fg)]" role="status">
            Case-flow and notes edit permissions are required to submit this decision.
          </p>
        )}
        {!action.hasValidVersion && (
          <p className="text-[var(--text-xs)] text-[var(--status-red)]" role="alert">
            This review has no valid version. Reload the review before taking action.
          </p>
        )}
        {action.actionError && (
          <p className="text-[var(--text-xs)] text-[var(--status-red)]" role="alert">
            {action.actionError}
          </p>
        )}
        {action.notice && (
          <p className="text-[var(--text-xs)] text-[var(--status-green-fg)]" role="status">
            {action.notice}
          </p>
        )}
        <div className="flex items-center gap-2 pt-2">
          <Button
            onClick={() => action.submit('approved')}
            disabled={!canUseCaseDecision || !action.canAct}
            className="flex-1 bg-[var(--status-green)] hover:bg-[#1bbd72] text-white border-transparent"
          >
            {action.actionLabel}
          </Button>
          {!isAcknowledgement && (
            <Button
              onClick={() => action.submit('rejected')}
              disabled={!canUseCaseDecision || !action.canAct}
              variant="outline"
              className="flex-1 text-[var(--status-red)] border-[var(--status-red)] hover:bg-[var(--status-red)] hover:text-white"
            >
              Reject
            </Button>
          )}
        </div>
        
        <button onClick={() => setExpanded(!expanded)} className="text-[var(--primary)] text-[var(--text-xs)] font-semibold flex items-center gap-1 mt-2 hover:underline">
          View decision context {expanded ? '▾' : '▸'}
        </button>
        {expanded && (
           <div className="text-[11px] text-[var(--text-muted)] bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] border border-[var(--border)] space-y-2">
             {approval.ruleRef && <div><strong>Policy Rule:</strong> <span className="font-mono">{lifecycleStageText(approval.ruleRef)}</span></div>}
             {approval.recordsEvidence?.map((e: any, i: number) => (
                <div key={i}>
                  <strong className="block text-[var(--text-secondary)]">{e.question}</strong>
                  <span>{e.answer}</span>
                </div>
             ))}
           </div>
        )}
      </div>
    </div>
  );
}

function CaseOwnerCard({ events, approvals }: any) {
  const actionsCount = events?.filter((e: any) => e.engine !== 'human').length || 0;
  const humanCount = approvals?.length || 0;
  // Events arrive ascending by createdAt — the latest is the last element.
  const lastEvent = events?.length ? events[events.length - 1] : undefined;

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm)]">
      <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-3">Case Owner</h3>
      <div className="flex items-center justify-between mb-4">
        <span className="font-bold text-[var(--text-base)] text-[var(--text-primary)]">Onboarding Agent</span>
        <span className="bg-[var(--status-green-bg)] text-[var(--status-green-fg)] text-[9px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wider">Operational</span>
      </div>
      <div className="space-y-2 text-[var(--text-sm)]">
        <div className="flex justify-between border-b border-[var(--border)] pb-2">
          <span className="text-[var(--text-muted)]">Actions completed</span>
          <span className="font-semibold text-[var(--text-primary)]">{actionsCount}</span>
        </div>
        <div className="flex justify-between border-b border-[var(--border)] pb-2">
          <span className="text-[var(--text-muted)]">Human interventions</span>
          <span className="font-semibold text-[var(--text-primary)]">{humanCount}</span>
        </div>
        <div className="flex justify-between pt-1">
          <span className="text-[var(--text-muted)]">Last action</span>
          <span className="font-semibold text-[var(--text-primary)]">{lastEvent ? formatDistanceToNow(new Date(lastEvent.createdAt), {addSuffix: true}) : '—'}</span>
        </div>
      </div>
    </div>
  );
}

function LatestCommunicationCard({ comms, setTab }: any) {
  // Communications arrive ascending by createdAt — the latest is the last element.
  const latest = comms?.length ? comms[comms.length - 1] : undefined;
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm)] flex flex-col">
      <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-3">Latest Communication</h3>
      {latest ? (
        <div className="space-y-2 flex-1">
          <p className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">{latest.subject || `Message to ${latest.toAddress}`}</p>
          <p className="text-[var(--text-xs)] text-[var(--text-secondary)] line-clamp-2 leading-relaxed bg-[var(--surface-alt)] p-2 rounded-[var(--radius-sm)] italic">"{latest.body}"</p>
          <div className="flex items-center gap-2 text-[10px] text-[var(--text-muted)] font-bold uppercase tracking-wider mt-2">
            <span>{format(new Date(latest.createdAt), 'h:mm a')}</span>
            <span>•</span>
            <span className={latest.status === 'delivered' ? 'text-[var(--status-green)]' : latest.status === 'failed' ? 'text-[var(--status-red)]' : ''}>{latest.status}</span>
          </div>
        </div>
      ) : (
        <p className="text-[var(--text-sm)] text-[var(--text-muted)] flex-1">No communications yet.</p>
      )}
      <button onClick={() => setTab('Communications')} className="text-[var(--primary)] text-[var(--text-xs)] font-bold mt-4 text-left hover:underline">
        Conversation →
      </button>
    </div>
  );
}

function DocumentsSummaryCard({ docs, setTab }: any) {
  const required = docs?.filter((d: any) => d.required).length || 0;
  const verified = docs?.filter((d: any) => d.status === 'verified').length || 0;
  const received = docs?.filter((d: any) => d.status === 'received').length || 0;
  const pending = docs?.filter((d: any) => d.status === 'pending').length || 0;

  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-lg)] p-5 shadow-[var(--shadow-sm)] flex flex-col">
      <h3 className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-4">Documents</h3>
      <div className="grid grid-cols-2 gap-y-4 gap-x-4 flex-1">
        <div className="bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] border border-[var(--border)]">
          <p className="text-[var(--text-xl)] font-bold text-[var(--text-primary)] leading-none mb-1">{required}</p>
          <p className="text-[9px] text-[var(--text-muted)] font-bold uppercase tracking-wider">Required</p>
        </div>
        <div className="bg-[var(--status-green-bg)] p-3 rounded-[var(--radius-md)] border border-[var(--status-green)]">
          <p className="text-[var(--text-xl)] font-bold text-[var(--status-green-fg)] leading-none mb-1">{verified}</p>
          <p className="text-[9px] text-[var(--status-green-fg)] font-bold uppercase tracking-wider">Verified</p>
        </div>
        <div className="bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] border border-[var(--border)]">
          <p className="text-[var(--text-xl)] font-bold text-[var(--status-blue)] leading-none mb-1">{received}</p>
          <p className="text-[9px] text-[var(--text-muted)] font-bold uppercase tracking-wider">Received</p>
        </div>
        <div className="bg-[var(--status-amber-bg)] p-3 rounded-[var(--radius-md)] border border-[var(--status-amber)]">
          <p className="text-[var(--text-xl)] font-bold text-[var(--status-amber-fg)] leading-none mb-1">{pending}</p>
          <p className="text-[9px] text-[var(--status-amber-fg)] font-bold uppercase tracking-wider">Pending</p>
        </div>
      </div>
      <button onClick={() => setTab('Documents')} className="text-[var(--primary)] text-[var(--text-xs)] font-bold mt-4 text-left hover:underline">
        View documents →
      </button>
    </div>
  );
}


function NextActions({ c, pendingApprovals, setTab }: any) {
  const actions = [];
  
  if (pendingApprovals?.length > 0) {
    actions.push({
      title: pendingApprovals[0].recommendation,
      desc: 'Required before accelerated handling begins',
      owner: 'HR Reviewer',
      priority: true
    });
  }

  const waitingWorkstreams = (c.workstreams || []).filter((w: any) => w.status !== 'ready' && w.status !== 'exception');
  waitingWorkstreams.forEach((w: any) => {
    actions.push({
      title: w.label,
      desc: w.status === 'blocked' ? 'Blocked by external dependency' : 'Begins automatically after dependencies met',
      owner: w.owner || w.agent || 'Onboarding Agent',
      priority: w.status === 'blocked'
    });
  });

  return (
    <div className="mb-10">
      <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-4">Next Actions</h2>
      <div className="space-y-3">
        {actions.length === 0 && <p className="text-[var(--text-sm)] text-[var(--text-muted)] bg-[var(--surface-alt)] p-4 rounded-[var(--radius-lg)] border border-[var(--border)]">No immediate actions required.</p>}
        {actions.map((a, i) => (
          <div key={i} className="flex gap-4 p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
            <div className="flex-shrink-0 mt-0.5 text-[var(--text-muted)] font-mono text-[var(--text-base)] font-bold">{i + 1}</div>
            <div className="flex-1">
              <h4 className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">{a.title}</h4>
              <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-0.5">{a.desc}</p>
              <div className="text-[10px] font-bold uppercase tracking-wider text-[var(--text-secondary)] mt-3 bg-[var(--surface-alt)] inline-block px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--border)]">
                Owner: {a.owner}
              </div>
            </div>
          </div>
        ))}
      </div>
      <button onClick={() => setTab('Tasks')} className="text-[var(--primary)] text-[var(--text-xs)] font-bold mt-4 text-left hover:underline">
        Execution plan →
      </button>
    </div>
  );
}

function RecentActivitySummary({ events }: any) {
  // Events arrive ascending — take the last 4 and show newest first.
  const recent = (events ? [...events].slice(-4).reverse() : []);

  return (
    <div className="mb-8">
      <h2 className="text-[var(--text-lg)] font-bold text-[var(--text-primary)] mb-4">Recent Activity</h2>
      <div className="space-y-5 border-l-2 border-[var(--border)] ml-3 pl-5 py-1">
        {recent.map((e: any) => (
          <div key={e.id} className="relative">
            <div className="absolute -left-[27px] top-1 w-3 h-3 rounded-full bg-[var(--surface-alt)] border-2 border-[var(--border-strong)]"></div>
            <div className="flex items-start gap-3">
              <div className="mt-0.5 shrink-0">
                <EngineBadge engine={e.engine} />
              </div>
              <div>
                <p className="text-[var(--text-sm)] font-bold text-[var(--text-primary)]">{lifecycleStageText(e.title)}</p>
                <p className="text-[var(--text-xs)] text-[var(--text-secondary)] mt-0.5 leading-relaxed">{lifecycleStageText(e.detail)}</p>
                <p className="text-[10px] font-mono text-[var(--text-muted)] mt-1.5">{formatDistanceToNow(new Date(e.createdAt), {addSuffix: true})}</p>
              </div>
            </div>
          </div>
        ))}
        {recent.length === 0 && <p className="text-[var(--text-sm)] text-[var(--text-muted)]">No recent activity.</p>}
      </div>
    </div>
  );
}
