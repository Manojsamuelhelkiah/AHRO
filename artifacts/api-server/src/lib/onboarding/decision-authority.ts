import { randomUUID } from "node:crypto";
import { clerkClient } from "@clerk/express";
import { and, eq, gt, isNull, lte, or } from "drizzle-orm";
import {
  onbApprovals,
  onbAuthorityAssignments,
  onbAuthorityAudit,
  onbAuthorityGovernance,
  onbCases,
  organizationMembershipsTable,
  type OnbAuthorityRole,
  type OnbAuthorityScope,
} from "@workspace/db/schema";
import type { OnboardingDbTransaction } from "./settings";
import type { ApprovalDecision, ApprovalProposal } from "./compound-action-contract";

export const AUTHORITY_SCOPES: readonly OnbAuthorityScope[] = [
  "hr-compliance-approve",
  "legal-approve",
  "occupational-health-approve",
  "payroll-approve",
  "fraud-control-approve",
  "manager-approve",
  "application-owner-approve",
  "security-approve",
  "it-security-approve",
  "authority-administration",
] as const;

export const AUTHORITY_ROLES: readonly OnbAuthorityRole[] = [
  "hr-compliance",
  "legal",
  "occupational-health",
  "payroll",
  "fraud-control",
  "manager",
  "application-owner",
  "security",
  "it-security",
  "governance",
] as const;

/** A display role is never a wildcard. Grants and live checks use this
 * immutable least-privilege matrix, rather than trusting a client scopes
 * array or a historical assignment row. */
export const ROLE_SCOPE_MATRIX: Readonly<Record<OnbAuthorityRole, readonly OnbAuthorityScope[]>> = {
  "hr-compliance": ["hr-compliance-approve"],
  legal: ["legal-approve"],
  "occupational-health": ["occupational-health-approve"],
  payroll: ["payroll-approve"],
  "fraud-control": ["fraud-control-approve"],
  manager: ["manager-approve"],
  "application-owner": ["application-owner-approve"],
  security: ["security-approve"],
  "it-security": ["it-security-approve"],
  governance: ["authority-administration"],
};

export function roleMayExerciseScope(role: OnbAuthorityRole, scope: OnbAuthorityScope): boolean {
  return ROLE_SCOPE_MATRIX[role].includes(scope);
}

export type DecisionAuthorityResult =
  | {
      allowed: true;
      authorityId: string;
      revision: number;
      source: "authenticated-user" | "authorized-email";
      /** Actual Clerk principal, never a mailbox persona or display label. */
      personUserId: string;
    }
  | { allowed: false; reason: string };

export function authorityScopeForApproval(input: {
  ruleRef?: string | null;
  agent?: string | null;
  recommendation?: string | null;
}): OnbAuthorityScope {
  const text = `${input.ruleRef ?? ""} ${input.agent ?? ""} ${input.recommendation ?? ""}`.toLowerCase();
  if (/\b(bgv|background).{0,50}\b(adverse|fail|exception|disposition)/.test(text)) {
    return "hr-compliance-approve";
  }
  if (/\b(legal|transfer|policy).{0,50}\b(approval|decision|review)/.test(text)) {
    return "legal-approve";
  }
  if (/\b(medical|occupational health|safety|ehs).{0,50}\b(clearance|approval|review)/.test(text)) {
    return "occupational-health-approve";
  }
  return "hr-compliance-approve";
}

function sameEmail(left: string | null | undefined, right: string | null | undefined): boolean {
  return Boolean(left?.trim() && right?.trim() && left.trim().toLowerCase() === right.trim().toLowerCase());
}

async function verifiedClerkUserForEmail(email: string): Promise<string | null> {
  try {
    const normalized = email.trim().toLowerCase();
    const users = await clerkClient.users.getUserList({ emailAddress: [normalized], limit: 2 });
    const matches = users.data.filter((user) => user.emailAddresses.some((address) =>
      address.emailAddress.trim().toLowerCase() === normalized &&
      address.verification?.status === "verified",
    ));
    return matches.length === 1 ? matches[0]!.id : null;
  } catch {
    // An unavailable identity provider must fail closed; a persisted contact
    // address is not substitute evidence of mailbox ownership.
    return null;
  }
}

