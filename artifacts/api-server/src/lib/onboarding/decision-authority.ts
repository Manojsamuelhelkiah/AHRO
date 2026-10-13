import { randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { and, eq } from "drizzle-orm";
import { onbApprovals, onbAuthorityAudit, onbCases, onbSettings, type OnbAuthorityRole, type OnbAuthorityScope } from "@workspace/db/schema";
import type { OnboardingDbTransaction } from "./settings";
import { isRestrictedControllerCase as isRetiredControllerCase } from "./operational-eligibility";
import type { ApprovalDecision, ApprovalProposal } from "./compound-action-contract";
import { hasHumanPermissions, permissionReceiptStillCurrent, type HumanPermissionReceipt } from "../human-permissions";

/** Retained vocabulary for historical records and workflow routing only. */
export const AUTHORITY_SCOPES: readonly OnbAuthorityScope[] = [
  "hrbp-approve", "hr-ethics-approve", "delivery-head-approve", "finance-approve",
  "hr-compliance-approve", "legal-approve", "occupational-health-approve", "safety-approve",
  "site-fulfillment-approve", "payroll-approve", "fraud-control-approve", "manager-approve",
  "application-owner-approve", "security-approve", "it-security-approve", "authority-administration",
];
export const AUTHORITY_ROLES: readonly OnbAuthorityRole[] = [
  "hrbp", "hr-ethics", "delivery-head", "finance", "hr-compliance", "legal",
  "occupational-health", "safety", "site-operations", "payroll", "fraud-control",
  "manager", "application-owner", "security", "it-security", "governance",
];

/** Historical validation only. No role or scope label confers access. */
export function roleMayExerciseScope(role: OnbAuthorityRole, scope: OnbAuthorityScope): boolean {
  const historical: Record<OnbAuthorityRole, OnbAuthorityScope> = {
    hrbp: "hrbp-approve", "hr-ethics": "hr-ethics-approve", "delivery-head": "delivery-head-approve",
    finance: "finance-approve", "hr-compliance": "hr-compliance-approve", legal: "legal-approve",
    "occupational-health": "occupational-health-approve", safety: "safety-approve",
    "site-operations": "site-fulfillment-approve", payroll: "payroll-approve",
    "fraud-control": "fraud-control-approve", manager: "manager-approve",
    "application-owner": "application-owner-approve", security: "security-approve",
    "it-security": "it-security-approve", governance: "authority-administration",
  };
  return historical[role] === scope;
}
export function authorityScopeForApproval(input: { ruleRef?: string | null; agent?: string | null; recommendation?: string | null }): OnbAuthorityScope {
  const text = `${input.ruleRef ?? ""} ${input.agent ?? ""} ${input.recommendation ?? ""}`.toLowerCase();
  if (/\b(bgv|background).{0,50}\b(adverse|fail|exception|disposition)/.test(text)) return "hr-compliance-approve";
  if (/\b(legal|transfer|policy).{0,50}\b(approval|decision|review)/.test(text)) return "legal-approve";
  if (/\b(medical|occupational health|safety|ehs).{0,50}\b(clearance|approval|review)/.test(text)) return "occupational-health-approve";
  return "hr-compliance-approve";
}

export type DecisionAuthorityResult =
  | { allowed: true; authorityId: string; revision: number; source: "authenticated-user" | "authorized-email"; personUserId: string }
  | { allowed: false; reason: string };

const DECISION_KEYS = ["tool.approval.decide", "flow.case.edit"] as const;
const DECISION_PREFIX = "human-permission/v1:approval:";
export const remoteMemberBindingKey = (email: string) => `approval-email-member-binding/v1:${email.trim().toLowerCase()}`;

/** Directory ownership and separately recorded member binding are independent of transport proof. */
export async function verifiedBoundEmailMember(tx: OnboardingDbTransaction, organizationId: string, email: string): Promise<string | null> {
  const normalized = email.trim().toLowerCase();
  const [binding] = await tx.select({ value: onbSettings.value }).from(onbSettings).where(and(
    eq(onbSettings.organizationId, organizationId), eq(onbSettings.key, remoteMemberBindingKey(normalized)),
  )).limit(1);
  if (!binding?.value) return null;
  try {
    const stored = JSON.parse(binding.value) as { schema?: string; userId?: string; email?: string };
    if (stored.schema !== "named-member-email/v1" || !stored.userId || stored.email !== normalized) return null;
    const users = await clerkClient.users.getUserList({ emailAddress: [normalized], limit: 2 });
    const matches = users.data.filter(user => user.emailAddresses.some(address =>
      address.emailAddress.trim().toLowerCase() === normalized && address.verification?.status === "verified"));
    return matches.length === 1 && matches[0]!.id === stored.userId ? stored.userId : null;
  } catch { return null; }
}

/** Live exact permissions under the caller's tenant/case decision fence. */
export async function verifyDecisionAuthorityInTransaction(tx: OnboardingDbTransaction, input: {
  organizationId: string; approval: typeof onbApprovals.$inferSelect;
  actorUserId?: string | null; responderEmail?: string | null; now?: Date;
}): Promise<DecisionAuthorityResult> {
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.approval.caseId),
  ));
  if (!c || input.approval.organizationId !== input.organizationId) return { allowed: false, reason: "case_tenant_mismatch" };
  if (isRetiredControllerCase(c)) return { allowed: false, reason: "case_operations_retired" };
  const actor = input.actorUserId ?? (input.responderEmail ? await verifiedBoundEmailMember(tx, input.organizationId, input.responderEmail) : null);
  if (!actor) return { allowed: false, reason: "authenticated_or_verified_named_member_required" };
  const requester = input.approval.requestedByUserId ?? c.createdByUserId;
  if (!requester) return { allowed: false, reason: "requester_provenance_required" };
  if (actor === requester) return { allowed: false, reason: "separation_of_duties_requester_conflict" };
  if (!await hasHumanPermissions(tx, { organizationId: input.organizationId, actorUserId: actor,
    caseId: c.id, requiredKeys: DECISION_KEYS })) return { allowed: false, reason: "current_approval_and_case_permissions_required" };
  return { allowed: true, authorityId: `${DECISION_PREFIX}${input.approval.id}`,
    revision: input.approval.version, source: input.actorUserId ? "authenticated-user" : "authorized-email", personUserId: actor };
}

