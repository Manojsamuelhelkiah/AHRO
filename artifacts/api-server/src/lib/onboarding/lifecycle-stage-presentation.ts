/** Display only. Never use this text for authorization, matching, or persistence. */
export function lifecycleStageText(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/\bGateway A\/B\/C\b/g, 'Offer-Acceptance Package, Background Checks, and Day-1 Readiness')
    .replace(/\bGateway A, B and C\b/g, 'Offer-Acceptance Package, Background Checks, and Day-1 Readiness')
    .replace(/\b(?:Gateway|Gate) A(?:\s*(?:[:—·-]\s*)?(?:offer[- ]acceptance(?: package)?|intake))?/gi, 'Offer-Acceptance Package')
    .replace(/\b(?:Gateway|Gate) B(?:\s*[:—·-]\s*(?:background verification|background checks|review))?/gi, 'Background Checks')
    .replace(/\b(?:Gateway|Gate) C(?:\s*(?:[:—·-]\s*)?Day[- ]1 readiness)?/gi, 'Day-1 Readiness');
}
