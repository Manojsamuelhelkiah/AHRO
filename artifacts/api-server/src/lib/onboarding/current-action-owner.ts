import { and, desc, eq, inArray } from "drizzle-orm";
import { db, onbActionCenterActions } from "@workspace/db";
import { openCaseAssignments } from "./current-action";

/** Read the append-only Action Center ledger, including resolution and reassignment.
 * This projection supplies no action capability or authority. */
export async function currentActionAssignments(organizationId: string, ids: number[], reader: Pick<typeof db, "select"> = db) {
  if (!ids.length) return new Map<number, ReturnType<typeof openCaseAssignments>>();
  const rows = await reader.select({
    id: onbActionCenterActions.id, caseId: onbActionCenterActions.caseId,
    kind: onbActionCenterActions.kind, status: onbActionCenterActions.status,
    owner: onbActionCenterActions.owner, assignee: onbActionCenterActions.assignee,
    payload: onbActionCenterActions.payload,
  }).from(onbActionCenterActions).where(and(
    eq(onbActionCenterActions.organizationId, organizationId),
    inArray(onbActionCenterActions.caseId, ids),
    inArray(onbActionCenterActions.kind, ["assign", "escalate", "reassign", "resolve"]),
  )).orderBy(desc(onbActionCenterActions.id));
  const result = new Map<number, ReturnType<typeof openCaseAssignments>>();
  for (const caseId of ids) {
    result.set(caseId, openCaseAssignments(rows.filter(row => row.caseId === caseId)));
  }
  return result;
}

export async function currentActionOwners(organizationId: string, ids: number[]) {
  const assignments = await currentActionAssignments(organizationId, ids);
  return new Map([...assignments].flatMap(([id, rows]) => rows.length ? [[id, rows[0].owner] as const] : []));
}
