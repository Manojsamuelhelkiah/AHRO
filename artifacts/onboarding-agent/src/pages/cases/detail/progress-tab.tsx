import React, { useEffect, useRef } from 'react';
import { TasksTab } from './tabs-content';
import { NextActions } from './overview';
import { ProgressHistory, type HistoryState } from './progress-history';
import type { ProgressSection } from './progress-navigation';

export function ProgressTab({ c, pendingApprovals, history, section = 'current-work' }: {
  c: any; pendingApprovals: any[]; history: HistoryState; section?: ProgressSection;
}) {
  const current = useRef<HTMLElement>(null);
  const recorded = useRef<HTMLElement>(null);
  useEffect(() => {
    const target = section === 'history' ? recorded.current : current.current;
    const header = document.querySelector<HTMLElement>('[data-case-header]');
    if (target) target.style.scrollMarginTop = `${header && getComputedStyle(header).position === 'sticky'
      ? header.getBoundingClientRect().height + 16 : 16}px`;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'start' });
  }, [section]);
  return <div className="min-w-0 max-w-4xl space-y-8 pb-12 [overflow-wrap:anywhere]">
    <section id="progress-current-work" ref={current} tabIndex={-1} aria-labelledby="progress-work-heading"
      className="min-w-0 scroll-mt-80 space-y-4">
      <h2 id="progress-work-heading" className="text-lg font-bold">Current work</h2>
      {!c.syntheticJourney && <NextActions c={c} pendingApprovals={pendingApprovals} showPlanLink={false} />}
      <TasksTab c={c} />
    </section>
    <section id="progress-history" ref={recorded} tabIndex={-1} aria-labelledby="progress-history-heading"
      className="min-w-0 scroll-mt-80 space-y-4">
      <h2 id="progress-history-heading" className="text-lg font-bold">History</h2>
      <p className="text-sm text-[var(--text-muted)]">Recorded events and their attribution. Workstream stages above are not event history.</p>
      <ProgressHistory {...history} />
    </section>
  </div>;
}
