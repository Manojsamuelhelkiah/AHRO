import { CASE_TYPES, type CaseTypeFilter } from './case-presentation';
import { PROGRAM_FILTER } from './transfer-presentation';

export type WorkItemFilter = CaseTypeFilter | typeof PROGRAM_FILTER;
export const OFFBOARDING_CASES_PATH = '/cases?caseType=Offboarding';

export function caseTypeFromSearch(search: string): WorkItemFilter {
  const value = new URLSearchParams(search).get('caseType');
  return value === PROGRAM_FILTER || CASE_TYPES.includes(value as CaseTypeFilter)
    ? value as WorkItemFilter
    : 'All Cases';
}

/** Change only the browsing filter, never intake or case-action parameters. */
export function caseListPath(search: string, type: WorkItemFilter, hash = ''): string {
  const params = new URLSearchParams(search);
  if (type === 'All Cases') params.delete('caseType');
  else params.set('caseType', type);
  return `/cases${params.size ? `?${params.toString()}` : ''}${hash}`;
}

export function legacySeparationsDestination(search: string, hash = ''): string {
  return caseListPath(search, 'Offboarding', hash);
}
