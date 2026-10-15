import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui-shared';
import { ExplainabilityTab } from './explainability-tab';
import { RestrictedActionNotice } from './case-access';

/**
 * Ask about this case: button placed after the action block. The panel is not mounted until the
 * first click (no spend or request is made implicitly), then stays mounted so an unsent question
 * and transcript survive hiding. Parent should key this by org/user/case to reset it.
 */
export function AskCaseSection({ canAnalyze, caseId, userId, requested }: {
  canAnalyze: boolean; caseId: number; userId?: string; requested: string | null;
}) {
  const [open, setOpen] = useState(Boolean(requested));
  const [everOpened, setEverOpened] = useState(Boolean(requested));
  useEffect(() => { if (requested) { setOpen(true); setEverOpened(true); } }, [requested]);
  const toggle = () => { setEverOpened(true); setOpen((v) => !v); };
  if (!canAnalyze && !requested) return null;
  return (
    <section id="case-ask-ai" aria-label="Ask about this case" className="mb-5 scroll-mt-24">
      {canAnalyze && (
        <Button variant="outline" aria-expanded={open} aria-controls="case-ask-ai-panel" onClick={toggle}
          className="gap-2 border-[var(--primary)] text-[var(--primary)] hover:bg-[var(--primary-light-bg)]">
          <Sparkles className="h-4 w-4" aria-hidden /> {open ? 'Hide Ask about this case' : 'Ask about this case'}
        </Button>
      )}
      <div id="case-ask-ai-panel" hidden={!open} className="mt-3">
        {everOpened && (canAnalyze
          ? <ExplainabilityTab caseId={caseId} userId={userId} />
          : <RestrictedActionNotice>Ask AI requires current case and sensitive-field read permissions. Review only the case records available to your account.</RestrictedActionNotice>)}
      </div>
    </section>
  );
}
