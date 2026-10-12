/**
 * Ordinary lists may include read-only examples. Operational reports must
 * start from a separate population, including every rate denominator and
 * domain, readiness, agent and filter summary. Retained approvals are history,
 * not live interventions.
 */
export function operationalReportingPopulation<
  C extends { id: number; controllerRetired?: boolean; offlineSample?: boolean },
  A extends { caseId: number },
>(caseRows: readonly C[], approvalRows: readonly A[]) {
  const cases = caseRows.filter(row => !row.controllerRetired && !row.offlineSample);
  const caseIds = new Set(cases.map(row => row.id));
  return { cases, approvals: approvalRows.filter(row => caseIds.has(row.caseId)) };
}
