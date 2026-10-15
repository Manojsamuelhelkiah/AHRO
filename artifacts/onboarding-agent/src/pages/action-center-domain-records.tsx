import { Link, useSearch } from "wouter";
import type { OnbActionCenter } from "@workspace/api-client-react";
import { createContext, useContext } from "react";
import { actionConversationHref } from "../lib/action-center-filter";

export const ActionCasePresentation = createContext<NonNullable<OnbActionCenter["caseSummaries"]>>([]);
export function useActionCase(caseId: number) {
  const row = useContext(ActionCasePresentation).find(s => s.caseId === caseId);
  return { label: row?.label ?? "Case record", href: row?.caseHref ?? `/cases/${caseId}`,
    family: row?.caseType };
}
export function ActionReference({ caseId }: { caseId: number }) {
  const row = useActionCase(caseId);
  return <span>{row.label}{row.family ? ` · ${row.family}` : ''}</span>;
}
export function ActionConversationLink({ caseId, workItemId }: { caseId: number; workItemId?: number }) {
  const href = actionConversationHref(useSearch(), caseId, workItemId);
  return <Link href={href} className="text-xs font-medium text-[var(--primary)] hover:underline">Conversation</Link>;
}

export function ActionCaseSummaries({ data }: { data: OnbActionCenter }) {
  const rows = data.caseSummaries ?? [];
  if (!rows.length) return null;
  return <section aria-label="Case summaries" className="rounded border border-[var(--border)] p-3">
    <h3 className="text-sm font-semibold">Case summaries ({rows.length})</h3>
    <p className="mb-2 text-xs text-[var(--text-muted)]">Discovery only. These cases are not counted as pending actions, completions or sent messages.</p>
    <div className="max-h-60 overflow-auto divide-y divide-[var(--border)]">
      {rows.map(row => <div key={row.caseId} className="flex flex-wrap items-center gap-2 py-2 text-xs">
        <Link href={row.caseHref} className="font-semibold text-[var(--primary)]">{row.label}</Link>
        <span>{row.caseType}</span><span className="text-[var(--text-muted)]">{row.status}</span>
      </div>)}
    </div>
  </section>;
}

export function DomainRecords({ data, category }: {
  data: OnbActionCenter; category: "attention" | "completed" | "communication";
}) {
  const rows = (data.domainRecords ?? []).filter(r => r.category === category);
  if (!rows.length) return null;
  const summaries = new Map((data.caseSummaries ?? []).map(s => [s.caseId, s]));
  return <section className="space-y-2">
    <h3 className="text-sm font-semibold">Recorded offboarding {category === "attention" ? "tasks" : category === "completed" ? "task outcomes" : "communications"} ({rows.length})</h3>
    {rows.map(row => <div key={row.id} className="rounded border border-[var(--border)] p-3 text-sm">
      <div className="flex flex-wrap gap-2">
        <Link href={row.caseHref} className="font-semibold text-[var(--primary)]">{summaries.get(row.caseId)?.label ?? `Case #${row.caseId}`}</Link>
        <span>{row.title}</span><span className="text-xs">{row.status}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{row.detail}</p>
    </div>)}
  </section>;
}
