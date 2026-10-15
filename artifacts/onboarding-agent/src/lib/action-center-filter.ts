import type { ActionCenterCaseType } from "@workspace/api-client-react";
import { CASE_TYPES } from "../pages/cases/case-presentation";

export function actionCenterTypeFromSearch(search: string): ActionCenterCaseType | undefined {
  const value = new URLSearchParams(search).get("caseType");
  return value && value !== "All Cases" && CASE_TYPES.includes(value as typeof CASE_TYPES[number])
    ? value as ActionCenterCaseType : undefined;
}
export function actionCenterTypeHref(pathname: string, search: string, caseType?: string, fragment = "") {
  const next = new URLSearchParams(search);
  if (caseType) next.set("caseType", caseType); else next.delete("caseType");
  return `${pathname}${next.size ? `?${next}` : ""}${fragment}`;
}
export function actionConversationHref(search: string, caseId: number, workItemId?: number) {
  const next = new URLSearchParams(search);
  next.set("tab", "conversation"); next.set("caseId", String(caseId));
  if (workItemId) next.set("workItemId", String(workItemId)); else next.delete("workItemId");
  return `/approvals?${next}`;
}
