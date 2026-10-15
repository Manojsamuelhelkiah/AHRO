import React, { useState } from 'react';
import { SyntheticJourneyHealth } from './synthetic-journey';
import { confirmedCaseDate } from '../case-presentation';
import { format } from 'date-fns';
import { ChevronDown, Mail, Phone, PhoneCall } from 'lucide-react';
import { Badge, Button, cn } from '@/components/ui-shared';
import { useStartOnboardingVoiceCall, getListOnboardingCaseCommunicationsQueryKey, getListOnboardingCaseEventsQueryKey } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { ContactDialog } from './ContactDialog';
import { casePresentationOf, caseTitleOf, caseTypeOf, originalIntentOf, isDemoCoverageCase, isFictionalOfflineExample, sampleCaseReference, caseWorkerName } from '../case-presentation';
import { useCaseAccess } from './case-access';
import { caseOwnerOf } from '../case-presentation';

export function isOfflineDemoSample(c: { scenarioKey?: string | null; offlineSample?: boolean; controllerRetired?: boolean }) {
  return c.controllerRetired === true || c.offlineSample === true;
}

function casePresentation(c: any) {
  return casePresentationOf(c) ?? {
    type: 'Onboarding',
    title: c.hireType?.replace(/-/g, ' ') || 'Onboarding case',
    owner: 'Onboarding Agent',
  };
}

export function StatusBadgeText({ status }: { status: string }) {
  const s = status.toLowerCase();
  let colorClass = 'text-[var(--text-muted)]';
  if (['completed', 'healthy', 'ready', 'verified', 'approved', 'delivered', 'done', 'complete'].includes(s)) colorClass = 'text-[var(--status-green)]';
  else if (['running', 'active', 'in-progress', 'received'].includes(s)) colorClass = 'text-[var(--status-blue)]';
  else if (['waiting-approval', 'human-review', 'human review', 'pending', 'attention'].includes(s)) colorClass = 'text-[var(--status-amber)]';
  else if (['blocked', 'checklist-blocked', 'critical', 'exception', 'failed', 'rejected'].includes(s)) colorClass = 'text-[var(--status-red)]';

  return (
    <span className={cn("font-bold uppercase tracking-wider text-[10px]", colorClass)}>
      {status.replace(/-/g, ' ')}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  const s = status.toLowerCase();
  let bg = 'var(--text-muted)';
  if (['completed', 'healthy', 'ready', 'verified', 'approved', 'delivered', 'done', 'complete'].includes(s)) bg = 'var(--status-green)';
  else if (['running', 'active', 'in-progress', 'received'].includes(s)) bg = 'var(--status-blue)';
  else if (['waiting-approval', 'human-review', 'human review', 'pending', 'attention'].includes(s)) bg = 'var(--status-amber)';
  else if (['blocked', 'checklist-blocked', 'critical', 'exception', 'failed', 'rejected'].includes(s)) bg = 'var(--status-red)';

  return <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: bg }} />;
}

export function OriginalIntent({ c }: { c: { originalIntent?: string | null } }) {
  return <p data-testid="text-original-intent" className="my-2 break-words text-sm text-[var(--text-secondary)]">
    <span className="font-semibold">Original intent:</span> {originalIntentOf(c)}
  </p>;
}

