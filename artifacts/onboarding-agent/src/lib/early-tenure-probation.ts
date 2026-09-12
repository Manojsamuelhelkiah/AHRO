export type ProbationDisposition = 'confirmed' | 'extended' | 'reviewed-other';

type ProbationTimingInput = {
  actualJoinedAt?: string | null;
  maturityAt?: string | null;
  governedEndAt?: string | null;
  effectiveAt: string;
  extensionEndsAt?: string;
  disposition: ProbationDisposition;
  now?: Date;
};

export type ProbationTimingResult = {
  canSubmit: boolean;
  message: string | null;
};

function date(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Mirrors the server's policy-snapshot timing fences without making a decision.
 * Extension and reviewed-other records remain available before policy maturity. */
export function probationTiming({ actualJoinedAt, maturityAt, governedEndAt, effectiveAt, extensionEndsAt, disposition, now = new Date() }: ProbationTimingInput): ProbationTimingResult {
  const actualStart = date(actualJoinedAt);
  const effective = date(effectiveAt);
  if (!actualStart) return { canSubmit: false, message: 'Record the actual joining anchor before submitting a probation review.' };
  if (!effective) return { canSubmit: false, message: 'Enter a valid reviewed effective date and time.' };
  if (effective.getTime() > now.getTime() + 5 * 60_000) return { canSubmit: false, message: 'A probation review effective time cannot be in the future.' };
  if (effective < actualStart) return { canSubmit: false, message: 'The reviewed effective time cannot precede the actual joining anchor.' };

  const governedEnd = date(governedEndAt);
  if (disposition === 'confirmed') {
    if (!governedEnd) return { canSubmit: false, message: 'The policy-derived probation end is unavailable. Reload before confirming.' };
    if (effective < governedEnd) return { canSubmit: false, message: `Confirmation is unavailable until the current governed probation end (${governedEnd.toLocaleString()}). An early extension or reviewed record may still be submitted.` };
  }

  if (disposition === 'extended') {
    const extensionEnd = date(extensionEndsAt);
    if (!extensionEnd) return { canSubmit: false, message: 'Enter the proposed extension end date and time.' };
    if (extensionEnd <= effective) return { canSubmit: false, message: 'An extension must end after its reviewed effective time.' };
    if (!governedEnd) return { canSubmit: false, message: 'The current governed probation end is unavailable. Reload before extending.' };
    if (extensionEnd <= governedEnd) return { canSubmit: false, message: 'An extension must end after the current governed probation end.' };
  }

  void maturityAt;
  return { canSubmit: true, message: null };
}