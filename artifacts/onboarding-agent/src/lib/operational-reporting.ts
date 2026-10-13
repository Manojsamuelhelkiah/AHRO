/**
 * Authorized offline examples belong in case totals and distributions just
 * like online rows. Status availability is not evidence of business success.
 * Retained sample approvals remain history, not current interventions.
 */
export function operationalReportingPopulation<
  C extends { id: number; controllerRetired?: boolean; offlineSample?: boolean; fictionalOfflineIdentity?: boolean; reportingCaseEligible?: boolean; operationalStartedAt?: string | null; createdAt?: string },
  A extends { caseId: number },
>(caseRows: readonly C[], approvalRows: readonly A[]) {
  const cases = caseRows.filter(row => row.reportingCaseEligible ??
    (!row.controllerRetired || row.fictionalOfflineIdentity === true)).map(row => row.operationalStartedAt
      ? { ...row, createdAt: row.operationalStartedAt } : row);
  const caseIds = new Set(cases.map(row => row.id));
  const byId = new Map(cases.map(row => [row.id, row]));
  return { cases, approvals: approvalRows.filter(row => {
    if (!caseIds.has(row.caseId)) return false;
    const c = byId.get(row.caseId)!;
    // Preactivation approvals are retained history, never current interventions.
    if (c.offlineSample) return false;
    const createdAt = (row as A & { createdAt?: string }).createdAt;
    return !c.operationalStartedAt || Boolean(createdAt &&
      Date.parse(createdAt) >= Date.parse(c.operationalStartedAt));
  }) };
}
