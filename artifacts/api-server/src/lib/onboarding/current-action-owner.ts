import { and, desc, eq, inArray } from "drizzle-orm";
import { db, onbActionCenterActions } from "@workspace/db";

/** Read the append-only Action Center ledger, including resolution and reassignment.
 * This projection supplies no action capability or authority. */
export async function currentActionOwners(organizationId: string, ids: number[]) {
  if (!ids.length) return new Map<number, string>();
  const rows = await db.select({
    id: onbActionCenterActions.id, caseId: onbActionCenterActions.caseId,
    kind: onbActionCenterActions.kind, status: onbActionCenterActions.status,
    owner: onbActionCenterActions.owner, assignee: onbActionCenterActions.assignee,
    payload: onbActionCenterActions.payload,
  }).from(onbActionCenterActions).where(and(
    eq(onbActionCenterActions.organizationId, organizationId),
    inArray(onbActionCenterActions.caseId, ids),
    inArray(onbActionCenterActions.kind, ["assign", "escalate", "reassign", "resolve"]),
  )).orderBy(desc(onbActionCenterActions.id));
  const result = new Map<number, string>();
  for (const caseId of ids) {
    const ledger = rows.filter(row => row.caseId === caseId);
    const targetId = (row: typeof rows[number]) =>
      Number((row.payload.body as Record<string, unknown> | undefined)?.workItemId);
    const resolved = new Set(ledger.filter(row => row.kind === "resolve").map(targetId));
    const pending = ledger.find(row => ["assign", "escalate"].includes(row.kind) &&
      row.status === "open" && !resolved.has(row.id));
    if (!pending) continue;
    const current = ledger.find(row => row.kind === "reassign" && targetId(row) === pending.id) ?? pending;
    result.set(caseId, current.assignee || current.owner || "Unassigned human team");
  }
  return result;
}
