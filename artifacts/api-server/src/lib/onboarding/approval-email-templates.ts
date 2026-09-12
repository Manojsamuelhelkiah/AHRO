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
  /** Set only for a current governance grant to the exact verified mailbox. */
  emailResponderAuthorized?: boolean;
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
  const identity = formatEmailIdentityLines({
    stakeholder,
    deliveryAddress: input.deliveryAddress,
    requestedBy: input.agent,
    requestedByKind: "agent",
    deliveryMode: input.deliveryMode ?? "real",
    deliveryState: input.deliveryState ?? "queued",
    actionRequired: input.emailResponderAuthorized
      ? `To decide by email, reply with exactly "approve" or "reject" and include ${reference} in the message body. We verify a full-body DKIM signature, exact From address, and current authority when processing.`
      : "Sign in to the same organization and open Action Center → Approvals to review this request.",
    reference,
    appNavigation: `Sign in to the same organization, open Action Center → Approvals, and locate ${reference}.`,
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
       input.emailResponderAuthorized
          ? `Email decisions require a valid DNS-backed DKIM signature from the exact governance-authorized Clerk-verified member address. The signature must cover From, Subject, and the entire body (no partial-body signature); include ${reference} and "approve" or "reject" in the body. A stale, revoked, expired, unscoped, non-member, or SoD-conflicted sender is not applied.`
         : "Action required: sign in to the same organization and open Action Center → Approvals.",
       input.emailResponderAuthorized
          ? "A passing mailbox header or Authentication-Results field is not trusted. Raw Gmail message cryptography and current member authority are both required; no stakeholder persona or mailbox label grants authority."
         : `Locate ${reference} and record the decision in the signed-in app.`,
       input.emailResponderAuthorized
         ? "If verification fails, no decision is applied and you will receive a receipt with the sign-in instructions."
         : "Email replies are notification receipts only: they do not approve, reject, or change this review.",
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
  const identity = formatEmailIdentityLines({
    stakeholder,
    deliveryAddress: input.deliveryAddress,
    requestedBy: input.decidedBy,
    requestedByKind: input.decidedByKind ?? "human",
    deliveryMode: input.deliveryMode ?? "real",
    deliveryState: input.deliveryState ?? "queued",
    actionRequired: stale
      ? "No decision was applied. Sign in to the same organization and review the current approval cycle in Action Center → Approvals."
      : "No further email action is required; review the recorded decision in the app.",
    reference,
    appNavigation: `Sign in to the same organization, open Action Center → Approvals, and locate ${reference}.`,
  });
  return {
    subject: `[${reference}] Decision ${stale ? "stale" : "recorded"}: ${input.decision} — ${input.workerName} (case #${input.caseId})`,
    body: [
      stale
        ? `An email response for ${reference} did not apply a decision. Sign in to the same organization and review the current approval cycle in Action Center → Approvals.`
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