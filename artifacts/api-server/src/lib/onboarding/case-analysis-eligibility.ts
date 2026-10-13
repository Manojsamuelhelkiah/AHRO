import { db, onbCases } from "@workspace/db";
import { isHistoricalTestRecord } from "./historical-test-record";
import { preparationSource, actualRunOwnsCase } from "./offline-preparation";
import { isRetiredControllerCase } from "./controller-retirement";
import { getUatCaseIsolation } from "./uat-isolation";

/** Read eligibility only; this never authorizes activation or provider I/O. */
export async function caseAnalysisRestriction(row: typeof onbCases.$inferSelect): Promise<string | null> {
  if (isRetiredControllerCase({ ...row, controllerRetired: false })) {
    return "Ask AI is unavailable for retained controller records. Review the permitted history directly; these records cannot be disclosed to an AI provider.";
  }
  const example = preparationSource(row);
  if (await actualRunOwnsCase(db, row)) {
    return "Ask AI is unavailable for actual or uncertain UAT-run records. Their isolated evidence cannot be disclosed to an AI provider.";
  }
  const isolation = await getUatCaseIsolation(row);
  if (isolation.isolated && !example) {
    return "Ask AI is unavailable for UAT-isolated records. Review permitted evidence in the case tabs instead.";
  }
  if (isHistoricalTestRecord(row) && !example) {
    return "Ask AI is unavailable for this retained historical record. Review permitted history directly; it is not current operational evidence.";
  }
  return null;
}
