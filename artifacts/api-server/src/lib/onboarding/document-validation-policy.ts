export function normalizeBgvStatus(status: string): "pending" | "incomplete" | "rejected" | "overdue" | "clear" | "manual_review" {
  if (status === "done") return "clear";
  return ["pending", "incomplete", "rejected", "overdue", "clear", "manual_review"].includes(status)
    ? status as ReturnType<typeof normalizeBgvStatus>
    : "manual_review";
}

export function reminderEligible(input: {
  required: boolean;
  status: string;
  updatedAt: Date;
  reminderNextAt?: Date | null;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return input.required && ["pending", "received"].includes(input.status) &&
    input.updatedAt.getTime() <= now - 24 * 3600_000 &&
    (!input.reminderNextAt || input.reminderNextAt.getTime() <= now);
}

export type ProviderDecision = "verified" | "rejected" | "manual_review";
export type ValidationOutcome = "passed" | "rejected" | "manual_review" | "correction_requested";
export function decideValidationOutcome(
  reasons: Array<{ code: string; evidence?: string }>,
  provider: ProviderDecision | "unavailable" | "error",
): ValidationOutcome {
  const hardLocal = reasons.some((r) => ["checksum_mismatch", "declared_type_mismatch", "unreadable_structure", "object_unavailable", "active_content_check"].includes(r.code) && r.evidence !== "clear");
  if (hardLocal) return "correction_requested";
  if (provider === "rejected") return "rejected";
  if (provider === "manual_review" || provider === "unavailable" || provider === "error") return "manual_review";
  return "passed";
}

export function actionableCorrectionReason(reason: { code: string; evidence?: string }): boolean {
  return ["checksum_mismatch", "declared_type_mismatch", "unreadable_structure", "object_unavailable", "active_content_check"].includes(reason.code) &&
    reason.evidence !== "clear";
}

export function documentationGateReady(input: { bgvApplicable: boolean; bgvClear: boolean; requiredDocuments: number; verifiedDocuments: number }): boolean {
  return (!input.bgvApplicable || input.bgvClear) && input.requiredDocuments === input.verifiedDocuments;
}