/**
 * The shared current-state check used before decision persistence and again
 * before a high-risk dispatch.  It deliberately queries the live assignment,
 * governance state, case and scopes rather than trusting an old role claim,
 * approval snapshot, mailbox persona, or client input.
 */
export async function verifyDecisionAuthorityInTransaction(
  tx: OnboardingDbTransaction,
  input: {
    organizationId: string;
    approval: typeof onbApprovals.$inferSelect;
    actorUserId?: string | null;
    responderEmail?: string | null;
    now?: Date;
  },
): Promise<DecisionAuthorityResult> {
  const now = input.now ?? new Date();
  if (!input.approval.authorityScope) {
    return { allowed: false, reason: "legacy_authority_evidence_required" };
  }
  if (!input.actorUserId && !input.responderEmail) {
    return { allowed: false, reason: "authenticated_or_authorized_responder_required" };
  }

  const [governance] = await tx.select().from(onbAuthorityGovernance).where(
    eq(onbAuthorityGovernance.organizationId, input.organizationId),
  );
  if (governance?.status !== "governance-approved") {
    return { allowed: false, reason: "production_governance_approval_required" };
  }
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId),
    eq(onbCases.id, input.approval.caseId),
  ));
  if (!c) return { allowed: false, reason: "case_tenant_mismatch" };
  // Approval rows created by older paths may omit requester provenance. The
  // immutable case creator is the only safe fallback; neither display/contact
  // fields nor a null principal can satisfy separation of duties.
  const requesterUserId = input.approval.requestedByUserId ?? c.createdByUserId;
  if (!requesterUserId) {
    return { allowed: false, reason: "requester_provenance_required" };
  }
  if (input.actorUserId === requesterUserId) {
    return { allowed: false, reason: "separation_of_duties_requester_conflict" };
  }
  const candidates = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, input.organizationId),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
  ));
  let decisionUserId = input.actorUserId ?? null;
  if (!input.actorUserId && input.responderEmail) {
    const candidateEmails = candidates.filter((row) =>
      row.emailResponderAuthorized &&
      sameEmail(row.personEmail, input.responderEmail) &&
      row.scopes.includes(input.approval.authorityScope!) &&
      roleMayExerciseScope(row.authorityRole, input.approval.authorityScope!) &&
      (row.caseId === null || row.caseId === input.approval.caseId) &&
      (!row.siteScope || row.siteScope === c.geography) &&
      (!row.jurisdictionScope || row.jurisdictionScope === c.legalEntity),
    );
    // Do not call Clerk for arbitrary sender text. A unique, live governance
    // grant must exist first; duplicate candidate grants fail closed.
    if (candidateEmails.length !== 1) {
      return { allowed: false, reason: "no_current_verified_scoped_assignment" };
    }
    decisionUserId = await verifiedClerkUserForEmail(input.responderEmail);
    if (!decisionUserId) {
      return { allowed: false, reason: "remote_identity_verification_required" };
    }
    if (decisionUserId === requesterUserId) {
      return { allowed: false, reason: "separation_of_duties_requester_conflict" };
    }
  }
  if (decisionUserId) {
    const [membership] = await tx.select({ id: organizationMembershipsTable.id })
      .from(organizationMembershipsTable)
      .where(and(
        eq(organizationMembershipsTable.organizationId, input.organizationId),
        eq(organizationMembershipsTable.clerkUserId, decisionUserId),
        isNull(organizationMembershipsTable.revokedAt),
      ));
    if (!membership) return { allowed: false, reason: "current_tenant_membership_required" };
  }

  const assignment = candidates.find((row) =>
    row.scopes.includes(input.approval.authorityScope!) &&
    roleMayExerciseScope(row.authorityRole, input.approval.authorityScope!) &&
    (row.caseId === null || row.caseId === input.approval.caseId) &&
    (!row.siteScope || row.siteScope === c.geography) &&
    (!row.jurisdictionScope || row.jurisdictionScope === c.legalEntity) &&
    (
      input.actorUserId
        ? row.personUserId === input.actorUserId
        : row.emailResponderAuthorized &&
          sameEmail(row.personEmail, input.responderEmail) &&
          row.personUserId === decisionUserId
    ),
  );
  if (!assignment) return { allowed: false, reason: "no_current_verified_scoped_assignment" };
  return {
    allowed: true,
    authorityId: assignment.id,
    revision: assignment.revision,
    source: input.actorUserId ? "authenticated-user" : "authorized-email",
    personUserId: assignment.personUserId,
  };
}

