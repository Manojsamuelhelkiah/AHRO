import React from 'react';
import { CaseReadiness } from './CaseReadiness';
import { AttentionPanel, NextActions } from './overview';
import { RestrictedActionNotice, useCaseAccess } from './case-access';
import { isOfflineDemoSample } from './components';
import { caseTypeOf } from '../case-presentation';

/** First block of the case page: what is required now, with the existing authoritative controls. */
export function CaseActionBlock({ c, caseId, pendingApprovals, setTab, offlineSample }: any) {
  const access = useCaseAccess();
  const showReadiness = !c.syntheticJourney && caseTypeOf(c) === 'Onboarding' && !isOfflineDemoSample(c) && !c.controllerRetired;
  const first = pendingApprovals?.[0];
  const status = String(c.orchestrationStatus || '');
  const DONE = ['ready', 'done', 'completed', 'complete', 'verified'];
  const outstanding = (c.readiness || []).filter((w: any) => w.key !== 'restricted' && !DONE.includes(String(w.status).toLowerCase()));
  const items = outstanding.filter((w: any) => w.mandatory);
  const blockedItems = outstanding.filter((w: any) => w.status === 'blocked' || w.status === 'exception');
  const workstreamBlockers = (c.workstreams || []).some((w: any) => w.key !== 'restricted' && w.blockers?.length > 0);
  const blocked = status === 'blocked' || status === 'checklist-blocked' || blockedItems.length > 0 || workstreamBlockers;
  const headline = offlineSample ? 'Read-only record: no action can be taken here'
    : !access?.access.notesRead ? 'Review the case information available to you'
    : first ? 'Review the pending decision'
    : blocked ? 'Resolve the blockers shown here'
    : items.length > 0 ? `Complete ${items.length} required checklist item${items.length === 1 ? '' : 's'} shown here`
    : outstanding.length > 0 ? `Review ${outstanding.length} pending checklist item${outstanding.length === 1 ? '' : 's'} shown here`
    : ['done', 'completed', 'complete'].includes(status) ? 'No action required: case complete'
    : 'No decision or checklist item needs you now';
  return (
    <section aria-label="Action required" data-testid="block-action-required"
      className="mb-5 rounded-[var(--radius-lg)] border-2 border-[var(--primary)] bg-[var(--surface)] p-4 shadow-[var(--shadow-md)] md:p-5">
      <p className="text-[10px] font-bold uppercase tracking-wider text-[var(--primary)]">Action required</p>
      <h2 className="mb-4 text-[var(--text-lg)] font-bold text-[var(--text-primary)]">{headline}</h2>
      {(first || !access?.access.notesRead || c.syntheticJourney || workstreamBlockers) && <div className="grid gap-5 lg:grid-cols-2">
        <div className="min-w-0">
          {access?.access.notesRead
            ? first && <AttentionPanel approval={first} caseId={caseId} offlineSample={offlineSample} />
            : <RestrictedActionNotice>Approval notes and decision details are restricted by your current permissions.</RestrictedActionNotice>}
        </div>
        <div className="min-w-0">
          {(c.syntheticJourney || workstreamBlockers) && <NextActions c={c} pendingApprovals={pendingApprovals} setTab={setTab} showPlanLink={false} />}
        </div>
      </div>}
      {showReadiness && (access?.access.profileRead
        ? <div className="mt-2"><CaseReadiness c={c} setTab={setTab} /></div>
        : <RestrictedActionNotice>Onboarding requirements are restricted by your current permissions.</RestrictedActionNotice>)}
    </section>
  );
}
