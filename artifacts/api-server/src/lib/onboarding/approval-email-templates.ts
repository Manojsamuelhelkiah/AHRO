import { approvalRef, approvalVersion } from "./approval-version";
import {
  formatEmailIdentityLines,
  identityForRole,
  type EmailDeliveryMode,
  type NamedStakeholder,
  type RequesterKind,
} from "./email-identity";

export type ApprovalEmailTemplateInput = {
  approvalId: number;
  version?: number | null;
  workerName: string;
  caseId: number;
  agent: string;
  hitlPattern: string;
  recommendation: string;
  rationale: string;
  stakeholder?: NamedStakeholder;
  deliveryAddress?: string | null;
  deliveryMode?: EmailDeliveryMode;
  deliveryState?: "queued" | "sent" | "not-sent";
  appPath?: string;
};

export type ApprovalDecisionEmailTemplateInput = {
  approvalId: number;
  version?: number | null;
  workerName: string;
  caseId: number;
  decidedBy: string;
  decision: "approved" | "rejected";
  decidedAt: Date;
  decidedByKind?: RequesterKind;
  stakeholder?: NamedStakeholder;
  deliveryAddress?: string | null;
  deliveryMode?: EmailDeliveryMode;
  deliveryState?: "queued" | "sent" | "not-sent";
  stale?: boolean;
  appPath?: string;
};

const DEFAULT_APPROVER: NamedStakeholder = {
  name: "",
  role: "HR approval stakeholder",
};

export function composeApprovalRequestEmail(
  input: ApprovalEmailTemplateInput,
): { subject: string; body: string } {
  const version = approvalVersion(input.version);
  const reference = approvalRef(input.approvalId, version);
  const kind = input.hitlPattern === "hard-block" ? "HARD-BLOCK" : "Approval needed";
  // Preserve the legacy V1 subject token for existing inbox rules while
  // keeping the versioned token authoritative for matching.
  const subjectReference = version === 1
    ? `AP-${input.approvalId}] [${reference}`
    : reference;
  const stakeholder = input.stakeholder ?? DEFAULT_APPROVER;
  const appPath = input.appPath ??
    `/approvals?tab=approvals&caseId=${encodeURIComponent(String(input.caseId))}` +
    `&approvalId=${encodeURIComponent(String(input.approvalId))}` +
    `&approvalRef=${encodeURIComponent(reference)}`;
  const identity = formatEmailIdentityLines({
    stakeholder,
    deliveryAddress: input.deliveryAddress,
    requestedBy: input.agent,
    requestedByKind: "agent",
    deliveryMode: input.deliveryMode ?? "real",
    deliveryState: input.deliveryState ?? "queued",
    actionRequired: `Reply with exactly "approve" or "reject" for ${reference}.`,
    reference,
    appPath,
  });
  return {
    subject: `[${subjectReference}] ${kind}: ${input.workerName} (case #${input.caseId})`,
    body: [
      "An onboarding approval request requires a human decision.",
      "",
      `Employee: ${input.workerName}`,
      `Case: #${input.caseId}`,
      `Approval cycle: ${reference}`,
      "",
      ...identity,
      "",
      `Recommendation: ${input.recommendation}`,
      `Rationale: ${input.rationale}`,
      "",
      `Action required: Reply with exactly "approve" or "reject" for ${reference}.`,
      "Only replies from the exact configured and allowlisted shared approver mailbox address are honored.",
      "A reply is recorded as a shared-mailbox response, not as a verified named human.",
    ].join("\n"),
  };
}

export function composeApprovalDecisionEmail(
  input: ApprovalDecisionEmailTemplateInput,
): { subject: string; body: string } {
  const version = approvalVersion(input.version);
  const reference = approvalRef(input.approvalId, version);
  const stale = input.stale === true;
  const stakeholder = input.stakeholder ?? DEFAULT_APPROVER;
  const appPath = input.appPath ??
    `/approvals?tab=approvals&caseId=${encodeURIComponent(String(input.caseId))}` +
    `&approvalId=${encodeURIComponent(String(input.approvalId))}` +
    `&approvalRef=${encodeURIComponent(reference)}`;
  const identity = formatEmailIdentityLines({
    stakeholder,
    deliveryAddress: input.deliveryAddress,
    requestedBy: input.decidedBy,
    requestedByKind: input.decidedByKind ?? "human",
    deliveryMode: input.deliveryMode ?? "real",
    deliveryState: input.deliveryState ?? "queued",
    actionRequired: stale
      ? "No action was applied; review the current approval cycle in the app."
      : "No further email action is required; review the recorded decision in the app.",
    reference,
    appPath,
  });
  return {
    subject: `[${reference}] Decision ${stale ? "stale" : "recorded"}: ${input.decision} — ${input.workerName} (case #${input.caseId})`,
    body: [
      stale
        ? `A reply for ${reference} was not applied because the current approval cycle was already decided or superseded.`
        : `The decision for ${reference} was recorded.`,
      "",
      `Employee: ${input.workerName}`,
      `Case: #${input.caseId}`,
      `Decision: ${input.decision}`,
      `Time: ${input.decidedAt.toISOString()}`,
      `Version: ${version}`,
      input.decidedByKind === "shared-mailbox"
        ? `Authenticated actor: no verified named human; actual responder: ${input.decidedBy} (shared mailbox)`
        : `Authenticated actor / actual responder: ${input.decidedBy} (${input.decidedByKind ?? "human"})`,
      "",
      ...identity,
      "",
      "This reports the approval record only. An approval does not by itself claim that a gateway was released.",
      "Any Gate A or Gate C release is reported separately after current-evidence reconciliation.",
    ].join("\n"),
  };
}

export function defaultApprovalStakeholder(): NamedStakeholder {
  return identityForRole("approver", undefined, null, DEFAULT_APPROVER.role);
}