export async function decisionAuthorityStillCurrent(
  tx: OnboardingDbTransaction,
  approval: typeof onbApprovals.$inferSelect,
  actualActorUserIds?: Array<string | undefined>,
): Promise<boolean> {
  if (!approval.decidedAuthorityId || !approval.decidedAuthorityRevision) return false;
  // Re-check the recorded assignment directly rather than treating the
  // historical display name as a principal.
  const now = new Date();
  const [assignment] = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, approval.organizationId),
    eq(onbAuthorityAssignments.id, approval.decidedAuthorityId),
    eq(onbAuthorityAssignments.status, "active"),
    eq(onbAuthorityAssignments.revision, approval.decidedAuthorityRevision),
    lte(onbAuthorityAssignments.validFrom, now),
    or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
  ));
  if (!assignment || !approval.authorityScope || !assignment.scopes.includes(approval.authorityScope) ||
      !roleMayExerciseScope(assignment.authorityRole, approval.authorityScope) ||
       (approval.requestedByUserId !== null && assignment.personUserId === approval.requestedByUserId) ||
      actualActorUserIds?.some((actorUserId) => Boolean(actorUserId) && assignment.personUserId === actorUserId)) return false;
  const [membership] = await tx.select({ id: organizationMembershipsTable.id })
    .from(organizationMembershipsTable)
    .where(and(
      eq(organizationMembershipsTable.organizationId, approval.organizationId),
      eq(organizationMembershipsTable.clerkUserId, assignment.personUserId),
        isNull(organizationMembershipsTable.revokedAt),
    ));
  if (!membership) return false;
  const [c] = await tx.select({
    id: onbCases.id,
    geography: onbCases.geography,
    legalEntity: onbCases.legalEntity,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, approval.organizationId),
    eq(onbCases.id, approval.caseId),
  ));
  if (!c || (assignment.caseId !== null && assignment.caseId !== c.id) ||
      (assignment.siteScope && assignment.siteScope !== c.geography) ||
      (assignment.jurisdictionScope && assignment.jurisdictionScope !== c.legalEntity)) return false;
  const [governance] = await tx.select().from(onbAuthorityGovernance).where(
    eq(onbAuthorityGovernance.organizationId, approval.organizationId),
  );
  return governance?.status === "governance-approved";
}

const OFFER_ACCEPTANCE_GATE_RULE = "Gate A — offer-acceptance package";
export const EXECUTION_AUTHORIZATION_RULES = {
  documents: "Execution authorization — documents envelope",
  "background-verification": "Execution authorization — background verification",
  iam: "Execution authorization — IAM provisioning",
  payroll: "Execution authorization — payroll enrolment",
} as const;

export function executionAuthorityScopes(
  connector: keyof typeof EXECUTION_AUTHORIZATION_RULES,
): readonly OnbAuthorityScope[] {
  switch (connector) {
    // Document envelopes are a legal-signatory operation. HR/compliance may
    // prepare the pack but cannot approve the provider send boundary.
    case "documents": return ["legal-approve"];
    case "background-verification": return ["hr-compliance-approve"];
    case "iam": return ["it-security-approve"];
    case "payroll": return ["payroll-approve"];
  }
}