export function CaseHeader({ c, caseId, setTab }: { c: any, caseId: number, setTab?: (t: string) => void }) {
  const access = useCaseAccess();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionOpen, setActionOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const startCall = useStartOnboardingVoiceCall();
  const queryClient = useQueryClient();

  const handleCall = (scenario: 'day-before' | 'sla-escalation') => {
    if (access?.access.flowEdit !== true || access?.access.notesEdit !== true
      || access?.sensitive.identity.read !== true || access?.sensitive.identity.edit !== true) return;
    startCall.mutate({ id: caseId, data: { scenario, simulate: false } }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseCommunicationsQueryKey(caseId) });
        queryClient.invalidateQueries({ queryKey: getListOnboardingCaseEventsQueryKey(caseId) });
        setActionOpen(false);
      }
    });
  };

  const statusText = c.syntheticJourney ? c.syntheticJourney.qualifier
    : c.orchestrationStatus === 'waiting-approval' ? 'HUMAN REVIEW' : c.orchestrationStatus.replace(/-/g, ' ');
  const offlineSample = isOfflineDemoSample(c);
  const ownership = caseOwnerOf(c);
   const presentation = { ...casePresentation(c), type: caseTypeOf(c), title: caseTitleOf(c) };
  const canViewIdentity = access?.access.profileRead === true &&
    (access?.sensitive.identity.read === true || c.fictionalOfflineIdentity === true);
  const contactPermissions = canViewIdentity
    && access?.sensitive.identity.edit === true
    && access?.access.flowEdit === true
    && access?.access.notesEdit === true;
  const canUseContactActions = contactPermissions && !offlineSample;
  const canAskAboutCase = access?.access.profileRead === true
    && access?.access.notesRead === true
    && !!access
    && Object.values(access.sensitive).every((permission) => permission.read);

  return (
    <div data-case-header className="lg:sticky top-0 z-30 bg-[var(--surface)] pb-4 pt-4 px-6 md:px-8 -mx-6 md:-mx-8 border-b border-[var(--border)] shadow-[var(--shadow-sm)] mb-6">
      <div className="max-w-7xl mx-auto flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
        <div className="min-w-0">
           <div className="mb-1">
             <span className="shrink-0 text-[var(--text-xs)] font-bold text-[var(--primary)] bg-[var(--primary-light-bg)] px-2 py-0.5 rounded-full">{sampleCaseReference(c) ?? `Case #${c.id}`}</span>
              <OriginalIntent c={c} />
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="break-words text-[var(--text-2xl)] font-bold text-[var(--text-primary)] leading-tight m-0">{access?.access.profileRead ? presentation.title : 'Case details restricted'}</h1>
               <Badge variant="outline" className="uppercase text-[10px] tracking-wider">{access?.access.profileRead ? presentation.type : 'Case details'}</Badge>
              </div>
           </div>
              <p className="text-[var(--text-sm)] text-[var(--text-muted)] font-medium">{canViewIdentity ? `${isFictionalOfflineExample(c) ? caseWorkerName(c) : `For ${c.workerName}`} • ` : <><span>Restricted candidate</span> • </>}{access?.access.profileRead ? `${c.role} • ${c.geography}` : 'Profile details restricted'}{canViewIdentity && confirmedCaseDate(c) ? ` • Effective ${format(new Date(confirmedCaseDate(c)!), 'MMM d, yyyy')}` : ''}</p>
            {offlineSample && !isFictionalOfflineExample(c) && (
              <p className="mt-2 text-[var(--text-xs)] font-semibold text-[var(--status-amber-fg)]">
                Read-only record — provider work and business completion are not authorized.
              </p>
            )}
           
           <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] uppercase tracking-wider font-semibold text-[var(--text-muted)]">
              <span className="break-words">Current owner: <span className="text-[var(--text-primary)]">{ownership.name}</span></span>
              {ownership.kind === 'Human Reviewer' && <span className="break-words">Coordinating agent: {ownership.coordinatingAgent}</span>}
             <span className="flex items-center gap-1">Priority: <span className={c.urgency === 'elevated' ? 'text-[var(--status-red)]' : 'text-[var(--text-primary)]'}>{c.urgency}</span></span>
             <span className="flex items-center gap-1">Stage: <span className="text-[var(--text-primary)]">{c.syntheticJourney
               ? c.syntheticJourney.stages[c.syntheticJourney.stages.length - 1]?.title
               : c.lifecycleStage.replace(/-/g, ' ')}</span></span>
             <span className="flex items-center gap-1">Status: <span className="text-[var(--text-primary)]">{statusText}</span></span>
              {canViewIdentity && <span className="flex items-center gap-1">Manager: <span className="text-[var(--text-primary)]">{c.managerName}</span></span>}
           </div>

            {canViewIdentity && <button onClick={() => setDetailsOpen(!detailsOpen)} className="mt-2 text-[var(--primary)] text-[var(--text-xs)] font-semibold flex items-center gap-1 hover:underline">
              Worker Details {detailsOpen ? '▾' : '▸'}
            </button>}
            {!canViewIdentity && <p className="mt-2 text-xs text-[var(--status-amber-fg)]">Worker identity details are restricted by your current permissions.</p>}
           {detailsOpen && (
             <div className="mt-2 bg-[var(--surface-alt)] p-3 rounded-[var(--radius-md)] text-[var(--text-sm)] grid grid-cols-1 sm:grid-cols-2 gap-4 text-[var(--text-secondary)] border border-[var(--border)]">
               <div><strong>Email:</strong> {c.workerEmail}</div>
               <div><strong>Phone:</strong> {c.workerPhone || '—'}</div>
               <div><strong>Channel:</strong> {c.channelPreference}</div>
               <div><strong>Recruiter:</strong> {c.recruiterName}</div>
             </div>
           )}
        </div>
         <div className="flex shrink-0 items-center gap-2 self-start lg:self-auto relative">
           {contactPermissions && offlineSample && <p className="max-w-xs text-xs text-[var(--text-muted)]">Contact requires an active operational case; no delivery is authorized here.</p>}
           {setTab && canAskAboutCase && (
            <Button variant="outline" className="gap-2 text-[var(--primary)] border-[var(--primary)] hover:bg-[var(--primary-light-bg)]" onClick={() => setTab('Ask AI')}>
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-sparkles"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>
              Ask about this case
            </Button>
          )}
          {canUseContactActions && (
            <>
              <Button variant="secondary" className="gap-2" onClick={() => setContactOpen(true)}><Mail className="w-4 h-4"/> Contact</Button>
              <ContactDialog caseId={caseId} open={contactOpen} onOpenChange={setContactOpen} />
            </>
          )}
          {canUseContactActions && <div className="relative">
            <Button onClick={() => setActionOpen(!actionOpen)} className="gap-2 bg-[var(--primary)] text-white hover:bg-[var(--primary-dark)] border-transparent">
              Take Action <ChevronDown className="w-4 h-4" />
            </Button>
            {actionOpen && (
              <div className="absolute right-0 top-full mt-1 w-48 bg-[var(--surface)] border border-[var(--border)] rounded-[var(--radius-md)] shadow-lg py-1 z-50">
                <button onClick={() => handleCall('day-before')} disabled={!c.workerPhone || startCall.isPending} className="w-full text-left px-3 py-2 text-[var(--text-sm)] hover:bg-[var(--surface-alt)] disabled:opacity-50 flex items-center gap-2">
                  <PhoneCall className="w-3.5 h-3.5" /> Voice: Day-before check
                </button>
                <button onClick={() => handleCall('sla-escalation')} disabled={!c.workerPhone || startCall.isPending} className="w-full text-left px-3 py-2 text-[var(--text-sm)] hover:bg-[var(--surface-alt)] disabled:opacity-50 flex items-center gap-2">
                  <Phone className="w-3.5 h-3.5 text-[var(--status-amber)]" /> Voice: SLA Escalation
                </button>
              </div>
            )}
          </div>}
        </div>
      </div>
    </div>
  );
}

