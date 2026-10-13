/** Display only. Never use this text for authorization, matching, or persistence. */
export const ONBOARDING_STAGE_NAMES = {
  a: 'Offer-Acceptance Package',
  b: 'Background Checks',
  c: 'Day-1 Readiness',
} as const;

export function lifecycleStageText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\bGateway A\/B\/C\b/g, 'Offer-Acceptance Package, Background Checks, and Day-1 Readiness')
    .replace(/\bGateway A, B and C\b/g, 'Offer-Acceptance Package, Background Checks, and Day-1 Readiness')
    .replace(/\b(?:Gateway|Gate) A(?:\s*(?:[:—·-]\s*)?(?:offer[- ]acceptance(?: package)?|intake))?/gi, ONBOARDING_STAGE_NAMES.a)
    .replace(/\b(?:Gateway|Gate) B(?:\s*[:—·-]\s*(?:background verification|background checks|review))?/gi, ONBOARDING_STAGE_NAMES.b)
    .replace(/\b(?:Gateway|Gate) C(?:\s*(?:[:—·-]\s*)?Day[- ]1 readiness)?/gi, ONBOARDING_STAGE_NAMES.c);
}

export function stageStatusText(status: string): string {
  return ({ complete: 'Complete', blocked: 'Blocked', pending: 'Pending',
    'human-review': 'Human Review', 'not-applicable': 'Not Applicable' } as Record<string, string>)[status] ?? status;
}
