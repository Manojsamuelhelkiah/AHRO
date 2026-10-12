import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesTransferProgram, plannedCutoverLabel, programHref, PROGRAM_FILTER } from './transfer-presentation';
import type { WorkforceTransferProgramSummary } from '@/lib/workforce-transfers-api';

const p: WorkforceTransferProgramSummary = {
  id: 'a/b', version: 1, name: 'Acquisition', sourceLegalEntity: 'Source', destinationLegalEntity: 'Destination',
  countries: ['US'], proposedBasis: 'cross-border', legalDay1: '2031-01-01T00:00:00.000Z',
  status: 'go', createdAt: '2026-01-01', hrIntegrationOwner: null, partialCountryScope: true,
  populationSummary: { importedHeadcount: 3, expectedHeadcount: null },
};
const input = { type: 'All Cases', query: '', geography: '', programStatus: '', caseOnly: false, dateFrom: '', dateTo: '' };

test('program filtering preserves native status and authorized countries and excludes all case-only criteria', () => {
  assert.equal(matchesTransferProgram(p, input), true);
  assert.equal(matchesTransferProgram(p, { ...input, type: PROGRAM_FILTER }), true);
  for (const type of ['Onboarding', 'Employee Changes', 'Payroll', 'Mobility']) assert.equal(matchesTransferProgram(p, { ...input, type }), false);
  assert.equal(matchesTransferProgram(p, { ...input, caseOnly: true }), false);
  assert.equal(matchesTransferProgram(p, { ...input, geography: 'DE' }), false);
  assert.equal(matchesTransferProgram(p, { ...input, geography: 'US' }), true);
  assert.equal(matchesTransferProgram(p, { ...input, programStatus: 'Completed' }), false);
  assert.equal(matchesTransferProgram(p, { ...input, programStatus: 'go' }), true);
  for (const query of ['Acquisition', 'SOURCE', 'destination', 'a/b']) assert.equal(matchesTransferProgram(p, { ...input, query }), true);
  assert.equal(matchesTransferProgram(p, { ...input, dateFrom: '2031-01-02' }), false);
  assert.equal(matchesTransferProgram(p, { ...input, dateTo: '2030-12-31' }), false);
  assert.equal(matchesTransferProgram({ ...p, legalDay1: '' }, { ...input, dateFrom: '2030-01-01' }), false);
});

test('planned cutover is the recorded calendar date and unknown dates and encoded links are honest', () => {
  assert.equal(plannedCutoverLabel(undefined), 'Unknown');
  assert.equal(plannedCutoverLabel('invalid'), 'Unknown');
  assert.equal(plannedCutoverLabel('2031-01-01T00:00:00.000Z'), '2031-01-01');
  assert.equal(programHref('a/b'), '/workforce-transfers/a%2Fb');
});
