import assert from "node:assert/strict";
import { test } from "node:test";
import { CASE_TYPES, casesForList, casePresentationOf, caseTitleOf, caseTypeOf, isFictionalOfflineExample, caseListReference, sampleCaseReference, caseWorkerName, caseSummary, sampleIntakeFields } from "./case-presentation";
import { CURATED_OFFLINE_EXAMPLES } from '../../../../api-server/src/lib/onboarding/offline-example-extension';

test("every family uses explicit request classification rather than falling back to onboarding", () => {
  for (const family of CASE_TYPES.filter(value => value !== "All Cases")) {
    for (let slot = 1; slot <= 10; slot++) {
      const c = { caseFamily: family, requestType: `${family} example ${slot}`, scenarioKey: `UAT-DEMO-EXAMPLES:${slot <= 5 ? "additional-v1" : "complementary-v1"}:${family}:${slot}`, hireType: "employee-service" };
      assert.equal(caseTypeOf(c), family);
      assert.equal(caseTitleOf(c), c.requestType);
      assert.equal(casePresentationOf(c)?.type, family);
      assert.equal(casePresentationOf(c)?.title, c.requestType);
    }
  }
});
test("ordinary lists retain existing fictional examples and new examples, not volunteers or unrestricted historical records", () => {
  const operational = { id: 1, controllerRetired: false };
  const existing = { id: 2, controllerRetired: true, offlineSample: true, fictionalOfflineIdentity: true };
  const added = { ...existing, id: 3 };
  const volunteer = { id: 4, controllerRetired: true, offlineSample: true, fictionalOfflineIdentity: false };
  const rows = [operational, existing, added, volunteer];
  assert.deepEqual(casesForList(rows, false), [operational, existing, added]);
  assert.deepEqual(casesForList(rows, true), [existing, added, volunteer]);
  assert.equal(isFictionalOfflineExample(volunteer), false);
});

const sample = { id: 3644, fictionalOfflineIdentity: true, offlineSample: true, workerName: 'Example — Kiran Pine', createdAt: '2026-10-13' };
test('every actual curated sample keeps meaningful request attributes and pending review without generated codes', () => {
  assert.equal(new Set(CURATED_OFFLINE_EXAMPLES.map(example => example.family)).size, 12);
  for (const example of CURATED_OFFLINE_EXAMPLES) {
    const request = example.values.processPolicySnapshot.batchIntake;
    const stored = JSON.stringify(example.values);
    const fields = Object.fromEntries(sampleIntakeFields(request.data, sample));
    assert.ok(!JSON.stringify(fields).includes('FICTIONAL-'), example.key);
    assert.ok(!JSON.stringify(fields).includes('UAT-DEMO-'), example.key);
    for (const [key, value] of Object.entries(request.data)) {
      if ((!value && (key.endsWith('_reference') || key === 'employee_id')) || (key.endsWith('_date') && value)) {
        assert.equal(fields[key], value, `${example.title}: preserve ${key}`);
      }
    }
    assert.equal(caseSummary({ ...sample, planSummary: example.values.planSummary }), `${example.summary} All evidence and human decisions remain pending.`);
    assert.equal(JSON.stringify(example.values), stored);
  }
});

test("only confirmed fictional offline identity changes case identifiers and names", () => {
  assert.equal(sampleCaseReference(sample), 'S3644');
  assert.equal(caseListReference(sample), 'S3644');
  assert.equal(caseWorkerName(sample), 'Kiran Pine');
  for (const flags of [
    { fictionalOfflineIdentity: false, offlineSample: true },
    { fictionalOfflineIdentity: true, offlineSample: false },
    { fictionalOfflineIdentity: undefined, offlineSample: undefined },
  ]) {
    const real = { ...sample, ...flags };
    assert.equal(sampleCaseReference(real), null);
    assert.equal(caseListReference(real), 'HRO-2026-03644');
    assert.equal(caseWorkerName(real), sample.workerName);
  }
  assert.equal(caseWorkerName({ ...sample, workerName: 'Restricted candidate' }), 'Restricted candidate');
  assert.equal(caseWorkerName({ ...sample, workerName: 'An Example — Worker' }), 'An Example — Worker');
});

test("fixed summary suffix is removed for samples only; pending decisions and arbitrary prose survive", () => {
  const request = 'Clarify the proposed effective date against a reported 2030-11-25 cutoff; payroll acceptance is pending.';
  const planSummary = `${request} Offline example only; all evidence and human decisions remain pending.`;
  assert.equal(caseSummary({ ...sample, planSummary }), `${request} All evidence and human decisions remain pending.`);
  assert.equal(caseSummary({ ...sample, fictionalOfflineIdentity: false, planSummary }), planSummary);
  const arbitrary = 'Discuss Offline example only; with HR.';
  assert.equal(caseSummary({ ...sample, planSummary: arbitrary }), arbitrary);
});

test("sample reference cleanup preserves conflicts, missing references, attributes and arbitrary narratives", () => {
  const data = {
    request_id: 'UAT-DEMO-EXAMPLES:complementary-v1:2:10',
    employee_id: 'FICTIONAL-EMPLOYEE-2-10',
    change_reference: 'FICTIONAL-CUTOFF-10',
    secure_submission_reference: 'FICTIONAL-REF-A / FICTIONAL-REF-B',
    evidence_reference: '', effective_date: '2030-11-24',
    worker_name: sample.workerName, request_summary: 'Discuss FICTIONAL-CUTOFF-10 with HR.',
  };
  assert.deepEqual(Object.fromEntries(sampleIntakeFields(data, sample)), {
    secure_submission_reference: 'Conflicting references A and B — neither verified',
    evidence_reference: '', effective_date: '2030-11-24',
    worker_name: 'Kiran Pine', request_summary: data.request_summary,
  });
  assert.deepEqual(sampleIntakeFields(data), Object.entries(data));
  assert.deepEqual(sampleIntakeFields(data, { ...sample, fictionalOfflineIdentity: false }), Object.entries(data));
  assert.equal(data.worker_name, 'Example — Kiran Pine');
});