export async function decisionAuthorityStillCurrent(tx: OnboardingDbTransaction, approval: typeof onbApprovals.$inferSelect,
  actualActorUserIds?: Array<string | undefined>): Promise<boolean> {
  const receipt = approval.permissionDecision;
  if (!receipt || approval.decidedBy !== receipt.actorUserId || receipt.decision !== approval.status ||
    approval.decidedAuthorityId !== `${DECISION_PREFIX}${approval.id}` ||
    approval.decidedAuthorityRevision !== approval.version ||
    actualActorUserIds?.includes(receipt.actorUserId)) return false;
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, approval.organizationId), eq(onbCases.id, approval.caseId),
  ));
  const requester = approval.requestedByUserId ?? c?.createdByUserId;
  if (!c || isRetiredControllerCase(c) || !requester || receipt.actorUserId === requester) return false;
  return permissionReceiptStillCurrent(tx, receipt as HumanPermissionReceipt, {
    organizationId: approval.organizationId, caseId: approval.caseId, requiredKeys: DECISION_KEYS,
    reviewedRevision: approval.version, evidenceGeneration: approval.version,
  });
}

export const EXECUTION_AUTHORIZATION_RULES = {
  documents: "Execution authorization — documents envelope",
  "background-verification": "Execution authorization — background verification",
  iam: "Execution authorization — IAM provisioning",
  payroll: "Execution authorization — payroll enrolment",
} as const;
/** Routing labels only; authorization never depends on these labels. */
export function executionAuthorityScopes(connector: keyof typeof EXECUTION_AUTHORIZATION_RULES): readonly OnbAuthorityScope[] {
  return [{ documents: "legal-approve", "background-verification": "hr-compliance-approve", iam: "it-security-approve", payroll: "payroll-approve" }[connector] as OnbAuthorityScope];
}
export type CaseExecutionAuthorityEvidence = { allowed: true; decisions: ApprovalDecision[] } | { allowed: false; reason: string };
export async function resolveCurrentCaseExecutionAuthorityEvidence(tx: OnboardingDbTransaction, input: {
  organizationId: string; caseId: number; connector?: keyof typeof EXECUTION_AUTHORIZATION_RULES;
  actualActorUserIds?: Array<string | undefined>;
}): Promise<CaseExecutionAuthorityEvidence> {
  const [c] = await tx.select().from(onbCases).where(and(eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId)));
  if (!c) return { allowed: false, reason: "case_tenant_mismatch" };
  const gateARequired = ["external-fte", "contractor", "rehire"].includes(c.hireType);
  if (gateARequired && !c.offerAcceptanceComplete) return { allowed: false, reason: "offer_acceptance_gate_not_complete" };
  const approvals = await tx.select().from(onbApprovals).where(and(eq(onbApprovals.organizationId, input.organizationId), eq(onbApprovals.caseId, input.caseId)));
  const relevant = approvals.filter(approval => input.connector
    ? approval.ruleRef === EXECUTION_AUTHORIZATION_RULES[input.connector]
    : approval.resumeAction === "continue-after-intake" || approval.resumeAction === "continue-after-plan" ||
      (gateARequired && approval.ruleRef === "Gate A — offer-acceptance package"));
  if (!relevant.length) return { allowed: false, reason: "human_execution_decision_required" };
  const actors = [...input.actualActorUserIds ?? [], ...relevant.map(row => row.requestedByUserId ?? undefined), c.createdByUserId ?? undefined];
  if (!actors.some(Boolean)) return { allowed: false, reason: "authenticated_execution_actor_identity_required" };
  const decisions: ApprovalDecision[] = [];
  for (const approval of relevant) {
    if (approval.status !== "approved") return { allowed: false, reason: "required_human_gate_not_approved" };
    if (!approval.permissionDecision) return { allowed: false, reason: "legacy_decision_requires_fresh_review" };
    if (!await decisionAuthorityStillCurrent(tx, approval, actors)) return { allowed: false, reason: "decision_permissions_no_longer_current" };
    decisions.push({ proposalHash: "", authorityId: approval.decidedAuthorityId!,
      authorityRevision: approval.decidedAuthorityRevision!, authorityRole: approval.authorityScope ?? "human-reviewer",
      decision: "approved", expiresAt: new Date("9999-12-31T23:59:59.999Z") });
  }
  return { allowed: true, decisions };
}