export type CaseExecutionAuthorityEvidence =
  | { allowed: true; decisions: ApprovalDecision[] }
  | { allowed: false; reason: string };

/**
 * Resolve the already-persisted human decisions that permit a case to cross a
 * provider boundary. This deliberately does not promote a historical
 * approval, a case display name, or a Gate A boolean into authority evidence:
 * every relevant decision must retain its assignment id and revision and be
 * live at the instant the writer runs.
 *
 * The continuation gates are the specialist reviews that authorized the case
 * to reach workstreams. Gate A is also an execution gate for pathways where it
 * is required, but only after its dedicated confirmation flow has persisted a
 * normal authority-bound decision. Later standalone/Gate C reviews are not
 * prerequisites for setup actions that happened before them.
 */
export async function resolveCurrentCaseExecutionAuthorityEvidence(
  tx: OnboardingDbTransaction,
  input: {
    organizationId: string;
    caseId: number;
    connector?: keyof typeof EXECUTION_AUTHORIZATION_RULES;
    actualActorUserIds?: Array<string | undefined>;
  },
): Promise<CaseExecutionAuthorityEvidence> {
  const [c] = await tx.select().from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId),
    eq(onbCases.id, input.caseId),
  ));
  if (!c) return { allowed: false, reason: "case_tenant_mismatch" };

  const gateARequired =
    c.hireType === "external-fte" ||
    c.hireType === "contractor" ||
    c.hireType === "rehire";
  if (gateARequired && !c.offerAcceptanceComplete) {
    return { allowed: false, reason: "offer_acceptance_gate_not_complete" };
  }

  const approvals = await tx.select().from(onbApprovals).where(and(
    eq(onbApprovals.organizationId, input.organizationId),
    eq(onbApprovals.caseId, input.caseId),
  ));
  const allowedScopes = input.connector
    ? executionAuthorityScopes(input.connector)
    : undefined;
  const relevant = input.connector
    ? approvals.filter((approval) =>
        approval.ruleRef === EXECUTION_AUTHORIZATION_RULES[input.connector!] &&
        allowedScopes!.includes(approval.authorityScope as OnbAuthorityScope),
      )
    : approvals.filter((approval) =>
        approval.resumeAction === "continue-after-intake" ||
        approval.resumeAction === "continue-after-plan" ||
        (gateARequired && approval.ruleRef === OFFER_ACCEPTANCE_GATE_RULE),
      );
  if (relevant.length === 0) {
    return { allowed: false, reason: "execution_authority_evidence_required" };
  }
  const actualActorUserIds = [
    ...input.actualActorUserIds ?? [],
    // A legacy recovery approval has an authenticated recovery requester even
    // when the immutable historical case creator is null.
    ...relevant.map((approval) => approval.requestedByUserId ?? undefined),
    c.createdByUserId ?? undefined,
  ].filter((actorUserId): actorUserId is string => Boolean(actorUserId));
  if (actualActorUserIds.length === 0) {
    // A legacy case with only recruiter/worker contact strings cannot provide
    // the principals needed for a meaningful separation-of-duties check.
    return { allowed: false, reason: "authenticated_execution_actor_identity_required" };
  }

  const decisions: ApprovalDecision[] = [];
  for (const approval of relevant) {
    if (approval.status !== "approved") {
      return {
        allowed: false,
        reason: approval.status === "rejected"
          ? "required_specialist_gate_rejected"
          : "required_specialist_gate_not_approved",
      };
    }
    if (
      !approval.authorityScope ||
      !approval.decidedAuthorityId ||
      !Number.isSafeInteger(approval.decidedAuthorityRevision) ||
      !approval.decidedAuthorityRevision
    ) {
      // Never infer an old reviewer identity or assignment generation.
      return { allowed: false, reason: "legacy_authority_evidence_required" };
    }
    if (!(await decisionAuthorityStillCurrent(tx, approval, actualActorUserIds))) {
      return { allowed: false, reason: "no_current_verified_scoped_assignment" };
    }
    decisions.push({
      // These decisions are evidence bindings; their current validity is
      // asserted above rather than inferred from a synthetic expiry date.
      proposalHash: "",
      authorityId: approval.decidedAuthorityId,
      authorityRevision: approval.decidedAuthorityRevision,
      authorityRole: approval.authorityScope,
      decision: "approved",
      expiresAt: new Date("9999-12-31T23:59:59.999Z"),
    });
  }
  return { allowed: true, decisions };
}

