import test from 'node:test';
import assert from 'node:assert/strict';
import { caseListPath, caseTypeFromSearch, legacySeparationsDestination } from './list-navigation';
import { caseTypeOf, caseTitleOf } from './case-presentation';

test('legacy list preserves opaque context and fragment, replacing only the type filter', () => {
  const result = legacySeparationsDestination('?caseType=Payroll&checklistProfileId=client%2Fv2&source=a%26b&source=c', '#history');
  assert.ok(result.startsWith('/cases?'));
  assert.ok(result.endsWith('#history'));
  const params = new URL(result, 'https://example.test').searchParams;
  assert.equal(params.get('caseType'), 'Offboarding');
  assert.equal(params.get('checklistProfileId'), 'client/v2');
  assert.deepEqual(params.getAll('source'), ['a&b', 'c']);
  assert.equal(caseTypeFromSearch(params.toString()), 'Offboarding');
});

test('shared case filters validate known values and preserve unrelated query parameters', () => {
  for (const search of ['', '?caseType=Separations', '?caseType=https://evil.test']) {
    assert.equal(caseTypeFromSearch(search), 'All Cases');
  }
  assert.equal(caseListPath('caseType=Offboarding&scenarioId=10', 'All Cases', '#saved'), '/cases?scenarioId=10#saved');
  assert.equal(caseListPath('', 'All Cases'), '/cases');
  assert.equal(caseTypeFromSearch('caseType=Workforce+Transfer+Programs'), 'Workforce Transfer Programs');
});

test('separation envelopes without batch metadata use the established Offboarding taxonomy', () => {
  assert.equal(caseTypeOf({ hireType: 'separation' }), 'Offboarding');
  assert.equal(caseTitleOf({ hireType: 'separation' }), 'Offboarding');
});
