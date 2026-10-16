/** Read-only projection. Never an execution claim, intent rewrite or permission. */
export type CurrentAction = {
  key: string;
  label: string;
  status: "pending" | "in-progress" | "blocked";
  source: "action-center" | "workstream";
  additionalCount: number;
};
export type ActionLedgerEntry = {
  id: number; caseId: number; kind: string; status: string;
  owner: string | null; assignee: string | null; payload: Record<string, unknown>;
};

export function readableCurrentAction(action: CurrentAction | null, access: {
  opaqueRead: boolean; readinessRead: boolean; illustrative: boolean;
}): CurrentAction | null {
  return access.opaqueRead && !access.illustrative &&
    (action?.source !== "workstream" || access.readinessRead) ? action : null;
}

export function openCaseAssignments(rows: readonly ActionLedgerEntry[]) {
  const ledger = [...rows].sort((a, b) => b.id - a.id);
  const target = (row: ActionLedgerEntry) =>
    Number((row.payload.body as Record<string, unknown> | undefined)?.workItemId);
  const resolved = new Set(ledger.filter(row => row.kind === "resolve").map(target));
  return ledger.filter(row => ["assign", "escalate"].includes(row.kind) &&
    row.status === "open" && !resolved.has(row.id)).map(row => {
      const current = ledger.find(item => item.kind === "reassign" && target(item) === row.id) ?? row;
      return { ...row, owner: current.assignee || current.owner || "Unassigned human team" };
    });
}

export function currentActionForCase(
  row: { lifecycleStage?: string; orchestrationStatus?: string; hireType?: string;
    workstreams: readonly { key: string; label: string; status: string }[] },
  assignments: readonly { id: number; kind: string }[] = [],
): CurrentAction | null {
  if (["complete", "completed", "cancelled", "canceled", "rejected"].includes((row.lifecycleStage ?? "").toLowerCase()) ||
    row.orchestrationStatus === "done") return null;
  if (assignments.length) return {
    key: assignments[0].kind === "escalate" ? "human-escalation" : "human-review",
    label: assignments[0].kind === "escalate" ? "Escalation review" : "Assigned human review",
    status: "pending", source: "action-center", additionalCount: assignments.length - 1,
  };
  // Separation tasks have their own authoritative domain state. Do not use
  // inherited onboarding workstreams as a substitute for that state.
  if (row.hireType === "separation" || row.lifecycleStage?.startsWith("separation-")) return null;
  const statuses: Record<string, CurrentAction["status"]> = {
    blocked: "blocked", "in-progress": "in-progress", in_progress: "in-progress",
    running: "in-progress", pending: "pending", waiting: "pending",
  };
  const candidates = row.workstreams.filter(item => item.key?.trim() && item.label?.trim() && statuses[item.status]);
  const rank = { blocked: 0, "in-progress": 1, pending: 2 };
  candidates.sort((a, b) => rank[statuses[a.status]] - rank[statuses[b.status]]);
  const selected = candidates[0];
  return selected ? {
    key: `workstream:${selected.key}`, label: selected.label.trim(), status: statuses[selected.status],
    source: "workstream", additionalCount: candidates.length - 1,
  } : null;
}