export async function canAdministerAuthority(
  tx: OnboardingDbTransaction,
  organizationId: string,
  actorUserId: string,
): Promise<boolean> {
  const [governance] = await tx.select().from(onbAuthorityGovernance).where(
    eq(onbAuthorityGovernance.organizationId, organizationId),
  );
  if (governance?.status !== "governance-approved") return false;
  const now = new Date();
  const rows = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, organizationId),
    eq(onbAuthorityAssignments.personUserId, actorUserId),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
  ));
  return rows.some((row) =>
    row.scopes.includes("authority-administration") &&
    roleMayExerciseScope(row.authorityRole, "authority-administration") &&
    row.caseId === null &&
    row.siteScope === null &&
    row.jurisdictionScope === null,
  );
}

/** Current authenticated authority check for a named non-approval control
 * (for example Gate A confirmation). It shares governance, membership,
 * tenant/case/site/jurisdiction, dates, and role→scope checks with decisions. */
export async function hasCurrentAuthorityScope(
  tx: OnboardingDbTransaction,
  input: { organizationId: string; actorUserId: string; scope: OnbAuthorityScope; caseId?: number },
): Promise<boolean> {
  const [governance, membership] = await Promise.all([
    tx.select().from(onbAuthorityGovernance).where(eq(onbAuthorityGovernance.organizationId, input.organizationId)),
    tx.select({ id: organizationMembershipsTable.id }).from(organizationMembershipsTable).where(and(
      eq(organizationMembershipsTable.organizationId, input.organizationId),
      eq(organizationMembershipsTable.clerkUserId, input.actorUserId),
    isNull(organizationMembershipsTable.revokedAt),
    )),
  ]);
  if (governance[0]?.status !== "governance-approved" || !membership[0]) return false;
  const c = input.caseId === undefined ? undefined : (await tx.select({
    geography: onbCases.geography, legalEntity: onbCases.legalEntity,
  }).from(onbCases).where(and(
    eq(onbCases.organizationId, input.organizationId), eq(onbCases.id, input.caseId),
  )))[0];
  if (input.caseId !== undefined && !c) return false;
  const now = new Date();
  const assignments = await tx.select().from(onbAuthorityAssignments).where(and(
    eq(onbAuthorityAssignments.organizationId, input.organizationId),
    eq(onbAuthorityAssignments.personUserId, input.actorUserId),
    eq(onbAuthorityAssignments.status, "active"),
    lte(onbAuthorityAssignments.validFrom, now),
    or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
  ));
  return assignments.some((assignment) =>
    assignment.scopes.includes(input.scope) &&
    roleMayExerciseScope(assignment.authorityRole, input.scope) &&
    (input.caseId === undefined || assignment.caseId === null || assignment.caseId === input.caseId) &&
    (!c || !assignment.siteScope || assignment.siteScope === c.geography) &&
    (!c || !assignment.jurisdictionScope || assignment.jurisdictionScope === c.legalEntity),
  );
}

const COMPOUND_SCOPE_BY_ROLE: Record<string, OnbAuthorityScope> = {
  "fraud-control approver": "fraud-control-approve",
  "payroll approver": "payroll-approve",
  manager: "manager-approve",
  "application owner": "application-owner-approve",
  "security approver": "security-approve",
};

/**
 * Final connector check. The pure contract verifies hashes/SoD; this database
 * boundary verifies that each recorded authority ID is still the same active
 * tenant/case/site/jurisdiction assignment at its recorded revision.
 */