/** Deprecated routing compatibility. All human decisions use the same exact key. */
export async function hasCurrentAuthorityScope(tx: OnboardingDbTransaction, input: {
  organizationId: string; actorUserId: string; scope: OnbAuthorityScope; caseId?: number;
}): Promise<boolean> {
  return hasHumanPermissions(tx, { ...input, requiredKeys: DECISION_KEYS });
}
export async function currentAuthorityScopesForCases(tx: OnboardingDbTransaction, input: {
  organizationId: string; actorUserId: string; caseIds: number[]; scopes: OnbAuthorityScope[];
}): Promise<Map<number, Set<OnbAuthorityScope>>> {
  const result = new Map<number, Set<OnbAuthorityScope>>();
  for (const caseId of input.caseIds) result.set(caseId, new Set(await hasCurrentAuthorityScope(tx, { ...input, caseId, scope: input.scopes[0]! }) ? input.scopes : []));
  return result;
}

/** Old specialist administration is permanently unavailable. */
export async function canAdministerAuthority(_tx: OnboardingDbTransaction, _organizationId: string, _actorUserId: string): Promise<boolean> { return false; }

export async function verifyCurrentCompoundAuthorities(input: {
  proposal: ApprovalProposal; decisions: ApprovalDecision[]; actorIds?: Array<string | undefined>; now?: Date;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const caseId = Number(input.proposal.caseId);
  if (!Number.isSafeInteger(caseId) || caseId < 1) return { allowed: false, reason: "case_tenant_mismatch" };
  if (!input.actorIds?.length || input.actorIds.some(id => !id)) return { allowed: false, reason: "authenticated_high_risk_actor_identity_required" };
  const { db } = await import("@workspace/db");
  return db.transaction(async tx => {
    const people = new Set<string>();
    for (const decision of input.decisions.filter(item => item.decision === "approved")) {
      if (!decision.authorityId.startsWith(DECISION_PREFIX)) return { allowed: false, reason: "legacy_decision_requires_fresh_review" } as const;
      const approvalId = Number(decision.authorityId.slice(DECISION_PREFIX.length));
      if (!Number.isSafeInteger(approvalId) || approvalId < 1) return { allowed: false, reason: "decision_binding_required" } as const;
      const [approval] = await tx.select().from(onbApprovals).where(and(eq(onbApprovals.organizationId, input.proposal.tenantId), eq(onbApprovals.id, approvalId), eq(onbApprovals.caseId, caseId)));
      if (!approval || approval.status !== "approved" || approval.version !== decision.authorityRevision ||
        !await decisionAuthorityStillCurrent(tx, approval, input.actorIds)) return { allowed: false, reason: "current_permission_decision_required" } as const;
      if (!approval.decidedBy || people.has(approval.decidedBy)) return { allowed: false, reason: "separation_of_duties_conflict" } as const;
      people.add(approval.decidedBy);
    }
    return { allowed: true } as const;
  });
}

/** Historical audit append utility; no grant mutations. */
export async function auditAuthority(tx: OnboardingDbTransaction, organizationId: string, actorUserId: string,
  action: string, detail: Record<string, unknown>, authorityId?: string): Promise<void> {
  await tx.insert(onbAuthorityAudit).values({ organizationId, actorUserId, action, detail, authorityId: authorityId ?? null });
}
export function newAuthorityId(): string { return randomUUID(); }