export function CaseHealthStrip({ c, pendingApprovals, offlineSample = false }: { c: any, pendingApprovals: any[], offlineSample?: boolean }) {
  if (c.syntheticJourney) return <SyntheticJourneyHealth journey={c.syntheticJourney} />;
  const total = c.workstreams?.length || 0;
  const ready = c.workstreams?.filter((w: any) => w.status === 'ready').length || 0;
  const progressPct = total > 0 ? Math.round((ready / total) * 100) : 0;
  
  // Health maps the full orchestrationStatus domain truthfully — never claim
  // active execution for idle/done cases.
  const orch = c.orchestrationStatus as string;
  const state = offlineSample ? 'offline' : pendingApprovals.length > 0 ? 'attention' : (orch === 'blocked' || orch === 'checklist-blocked') ? 'blocked' : orch === 'done' ? 'done' : orch === 'idle' ? 'idle' : 'healthy';
  const healthTitle = state === 'offline' ? 'Awaiting prerequisites' : state === 'attention' ? 'Attention required' : state === 'blocked' ? 'Blocked' : state === 'done' ? 'Complete' : state === 'idle' ? 'Idle' : 'Healthy';
  const healthSub = state === 'offline' ? 'Activation, verified evidence and current human decisions are required.'
    : state === 'attention' ? `${pendingApprovals.length} decision${pendingApprovals.length > 1 ? 's' : ''} require${pendingApprovals.length === 1 ? 's' : ''} review`
    : state === 'blocked' ? (c.workstreams?.find((w: any) => w.status === 'blocked' && w.blockers?.length)?.blockers.join(' ')
      || (orch === 'checklist-blocked' ? 'Waiting for mandatory checklist items' : 'Waiting for recorded prerequisites and human review'))
    : state === 'done' ? 'Case processing complete'
    : state === 'idle' ? 'No execution in progress'
    : 'Automated execution active';
  const healthColor = state === 'offline' ? 'var(--status-amber)' : state === 'attention' ? 'var(--status-amber)' : state === 'blocked' ? 'var(--status-red)' : state === 'idle' ? 'var(--border-strong)' : 'var(--status-green)';
  const healthFg = state === 'offline' ? 'var(--status-amber-fg)' : state === 'attention' ? 'var(--status-amber-fg)' : state === 'blocked' ? 'var(--status-red-fg)' : state === 'idle' ? 'var(--text-secondary)' : 'var(--status-green-fg)';

  // Day-1 milestone only applies to onboarding-lifecycle cases with a future-relevant joining date.
  const onboardingStages = ['trigger-received', 'profile-validated', 'plan-generated', 'preboarding', 'day1-review', 'early-enablement'];
  const isOnboarding = !offlineSample && onboardingStages.includes(c.lifecycleStage) && !!c.joiningDate;
  
  return (
    <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
      <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
        <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">Case Health</p>
        <div className="flex items-center gap-2 mb-1">
          <span className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: healthColor}} />
          <p className="text-[var(--text-base)] font-semibold" style={{color: healthFg}}>{healthTitle}</p>
        </div>
        <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">{healthSub}</p>
      </div>

      <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
        <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">Progress</p>
        <p className="text-[var(--text-base)] font-semibold text-[var(--text-primary)] mb-1">{ready} / {total} complete</p>
        <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">{progressPct}% of workflow complete</p>
      </div>

      <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
        <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">SLA</p>
        <p className="text-[var(--text-base)] font-semibold text-[var(--text-primary)] mb-1">—</p>
        <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">No SLA target</p>
      </div>

      <div className="p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-sm)]">
        <p className="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mb-2">Next Milestone</p>
        <p className="text-[var(--text-base)] font-semibold text-[var(--text-primary)] mb-1">{isOnboarding ? 'Day-1 Readiness' : '—'}</p>
        <p className="text-[var(--text-xs)] text-[var(--text-secondary)]">{isOnboarding ? `Due ${format(new Date(c.joiningDate), 'MMM d')}` : '—'}</p>
      </div>
    </div>
  );
}

export function CaseTabs({ activeTab, setTab, offlineSample = false }: { activeTab: string, setTab: (t: string) => void, offlineSample?: boolean }) {
  const access = useCaseAccess();
  const tabs = ['Overview', ...(offlineSample ? [] : ['Early tenure']), 'Progress', 'Frontline', 'Documents',
    ...(access?.access.notesRead ? ['Communications', 'Audit'] : []),
    ...(access?.access.flowRead ? ['Transaction context'] : []),
    'Ask AI'];
  return (
    <div role="group" aria-label="Case sections" className="flex flex-wrap border-b border-[var(--border)] mb-6">
      {tabs.map(t => (
        <button
          key={t}
          onClick={() => setTab(t)}
          aria-current={activeTab === t ? 'page' : undefined}
          className={cn(
            "px-4 py-3 text-[var(--text-sm)] font-semibold whitespace-nowrap border-b-2 transition-colors",
            activeTab === t 
              ? "border-[var(--primary)] text-[var(--primary)]" 
              : "border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:border-[var(--border-strong)]",
            t === 'Ask AI' && activeTab !== t ? "text-[var(--primary)] font-bold" : ""
          )}
        >
          {t}
        </button>
      ))}
    </div>
  );
}