export async function verifyCurrentCompoundAuthorities(input: {
  proposal: ApprovalProposal;
  decisions: ApprovalDecision[];
  /** Authenticated immutable user IDs for requestor, beneficiary and executor. */
  actorIds?: Array<string | undefined>;
  now?: Date;
}): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  const caseId = Number(input.proposal.caseId);
  if (!Number.isSafeInteger(caseId) || caseId < 1) return { allowed: false, reason: "case_tenant_mismatch" };
  if (!input.actorIds?.length || input.actorIds.some((id) => !id)) {
    return { allowed: false, reason: "authenticated_high_risk_actor_identity_required" };
  }
  const { db } = await import("@workspace/db");
  return db.transaction(async (tx) => {
    const [governance] = await tx.select().from(onbAuthorityGovernance).where(
      eq(onbAuthorityGovernance.organizationId, input.proposal.tenantId),
    );
    if (governance?.status !== "governance-approved") {
      return { allowed: false, reason: "production_governance_approval_required" } as const;
    }
    const [c] = await tx.select({
      geography: onbCases.geography,
      legalEntity: onbCases.legalEntity,
    }).from(onbCases).where(and(
      eq(onbCases.organizationId, input.proposal.tenantId),
      eq(onbCases.id, caseId),
    ));
    if (!c) return { allowed: false, reason: "case_tenant_mismatch" } as const;
    const now = input.now ?? new Date();
    const approvingPeople = new Set<string>();
    for (const decision of input.decisions.filter((item) => item.decision === "approved")) {
      const scope = COMPOUND_SCOPE_BY_ROLE[decision.authorityRole];
      if (!scope || !Number.isSafeInteger(decision.authorityRevision) || !decision.authorityRevision) {
        return { allowed: false, reason: "legacy_authority_evidence_required" } as const;
      }
      const [assignment] = await tx.select().from(onbAuthorityAssignments).where(and(
        eq(onbAuthorityAssignments.organizationId, input.proposal.tenantId),
        eq(onbAuthorityAssignments.id, decision.authorityId),
        eq(onbAuthorityAssignments.revision, decision.authorityRevision),
        eq(onbAuthorityAssignments.status, "active"),
        lte(onbAuthorityAssignments.validFrom, now),
        or(isNull(onbAuthorityAssignments.validUntil), gt(onbAuthorityAssignments.validUntil, now)),
      ));
      if (!assignment || !assignment.scopes.includes(scope) ||
          !roleMayExerciseScope(assignment.authorityRole, scope) ||
          (assignment.caseId !== null && assignment.caseId !== caseId) ||
          (assignment.siteScope && assignment.siteScope !== c.geography) ||
          (assignment.jurisdictionScope && assignment.jurisdictionScope !== c.legalEntity)) {
        return { allowed: false, reason: "no_current_verified_scoped_assignment" } as const;
      }
      const [membership] = await tx.select({ id: organizationMembershipsTable.id })
        .from(organizationMembershipsTable)
        .where(and(
          eq(organizationMembershipsTable.organizationId, input.proposal.tenantId),
          eq(organizationMembershipsTable.clerkUserId, assignment.personUserId),
          isNull(organizationMembershipsTable.revokedAt),
        ));
      if (!membership) return { allowed: false, reason: "current_tenant_membership_required" } as const;
      if (
        approvingPeople.has(assignment.personUserId) ||
        input.actorIds?.includes(assignment.personUserId)
      ) {
        return { allowed: false, reason: "separation_of_duties_conflict" } as const;
      }
      approvingPeople.add(assignment.personUserId);
    }
    return { allowed: true } as const;
  });
}

export async function auditAuthority(
  tx: OnboardingDbTransaction,
  organizationId: string,
  actorUserId: string,
  action: string,
  detail: Record<string, unknown>,
  authorityId?: string,
): Promise<void> {
  await tx.insert(onbAuthorityAudit).values({ organizationId, actorUserId, action, detail, authorityId: authorityId ?? null });
}

export function newAuthorityId(): string {
  return randomUUID();
}