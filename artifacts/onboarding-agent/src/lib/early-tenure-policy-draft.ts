import type { EarlyTenurePolicy, EarlyTenurePolicyCheckIn, EarlyTenurePolicyObligation } from './early-tenure-api';

export type EarlyTenurePolicyDraft = {
  probationLengthDays: string;
  checkInDays: string;
  decisionAuthorityScope: string;
  hireTypes: string;
  workerCategories: string;
  legalEntities: string;
};

export type EarlyTenurePolicyPayload = {
  probationLengthDays: number;
  decisionAuthorityScope: string;
  applicability: { hireTypes?: string[]; workerCategories?: string[]; legalEntities?: string[] };
  obligations: EarlyTenurePolicyObligation[];
  checkIns: EarlyTenurePolicyCheckIn[];
};

export const defaultObligations = (): EarlyTenurePolicyObligation[] => [
  { key: 'induction', kind: 'induction', label: 'Induction attendance', offsetDays: 0, required: true, ownerRole: 'HR onboarding', requireEvidence: true, sourceConfirmationRequired: false },
  // LMS/calendar adapters are activation-pending. New policies remain human-evidence
  // work until an explicitly verified server-owned adapter is available.
  { key: 'compliance-training', kind: 'compliance-training', label: 'Required compliance completion', offsetDays: 7, required: true, ownerRole: 'HR compliance', requireEvidence: true, sourceConfirmationRequired: false },
  { key: 'learning-enrollment', kind: 'learning-enrollment', label: 'Required learning enrollment evidence', offsetDays: 7, required: true, ownerRole: 'HR learning', requireEvidence: true, sourceConfirmationRequired: false },
  { key: 'calendar-delivery', kind: 'calendar-delivery', label: 'Required calendar delivery evidence', offsetDays: 14, required: true, ownerRole: 'manager', requireEvidence: true, sourceConfirmationRequired: false },
  { key: 'buddy-acknowledgement', kind: 'buddy-acknowledgement', label: 'Buddy acknowledgement', offsetDays: 7, required: true, ownerRole: 'manager', requireEvidence: true, sourceConfirmationRequired: false },
  { key: 'manager-connect', kind: 'manager-connect', label: 'Structured manager connect', offsetDays: 14, required: true, ownerRole: 'manager', requireEvidence: true, sourceConfirmationRequired: false, structuredAgenda: ['role expectations', 'support needed', 'onboarding feedback'] },
];

const defaultCheckIns = (): EarlyTenurePolicyCheckIn[] => [30, 60, 90].map((offsetDays) => ({
  key: `day-${offsetDays}`, label: `${offsetDays}-day policy check-in`, offsetDays, required: true, reminderLeadDays: 3,
}));

const csv = (values?: string[]) => values?.join(', ') ?? '';
const strings = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

export function policyDraft(policy?: EarlyTenurePolicy): EarlyTenurePolicyDraft {
  return {
    probationLengthDays: String(policy?.probationLengthDays ?? ''),
    checkInDays: (policy?.checkIns?.map((item) => item.offsetDays) ?? [30, 60, 90]).join(', '),
    decisionAuthorityScope: policy?.decisionAuthorityScope ?? 'hr-compliance-approve',
    hireTypes: csv(policy?.applicability?.hireTypes),
    workerCategories: csv(policy?.applicability?.workerCategories),
    legalEntities: csv(policy?.applicability?.legalEntities),
  };
}

export function cadenceOffsets(value: string): number[] {
  const offsets = value.split(',').map((item) => Number(item.trim()));
  return offsets.filter((offset, index) => Number.isInteger(offset) && offset > 0 && offsets.indexOf(offset) === index);
}

export function hasValidCadence(value: string): boolean {
  const entries = value.split(',').map((item) => item.trim());
  const offsets = entries.map(Number);
  return entries.length > 0 && entries.every((item, index) => item.length > 0 && Number.isInteger(offsets[index]) && offsets[index] > 0) && new Set(offsets).size === offsets.length;
}

export function removedCheckIns(policy: EarlyTenurePolicy | undefined, offsets: number[]): EarlyTenurePolicyCheckIn[] {
  const matched = new Set<number>();
  return (policy?.checkIns ?? []).filter((checkIn) => {
    const offsetIndex = offsets.findIndex((offset, index) => offset === checkIn.offsetDays && !matched.has(index));
    if (offsetIndex < 0) return true;
    matched.add(offsetIndex);
    return false;
  });
}

/** Required workflow types added in current policy versions. Existing custom
 * tasks are intentionally left unchanged; callers must explicitly authorize a
 * migration before missing defaults are appended. */
export function missingMandatoryObligations(policy: EarlyTenurePolicy | undefined): EarlyTenurePolicyObligation[] {
  const current = policy?.obligations ?? [];
  return defaultObligations().filter((required) => !current.some((obligation) => (
    obligation.kind === required.kind && obligation.required && obligation.requireEvidence
  )));
}

function migrationObligations(policy: EarlyTenurePolicy): EarlyTenurePolicyObligation[] {
  const keys = new Set((policy.obligations ?? []).map((obligation) => obligation.key));
  return missingMandatoryObligations(policy).map((obligation) => {
    let key = obligation.key;
    let suffix = 2;
    while (keys.has(key)) key = `${obligation.key}-${suffix++}`;
    keys.add(key);
    return { ...obligation, key, ...(obligation.structuredAgenda ? { structuredAgenda: [...obligation.structuredAgenda] } : {}) };
  });
}

/** Creates a new policy version by cloning all unedited governed policy fields.
 * Existing snapshots are never involved: this payload is used only for publish. */
export function buildEarlyTenurePolicy(policy: EarlyTenurePolicy | undefined, draft: EarlyTenurePolicyDraft, options: { addMissingMandatoryObligations?: boolean } = {}): EarlyTenurePolicyPayload {
  const offsets = cadenceOffsets(draft.checkInDays);
  const currentCheckIns = policy?.checkIns ?? defaultCheckIns();
  const originalApplicability = policy?.applicability ?? {};
  const applicability = { ...originalApplicability };
  if (!policy || draft.hireTypes !== csv(originalApplicability.hireTypes)) applicability.hireTypes = strings(draft.hireTypes);
  if (!policy || draft.workerCategories !== csv(originalApplicability.workerCategories)) applicability.workerCategories = strings(draft.workerCategories);
  if (!policy || draft.legalEntities !== csv(originalApplicability.legalEntities)) applicability.legalEntities = strings(draft.legalEntities);
  return {
    probationLengthDays: Number(draft.probationLengthDays),
    decisionAuthorityScope: draft.decisionAuthorityScope,
    applicability,
    obligations: [
      ...(policy?.obligations ?? defaultObligations()).map((obligation) => ({
        ...obligation,
        ...(obligation.structuredAgenda ? { structuredAgenda: [...obligation.structuredAgenda] } : {}),
      })),
      ...(policy && options.addMissingMandatoryObligations ? migrationObligations(policy) : []),
    ],
    checkIns: offsets.map((offsetDays) => {
      const existing = currentCheckIns.find((checkIn) => checkIn.offsetDays === offsetDays);
      return existing ? { ...existing } : {
        key: `day-${offsetDays}`, label: `${offsetDays}-day policy check-in`, offsetDays, required: true, reminderLeadDays: 3,
      };
    }),
  };
}