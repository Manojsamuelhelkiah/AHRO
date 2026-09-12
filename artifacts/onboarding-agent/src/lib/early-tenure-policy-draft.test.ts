import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEarlyTenurePolicy, missingMandatoryObligations, policyDraft } from './early-tenure-policy-draft';
import type { EarlyTenurePolicy } from './early-tenure-api';

test('policy editing clones custom obligations, applicability, and retained check-in metadata', () => {
  const existingCheckIns = [
    { key: 'thirty', label: 'Thirty day custom review', offsetDays: 30, required: false, reminderLeadDays: 9 },
    { key: 'sixty', label: 'Sixty day custom review', offsetDays: 60, required: true, reminderLeadDays: 5 },
    { key: 'ninety', label: 'Ninety day custom review', offsetDays: 90, required: true, reminderLeadDays: 2 },
  ];
  const active: EarlyTenurePolicy = {
    id: 'policy-7',
    version: 7,
    status: 'active',
    probationLengthDays: 90,
    decisionAuthorityScope: 'legal-approve',
    applicability: {
      hireTypes: ['employee'],
      workerCategories: ['frontline', 'field'],
      legalEntities: ['north', 'south'],
    },
    obligations: [
      { key: 'custom-learning', kind: 'learning-enrollment', label: 'Custom learning', offsetDays: 3, required: false, ownerRole: 'learning', requireEvidence: true, connectorKey: 'custom-lms', sourceConfirmationRequired: true },
      { key: 'calendar-task', kind: 'calendar-delivery', label: 'Calendar delivery', offsetDays: 4, required: false, ownerRole: 'manager', requireEvidence: false, connectorKey: 'calendar', sourceConfirmationRequired: false },
    ],
    checkIns: existingCheckIns,
  };

  const draft = { ...policyDraft(active), probationLengthDays: '120', checkInDays: '30, 45, 60, 90' };
  const next = buildEarlyTenurePolicy(active, draft);

  assert.equal(next.probationLengthDays, 120);
  assert.deepEqual(next.applicability, active.applicability);
  assert.deepEqual(next.obligations, active.obligations);
  assert.deepEqual(next.checkIns, [
    existingCheckIns[0],
    { key: 'day-45', label: '45-day policy check-in', offsetDays: 45, required: true, reminderLeadDays: 3 },
    existingCheckIns[1],
    existingCheckIns[2],
  ]);
});

test('new policies include separate human-evidence learning and calendar tasks, while legacy task migration is explicit', () => {
  const newPolicy = buildEarlyTenurePolicy(undefined, {
    probationLengthDays: '90',
    checkInDays: '14, 45',
    decisionAuthorityScope: 'hr-compliance-approve',
    hireTypes: '',
    workerCategories: '',
    legalEntities: '',
  });
  const learning = newPolicy.obligations.find((item) => item.kind === 'learning-enrollment');
  const calendar = newPolicy.obligations.find((item) => item.kind === 'calendar-delivery');
  assert.deepEqual(newPolicy.checkIns.map((item) => item.offsetDays), [14, 45]);
  assert.deepEqual(learning, {
    key: 'learning-enrollment', kind: 'learning-enrollment', label: 'Required learning enrollment evidence', offsetDays: 7,
    required: true, ownerRole: 'HR learning', requireEvidence: true, sourceConfirmationRequired: false,
  });
  assert.deepEqual(calendar, {
    key: 'calendar-delivery', kind: 'calendar-delivery', label: 'Required calendar delivery evidence', offsetDays: 14,
    required: true, ownerRole: 'manager', requireEvidence: true, sourceConfirmationRequired: false,
  });

  const legacy: EarlyTenurePolicy = {
    id: 'legacy',
    probationLengthDays: 90,
    decisionAuthorityScope: 'hr-compliance-approve',
    obligations: [
      { key: 'induction', kind: 'induction', label: 'Induction', offsetDays: 0, required: true, ownerRole: 'HR', requireEvidence: true },
      { key: 'compliance', kind: 'compliance-training', label: 'Compliance', offsetDays: 7, required: true, ownerRole: 'HR', requireEvidence: true },
      { key: 'buddy', kind: 'buddy-acknowledgement', label: 'Buddy', offsetDays: 7, required: true, ownerRole: 'manager', requireEvidence: true },
      { key: 'manager', kind: 'manager-connect', label: 'Manager', offsetDays: 14, required: true, ownerRole: 'manager', requireEvidence: true, structuredAgenda: ['Support'] },
    ],
    checkIns: [{ key: 'day-45', label: '45-day review', offsetDays: 45, required: true, reminderLeadDays: 4 }],
  };
  const draft = policyDraft(legacy);
  assert.deepEqual(missingMandatoryObligations(legacy).map((item) => item.kind), ['learning-enrollment', 'calendar-delivery']);
  assert.deepEqual(buildEarlyTenurePolicy(legacy, draft).obligations, legacy.obligations);
  assert.deepEqual(
    buildEarlyTenurePolicy(legacy, draft, { addMissingMandatoryObligations: true }).obligations.map((item) => item.kind),
    ['induction', 'compliance-training', 'buddy-acknowledgement', 'manager-connect', 'learning-enrollment', 'calendar-delivery'],
  );
});